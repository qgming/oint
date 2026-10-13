/**
 * 会话种类。
 *
 * 左侧栏只列 `chat`：`subagent` 是**从属会话**，它的价值在「关联到发起它的主会话」，
 * 而不是在会话列表里占一行 —— 子智能体的一次运行所承载的转录（见 shared/contracts/subagent.ts）
 * 不进左侧栏。
 *
 * 缺省（undefined）一律按 `chat` 处理：旧索引里没有这个字段。
 */
export type SessionKind = "chat" | "subagent";

/** 只有这个种类的会话会出现在左侧栏 */
export const VISIBLE_SESSION_KIND: SessionKind = "chat";

/** 该种类的会话是否应当从左侧栏列表里隐藏 */
export function isHiddenSessionKind(kind: SessionKind | undefined): boolean {
  return kind !== undefined && kind !== VISIBLE_SESSION_KIND;
}

/**
 * 新建会话的入参。
 *
 * 从属会话（subagent）必须同时带上归属信息，否则「点开子智能体组件跳到它的记录」
 * 就只能靠再扫一遍全部会话来找 —— 关联关系必须在写入时就固定下来。
 */
export interface SessionCreateOptions {
  cwd?: string;
  title?: string;
  kind?: SessionKind;
  /** 发起它的主会话 id（subagent 用） */
  parentSessionId?: string;
  /** 子智能体运行时：派发它的那次 Task 工具调用 id */
  parentToolCallId?: string;
  /** 子智能体运行时：子智能体名 */
  agentName?: string;
  /** 子智能体运行时：运行 id（与 parentToolCallId 相同，冗余一份便于按会话查） */
  delegationId?: string;
}

import type { AttachmentPart } from "./attachment";
import type { AgentMode, ModelRef } from "./common";

export interface SessionSummary {
  id: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
  cwd: string;
  /** 会话种类；缺省按 "chat"。从属会话（subagent）不出现在左侧栏 */
  kind?: SessionKind;
  /** 发起它的主会话 id（kind 为从属会话时有效，等价于 kind !== "chat"） */
  parentSessionId?: string;
  /** 子智能体运行：派发它的那次 Task 工具调用 id 与子智能体名 */
  parentToolCallId?: string;
  agentName?: string;
  archived: boolean;
  /** 置顶：置顶的会话只出现在侧栏「置顶」分组，不再出现在项目/最近分组 */
  pinned: boolean;
  messageCount: number;
  /**
   * 该会话自己指定的模型；null = 跟随设置里的默认模型。
   *
   * 与 cwd 同一个模式：会话级选择优先，没有就回落到全局默认。持久化在会话索引里，
   * 所以重启后仍然生效。
   */
  model: ModelRef | null;
  /**
   * 该会话自己指定的智能体模式；null / 缺省 = 跟随设置里的默认模式。
   *
   * 与 model 同一个模式（会话级选择优先、持久化在会话索引里、重启后仍生效），
   * 理由也相同：模式改的是「我在跟谁说话」，是**这个会话**的属性；
   * 而 permissionMode 是「我多信任它」的全局信任级别，两者不该混。
   *
   * **可选**是刻意的（与 `kind` / `parentSessionId` 同级）：升级前建的会话索引里
   * 没有这个键，读出来是 undefined —— 语义就是「没绑定过，跟随默认」。
   * 写成必填会逼所有旧数据与测试夹具都伪造一个值，而那个值本来就有明确缺省。
   */
  agentMode?: AgentMode | null;
}

/**
 * 切换会话模式的失败原因。
 *
 * 模式偏好可在运行中保存；系统提示和执行策略在下一次独立运行开始时一起生效。
 * 当前运行固定使用其持久化的模式，防止从计划模式切换时放宽已在执行的工具限制。
 * 若偏好已改变，当前运行期间的追加输入需等运行结束后重发。
 *
 * 这一对类型保留下来（而不是把 IPC 返回值改成 void），是为了让调用方的形状不变、
 * 且将来若真的出现失败场景（例如会话已被删除）时不必再改一遍双端契约。
 * 用 `never` 表达「现在不可能失败」比删掉整个联合类型更好：
 * 调用方的 `if (!result.ok)` 分支将来能直接复用，而不必重新推导。
 */
