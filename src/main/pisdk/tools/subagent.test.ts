import { createToolTestApi } from "@/main/pisdk/tools/tool-test-api";
/**
 * 子智能体四个工具（Task / TaskWait / TaskList / TaskStop）的测试。
 *
 * 这里不碰 harness、Electron 与文件系统：createSubagentTools 的依赖整体注入，
 * 本文件钉住工具自己负责的那一层 ——
 * - 参数校验与失败回执（isError + 给模型看的文案）；
 * - 并发上限在工具侧直接拒绝（排队会让模型以为「已经派出去了」）；
 * - details 的形状（成功 = SubagentRun，其余 = { runs }，渲染层按它画卡片）；
 * - TaskWait 的超时语义：还没跑完是 running，不是失败。
 *
 * 运行管理器（pisdk/subagent-runner.ts）的真实行为不在本文件范围：这里只验证工具
 * 把请求原样交给它、并把返回的记录原样带出去。
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { describe, expect, it, vi } from "vitest";
import type { SubagentDefinition, SubagentRun } from "@/shared/contracts/subagent";
import { BUILTIN_SUBAGENTS } from "../subagent-catalog";
import {
  createSubagentTools,
  normalizeWhitelist,
  SUBAGENT_TOOL_NAMES,
  type SubagentStartRequest,
  type SubagentToolDeps,
} from "./subagent";

type SubagentTool = ReturnType<typeof createSubagentTools>[number];
type SubagentToolParams = Parameters<SubagentTool["execute"]>[0];
type SubagentToolResult = Awaited<ReturnType<SubagentTool["execute"]>>;

/** 工具不读 toolContext（父会话 id / cwd 都在 deps 里），空壳即可 */

/** 一个可用的子智能体定义（工具不再可配：拿到的是主代理同一批） */
function definition(name: string, patch: Partial<SubagentDefinition> = {}): SubagentDefinition {
  return {
    name,
    description: `${name} 的说明`,
    prompt: "你是子智能体，只做被派的那件事。",
    source: "builtin",
    ...patch,
  };
}

/** 一条运行记录：只填工具层会读的字段，其余用中性默认值 */
function makeRun(patch: Partial<SubagentRun> = {}): SubagentRun {
  return {
    delegationId: "d-1",
    sessionId: "s-parent",
    parentToolCallId: "d-1",
    childSessionId: "child-1",
    agentName: "scout",
    agentSource: "builtin",
    description: "调研重试逻辑",
    task: "看 src/retry.ts 的重试逻辑",
    status: "running",
    startedAt: 1_000,
    model: null,
    modelId: "svc/model-x",
    thinkingLevel: "medium",
    turns: 2,
    toolCalls: 3,
    ...patch,
  };
}

/** 一条上一进程留下来的、已经意外终止的运行：重派用例的起点 */
function interruptedRun(patch: Partial<SubagentRun> = {}): SubagentRun {
  return makeRun({
    delegationId: "d-old",
    parentToolCallId: "d-old",
    childSessionId: "child-old",
    agentName: "scout",
    description: "调研重试逻辑",
    task: "看 src/retry.ts 的重试逻辑",
    status: "interrupted",
    startedAt: 1_000,
    endedAt: 2_000,
    updatedAt: 2_000,
    turns: 3,
    toolCalls: 4,
    ...patch,
  });
}

/**
 * 可注入的完整 deps：每个用例只覆盖自己关心的那几个。
 *
 * `reserveSlot` 默认是**真的占位**（一个本地 Map），不是恒返回 ok 的桩：
 * 并发上限那几条用例正是靠「占位会被记住」才能测出同批并发时的真实行为，
 * 用一个永远放行的假实现会把要验的东西验成空的。
 */
function createDeps(overrides: Partial<SubagentToolDeps> = {}): SubagentToolDeps {
  return {
    sessionId: "s-parent",
    cwd: () => "C:/work",
    definitions: vi.fn(async () => [definition("scout"), definition("reporter")]),
    start: vi.fn(async (request: SubagentStartRequest) =>
      makeRun({
        delegationId: request.toolCallId,
        agentName: request.definition.name,
        agentSource: request.definition.source,
        description: request.description,
        task: request.task,
        ...(request.resumedFrom === undefined ? {} : { resumedFrom: request.resumedFrom }),
      }),
    ),
    wait: vi.fn(async () => [] as SubagentRun[]),
    list: vi.fn(async () => [] as SubagentRun[]),
    stop: vi.fn(async () => [] as SubagentRun[]),
    parentModelId: () => "svc/model-x",
    // 父会话真实拥有的工具名（白名单校验用）；含一个 MCP 工具名，证明校验不写死内置清单
    availableToolNames: () => [
      "read",
      "read_image",
      "grep",
      "glob",
      "write",
      "edit",
      "bash",
      "todo",
      "web_search",
      "web_fetch",
      "mcp__arxiv__call",
    ],
    ...overrides,
  };
}

