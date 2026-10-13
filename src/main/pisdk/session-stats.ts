/**
 * 会话级统计折叠：纯函数增量维护 turn/step 计数、LLM/工具耗时、TTFT、解码速度。
 *
 * 对标 DSH 的 dsh-session-stats 投影（sessionStatsProjectionDefinition），
 * 从 pi harness 事件流增量折叠；折叠结果按会话落盘（见 runtime 的 persistUsage），
 * 重启后打开旧会话直接读回，不重放事件。
 *
 * 因 pi 的 HarnessEvent 不带统一 time 字段，时间由调用方在 handler 中用 Date.now() 传入。
 */

import { normalizeContext, type TSchema } from "@earendil-works/pi-ai";
import { estimateContextTokens, estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import type { ContextBreakdown, SessionStats } from "@/shared/contracts/session";

/**
 * 工具定义段的 token 估算：**直接用内核的口径**，不再自算。
 *
 * 为什么不能自算（实测过）：内核把它算在 system 消息的 `toolsAdded` 上，
 * 走的是 `estimateTextTokens(JSON.stringify(tools))` —— 含整个数组的 JSON 外壳与键名。
 * 本仓早先是「逐个工具拼 name+description+schema 再除以 4」，同一份输入实测
 * **71 vs 内核 93（低估约 24%）**。这个差值会全额转嫁到「对话消息」段
 *（`deriveContextBreakdown` 是 `压力 − 系统 − 工具` 倒推的），于是上下文环的三段占比是错的。
 *
 * 实现上绕了一步 `normalizeContext`：内核的 tools 估算没有单独导出，但它会在
 * 「首条 system 消息」上算 —— 传空 messages + tools，得到的就是纯工具段。
 * 这样内核改了公式我们自动跟上，而不是再抄一份。
 */
export function estimateToolsTokens(
  tools: readonly { name: string; description?: string; parameters?: unknown }[],
): number {
  if (tools.length === 0) return 0;
  return estimateContextTokens(
    normalizeContext({
      messages: [],
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        // 缺 schema 的工具按「空对象 schema」计入：内核序列化时同样会给它一个 JSON 外壳
        parameters: (tool.parameters ?? { type: "object", properties: {} }) as TSchema,
      })),
    }),
  ).tokens;
}

/** 文本段估算：内核口径（`ceil(len/3.5)`，空串为 0；1.2.0 起每 token 3.5 字符） */
export { estimateTextTokens as estimateTokens };

/**
 * 折叠内部状态：在视图基础上增加 in-flight 边界。
 */
export interface SessionStatsState extends SessionStats {
  /** 当前打开的 step（一次 message_start → message_end 为一步） */
  openStep: {
    messageId: string;
    startTime: number;
    firstTokenTime: number | null;
  } | null;
  /** 上一个 turn 的 turnId，用于去重计数 */
  lastTurnId: string | null;
  /** 正在等 tool_end 的调用, keyed by toolCallId */
  pendingCalls: Record<string, number>;
}

/** 初始值 */
export function initSessionStatsState(): SessionStatsState {
  return {
    turns: 0,
    steps: 0,
    llmMs: 0,
    toolMs: 0,
    ttftMs: 0,
    ttftSteps: 0,
    decodeMs: 0,
    decodeTokens: 0,
    openStep: null,
    lastTurnId: null,
    pendingCalls: {},
  };
}

/** 从状态提取视图 */
export function sessionStatsView(state: SessionStatsState): SessionStats {
  return {
    turns: state.turns,
    steps: state.steps,
    llmMs: state.llmMs,
    toolMs: state.toolMs,
    ttftMs: state.ttftMs,
    ttftSteps: state.ttftSteps,
    decodeMs: state.decodeMs,
    decodeTokens: state.decodeTokens,
  };
}

// ---- 纯增量事件处理 ----

/** assistant 消息开始计时 */
export function onMessageStart(
  state: SessionStatsState,
  messageId: string,
  now: number,
): SessionStatsState {
  // 防御：前一个 step 未正常关闭就跳过旧 step、打开新的
  return {
    ...state,
    openStep: { messageId, startTime: now, firstTokenTime: null },
  };
}

