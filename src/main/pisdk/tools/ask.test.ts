import { createToolTestApi } from "@/main/pisdk/tools/tool-test-api";
// ask_user 工具的行为测试：schema 边界、三种 outcome 的文本与 details 形状。
// 提问服务用假实现（记录请求、按预置结论立即结算），不挂真挂起、不碰定时器。

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import type { AskAnswerItem, AskQuestion, AskResponse } from "@/shared/contracts/interaction";
import type { AskInput, InteractionService } from "../interactions";
import { ASK_TOOL_NAME, type AskToolParams, askSchema, createAskTool } from "./ask";

/** 假服务对外声称的等待上限：工具要把它写进给模型的超时提示里 */
const TIMEOUT_MS = 60_000;

/** 假提问服务：记录每次 request 的入参，按调用方给的结论立即结算 */
function fakeInteractions(reply: (input: AskInput) => AskResponse): {
  service: InteractionService;
  requests: AskInput[];
} {
  const requests: AskInput[] = [];
  const service: InteractionService = {
    request: (input) => {
      requests.push(input);
      return Promise.resolve(reply(input));
    },
    taskDefinitions: [],
    attach: async () => () => {},
    respond: async () => {},
    pending: async () => [],
    cancelSession: async () => {},
    timeoutMs: () => TIMEOUT_MS,
  };
  return { service, requests };
}

function question(id: string, header: string, text: string, options?: string[]): AskQuestion {
  return { id, header, question: text, ...(options === undefined ? {} : { options }) };
}

const DB_QUESTION = question("q1", "数据库", "用哪个数据库？", ["PostgreSQL", "SQLite"]);
const STYLE_QUESTION = question("q2", "文案", "文档语气？");
const QUESTIONS = [DB_QUESTION, STYLE_QUESTION];

/** ask 不读 toolContext（只走提问服务），最小替身即可 */

type AskTool = ReturnType<typeof createAskTool>;
type AskToolResult = Awaited<ReturnType<AskTool["execute"]>>;

function runAsk(
  tool: AskTool,
  params: AskToolParams,
  toolCallId = "call-ask",
): Promise<AskToolResult> {
  return tool.execute(params, createToolTestApi({ callId: toolCallId }), BACKGROUND_CONTEXT);
}

function textOf(outcome: AskToolResult): string {
  return (outcome.output ?? [])
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n");
}