export type SessionModeFailure = never;

/** 恒为 `{ ok: true }`；见 SessionModeFailure 的说明 */
export type SetSessionModeResult = { ok: true } | { ok: false; reason: SessionModeFailure };

/** 切换会话模型失败的原因：界面据此给出具体说明，而不是笼统的「失败」 */
export type SessionModelFailure =
  /** 正在运行：中途换模型会让同一段对话里的工具调用/思考历史跨供应商，先停下再换 */
  | "running"
  /** 目标模型在当前设置里不存在（服务被删、模型被删，或压根没配） */
  | "no-model";

export type SetSessionModelResult = { ok: true } | { ok: false; reason: SessionModelFailure };

export interface TextPart {
  type: "text";
  text: string;
}

export interface ReasoningPart {
  type: "reasoning";
  text: string;
}

export interface ToolCallPart {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  /** 流式期间可能尚未解析完成，保留原始文本；args 为解析成功后的结果 */
  argsText: string;
  args?: unknown;
  result?: unknown;
  /**
   * 运行期间工具流式产出的**累计输出**（内核 `tool_update` 转发的最近一份快照）。
   *
   * 只用来在「还在跑」的时候给用户看一眼进展 —— 长命令（装依赖、构建、跑测试）没有它
   * 就是一张转圈的卡片，用户无从判断是在干活还是卡住了。
   *
   * 三点约定：
   * - **不是完整输出**：内核的 shell 捕获按 tail 保留，超出上限后头部会被丢掉；
   * - **只在内存里**：它不来自会话条目，所以落盘的历史里没有它（回读时为 undefined）；
   * - 结束后由 `result` 接管，渲染层只在 `status === "running"` 时展示。
   */
  partialOutput?: string;
  /** 工具自己声明的结构化详情（如 edit 的 diff/patch）；形状由工具决定，渲染层按工具名取用 */
  details?: unknown;
  /**
   * 工具产出的**图片本体**（界面用）：目前只有 `browser_screenshot` 会带。
   *
   * 与 read_image 的分工必须说清，否则两条路会被混成一条：
   *   · read_image 的图**不在这里** —— 它给一个 path，界面展开时用 `files.readImage`
   *     现取（见 tool-presentation.ts 的 ImageDetailData）。那是最省内存的一条路。
   *   · 截图没有可回读的路径：它只存在于这次工具结果里，而结果文本（detail 面板要显示的
   *     读数）盖住了 content 里的 image 块。所以图片只能随 part 走一趟。
   *
   * **不落盘**：这里的数据只活在渲染层的内存里（主进程侧同样只写进内存中的 part），
   * 会话库里的图片来自 pi 的 toolResult 条目本身 —— 历史回读时由 message-mapper
   * 从那条消息的 content 里重新取出，所以刷新窗口、重开应用之后它照样在。
   */
  images?: ToolPartImage[];
  isError?: boolean;
  status: "running" | "done" | "error" | "pending-approval" | "denied";
  /**
   * 内核测量的单次执行耗时（pi-durable 1.2.0 起随 toolResult 条目落盘）。
   * 界面的「运行中耗时」由 run 现算；这里是历史回读（run 起止缺失）时的权威回退。
   */
  durationMs?: number;
}

/** 工具结果里的图片块 → 界面可直接渲染的形态（与 ImagePart 同形，但不占消息的 parts 槽位） */
export interface ToolPartImage {
  mimeType: string;
  /** `data:<mimeType>;base64,...`；CSP 只放行 data:/blob:，file:// 会被拦掉 */
  dataUrl: string;
}

export interface ImagePart {
  type: "image";
  mimeType: string;
  dataUrl: string;
}

/**
 * 用户消息里的附件。
 *
 * 与 `ImagePart` 并存而不是取代它：`ImagePart` 是**历史**（旧会话里用户贴的图只有裸
 * image 块，没有信封），回读时必须继续认它。新的发送路径一律产出 `AttachmentPart`，
 * 因为图片只是附件的一种 —— 视频、文本、PDF 都需要「名字 + 路径 + 读数」这一层。
 *
 * 图片/视频的缩略图走 `thumbnail`：它是从落盘那份的第一个内容块重建的，所以刷新窗口、
 * 重开应用之后照样在，不需要另存一份。
 */
