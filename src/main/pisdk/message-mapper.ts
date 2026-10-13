import type { Message } from "@earendil-works/pi-ai";
import type { AttachmentPart } from "@/shared/contracts/attachment";
import type {
  ChatMessage,
  ChatMessageUsage,
  ChatPart,
  ToolCallPart,
} from "@/shared/contracts/session";
import { type AttachmentEnvelope, parseAttachmentEnvelope } from "./attachments";
import type { AppEntry } from "./durable-session";
import { modelGenerationId } from "./model-retry";
import { toolPartImages } from "./tool-images";

type UserMessage = Extract<Message, { role: "user" }>;
type AssistantMessage = Extract<Message, { role: "assistant" }>;
type ToolResultMessage = Extract<Message, { role: "toolResult" }>;

/** 记录已映射出的 tool-call part，等待后续 toolResult 条目回填 */
type PendingToolCalls = Map<string, ToolCallPart>;

function toDataUrl(mimeType: string, data: string): string {
  return `data:${mimeType};base64,${data}`;
}

/** 未知块类型只告警不抛错，避免历史数据把整个会话回读打断 */
function warnUnknownBlock(entryId: string, block: unknown): void {
  const type = typeof block === "object" && block !== null && "type" in block ? block.type : block;
  console.warn(`跳过未知内容块 (entry ${entryId}): ${String(type)}`);
}

/**
 * 用户消息的内容块 → UI 的 part 列表。
 *
 * **实时回显（runtime 的 message_start）与历史回读（mapEntriesToMessages）共用这一个函数**，
 * 这是刻意的：附件在模型侧是「信封文本 + 图片块」两段，界面要还原成一张附件卡片；
 * 如果两条路各写一份解析，实时看到的与刷新之后看到的迟早会不一样 —— 而那种不一致
 * 只有「刷新一下附件就变了样」这种很难归因的现象才会暴露。
 *
 * 还原规则：
 *   · 文本块以 `<attachment ` 开头 → 起一条附件，随后的 N 个图片块（信封里的 `frames`）
 *     是它的图；N 个收满即收工，接着按普通文本处理；
 *   · 不匹配信封的图片块 → 退回裸 `ImagePart`。这是**旧会话**的形状（附件功能之前
 *     用户贴的图只有 image 块，没有信封），回读时必须继续显示，不能因为升级就丢历史；
 *   · 帧数对不上（信封说 3 帧、实际只有 1 个图片块）时按实际数量收 —— 解析以**块为准**，
 *     信封只是提示，否则一次异常落盘会让后面所有附件错位。
 */
export function mapUserParts(message: UserMessage, label = "(user)"): ChatPart[] {
  const parts: ChatPart[] = [];
  if (typeof message.content === "string") {
    if (message.content.trim().length > 0) parts.push({ type: "text", text: message.content });
    return parts;
  }

  /** 正在收图的附件：信封已出现，帧还没收满 */
  let pending: {
    envelope: AttachmentEnvelope;
    frames: { mimeType: string; dataUrl: string }[];
  } | null = null;

  const flush = (): void => {
    if (pending === null) return;
    parts.push(toAttachmentPart(pending.envelope, pending.frames));
    pending = null;
  };

  for (const block of message.content) {
    if (block.type === "text") {
      const envelope = parseAttachmentEnvelope(block.text);
      if (envelope !== null) {
        flush();
        // 声明 0 帧（文本/二进制附件）时当场收工，不必等下一个块来触发
        if (envelope.frames > 0) pending = { envelope, frames: [] };
        else parts.push(toAttachmentPart(envelope, []));
        continue;
      }
      flush();
      if (block.text.trim().length > 0) parts.push({ type: "text", text: block.text });
      continue;
    }
    if (block.type === "image") {
      const frame = { mimeType: block.mimeType, dataUrl: toDataUrl(block.mimeType, block.data) };
      if (pending !== null) {
        pending.frames.push(frame);
        if (pending.frames.length >= pending.envelope.frames) flush();
        continue;
      }
      parts.push({ type: "image", mimeType: block.mimeType, dataUrl: frame.dataUrl });
      continue;
    }
    warnUnknownBlock(label, block);
  }
  flush();
  return parts;
}

/** 信封 + 收到的帧 → 附件 part（展示态） */
function toAttachmentPart(
  envelope: AttachmentEnvelope,
  frames: readonly { mimeType: string; dataUrl: string }[],
): AttachmentPart {
  return {
    type: "attachment",
    index: envelope.index,
    kind: envelope.kind,
    name: envelope.name,
    mimeType: envelope.mimeType,
    size: envelope.bytes,
    path: envelope.path,
    ...(frames.length === 0 ? {} : { frames: [...frames] }),
    ...(envelope.durationSeconds === undefined
      ? {}
      : { durationSeconds: envelope.durationSeconds }),
    ...(envelope.width === undefined ? {} : { width: envelope.width }),
    ...(envelope.height === undefined ? {} : { height: envelope.height }),
    ...(envelope.kind === "video" ? { frameCount: frames.length } : {}),
    ...(envelope.totalLines === undefined ? {} : { totalLines: envelope.totalLines }),
    ...(envelope.textTruncated === true ? { textTruncated: true } : {}),
    ...(envelope.downscaled === true ? { downscaled: true } : {}),
  };
}

function mapUsage(message: AssistantMessage): ChatMessageUsage | undefined {
  const usage = message.usage;
  if (!usage) return undefined;
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    ...(usage.reasoning === undefined ? {} : { reasoningTokens: usage.reasoning }),
    totalTokens: usage.totalTokens,
    uncachedInputTokens: usage.input,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
  };
}

