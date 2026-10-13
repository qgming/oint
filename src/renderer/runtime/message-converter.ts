import type {
  AppendMessage,
  MessageStatus,
  ThreadMessage,
  ThreadMessageLike,
} from "@assistant-ui/react";
import { fromThreadMessageLike } from "@assistant-ui/react";
import type { ChatMessage, ChatPart } from "@/shared/contracts";
import { ATTACHMENT_DATA_PART } from "./attachment-payload";

/** ThreadMessageLike 的 content 元素类型（从库类型推导，保证兼容） */
type ThreadPart =
  Exclude<ThreadMessageLike["content"], string> extends readonly (infer P)[] ? P : never;

/**
 * 子会话转录的解析函数（子会话 id → 该子会话的转录）。
 *
 * 由调用方注入，转换器自己**不读任何 store**：保持纯函数，同一份入参永远得到同一棵
 * 线程消息树，memo 与测试都能按值判断。取不到（undefined / 空数组）时不挂嵌套，
 * 工具 part 保持现在的平铺形状。
 */
type ChildMessageResolver = (childSessionId: string) => readonly ChatMessage[] | undefined;

/**
 * 嵌套子消息的回退状态。
 * 子会话转录是**历史**（读到它时这次委派已经落定），一律按 complete/stop 归一化；
 * 挂一个 running 会让早就结束的子会话在树里一直转圈。
 */
const CHILD_FALLBACK_STATUS: MessageStatus = { type: "complete", reason: "stop" };

/**
 * 主进程消息 → assistant-ui 线程消息。
 *
 * 三个重载是两种调用场景：注入子会话解析函数（工具调用要挂嵌套消息），或被直接当作
 * ExternalStoreMessageConverter 传进 useExternalStoreRuntime（第二个参数是消息下标）。
 * 后者没有嵌套来源，保持平铺；不这么写会让两处的类型对不上（number ≠ 解析函数）。
 */
export function toThreadMessage(message: ChatMessage): ThreadMessageLike;
export function toThreadMessage(
  message: ChatMessage,
  resolveChild: ChildMessageResolver,
): ThreadMessageLike;
export function toThreadMessage(message: ChatMessage, index: number): ThreadMessageLike;
export function toThreadMessage(
  message: ChatMessage,
  resolveChild?: ChildMessageResolver | number,
): ThreadMessageLike {
  const resolve = typeof resolveChild === "function" ? resolveChild : undefined;
  return {
    id: message.id,
    role: message.role,
    createdAt: new Date(message.createdAt),
    content: message.parts.map((part) => toThreadPart(part, resolve)),
    // assistant-ui 只允许 assistant 消息携带 status；用户消息带上会抛
    // "status is only supported for assistant messages" 并导致整树崩溃白屏
    ...(message.role === "assistant" ? { status: toMessageStatus(message) } : {}),
    // entryId / origin 走 metadata.custom 通道透出：entryId 供「分支」映射回 pi 条目，
    // origin 供渲染层判断是否按系统通知行渲染（UserMessage origin === "system" 分支）；
    // durationMs 供消息脚注展示内核测量的回复耗时。
    ...(message.entryId === undefined &&
    message.origin === undefined &&
    message.generationId === undefined &&
    message.durationMs === undefined
      ? {}
      : {
          metadata: {
            custom: {
              ...(message.entryId === undefined ? {} : { entryId: message.entryId }),
              ...(message.origin === undefined ? {} : { origin: message.origin }),
              ...(message.generationId === undefined ? {} : { generationId: message.generationId }),
              ...(message.durationMs === undefined ? {} : { durationMs: message.durationMs }),
            },
          },
        }),
  };
}