describe("ask_user", () => {
  it("工具名取自常量；schema 只收 1~4 道题（0 题 / 5 题被拒）", () => {
    const tool = createAskTool({
      sessionId: "s1",
      interactions: fakeInteractions(() => ({ id: "r", outcome: "answered", answers: [] })).service,
    });
    expect(tool.name).toBe(ASK_TOOL_NAME);

    const five = [
      DB_QUESTION,
      STYLE_QUESTION,
      question("q3", "范围", "改哪些模块？"),
      question("q4", "依赖", "能加依赖吗？"),
      question("q5", "第五题", "会被拒吗？"),
    ];
    expect(Value.Check(askSchema, { questions: [DB_QUESTION] })).toBe(true);
    expect(Value.Check(askSchema, { questions: QUESTIONS })).toBe(true);
    expect(Value.Check(askSchema, { questions: five.slice(0, 4) })).toBe(true);
    expect(Value.Check(askSchema, { questions: [] })).toBe(false);
    expect(Value.Check(askSchema, { questions: five })).toBe(false);
  });

  it("0 题 / 5 题即使绕过 schema 也不提问，返回错误文本", async () => {
    const { service, requests } = fakeInteractions(() => ({
      id: "r",
      outcome: "answered",
      answers: [],
    }));
    const tool = createAskTool({ sessionId: "s1", interactions: service });

    const zero = await runAsk(tool, { questions: [] });
    expect(textOf(zero)).toContain("Error: ask_user 需要 1~4 道题（收到 0 道）");
    expect(zero.details).toEqual({ outcome: "unanswered", questions: [], answers: [] });

    const fiveTodo = [
      DB_QUESTION,
      STYLE_QUESTION,
      question("q3", "范围", "改哪些模块？"),
      question("q4", "依赖", "能加依赖吗？"),
      question("q5", "第五题", "会被拒吗？"),
    ];
    const five = await runAsk(tool, { questions: fiveTodo });
    expect(textOf(five)).toContain("（收到 5 道）");
    expect(requests).toHaveLength(0);
  });

  it("answered：按题序回选项与自由输入，details 原样带回问题与答案", async () => {
    const answers: AskAnswerItem[] = [
      { questionId: "q1", selected: ["PostgreSQL"], text: "顺手加迁移脚本" },
      { questionId: "q2", selected: [], text: "简洁一点" },
    ];
    const { service, requests } = fakeInteractions(() => ({
      id: "r1",
      outcome: "answered",
      answers,
    }));
    const tool = createAskTool({ sessionId: "s1", interactions: service });

    const outcome = await runAsk(tool, { questions: QUESTIONS }, "call-1");

    expect(outcome.details).toEqual({ outcome: "answered", questions: QUESTIONS, answers });
    // answers 是渲染层与日志都依赖的对外形状：每题只能有这三个字段
    expect(Object.keys(outcome.details?.answers[0] ?? {}).sort()).toEqual([
      "questionId",
      "selected",
      "text",
    ]);

    const text = textOf(outcome);
    expect(text).toContain("用户已回答（2/2 题）：");
    expect(text).toContain("- 数据库：用哪个数据库？ → 选定 PostgreSQL；自由输入：顺手加迁移脚本");
    expect(text).toContain("- 文案：文档语气？ → 自由输入：简洁一点");

    // 请求原样落到服务上：会话、工具调用 id 与题目都不能丢
    expect(requests).toMatchObject([
      { sessionId: "s1", toolCallId: "call-1", questions: QUESTIONS },
    ]);
  });

  it("answered：没作答的题按题序记「未作答」，计数与 details 对得上", async () => {
    const answers: AskAnswerItem[] = [{ questionId: "q1", selected: ["SQLite"] }];
    const { service } = fakeInteractions(() => ({ id: "r1", outcome: "answered", answers }));
    const tool = createAskTool({ sessionId: "s1", interactions: service });

    const outcome = await runAsk(tool, { questions: QUESTIONS }, "call-1");
    const text = textOf(outcome);
    expect(text).toContain("用户已回答（1/2 题）：");
    expect(text).toContain("- 数据库：用哪个数据库？ → 选定 SQLite");
    expect(text).toContain("- 文案：文档语气？ → 未作答");
    expect(outcome.details?.answers).toEqual(answers);
  });

  it("unanswered：给出超时秒数与保守继续的提示，details 记 unanswered", async () => {
    const { service } = fakeInteractions(() => ({
      id: "r2",
      outcome: "unanswered",
      answers: [],
      note: "等待超时（60 秒）未回应",
    }));
    const tool = createAskTool({ sessionId: "s1", interactions: service });

    const outcome = await runAsk(tool, { questions: QUESTIONS }, "call-2");
    const text = textOf(outcome);
    // 秒数来自服务的 timeoutMs()，工具不自己写死
    expect(text).toContain("用户未在 60 秒内回应");
    expect(text).toContain("不要重复提问");
    expect(outcome.details).toEqual({ outcome: "unanswered", questions: QUESTIONS, answers: [] });
  });

  it("cancelled：告知本轮运行已停止，details 记 cancelled", async () => {
    const { service } = fakeInteractions(() => ({
      id: "r3",
      outcome: "cancelled",
      answers: [],
      note: "运行已停止",
    }));
    const tool = createAskTool({ sessionId: "s1", interactions: service });

    const outcome = await runAsk(tool, { questions: QUESTIONS }, "call-3");
    expect(textOf(outcome)).toBe("本轮运行已停止，未获得用户回答。");
    expect(outcome.details).toEqual({ outcome: "cancelled", questions: QUESTIONS, answers: [] });
  });
});