/** 按名字调用一次工具；params 的校验交给 schema，这里只测 execute 的行为 */
async function invoke(
  deps: SubagentToolDeps,
  name: string,
  toolCallId: string,
  params: SubagentToolParams,
): Promise<SubagentToolResult> {
  const tool = createSubagentTools(deps).find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`工具不存在：${name}`);
  return tool.execute(params, createToolTestApi({ callId: toolCallId }), BACKGROUND_CONTEXT);
}

/** 回执的文本部分：可能是一段或多段，测试统一拼起来看 */
function resultText(result: SubagentToolResult): string {
  return (result.output ?? []).map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

/** 取第一次 start 的请求；没调用过直接抛错，避免断言拿到 undefined */
function firstStart(deps: SubagentToolDeps): SubagentStartRequest {
  const call = vi.mocked(deps.start).mock.calls.at(0);
  if (call === undefined) throw new Error("deps.start 未被调用");
  return call[0];
}

/** 取最后一次 start 的请求 */
function lastStart(deps: SubagentToolDeps): SubagentStartRequest {
  const call = vi.mocked(deps.start).mock.calls.at(-1);
  if (call === undefined) throw new Error("deps.start 未被调用");
  return call[0];
}

/**
 * 临时定义的工具白名单（**唯一**能收窄子智能体工具的地方）。
 *
 * 内置预设与用户 `.md` 定义没有这个字段：它们拿到的就是主代理同一批工具。
 * 白名单只由主代理在派发时给，因此校验必须**当次**做完并把可用清单回给它 ——
 * 写错一个名字就让一个空转的子智能体跑完再报「我什么也做不了」，代价高得多。
 */
describe("normalizeWhitelist（临时定义的工具白名单）", () => {
  const AVAILABLE = ["read", "write", "bash", "web_search", "mcp__arxiv__call"];

  it("未指定 = 不限制（返回不带 tools 的结果）", () => {
    expect(normalizeWhitelist(undefined, AVAILABLE)).toEqual({ ok: true });
    expect(normalizeWhitelist([], AVAILABLE)).toEqual({ ok: true });
  });

  it("合法清单原样通过（含 MCP 这类运行时才存在的工具名）", () => {
    expect(normalizeWhitelist(["read", "mcp__arxiv__call"], AVAILABLE)).toEqual({
      ok: true,
      tools: ["read", "mcp__arxiv__call"],
    });
  });

  it("去空白、去重、丢掉空串", () => {
    expect(normalizeWhitelist([" read ", "read", "", "  "], AVAILABLE)).toEqual({
      ok: true,
      tools: ["read"],
    });
  });

  it("不存在的工具名直接报错，并把可用清单回给模型", () => {
    const result = normalizeWhitelist(["read", "teleport"], AVAILABLE);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("应当失败");
    expect(result.reason).toContain("teleport");
    expect(result.reason).toContain("read, write, bash");
  });

  it("不可授权的工具名同样报错：Task 系列与 ask_user 不在可用清单里", () => {
    // 父会话注入的清单已经把这两个排除掉了，所以模型写它们时拿到的是同一条错误
    const result = normalizeWhitelist(["Task"], AVAILABLE);
    expect(result.ok).toBe(false);
  });
});

describe("Task", () => {
  /**
   * 名录**不再写死在 Task 的描述里** —— 那是同一事实的第二个来源，必然与系统提示漂移。
   *
   * 现在描述只指向系统提示里的 `<available_subagents>` 索引（内置 + 用户自定义都在那里，
   * 见 subagent-prompt.ts）。这条断言锁住的是「描述必须把模型指过去」，
   * 而不是「描述里必须列全」—— 后者是索引的职责，由 subagent-prompt.test.ts 覆盖。
   */
  it("描述指向系统提示里的子智能体索引，而不是自己抄一份名录", () => {
    const task = createSubagentTools(createDeps()).find(
      (candidate) => candidate.name === SUBAGENT_TOOL_NAMES.task,
    );

    expect(task?.description).toContain("<available_subagents>");
    // 抄一份名单的痕迹：任何一条内置定义的完整描述都不应出现在这里
    for (const builtin of BUILTIN_SUBAGENTS) {
      expect(task?.description).not.toContain(builtin.description);
    }
  });

  it("描述里给的 agent 示例是真实存在的内置名", () => {
    const task = createSubagentTools(createDeps()).find(
      (candidate) => candidate.name === SUBAGENT_TOOL_NAMES.task,
    );
    const names = BUILTIN_SUBAGENTS.map((def) => def.name);

    // 示例名必须真实存在：`scout` 那种不存在的名字会把模型引到一个派不出去的定义上
    expect(names).toContain("explorer");
    expect(task?.description).toContain("explorer");

    // 参数 schema 里的示例同样是真实名字（模型读的是这一份，不是描述那一份）
    const params = task?.parameters as
      | { properties?: Record<string, { description?: string }> }
      | undefined;
    expect(params?.properties?.agent?.description).toContain('"explorer"');
  });

  it("未知 agent 名：返回失败回执，并把可用的名字告诉模型", async () => {
    const deps = createDeps();

    const result = await invoke(deps, SUBAGENT_TOOL_NAMES.task, "call-1", {
      agent: "analyst",
      description: "分析重试逻辑",
      task: "读 src/retry.ts",
    });

    expect(result).toMatchObject({ isError: true });
    const text = resultText(result);
    expect(text).toContain("analyst");
    expect(text).toContain("scout");
    expect(text).toContain("reporter");
    expect(result.details).toEqual({ error: expect.stringContaining("analyst") });
    expect(vi.mocked(deps.start)).not.toHaveBeenCalled();
  });

  it("agent 与 definition 都没给：拒绝并说明有两条路可走", async () => {
    const deps = createDeps();

    const result = await invoke(deps, SUBAGENT_TOOL_NAMES.task, "call-1", {
      description: "没有指名",
      task: "做点事",
    });

    expect(result).toMatchObject({ isError: true });
    expect(resultText(result)).toContain("agent");
    expect(vi.mocked(deps.start)).not.toHaveBeenCalled();
  });

  it("临时定义：source=temp、model=null，未给禁用项即全部可用", async () => {
    const deps = createDeps();

    await invoke(deps, SUBAGENT_TOOL_NAMES.task, "call-2", {
      description: "临时子智能体跑一件事",
      task: "把 CHANGELOG 写出来",
      definition: { name: "My Temp Agent", description: "临时的", prompt: "你是临时子智能体。" },
    });

    const request = firstStart(deps);
    expect(request).toMatchObject({
      toolCallId: "call-2",
      description: "临时子智能体跑一件事",
      task: "把 CHANGELOG 写出来",
    });
    expect(request.definition).toMatchObject({
      name: "my-temp-agent", // 名字先规范化再当运行标签用
      source: "temp",
      model: null,
    });
    // 没给 tools = 不限制（临时子智能体拿到全部工具，与内置定义同款）
    expect(request.definition).not.toHaveProperty("tools");
    // 临时定义不查目录：目录里有没有同名定义都不影响这次派发
    expect(vi.mocked(deps.definitions)).not.toHaveBeenCalled();
  });

  it("临时定义带合法白名单：原样写进定义（运行时据此过滤工具）", async () => {
    const deps = createDeps();

    await invoke(deps, SUBAGENT_TOOL_NAMES.task, "call-3", {
      description: "带工具白名单",
      task: "只读地扫一遍",
      definition: {
        name: "temp-2",
        description: "临时的",
        prompt: "p",
        tools: ["read", "grep", "glob"],
      },
    });

    expect(lastStart(deps).definition.tools).toEqual(["read", "grep", "glob"]);
  });

  /**
   * 白名单里写了不存在的工具名 → **当次拒绝**，并把可用清单回给模型。
   *
   * 静默丢掉会让模型以为「我已经限制了工具」，而子智能体实际拿到的是别的组合；
   * 让它跑完再报「我什么也做不了」更贵。所以这里走 MCP 聚合工具同一套口径：报错 + 清单。
   */
  it("白名单里有不存在的工具名：拒绝这次派发，并给出可用清单", async () => {
    const deps = createDeps();

    const result = await invoke(deps, SUBAGENT_TOOL_NAMES.task, "call-4", {
      description: "带错误工具名",
      task: "读文件",
      definition: {
        name: "temp-3",
        description: "临时的",
        prompt: "p",
        tools: ["read", "teleport"],
      },
    });

    expect(vi.mocked(deps.start)).not.toHaveBeenCalled();
    expect(resultText(result)).toContain("teleport");
    expect(resultText(result)).toContain("read"); // 可用清单
  });

  it("成功派发：details 就是运行记录，文本不带错误", async () => {
    const deps = createDeps();

    const result = await invoke(deps, SUBAGENT_TOOL_NAMES.task, "call-7", {
      agent: "scout",
      description: "调研重试逻辑",
      task: "读 src/retry.ts",
    });

    // 渲染层按 details 里的运行记录画卡片，所以这里必须是完整的 SubagentRun
    expect(result.details).toMatchObject({
      delegationId: "call-7",
      agentName: "scout",
      description: "调研重试逻辑",
      task: "读 src/retry.ts",
      status: "running",
    });
    expect(result).not.toHaveProperty("isError");
    expect(resultText(result)).toContain("call-7");
    expect(resultText(result)).toContain(SUBAGENT_TOOL_NAMES.wait);
  });

  it("启动抛错：转成失败回执，而不是让异常冒出去", async () => {
    const deps = createDeps({
      start: vi.fn(async () => {
        throw new Error("子会话创建失败");
      }),
    });

    const result = await invoke(deps, SUBAGENT_TOOL_NAMES.task, "call-1", {
      agent: "scout",
      description: "起不来",
      task: "做点事",
    });

    expect(result).toMatchObject({ isError: true });
    expect(resultText(result)).toContain("子会话创建失败");
  });
});

describe("Task 的 resumeOf", () => {
  it("重派一次意外终止的运行：沿用原来的 agent / task / description，写下 resumedFrom，并拿到新的 delegationId", async () => {
    const deps = createDeps({ list: vi.fn(async () => [interruptedRun()]) });

    const result = await invoke(deps, SUBAGENT_TOOL_NAMES.task, "call-new", { resumeOf: "d-old" });

    const request = firstStart(deps);
    expect(request.resumedFrom).toBe("d-old");
    expect(request.definition.name).toBe("scout");
    expect(request.description).toBe("调研重试逻辑");
    expect(request.task).toBe("看 src/retry.ts 的重试逻辑");
    // 新的一条用自己的 toolCallId 当 delegationId：旧记录留在列表里，不被覆盖
    expect(result.details).toMatchObject({ delegationId: "call-new", resumedFrom: "d-old" });
    expect(result).not.toHaveProperty("isError");
    const text = resultText(result);
    expect(text).toContain("call-new");
    expect(text).toContain("d-old");
  });

  it("显式给的 description / task 优先于沿用", async () => {
    const deps = createDeps({ list: vi.fn(async () => [interruptedRun()]) });

    await invoke(deps, SUBAGENT_TOOL_NAMES.task, "call-new", {
      resumeOf: "d-old",
      description: "接着调研重试逻辑，这次带上测试",
      task: "补齐 src/retry.ts 的单测",
    });

    expect(lastStart(deps).description).toBe("接着调研重试逻辑，这次带上测试");
    expect(lastStart(deps).task).toBe("补齐 src/retry.ts 的单测");
  });

  it("要接续的运行还在跑：拒绝，并让模型改用 TaskWait 收敛它", async () => {
    const deps = createDeps({ list: vi.fn(async () => [makeRun({ delegationId: "d-live" })]) });

    const result = await invoke(deps, SUBAGENT_TOOL_NAMES.task, "call-new", {
      resumeOf: "d-live",
    });

    expect(result).toMatchObject({ isError: true });
    expect(resultText(result)).toContain(SUBAGENT_TOOL_NAMES.wait);
    expect(vi.mocked(deps.start)).not.toHaveBeenCalled();
  });

  it("resumeOf 是个不存在的 id：拒绝，并指出用 TaskList 看有哪些", async () => {
    const deps = createDeps(); // list 默认空

    const result = await invoke(deps, SUBAGENT_TOOL_NAMES.task, "call-new", {
      resumeOf: "d-ghost",
    });

    expect(result).toMatchObject({ isError: true });
    const text = resultText(result);
    expect(text).toContain("d-ghost");
    expect(text).toContain(SUBAGENT_TOOL_NAMES.list);
    expect(vi.mocked(deps.start)).not.toHaveBeenCalled();
  });

  it("原来的子智能体已经不存在：拒绝，并把现在可用的名字列出来", async () => {
    const deps = createDeps({
      list: vi.fn(async () => [interruptedRun({ agentName: "retired" })]),
      definitions: vi.fn(async () => [definition("scout"), definition("reporter")]),
    });

    const result = await invoke(deps, SUBAGENT_TOOL_NAMES.task, "call-new", {
      resumeOf: "d-old",
    });

    expect(result).toMatchObject({ isError: true });
    const text = resultText(result);
    expect(text).toContain("retired");
    expect(text).toContain("scout");
    expect(text).toContain("reporter");
    expect(vi.mocked(deps.start)).not.toHaveBeenCalled();
  });

  it("想换成别的 agent 再「接续」：拒绝，并说明这条运行属于谁", async () => {
    const deps = createDeps({ list: vi.fn(async () => [interruptedRun()]) });

    const result = await invoke(deps, SUBAGENT_TOOL_NAMES.task, "call-new", {
      resumeOf: "d-old",
      agent: "reporter",
    });

    expect(result).toMatchObject({ isError: true });
    expect(resultText(result)).toContain("scout");
    expect(vi.mocked(deps.start)).not.toHaveBeenCalled();
  });

  it("临时定义换了名字：同样拒绝（接续的必须是同一个子智能体）", async () => {
    const deps = createDeps({ list: vi.fn(async () => [interruptedRun()]) });

    const result = await invoke(deps, SUBAGENT_TOOL_NAMES.task, "call-new", {
      resumeOf: "d-old",
      definition: { name: "someone-else", description: "另一个", prompt: "p" },
    });

    expect(result).toMatchObject({ isError: true });
    expect(vi.mocked(deps.start)).not.toHaveBeenCalled();
  });
});

describe("Task 不带 resumeOf 时的必填参数（行为不变）", () => {
  it("description 为空：原样拒绝", async () => {
    const deps = createDeps();

    const result = await invoke(deps, SUBAGENT_TOOL_NAMES.task, "call-1", {
      description: "   ",
      task: "做点事",
    });

    expect(result).toMatchObject({ isError: true, details: { error: "description 为空" } });
    expect(resultText(result)).toContain("description 不能为空");
    expect(vi.mocked(deps.start)).not.toHaveBeenCalled();
  });

  it("task 为空：原样拒绝", async () => {
    const deps = createDeps();

    const result = await invoke(deps, SUBAGENT_TOOL_NAMES.task, "call-1", {
      description: "一件事",
      task: "   ",
    });

    expect(result).toMatchObject({ isError: true, details: { error: "task 为空" } });
    expect(resultText(result)).toContain("task 不能为空");
    expect(vi.mocked(deps.start)).not.toHaveBeenCalled();
  });
});

describe("TaskWait", () => {
  it("mode / minCompleted / delegationIds / timeoutSeconds 原样转发，输出带每条运行的状态与报告", async () => {
    const completed = makeRun({
      delegationId: "d-a",
      agentName: "scout",
      status: "completed",
      endedAt: 5_000,
      report: "重试逻辑在 src/retry.ts:42，最多 3 次",
    });
    const stillRunning = makeRun({ delegationId: "d-b", agentName: "reporter" });
    const deps = createDeps({ wait: vi.fn(async () => [completed, stillRunning]) });

    const result = await invoke(deps, SUBAGENT_TOOL_NAMES.wait, "call-1", {
      delegationIds: ["d-a", "d-b"],
      mode: "any",
      minCompleted: 2,
      timeoutSeconds: 123,
    });

    expect(vi.mocked(deps.wait)).toHaveBeenCalledWith(
      ["d-a", "d-b"],
      "any",
      2,
      123,
      BACKGROUND_CONTEXT,
    );
    expect(result.details).toEqual({ runs: [completed, stillRunning] });
    const text = resultText(result);
    expect(text).toContain("[scout]");
    expect(text).toContain("已完成");
    expect(text).toContain("重试逻辑在 src/retry.ts:42，最多 3 次");
    expect(text).toContain("[reporter]");
    expect(text).toContain("仍在运行");
    expect(result).not.toHaveProperty("isError");
  });

  it("缺省参数按契约给 all / 1 / 默认等待秒数", async () => {
    const deps = createDeps({
      wait: vi.fn(async () => [makeRun({ status: "completed", endedAt: 2_000, report: "完成" })]),
    });

    await invoke(deps, SUBAGENT_TOOL_NAMES.wait, "call-1", {});

    expect(vi.mocked(deps.wait)).toHaveBeenCalledWith(undefined, "all", 1, 600, BACKGROUND_CONTEXT);
  });

  it("超时不是失败：还在跑的运行以 running + 无报告回来，回执不带错误", async () => {
    const deps = createDeps({ wait: vi.fn(async () => [makeRun({ status: "running" })]) });

    const result = await invoke(deps, SUBAGENT_TOOL_NAMES.wait, "call-1", { timeoutSeconds: 5 });

    const text = resultText(result);
    expect(text).toContain("仍在运行");
    expect(text).toContain("（还没产出最终报告）");
    expect(text).not.toContain("Error:");
    expect(result).not.toHaveProperty("isError");
  });

  it("没有可等的运行：给一句说明（含没找到的 id），而不是空回执", async () => {
    const deps = createDeps(); // wait 默认返回 []

    const result = await invoke(deps, SUBAGENT_TOOL_NAMES.wait, "call-1", {
      delegationIds: ["d-ghost"],
    });

    expect(resultText(result)).toContain("d-ghost");
    expect(result.details).toEqual({ runs: [] });
  });
});

describe("TaskList", () => {
  it("空会话：给一句「还没有运行」，details 是空 runs 而不是 undefined", async () => {
    const deps = createDeps();

    const result = await invoke(deps, SUBAGENT_TOOL_NAMES.list, "call-1", {});

    expect(resultText(result)).toContain("还没有子智能体运行");
    expect(result.details).toEqual({ runs: [] });
  });

  it("意外终止的运行照常列出来，带上「要不要重来由你决定」的指引", async () => {
    const deps = createDeps({
      list: vi.fn(async () => [
        interruptedRun(),
        makeRun({ delegationId: "d-live", agentName: "reporter" }),
      ]),
    });

    const result = await invoke(deps, SUBAGENT_TOOL_NAMES.list, "call-1", {});

    const text = resultText(result);
    expect(text).toContain("[interrupted]");
    expect(text).toContain("已意外终止");
    expect(text).toContain("结果未知");
    expect(text).toContain("d-old");
    // 工具说明里必须写清「决定权在主代理」以及重来用哪个参数（模型挑工具时只看这段）
    const tool = createSubagentTools(deps).find(
      (candidate) => candidate.name === SUBAGENT_TOOL_NAMES.list,
    );
    expect(tool?.description).toContain("interrupted");
    expect(tool?.description).toContain("resumeOf");
    expect(tool?.description).toContain("由你决定");
  });

  it("重派出来的那条会标出接续的是哪一次", async () => {
    const deps = createDeps({
      list: vi.fn(async () => [interruptedRun({ status: "running", resumedFrom: "d-old" })]),
    });

    const result = await invoke(deps, SUBAGENT_TOOL_NAMES.list, "call-1", {});

    expect(resultText(result)).toContain("接续 d-old");
  });
});

describe("TaskStop", () => {
  it("未知 id：不抛错，把没找到的 id 说出来，空结果也能安全收尾", async () => {
    const deps = createDeps(); // stop 默认返回 []

    const result = await invoke(deps, SUBAGENT_TOOL_NAMES.stop, "call-1", {
      delegationIds: ["d-ghost"],
    });

    expect(vi.mocked(deps.stop)).toHaveBeenCalledWith(["d-ghost"]);
    const text = resultText(result);
    expect(text).toContain("d-ghost");
    expect(text).toContain("没有找到");
    expect(result.details).toEqual({ runs: [] });
    expect(result).not.toHaveProperty("isError");
  });

  it("重复 id 只停一次；停成功时输出停止后的状态", async () => {
    const stopped = makeRun({ status: "aborted", endedAt: 3_000, error: "主代理停止了这次运行" });
    const deps = createDeps({ stop: vi.fn(async () => [stopped]) });

    const result = await invoke(deps, SUBAGENT_TOOL_NAMES.stop, "call-1", {
      delegationIds: ["d-1", "d-1"],
    });

    expect(vi.mocked(deps.stop)).toHaveBeenCalledWith(["d-1"]);
    const text = resultText(result);
    expect(text).toContain("已停止");
    expect(text).toContain("主代理停止了这次运行");
    expect(result.details).toEqual({ runs: [stopped] });
  });
});