export type { AttachmentPart };

export type ChatPart = TextPart | ReasoningPart | ToolCallPart | ImagePart | AttachmentPart;

export interface ChatMessageUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  totalTokens: number;
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * 会话级统计视图：全量 turn/step 计数与 LLM/工具/首 token/解码耗时。
 * 对标 DSH 的 sessionStats 投影（dsh-session-stats）。
 */
export interface SessionStats {
  turns: number;
  steps: number;
  llmMs: number;
  toolMs: number;
  ttftMs: number;
  ttftSteps: number;
  decodeMs: number;
  decodeTokens: number;
}

/** 会话级 Token 用量合计：全量全品类的累加桶。对标 DSH 的 tokenUsage 投影。 */
export interface SessionTokenUsage {
  uncachedInputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * 上下文占用分解：系统提示词 / 工具定义 / 对话消息三段的启发式 token 估算。
 * 对标 DSH 的 contextBreakdown 投影（dsh-token-meter）。
 */
export interface ContextBreakdown {
  systemTokens: number;
  toolsTokens: number;
  messageTokens: number;
}

/**
 * 随会话持久化的用量快照：统计 + Token 合计 + 上下文分解。
 *
 * 为什么整体持久化而不是运行中重算：统计的耗时字段（LLM/TTFT/解码）依赖真实事件时间戳，
 * 磁盘日志里没有，事后无法重建 —— 不落盘就只能在「进程内跑过的那一轮」里显示，
 * 重启或打开历史会话时底部永远是空的。
 */
export interface SessionUsageRecord {
  stats: SessionStats;
  tokenUsage: SessionTokenUsage;
  breakdown: ContextBreakdown;
}

export interface ChatMessage {
  id: string;
  /** 关联的会话存储条目 id；本地临时消息可为空 */
  entryId?: string;
  /** Native model-generation identity shared by its failed attempts and final response. */
  generationId?: string;
  /**
   * pi 条目树里的父条目 id。渲染层据此把它交给 assistant-ui 的分支仓库，
   * 同一父条目下的多条助手回复即成为可切换的分支（重新生成会产生这种兄弟关系）。
   */
  parentId?: string | null;
  role: "user" | "assistant";
  /**
   * 这条消息是谁「说」的：用户亲手发的，还是系统内部产生的（目前只有后台作业的结束通知）。
   *
   * 为什么必须与 role 分开：`role` 决定**模型怎么读**（作业通知确实要以 user 身份进上下文，
   * 模型下一轮才看得见），而 `origin` 决定**界面怎么画** —— 作业通知不是用户说的话，
   * 画成普通用户气泡等于替用户发言（他会看到一句自己从没打过的话）。
   * 缺省（undefined）按 "user" 处理：历史消息与所有既有路径都不带这个字段。
   *
   * 跨重启存活：值来自 pi 的 custom 消息（customType 见 main/pisdk/runtime.ts 的
   * SYNTHETIC_MESSAGE_TYPE），历史回读时由 message-mapper 重新解析，因此不依赖内存。
   */
  origin?: "user" | "system";
  createdAt: number;
  parts: ChatPart[];
  status: "complete" | "streaming" | "error";
  usage?: ChatMessageUsage;
  /** 内核测量的本次回复耗时（AssistantMessage.durationMs；延迟取回的结果没有这个值） */
  durationMs?: number;
  error?: string;
}

/** 会话消息分页结果：nextCursor 存在时表示还能继续向上加载更早消息 */
export interface SessionMessagesPage {
  messages: ChatMessage[];
  compactionSummaries: string[];
  nextCursor?: number;
  /**
   * 该会话持久化的用量快照（统计 / Token 合计 / 上下文分解）。
   *
   * 搭在分页结果里一起返回，而不是单开一条 IPC：渲染层打开会话时必然要拉消息，
   * 底栏需要的数据同源同刻 —— 分两次请求只会多一条可能失败的路径。
   * 没有记录（新会话 / 升级前的旧会话）时缺省，渲染层显示空状态。
   */
  usage?: SessionUsageRecord;
}

export interface LoadSessionMessagesOptions {
  limit?: number;
  beforeSeq?: number;
}