/** ChatPart → 线程消息 part */
function toThreadPart(part: ChatPart, resolveChild?: ChildMessageResolver): ThreadPart {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "reasoning":
      return { type: "reasoning", text: part.text };
    case "tool-call": {
      const nested = resolveChild === undefined ? undefined : toNestedMessages(part, resolveChild);
      const partLike = {
        type: "tool-call",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        argsText: part.argsText,
        ...(part.args !== undefined ? { args: part.args } : {}),
        ...(part.result !== undefined ? { result: part.result } : {}),
        ...(part.isError !== undefined ? { isError: part.isError } : {}),
        // 工具的 details 走 assistant-ui 的 artifact 槽位（库声明的 UI 专用附属数据）。
        // 不能直接挂一个自造字段：那不是 ThreadMessageLike 的形状，会在归一化时被丢掉。
        ...(part.details !== undefined ? { artifact: part.details } : {}),
        /**
         * 运行期间的输出快照走 `providerMetadata`（库声明的「宿主附加的 JSON 数据」槽位）。
         *
         * 与 artifact 同理：自造字段会被归一化丢掉，而 artifact 已经被工具 details 占了
         *（混进去会污染 `parseToolDetail` 的输入）。嵌套在 `oint` 命名空间下，
         * 与类型要求的 `{ [providerName]: ReadonlyJSONObject }` 形状一致。
         *
         * 工具的**图片本体**（目前只有 browser_screenshot）走同一个槽位的另一个键：
         * 它同样不能进 artifact（那会随 pi 的 toolResult 条目落盘，每截一张图就多存一份
         * base64），而渲染层要的只是「点开详情时能看见那张图」。
         */
        ...(part.partialOutput === undefined && part.images === undefined
          ? {}
          : {
              providerMetadata: {
                oint: {
                  ...(part.partialOutput === undefined
                    ? {}
                    : { partialOutput: part.partialOutput }),
                  ...(part.images === undefined ? {} : { images: part.images }),
                },
              },
            }),
        // 嵌套是 assistant-ui 为「工具调用自己开了一条会话」预留的槽位（见库的
        // ToolCallMessagePart.messages 注释），sub-agent 正好就是这种形状：把子会话
        // 转录挂上去，PartPrimitive.Messages 才能把它渲染成一条真实的会话。
        ...(nested === undefined ? {} : { parentId: part.toolCallId, messages: nested }),
      };
      return partLike as ThreadPart;
    }
    case "image":
      return { type: "image", image: part.dataUrl };
    case "attachment":
      /**
       * 附件走库的 `data` part 槽位（`name` 由渲染层的附件卡片组件按名派发）。
       *
       * 为什么不用 image/file part：附件有四种形态（图片 / 视频 / 文本 / 其他文件），
       * 而卡片要显示的是「名字 + 大小 + 时长 + 抽帧数」这一整套读数，还要带「用系统
       * 默认程序打开」这类动作 —— 那超出了 ImageMessagePart / FileMessagePart 的形状。
       * `data` 是库为「宿主自定义的 part」留的槽位，形状原样保留，正是这里要的。
       */
      return {
        type: "data",
        name: ATTACHMENT_DATA_PART,
        data: part,
      } as ThreadPart;
  }
}

/**
 * 从工具 details 里取子会话 id。
 *
 * details 是 unknown（形状由工具自己声明），这里只认「对象 + childSessionId 是非空字符串」
 * 这一种。取不到就说明这次调用不承载子会话（绝大多数字工具都是），返回 undefined 让
 * 调用方按普通工具 part 处理。
 */
export function childSessionIdFromDetails(details: unknown): string | undefined {
  if (typeof details !== "object" || details === null) return undefined;
  if (!("childSessionId" in details)) return undefined;
  const { childSessionId } = details;
  return typeof childSessionId === "string" && childSessionId !== "" ? childSessionId : undefined;
}

/**
 * 子会话转录 → 工具调用 part 上的嵌套消息。
 *
 * parentId 取**派发这次调用的 toolCallId**（即 part 自己的 id），不是某条子消息的 id：
 * 嵌套里的每一件东西都属于「这次调用」，用子消息 id 会让同一次调用的多个分支各自
 * 认一个父。子消息先走同一套映射转成 ThreadMessageLike，再用 fromThreadMessageLike
 * 归一化成库真正要的 ThreadMessage —— 它只接受已归一化的线程消息，把 Like 直接塞进
 * messages 会在下游的树遍历里被当成形状不对的东西。Task 套 Task 时 resolver 继续下传。
 */
function toNestedMessages(
  part: Extract<ChatPart, { type: "tool-call" }>,
  resolveChild: ChildMessageResolver,
): ThreadMessage[] | undefined {
  const childSessionId = childSessionIdFromDetails(part.details);
  if (childSessionId === undefined) return undefined;
  const childMessages = resolveChild(childSessionId);
  if (childMessages === undefined || childMessages.length === 0) return undefined;
  return childMessages.map((child) =>
    fromThreadMessageLike(toThreadMessage(child, resolveChild), child.id, CHILD_FALLBACK_STATUS),
  );
}

/** ChatMessage 状态 → MessageStatus（三态映射，编译期校验真实取值） */
function toMessageStatus(message: ChatMessage): MessageStatus {
  switch (message.status) {
    case "streaming":
      return { type: "running" };
    case "error":
      return {
        type: "incomplete",
        reason: "error",
        ...(message.error !== undefined ? { error: message.error } : {}),
      };
    case "complete":
      return { type: "complete", reason: "stop" };
  }
}

/** 提取用户发送的纯文本（拼接所有 text part，忽略其他类型） */
export function appendMessageToText(message: AppendMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

/**
 * 附件不在 `message.content` 里 —— 它在 `message.attachments`。
 *
 * 提取逻辑见 attachment-payload.ts 的 appendMessageToAttachments。这里留一句指路，
 * 因为**这正是那次「图片从来没发出去」的根因**：`content` 里只有文本，
 * 库把附件放在与它并列的另一个字段上。
 */