/**
 * assistant 消息的第一个 delta 到达，记录 firstTokenTime。
 *
 * 只有「当前打开的 step 是这条消息、且还没记过」才写入；其余情况原样返回，
 * 因此可以每个 delta 都无脑调用。
 */
export function onFirstToken(
  state: SessionStatsState,
  messageId: string,
  now: number,
): SessionStatsState {
  const openStep = state.openStep;
  if (openStep === null) return state;
  if (openStep.messageId !== messageId) return state;
  if (openStep.firstTokenTime !== null) return state;
  return {
    ...state,
    openStep: { ...openStep, firstTokenTime: now },
  };
}

/** assistant 消息结束，折叠 llmMs/ttftMs/decodeMs/decodeTokens/steps */
export function onMessageEnd(
  state: SessionStatsState,
  messageId: string,
  now: number,
  outputTokens: number,
): SessionStatsState {
  const openStep = state.openStep;
  if (openStep === null || openStep.messageId !== messageId) return state;

  const llmMs = Math.max(0, now - openStep.startTime);
  const next: SessionStatsState = {
    ...state,
    steps: state.steps + 1,
    llmMs: state.llmMs + llmMs,
    openStep: null,
  };

  const firstTokenTime = openStep.firstTokenTime;
  if (firstTokenTime !== null) {
    const ttft = Math.max(0, firstTokenTime - openStep.startTime);
    next.ttftMs += ttft;
    next.ttftSteps += 1;

    if (outputTokens > 0) {
      next.decodeMs += Math.max(0, now - firstTokenTime);
      next.decodeTokens += outputTokens;
    }
  }

  return next;
}

/** turn 开始。同 turnId 只计一次轮次（对应 DSH step/end 的 turn 判重） */
export function onTurnStart(state: SessionStatsState, turnId: string): SessionStatsState {
  if (state.lastTurnId === turnId) return state;
  return {
    ...state,
    turns: state.turns + 1,
    lastTurnId: turnId,
  };
}

/** tool 调用开始 */
export function onToolStart(
  state: SessionStatsState,
  toolCallId: string,
  now: number,
): SessionStatsState {
  if (Object.hasOwn(state.pendingCalls, toolCallId)) {
    return state;
  }
  return {
    ...state,
    pendingCalls: {
      ...state.pendingCalls,
      [toolCallId]: now,
    },
  };
}

/** tool 调用结束 */
export function onToolEnd(
  state: SessionStatsState,
  toolCallId: string,
  now: number,
): SessionStatsState {
  const dispatched = state.pendingCalls[toolCallId];
  if (dispatched === undefined) return state;

  const toolMs = Math.max(0, now - dispatched);
  const pendingCalls = { ...state.pendingCalls };
  delete pendingCalls[toolCallId];

  return {
    ...state,
    toolMs: state.toolMs + toolMs,
    pendingCalls,
  };
}

/** run 结束，清理 pending calls */
export function onRunEnd(state: SessionStatsState): SessionStatsState {
  const hasPending = Object.keys(state.pendingCalls).length > 0;
  return {
    ...state,
    ...(hasPending ? { pendingCalls: {} } : {}),
  };
}

// ---- 上下文分解 ----

/**
 * 从一次请求的 usage 样本推导三段分解。
 *
 * 系统提示词与工具定义是**估算值**（构建请求时按字符数折算），
 * 对话消息按「压力总量 − 系统 − 工具」倒推，不足时钳到 0。
 * 压力按提示侧计费口径：未缓存输入 + 缓存读取 + 缓存写入（与 DSH
 * token-meter 的 pressureFrom 一致）。
 */
export function deriveContextBreakdown(
  breakdown: Omit<ContextBreakdown, "messageTokens">,
  usage: { inputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number },
): ContextBreakdown {
  const pressure = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  return {
    systemTokens: breakdown.systemTokens,
    toolsTokens: breakdown.toolsTokens,
    messageTokens: Math.max(0, pressure - breakdown.systemTokens - breakdown.toolsTokens),
  };
}
