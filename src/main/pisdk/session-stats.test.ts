import { describe, expect, it } from "vitest";
import {
  deriveContextBreakdown,
  estimateTokens,
  estimateToolsTokens,
  initSessionStatsState,
  onFirstToken,
  onMessageEnd,
  onMessageStart,
  onRunEnd,
  onToolEnd,
  onToolStart,
  onTurnStart,
  sessionStatsView,
} from "./session-stats";

/**
 * 会话统计折叠的单测：覆盖 DSH sessionStats 投影对应的每一条时间线
 * （LLM 耗时 / TTFT / 解码速度 / 工具耗时 / 轮次与步数计数）。
 */
describe("session-stats 折叠", () => {
  it("一个完整 step：llmMs 与 steps 各记一次", () => {
    let state = initSessionStatsState();
    state = onMessageStart(state, "m1", 1_000);
    state = onMessageEnd(state, "m1", 4_000, 100);

    const view = sessionStatsView(state);
    expect(view.steps).toBe(1);
    expect(view.llmMs).toBe(3_000);
    // 没有首 token 记录 ⇒ 不计 TTFT / 解码
    expect(view.ttftSteps).toBe(0);
    expect(view.decodeTokens).toBe(0);
  });

  it("TTFT 与解码速度：首 token 之后到消息结束算解码耗时", () => {
    let state = initSessionStatsState();
    state = onMessageStart(state, "m1", 1_000);
    state = onFirstToken(state, "m1", 1_500);
    // 重复记录不生效（只有第一个 delta 才算首 token）
    const afterSecond = onFirstToken(state, "m1", 1_800);
    expect(afterSecond).toBe(state);
    state = onMessageEnd(afterSecond, "m1", 3_500, 200);

    const view = sessionStatsView(state);
    expect(view.ttftMs).toBe(500);
    expect(view.ttftSteps).toBe(1);
    expect(view.decodeMs).toBe(2_000);
    expect(view.decodeTokens).toBe(200);
    // 200 token / 2s = 100 tok/s
    expect(view.decodeTokens / (view.decodeMs / 1_000)).toBe(100);
    expect(view.llmMs).toBe(2_500);
  });

  it("多个 step 累加，steps 与各耗时逐条相加", () => {
    let state = initSessionStatsState();
    state = onMessageStart(state, "m1", 0);
    state = onFirstToken(state, "m1", 100);
    state = onMessageEnd(state, "m1", 1_100, 50);
    state = onMessageStart(state, "m2", 2_000);
    state = onFirstToken(state, "m2", 2_400);
    state = onMessageEnd(state, "m2", 3_400, 80);

    const view = sessionStatsView(state);
    expect(view.steps).toBe(2);
    expect(view.llmMs).toBe(1_100 + 1_400);
    expect(view.ttftMs).toBe(100 + 400);
    expect(view.ttftSteps).toBe(2);
    expect(view.decodeTokens).toBe(50 + 80);
  });

  it("message_end 没有对应的 message_start 时忽略（不虚增步数）", () => {
    const state = initSessionStatsState();
    const next = onMessageEnd(state, "ghost", 5_000, 10);
    expect(next).toBe(state);
    expect(sessionStatsView(next).steps).toBe(0);
  });

  it("首 token 落在别的消息上不算数", () => {
    let state = initSessionStatsState();
    state = onMessageStart(state, "m1", 1_000);
    const afterOther = onFirstToken(state, "m2", 1_200);
    expect(afterOther).toBe(state);
    state = onMessageEnd(afterOther, "m1", 2_000, 10);
    expect(sessionStatsView(state).ttftSteps).toBe(0);
  });

  it("工具耗时：tool_start → tool_end 配对累加", () => {
    let state = initSessionStatsState();
    state = onToolStart(state, "call-1", 1_000);
    state = onToolEnd(state, "call-1", 1_250);
    expect(sessionStatsView(state).toolMs).toBe(250);

    // 第二个调用继续累加
    state = onToolStart(state, "call-2", 2_000);
    state = onToolEnd(state, "call-2", 2_500);
    expect(sessionStatsView(state).toolMs).toBe(250 + 500);

    // 没有 start 的 end 忽略（历史遗留 / 重启后的事件）
    const after = onToolEnd(state, "call-x", 9_999);
    expect(after).toBe(state);
  });

  it("同一个 toolCallId 只记一次 start", () => {
    let state = initSessionStatsState();
    state = onToolStart(state, "call-1", 1_000);
    const again = onToolStart(state, "call-1", 1_500);
    expect(again).toBe(state);
    state = onToolEnd(again, "call-1", 2_000);
    expect(sessionStatsView(state).toolMs).toBe(1_000);
  });

  it("run 结束清理未配对的 pending 调用（它们不再计入耗时）", () => {
    let state = initSessionStatsState();
    state = onToolStart(state, "call-1", 1_000);
    state = onRunEnd(state);
    state = onToolEnd(state, "call-1", 5_000);
    expect(sessionStatsView(state).toolMs).toBe(0);
  });

  it("轮次按 turnId 去重：同一轮内多条消息只计一轮", () => {
    let state = initSessionStatsState();
    state = onTurnStart(state, "turn-1");
    state = onTurnStart(state, "turn-1");
    expect(sessionStatsView(state).turns).toBe(1);
    state = onTurnStart(state, "turn-2");
    expect(sessionStatsView(state).turns).toBe(2);
  });

  it("时间倒退（时钟回拨）钳到 0，不产生负耗时", () => {
    let state = initSessionStatsState();
    state = onMessageStart(state, "m1", 5_000);
    state = onFirstToken(state, "m1", 4_000);
    state = onMessageEnd(state, "m1", 3_000, 10);
    const view = sessionStatsView(state);
    expect(view.llmMs).toBe(0);
    expect(view.ttftMs).toBe(0);
    expect(view.decodeMs).toBe(0);
  });

  it("视图是状态的真子集（不含 openStep / pendingCalls 等内部字段）", () => {
    let state = initSessionStatsState();
    state = onMessageStart(state, "m1", 1_000);
    const view = sessionStatsView(state);
    expect(Object.keys(view).sort()).toEqual(
      [
        "decodeMs",
        "decodeTokens",
        "llmMs",
        "steps",
        "toolMs",
        "ttftMs",
        "ttftSteps",
        "turns",
      ].sort(),
    );
  });
});