function mapUserMessage(
  entryId: string,
  message: UserMessage,
  createdAt: number,
  parentId: string | null,
): ChatMessage {
  return {
    id: entryId,
    entryId,
    parentId,
    role: "user",
    createdAt,
    parts: mapUserParts(message, entryId),
    status: "complete",
  };
}

function mapAssistantMessage(
  entryId: string,
  message: AssistantMessage,
  createdAt: number,
  pending: PendingToolCalls,
  parentId: string | null,
): ChatMessage {
  const parts: ChatPart[] = [];
  for (const block of message.content) {
    if (block.type === "text") {
      if (block.text.trim().length > 0) parts.push({ type: "text", text: block.text });
    } else if (block.type === "thinking") {
      // 被安全策略屏蔽的 thinking 只有加密签名，没有可展示文本
      if (block.redacted !== true && block.thinking.trim().length > 0) {
        parts.push({ type: "reasoning", text: block.thinking });
      }
    } else if (block.type === "toolCall") {
      const part: ToolCallPart = {
        type: "tool-call",
        toolCallId: block.id,
        toolName: block.name,
        // 流式期间 args 可能不完整；落盘条目已是最终结构，这里直接序列化原值
        argsText: JSON.stringify(block.arguments) ?? "{}",
        args: block.arguments,
        // 有对应 toolResult 时会在后续条目里改写为 done/error
        status: "running",
      };
      pending.set(block.id, part);
      parts.push(part);
    } else {
      warnUnknownBlock(entryId, block);
    }
  }

  const failed = message.stopReason === "error" || message.stopReason === "aborted";
  const usage = mapUsage(message);
  return {
    id: entryId,
    entryId,
    parentId,
    role: "assistant",
    createdAt,
    parts,
    status: failed ? "error" : "complete",
    ...(usage === undefined ? {} : { usage }),
    // 1.2.0：内核测量了本次回复耗时；延迟取回（deferred）的结果没有这个值
    ...(message.durationMs === undefined ? {} : { durationMs: message.durationMs }),
    ...(failed && message.errorMessage ? { error: message.errorMessage } : {}),
  };
}

/** 工具结果内容：优先纯文本，其次结构化 details，最后原样保留内容块 */
function toolResultValue(message: ToolResultMessage): unknown {
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  if (text.length > 0) return text;
  if (message.details !== undefined) return message.details;
  if (message.content.length > 0) return message.content;
  return "";
}

function applyToolResult(message: ToolResultMessage, pending: PendingToolCalls): void {
  const part = pending.get(message.toolCallId);
  // 找不到匹配调用的结果直接忽略（可能来自分支外的历史残留）
  if (!part) return;
  part.result = toolResultValue(message);
  // 文本结果会盖住 details，两者都留：工具的结构化详情（edit 的 patch 等）只有 details 里有
  if (message.details !== undefined) part.details = message.details;
  /**
   * 图片本体：与流式路径（runtime 的 applyToolEnd）同一个判断函数。
   *
   * 这一步就是「刷新窗口 / 重开应用之后，会话里的截图还在」的全部实现 ——
   * part 上的 images 只在内存里，磁盘上的那份是 pi 的 toolResult 条目（含 image 内容块），
   * 回读时从这里重新取出。哪一类工具该带、带多大，都由 toolPartImages 说了算。
   */
  const images = toolPartImages(part.toolName, message.content);
  if (images !== undefined) part.images = images;
  part.isError = message.isError;
  part.status = message.isError ? "error" : "done";
  // 1.2.0：内核测量了这次执行耗时（未执行/中断的调用没有这个值）；界面的历史回读靠它。
  if (message.durationMs !== undefined) part.durationMs = message.durationMs;
}

/**
 * Entry 列表（按时间正序）→ UI 消息。
 * 忽略 compaction / branch_summary / custom 条目本身，仅收集压缩摘要文本预览；
 * 每个 message 条目保持一条 ChatMessage（不跨条目合并），保证 entryId 精确对应分支点。
 */
export function mapEntriesToMessages(entries: readonly AppEntry[]): {
  messages: ChatMessage[];
  compactionSummaries: string[];
} {
  const messages: ChatMessage[] = [];
  const compactionSummaries: string[] = [];
  const pending: PendingToolCalls = new Map();

  for (const entry of entries) {
    if (entry.record.kind === "pi.compaction") {
      for (const message of entry.record.model ?? []) {
        if (message.role !== "user") continue;
        compactionSummaries.push(
          typeof message.content === "string"
            ? message.content
            : message.content
                .filter((block) => block.type === "text")
                .map((block) => block.text)
                .join("\n"),
        );
      }
      continue;
    }
    if (!["pi.user", "pi.assistant", "pi.tool-result"].includes(entry.record.kind)) continue;
    for (const message of entry.record.model ?? []) {
      const createdAt = entry.createdAt;
      if (message.role === "user") {
        messages.push(mapUserMessage(entry.entryId, message, createdAt, entry.parentId));
      } else if (message.role === "assistant") {
        const mapped = mapAssistantMessage(
          entry.entryId,
          message,
          createdAt,
          pending,
          entry.parentId,
        );
        if (entry.record.byTaskId !== undefined)
          mapped.generationId = modelGenerationId(
            entry.record.conversationId,
            entry.record.byTaskId,
          );
        messages.push(mapped);
      } else if (message.role === "toolResult") {
        // toolResult 是独立消息条目：只回填对应 tool-call，不单独成条
        applyToolResult(message, pending);
      } else {
        const role = (message as { role?: unknown }).role;
        console.warn(`跳过未知消息角色 (entry ${entry.entryId}): ${String(role)}`);
      }
    }
  }

  return { messages, compactionSummaries };
}