describe("上下文分解", () => {
  it("文本估算与内核同口径：ceil(len/3.5)，空串为 0", () => {
    // 这几条钉的是「不再自算」：早先本仓用 max(1, round(len/4))，与内核的 ceil 在边界上差 1，
    // 且把空串算成 1（内核算 0）。1.2.0 起内核把每 token 字符数从 4 收紧到 3.5，
    // 本仓直接委托 estimateTextTokens，这里跟着内核口径钉边界值。
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(2);
    expect(estimateTokens("a".repeat(400))).toBe(115);
    // ceil 而非 round：5 字符是 2 个 token，不是 1
    expect(estimateTokens("abcde")).toBe(2);
  });

  it("工具定义估算：空清单为 0，随描述与 schema 增长", () => {
    expect(estimateToolsTokens([])).toBe(0);
    const bare = estimateToolsTokens([{ name: "read", description: "读文件" }]);
    const rich = estimateToolsTokens([
      { name: "read", description: "读文件", parameters: { type: "object", properties: {} } },
    ]);
    expect(bare).toBeGreaterThan(0);
    expect(rich).toBeGreaterThanOrEqual(bare);
  });

  it("工具段按内核口径计入 JSON 外壳（不再逐字段拼文本）", () => {
    // 内核是把整个 tools 数组序列化后折算，所以同一份输入必然比
    // 「逐个工具拼 name+description+schema」的旧口径大 —— 旧口径实测低估约 24%
    const tools = [{ name: "read", description: "读文件" }];
    const serialized = JSON.stringify([
      { name: "read", description: "读文件", parameters: { type: "object", properties: {} } },
    ]);
    // 1.2.0：内核的每 token 字符数为 3.5（原先 4）
    expect(estimateToolsTokens(tools)).toBe(Math.ceil(serialized.length / 3.5));
  });

  it("schema 无法序列化时不抛错", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => estimateToolsTokens([{ name: "x", parameters: cyclic }])).not.toThrow();
  });

  it("对话消息按压力倒推：压力 − 系统 − 工具", () => {
    const breakdown = deriveContextBreakdown(
      { systemTokens: 1_800, toolsTokens: 7_100 },
      { inputTokens: 63_800, cacheReadTokens: 10_000, cacheWriteTokens: 1_000 },
    );
    expect(breakdown).toEqual({
      systemTokens: 1_800,
      toolsTokens: 7_100,
      messageTokens: 63_800 + 10_000 + 1_000 - 1_800 - 7_100,
    });
  });

  it("压力小于固定项时消息段钳到 0", () => {
    const breakdown = deriveContextBreakdown(
      { systemTokens: 5_000, toolsTokens: 5_000 },
      { inputTokens: 100 },
    );
    expect(breakdown.messageTokens).toBe(0);
  });

  it("缓存桶缺失时按 0 计（不是 NaN）", () => {
    const breakdown = deriveContextBreakdown(
      { systemTokens: 100, toolsTokens: 100 },
      { inputTokens: 1_000 },
    );
    expect(breakdown.messageTokens).toBe(800);
  });
});
