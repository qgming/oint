// Product behavior through the official durable scheduler, events and SQLite storage.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  type FauxProviderHandle,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineTool,
  Harness,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { TOOL_SEARCH_TOOL_NAME } from "@earendil-works/pi-durable/tool-search";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatAttachment } from "@/shared/contracts/attachment";
import type { ChatEventEnvelope } from "@/shared/contracts/chat";
import type { Settings } from "@/shared/contracts/settings";
import { DEFAULT_WEB_SEARCH_SETTINGS } from "@/shared/contracts/web";
import type { ApprovalService } from "./approvals";
import { readDocument } from "./durable-session";
import { RunPolicyDoc } from "./execution-policy";
import type { WorkflowState } from "@/shared/contracts/workflow";
import { type ChatRuntime, createChatRuntime } from "./runtime";
import { createSessionStore, type SessionStore } from "./session-store";
import { createSubagentExtension, createSubagentRunner } from "./subagent-runner";
import { createToolTestApi } from "./tools/tool-test-api";
import { beginWork } from "./workflow";

const providerState = vi.hoisted(() => ({ current: undefined as FauxProviderHandle | undefined }));
const preprocessing = vi.hoisted(() => ({
  wait: undefined as Promise<void> | undefined,
  entered: false,
}));
vi.mock("./attachments", async (load) => {
  const actual = await load<typeof import("./attachments")>();
  return {
    ...actual,
    buildUserContent: async (sessionId: string, text: string, attachments?: ChatAttachment[]) => {
      preprocessing.entered = true;
      await preprocessing.wait;
      return actual.buildUserContent(sessionId, text, attachments);
    },
  };
});
vi.mock("./providers", () => ({
  buildProviders: () => {
    if (providerState.current === undefined) throw new Error("Missing test provider");
    const models = createModels();
    models.setProvider(providerState.current.provider);
    return { models, providers: new Map([["svc", providerState.current.provider]]) };
  },
  resolveModel: (_settings: unknown, ref?: { modelId: string } | null) =>
    providerState.current?.getModel(ref?.modelId ?? "test"),
}));
const pluginHost = vi.hoisted(() => ({
  dispatch: vi.fn(
    async (
      _name: string,
      _payload: unknown,
    ): Promise<{ block?: string; additionalContext?: string; failures: [] }> => ({ failures: [] }),
  ),
}));
vi.mock("@/main/plugins/process-host", async () => {
  const { defineExtension, hook, ToolTask, GenerationTask } = await import(
    "@earendil-works/pi-durable"
  );
  let pendingContext: string | undefined;
  const extension = defineExtension({
    name: "test-plugin",
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call) => {
          const result = await pluginHost.dispatch("beforeTool", call);
          return result.block ? { block: result.block } : undefined;
        },
        afterTool: async (call, result) => {
          const response = await pluginHost.dispatch("afterTool", { call, result });
          pendingContext = response.additionalContext;
        },
      }),
      hook(GenerationTask, {
        beforeRequest: ({ messages }) => {
          const content = pendingContext;
          pendingContext = undefined;
          return content
            ? { messages: [...messages, { role: "user", content, timestamp: Date.now() }] }
            : undefined;
        },
      }),
    ],
  });
  return {
    pluginExtensions: () => [{ pluginId: "test-plugin", extension }],
    subscribePluginExtensions: () => () => {},
  };
});
vi.mock("@/main/plugins/contributions", () => ({
  ensurePluginWorkspace: async () => {},
  pluginContributionDirs: () => ({ skills: [], prompts: [], subagents: [] }),
}));
vi.mock("./resources", async (load) => ({
  ...(await load<Record<string, unknown>>()),
  loadSkills: async () => ({ skills: [], diagnostics: [] }),
  loadPromptTemplates: async () => ({ promptTemplates: [], diagnostics: [] }),
}));

let directory: string;
let store: SessionStore;
let runtime: ChatRuntime;
let sessionId: string;
let settings: Settings;
let faux: FauxProviderHandle;
let events: ChatEventEnvelope[];
let mcpTools: ToolRegistration[];
let mcpListeners: Set<() => void>;
let approvals: ApprovalService;

const toolResponse = (call: ReturnType<typeof fauxToolCall>) =>
  fauxAssistantMessage(call, { stopReason: "toolUse" });

function textOf(context: TranscriptContext): string[] {
  return context.messages
    .filter((message) => message.role === "user")
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join(""),
    );
}

beforeEach(async () => {
  preprocessing.wait = undefined;
  preprocessing.entered = false;
  directory = await mkdtemp(path.join(tmpdir(), "oint-native-runtime-"));
  vi.stubEnv("OINT_HOME", directory);
  store = createSessionStore(directory);
  sessionId = (await store.create({ cwd: directory })).id;
  faux = fauxProvider({
    provider: "svc",
    models: [
      { id: "test", contextWindow: 128_000, input: ["text", "image"] },
      { id: "second", contextWindow: 128_000, reasoning: true },
    ],
    tokensPerSecond: 100_000,
  });
  providerState.current = faux;
  settings = {
    theme: "system",
    language: "zh-CN",
    density: "comfortable",
    chatFont: "",
    chatFontSize: 14,
    services: [
      {
        id: "svc",
        name: "test",
        baseUrl: "https://unused.invalid",
        apiKey: "",
        wireFormat: "openai-completions",
        models: [{ id: "test" }],
      },
    ],
    defaultModel: { serviceId: "svc", modelId: "test" },
    thinkingLevel: "off",
    permissionMode: "default",
    agentMode: "standard",
    disabledSkillNames: [],
    disabledSubagentNames: [],
    mcpServers: [],
    systemMcpServerEnabled: {},
    webSearch: DEFAULT_WEB_SEARCH_SETTINGS,
  };
  events = [];
  mcpTools = [];
  mcpListeners = new Set();
  approvals = {
    attach: async () => () => {},
    taskDefinitions: [],
    request: vi.fn(async () => "allow_once" as const),
    respond: vi.fn(),
    pending: async () => [],
    cancelSession: vi.fn(),
    history: async () => [],
  };
  pluginHost.dispatch.mockReset();
  pluginHost.dispatch.mockResolvedValue({ failures: [] });
  runtime = createChatRuntime({
    getSettings: async () => settings,
    sessionStore: store,
    approvals,
    resolveWorkingDir: async () => directory,
    emit: (event) => {
      events.push(structuredClone(event));
    },
    mcp: {
      tools: () => mcpTools,
      subscribe: (listener) => {
        mcpListeners.add(listener);
        return () => {
          mcpListeners.delete(listener);
        };
      },
    },
  });
});

afterEach(async () => {
  await runtime?.dispose();
  await store?.close();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

async function seedPendingChild(modelId?: string) {
  const opened = await store.open(sessionId);
  if (!opened) throw new Error("Missing fixture session");
  const registry = createRegistry();
  const models = createModels();
  models.setProvider(faux.provider);
  const tasks = createSubagentExtension(async () => {});
  registry.install(tasks.extension);
  const harness = await opened.session.bindHarness(() =>
    Harness.open(opened.storage, { models, registry }, BACKGROUND_CONTEXT),
  );
  const root = await harness.conversation(opened.conversationId, BACKGROUND_CONTEXT);
  if (!root) throw new Error("Missing fixture root");
  await root.configure({ model: { provider: "svc", modelId: "test" } }, BACKGROUND_CONTEXT);
  const runner = createSubagentRunner({
    harness,
    conversation: () => root,
    familyId: sessionId,
    tasks,
    parent: async () => ({ sessionId, cwd: directory, parentModelId: "test" }),
  });
  const run = await runner.start(
    {
      toolCallId: "cold-child",
      description: "recover child",
      task: "recover-work",
      definition: {
        name: "reader",
        description: "reader",
        prompt: "Report findings",
        source: "temp",
        tools: ["read"],
        ...(modelId ? { model: { serviceId: "svc", modelId } } : {}),
      },
    },
    createToolTestApi({ conversationId: root.id, commit: root.commit.bind(root) }),
    BACKGROUND_CONTEXT,
  );
  await harness.close(BACKGROUND_CONTEXT);
  await opened.session.unbindHarness(harness);
  return run;
}

async function workflowState(): Promise<WorkflowState> {
  const state = (await runtime.liveSnapshot(sessionId))?.state.workflow;
  if (!state) throw new Error("Expected workflow state");
  return state;
}
async function workVersion() {
  const work = (await workflowState()).work!;
  return { workId: work.workId, workRevision: work.revision };
}
function workflowResponse(
  name: string,
  params: Record<string, unknown> | ((state: WorkflowState) => Record<string, unknown>),
) {
  return async () => {
    const state = await workflowState();
    return toolResponse(
      fauxToolCall(name, {
        ...(await workVersion()),
        ...(typeof params === "function" ? params(state) : params),
      }),
    );
  };
}
function planResponses(markdown = "# Approach\nImplement and verify", changed = false) {
  return [
    workflowResponse("set_work_contract", (state) => ({
      resolvedInputIds: state.work!.pendingInputIds,
      requirementsChanged: changed,
    })),
    workflowResponse("save_plan", (state) => ({
      title: "Approach",
      markdown,
      ...(state.plan && state.plan.workId === state.work?.workId && state.plan.status !== "archived"
        ? { planId: state.plan.id, revision: state.plan.revision }
        : {}),
    })),
    workflowResponse("present_plan", (state) => ({
      planId: state.plan!.id,
      revision: state.plan!.revision,
    })),
    fauxAssistantMessage("Saved for review"),
  ];
}
async function executionRequest(requestId: string) {
  const state = await workflowState();
  return {
    ...(await workVersion()),
    requestId,
    planId: state.plan!.id,
    revision: state.plan!.revision,
  };
}
const acknowledgeInput = () =>
  workflowResponse("set_work_contract", (state) => ({
    resolvedInputIds: state.work!.pendingInputIds,
    requirementsChanged: false,
  }));
/**
 * 旧的 `planOnly` 发送选项已随「新工作」入口移除。测试改为在持久层预建同一份契约：
 * effects/requiresReview 在首轮请求前即生效，与旧路径产出的工作状态完全一致。
 */
async function seedPlanOnlyWork() {
  const opened = (await store.open(sessionId))!;
  if (!opened) throw new Error("Missing fixture session");
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await opened.session.bindHarness(() =>
    Harness.open(opened.storage, { models, registry: createRegistry() }, BACKGROUND_CONTEXT),
  );
  try {
    const root = await harness.conversation(opened.conversationId, BACKGROUND_CONTEXT);
    if (!root) throw new Error("Missing fixture root");
    await beginWork(harness, root.id, { effects: "read-only", requiresReview: true });
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
    await opened.session.unbindHarness(harness);
  }
}

describe("native durable chat runtime", () => {
  it.each(["research", "implementation"] as const)(
    "only a %s goal uses read-only automatic rounds before review",
    async (scope) => {
      faux.setResponses([
        acknowledgeInput(),
        workflowResponse("create_goal", {
          scope,
          objective: "Deliver research",
          criteria: ["Research verified"],
        }),
        fauxAssistantMessage("First research round"),
        workflowResponse("update_goal", (state) => ({
          goalId: state.goal!.id,
          revision: state.goal!.revision,
          progress: "Research verified",
          status: "completed",
        })),
        fauxAssistantMessage("Research complete"),
      ]);
      await seedPlanOnlyWork();
      await runtime.send(sessionId, "研究并交付方案");
      if (scope === "research") {
        // 目标完成的提交早于续行轮的收尾请求：先等第 5 次调用落地，
        // 否则 closeSession 会把在途请求中止掉（间歇性少一次调用）。
        await vi.waitFor(() => expect(faux.state.callCount).toBe(5));
        expect((await workflowState()).goal?.status).toBe("completed");
        expect((await workflowState()).goal?.continuationCount).toBe(1);
      }
      await runtime.closeSession(sessionId);
      expect(faux.state.callCount).toBe(scope === "research" ? 5 : 3);
    },
  );
  it("retries a timed-out model request without resubmitting input or enabling hidden provider retries", async () => {
    const providerRetries: (number | undefined)[] = [];
    const inputs: string[][] = [];
    faux.setResponses([
      (messages, options) => {
        providerRetries.push(options?.maxRetries);
        inputs.push(textOf(messages));
        return fauxAssistantMessage("partial", {
          stopReason: "error",
          errorMessage: "Request timed out.",
        });
      },
      (messages, options) => {
        providerRetries.push(options?.maxRetries);
        inputs.push(textOf(messages));
        return fauxAssistantMessage("recovered");
      },
    ]);
    const sending = runtime.send(sessionId, "continue this exact request");
    await vi.waitFor(
      async () => {
        expect((await runtime.liveSnapshot(sessionId))?.state.retry).toMatchObject({
          phase: "retrying",
          attempt: 1,
          maxAttempts: 5,
          error: "Request timed out.",
        });
      },
      { timeout: 5000 },
    );
    await sending;
    const state = (await runtime.liveSnapshot(sessionId))?.state;
    expect(faux.state.callCount).toBe(2);
    expect(providerRetries).toEqual([0, 0]);
    expect(inputs).toEqual([["continue this exact request"], ["continue this exact request"]]);
    expect(state?.retry).toBeNull();
    expect(state?.messages.filter((message) => message.role === "user")).toHaveLength(1);
    const attempts = state?.messages.filter((message) => message.role === "assistant") ?? [];
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.generationId).toBe(attempts[1]?.generationId);
    expect(attempts[0]?.parts).toEqual([{ type: "text", text: "partial" }]);
  });

  it("background naming starts from the user request without delaying chat or overriding manual names", async () => {
    await runtime.dispose();
    let resolveTitle: (title: string) => void = () => {};
    const pendingTitle = new Promise<string>((resolve) => {
      resolveTitle = resolve;
    });
    const generate = vi.fn(async () => pendingTitle);
    runtime = createChatRuntime({
      getSettings: async () => settings,
      sessionStore: store,
      approvals,
      resolveWorkingDir: async () => directory,
      emit: (event) => events.push(event),
      sessionTitles: generate,
    });
    faux.setResponses([fauxAssistantMessage("answer")]);
    try {
      await runtime.send(sessionId, "修复登录超时");
      await vi.waitFor(() => expect(generate).toHaveBeenCalled());
      expect(generate.mock.calls[0]?.length).toBeGreaterThan(0);
      expect(await store.readTitle(sessionId)).toBeNull();
      await store.rename(sessionId, "我的标题");
    } finally {
      resolveTitle("自动标题");
    }
    await runtime.closeSession(sessionId);
    expect(await store.readTitle(sessionId)).toBe("我的标题");
  });

  it("read-only work blocks writes and unknown MCP tools even with full permission, and skips plugin hooks", async () => {
    settings.permissionMode = "full";
    const execute = vi.fn(async () => ({
      output: [{ type: "text" as const, text: "unexpected" }],
    }));
    mcpTools = [
      defineTool({
        name: "mcp__test__write",
        description: "write",
        parameters: Type.Object({}),
        execute,
      }),
    ];
    const target = path.join(directory, "forbidden.txt");
    faux.setResponses([
      acknowledgeInput(),
      toolResponse(fauxToolCall("write", { path: target, content: "changed" })),
      toolResponse(fauxToolCall("mcp__test__write", {})),
      fauxAssistantMessage("Read-only research"),
    ]);
    await seedPlanOnlyWork();
    await runtime.send(sessionId, "Research only");
    await expect(readFile(target)).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
    expect(pluginHost.dispatch).not.toHaveBeenCalled();
    expect(approvals.request).not.toHaveBeenCalled();
  });

  it("fences the first natural-language request before effects, then enforces model-recorded planning constraints", async () => {
    settings.permissionMode = "full";
    const target = path.join(directory, "must-not-create.txt");
    faux.setResponses([
      toolResponse(fauxToolCall("write", { path: target, content: "before classification" })),
      workflowResponse("set_work_contract", (state) => ({
        effects: "read-only",
        resolvedInputIds: state.work!.pendingInputIds,
        requirementsChanged: false,
      })),
      toolResponse(fauxToolCall("write", { path: target, content: "after narrowing" })),
      fauxAssistantMessage("Research only"),
    ]);
    await runtime.send(sessionId, "只给方案，不要修改文件");
    await expect(readFile(target)).rejects.toThrow();
    expect((await workflowState()).work).toMatchObject({
      effects: "read-only",
      pendingInputIds: [],
    });
    expect(pluginHost.dispatch).not.toHaveBeenCalled();
  });

  it("saves native plans in either style and executes only the reviewed current revision", async () => {
    await store.setAgentMode(sessionId, "orchestrate");
    faux.setResponses([fauxAssistantMessage("Research only")]);
    await seedPlanOnlyWork();
    await runtime.send(sessionId, "research");
    expect((await workflowState()).plan).toBeNull();
    faux.setResponses(planResponses("# First\nInspect the source."));
    await runtime.send(sessionId, "write the plan");
    const first = (await workflowState()).plan!;
    expect(first.status).toBe("ready");
    expect(await runtime.readPlan(sessionId)).toMatchObject({
      markdown: "# First\nInspect the source.",
    });
    faux.setResponses(planResponses("# Revised\nInspect and verify.", true));
    await runtime.send(sessionId, "include verification");
    const latest = (await workflowState()).plan!;
    expect(latest.revision).toBe(2);
    expect(
      await runtime.startPlan(sessionId, {
        ...(await executionRequest("stale")),
        revision: first.revision,
      }),
    ).toMatchObject({ ok: false, code: "stale" });
    let executionInput = "";
    faux.setResponses([
      (context) => {
        executionInput = textOf(context).at(-1) ?? "";
        return fauxAssistantMessage("Executed");
      },
    ]);
    const request = await executionRequest("execute-current");
    const starts = await Promise.all([
      runtime.startPlan(sessionId, request),
      runtime.startPlan(sessionId, request),
    ]);
    expect(starts.some((result) => result.ok)).toBe(true);
    await vi.waitFor(() => expect(executionInput).toContain("# Revised"));
    await vi.waitFor(async () =>
      expect((await runtime.liveSnapshot(sessionId))!.state.running).toBe(false),
    );
    expect((await workflowState()).execution).toMatchObject({
      status: "admitted",
      requestId: request.requestId,
    });
    expect((await workflowState()).plan?.status).toBe("ready");
    expect(executionInput).not.toContain("# First");
    expect(await store.readAgentMode(sessionId)).toBe("orchestrate");
    const before = faux.state.callCount;
    expect(await runtime.startPlan(sessionId, request)).toMatchObject({ ok: true });
    expect(faux.state.callCount).toBe(before);
  });

  it.each(["standard", "orchestrate"] as const)(
    "automatically advances a main-AI goal in %s until verified",
    async (mode) => {
      await store.setAgentMode(sessionId, mode);
      faux.setResponses([
        acknowledgeInput(),
        workflowResponse("create_goal", {
          objective: "Verify feature",
          criteria: ["Verification passes"],
        }),
        fauxAssistantMessage("First step done"),
        async () => {
          const goal = (await runtime.liveSnapshot(sessionId))!.state.workflow!.goal!;
          return toolResponse(
            fauxToolCall("update_goal", {
              ...(await workVersion()),
              goalId: goal.id,
              revision: goal.revision,
              progress: "Verification passed",
              status: "completed",
            }),
          );
        },
        fauxAssistantMessage("Complete"),
      ]);
      await runtime.send(sessionId, "Verify feature");
      await vi.waitFor(async () =>
        expect((await runtime.liveSnapshot(sessionId))?.state.workflow?.goal?.status).toBe(
          "completed",
        ),
      );
      const goal = (await runtime.liveSnapshot(sessionId))?.state.workflow?.goal;
      expect(goal?.continuationCount).toBe(1);
      expect(goal?.progress).toBe("Verification passed");
      expect(await store.readAgentMode(sessionId)).toBe(mode);
    },
  );

  it.each(["standard", "orchestrate"] as const)(
    "does not schedule goal work for ordinary chat in %s",
    async (mode) => {
      await store.setAgentMode(sessionId, mode);
      faux.setResponses([fauxAssistantMessage("Hello")]);
      await runtime.send(sessionId, "Hello");
      expect((await runtime.liveSnapshot(sessionId))!.state.workflow!.goal).toBeNull();
      await runtime.closeSession(sessionId);
      expect(faux.state.callCount).toBe(1);
    },
  );

  it("keeps goal metadata independent while required review blocks implementation and continuation", async () => {
    settings.permissionMode = "full";
    const target = path.join(directory, "must-not-write.txt");
    faux.setResponses([
      acknowledgeInput(),
      workflowResponse("create_goal", {
        objective: "Investigate change",
        criteria: ["Verified change"],
      }),
      workflowResponse("update_goal", (state) => ({
        goalId: state.goal!.id,
        revision: state.goal!.revision,
        progress: "Investigated scope",
        status: "active",
      })),
      toolResponse(fauxToolCall("write", { path: target, content: "forbidden" })),
      fauxAssistantMessage("Ready to prepare a plan"),
    ]);
    await seedPlanOnlyWork();
    await runtime.send(sessionId, "Investigate the change");
    expect(await workflowState()).toMatchObject({
      goal: { status: "active", progress: "Investigated scope", continuationCount: 0 },
      plan: null,
    });
    expect(await runtime.controlGoal(sessionId, "resume")).toMatchObject({ ok: false });
    await expect(readFile(target)).rejects.toThrow();
    await runtime.closeSession(sessionId);
    await runtime.prepareSubagent(sessionId);
    expect((await workflowState()).goal).toMatchObject({ status: "paused", continuationCount: 0 });
    expect(faux.state.callCount).toBe(5);
  });

  it.each(["standard", "orchestrate"] as const)(
    "keeps automatic continuation in admitted %s despite a preference change",
    async (mode) => {
      await store.setAgentMode(sessionId, mode);
      faux.setResponses([
        acknowledgeInput(),
        workflowResponse("create_goal", {
          objective: "Verify",
          criteria: ["Verified"],
        }),
        async () => {
          await store.setAgentMode(sessionId, mode === "standard" ? "orchestrate" : "standard");
          return fauxAssistantMessage("First step");
        },
        async () => {
          const opened = (await store.open(sessionId))!;
          expect(
            await readDocument(opened.storage, RunPolicyDoc.definition.kind, opened.conversationId),
          ).toMatchObject({ mode });
          const workflow = (await runtime.liveSnapshot(sessionId))!.state.workflow!;
          return toolResponse(
            fauxToolCall("update_goal", {
              ...(await workVersion()),
              goalId: workflow.goal!.id,
              revision: workflow.goal!.revision,
              progress: "Verified",
              status: "completed",
            }),
          );
        },
        fauxAssistantMessage("Done"),
      ]);
      await runtime.send(sessionId, "Verify");
      await vi.waitFor(async () =>
        expect((await runtime.liveSnapshot(sessionId))!.state.workflow!.goal!.status).toBe(
          "completed",
        ),
      );
      expect(await store.readAgentMode(sessionId)).toBe(
        mode === "standard" ? "orchestrate" : "standard",
      );
    },
  );

  it("restores native plan content and current restrictions without a goal or mode transition", async () => {
    await store.setAgentMode(sessionId, "orchestrate");
    faux.setResponses(planResponses());
    await seedPlanOnlyWork();
    await runtime.send(sessionId, "Prepare a plan");
    const plan = (await workflowState()).plan!;
    await runtime.closeSession(sessionId);
    await runtime.prepareSubagent(sessionId);
    expect(await runtime.readPlan(sessionId)).toEqual(plan);
    expect((await workflowState()).work?.effects).toBe("read-only");
    const calls = faux.state.callCount;
    faux.setResponses([
      workflowResponse("set_work_contract", (state) => ({
        resolvedInputIds: state.work!.pendingInputIds,
        requirementsChanged: false,
      })),
      fauxAssistantMessage("This step verifies the result"),
    ]);
    await runtime.send(sessionId, "Explain the verification step");
    expect((await workflowState()).plan).toEqual(plan);
    expect((await workflowState()).work?.pendingInputIds).toEqual([]);
    expect(faux.state.callCount).toBe(calls + 2);
    faux.setResponses([fauxAssistantMessage("Executed")]);
    expect(await runtime.startPlan(sessionId, await executionRequest("after-reopen"))).toEqual({
      ok: true,
    });
    await vi.waitFor(async () =>
      expect((await runtime.liveSnapshot(sessionId))!.state.running).toBe(false),
    );
    expect(await store.readAgentMode(sessionId)).toBe("orchestrate");
    expect((await workflowState()).goal).toBeNull();
  });

  it("keeps manual goal pause through queued messages, working-style changes and plan execution", async () => {
    faux.setResponses([
      acknowledgeInput(),
      workflowResponse("create_goal", {
        objective: "Finish original task",
        criteria: ["Original task verified"],
      }),
      fauxAssistantMessage("Tracked"),
    ]);
    await seedPlanOnlyWork();
    await runtime.send(sessionId, "Track this task");
    expect(await runtime.controlGoal(sessionId, "pause")).toEqual({ ok: true });
    await store.setAgentMode(sessionId, "orchestrate");
    faux.setResponses([
      async () => {
        await runtime.queue(sessionId, "Additional detail", "followUp");
        return fauxAssistantMessage("Noted");
      },
      fauxAssistantMessage("Detail handled"),
    ]);
    await runtime.send(sessionId, "Explain the scope");
    await vi.waitFor(async () =>
      expect((await runtime.liveSnapshot(sessionId))!.state.running).toBe(false),
    );
    expect((await workflowState()).goal).toMatchObject({ status: "paused", continuationCount: 0 });
    faux.setResponses(planResponses());
    await runtime.send(sessionId, "Save the approach");
    faux.setResponses([fauxAssistantMessage("Plan executed")]);
    expect(await runtime.startPlan(sessionId, await executionRequest("paused-goal-plan"))).toEqual({
      ok: true,
    });
    await vi.waitFor(async () =>
      expect((await runtime.liveSnapshot(sessionId))!.state.running).toBe(false),
    );
    expect((await workflowState()).goal).toMatchObject({ status: "paused", continuationCount: 0 });
    faux.setResponses([
      workflowResponse("update_goal", (state) => ({
        goalId: state.goal!.id,
        revision: state.goal!.revision,
        progress: "Original task verified",
        status: "completed",
      })),
      fauxAssistantMessage("Complete"),
    ]);
    expect(await runtime.controlGoal(sessionId, "resume")).toEqual({ ok: true });
    await vi.waitFor(async () => expect((await workflowState()).goal?.status).toBe("completed"));
    expect(await store.readAgentMode(sessionId)).toBe("orchestrate");
  });

  it("pauses at the configured continuation limit and never resumes on reopen", async () => {
    settings.goalContinuationLimit = 1;
    await store.setAgentMode(sessionId, "standard");
    faux.setResponses([
      acknowledgeInput(),
      workflowResponse("create_goal", {
        objective: "Bounded work",
        criteria: ["Finished"],
      }),
      fauxAssistantMessage("Some progress"),
      fauxAssistantMessage("More progress"),
    ]);
    await runtime.send(sessionId, "Bounded work");
    await vi.waitFor(async () =>
      expect((await runtime.liveSnapshot(sessionId))?.state.workflow?.goal?.status).toBe("paused"),
    );
    expect((await runtime.liveSnapshot(sessionId))?.state.workflow?.goal?.continuationCount).toBe(
      1,
    );
    const before = (await store.loadMessages(sessionId)).messages.length;
    await runtime.closeSession(sessionId);
    await runtime.prepareSubagent(sessionId);
    expect((await runtime.liveSnapshot(sessionId))?.state.workflow?.goal?.status).toBe("paused");
    expect((await store.loadMessages(sessionId)).messages).toHaveLength(before);
  });

  it("does not auto-continue a truncated goal response", async () => {
    await store.setAgentMode(sessionId, "standard");
    faux.setResponses([
      acknowledgeInput(),
      workflowResponse("create_goal", {
        objective: "Work",
        criteria: ["Verified"],
      }),
      fauxAssistantMessage("Truncated", { stopReason: "length" }),
    ]);
    await runtime.send(sessionId, "Work");
    const goal = (await runtime.liveSnapshot(sessionId))?.state.workflow?.goal;
    expect(goal?.status).toBe("paused");
    expect(goal?.continuationCount).toBe(0);
  });

  it("releases a plan reservation without authorization if stopped before submission admission", async () => {
    faux.setResponses(planResponses());
    await seedPlanOnlyWork();
    await runtime.send(sessionId, "Plan");
    const plan = (await workflowState()).plan!;
    const request = await executionRequest("cancelled-start");
    preprocessing.entered = false;
    let release = () => {};
    preprocessing.wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const start = runtime.startPlan(sessionId, request);
    try {
      await vi.waitFor(() => expect(preprocessing.entered).toBe(true));
      await runtime.stop(sessionId);
    } finally {
      release();
    }
    expect(await start).toMatchObject({ ok: false });
    expect((await workflowState()).plan).toEqual(plan);
    expect((await workflowState()).work).toMatchObject({
      effects: "read-only",
      approvedPlanRef: null,
    });
    expect(
      (await store.loadMessages(sessionId)).messages.filter((message) => message.role === "user"),
    ).toHaveLength(1);
    preprocessing.wait = undefined;
    faux.setResponses([fauxAssistantMessage("Executed on retry")]);
    expect(await runtime.startPlan(sessionId, await executionRequest("retry-start"))).toMatchObject(
      { ok: true },
    );
  });

  it("executes an approved goal plan in the existing working style", async () => {
    await store.setAgentMode(sessionId, "orchestrate");
    faux.setResponses([
      acknowledgeInput(),
      workflowResponse("create_goal", { objective: "Verified feature", criteria: ["Tests pass"] }),
      ...planResponses("# Verify\nRun the tests."),
    ]);
    await seedPlanOnlyWork();
    await runtime.send(sessionId, "Prepare verification plan");
    const before = await workflowState();
    expect(before.goal).toMatchObject({ status: "active", continuationCount: 0 });
    faux.setResponses([
      workflowResponse("update_goal", (state) => ({
        goalId: state.goal!.id,
        revision: state.goal!.revision,
        progress: "Tests passed",
        status: "completed",
      })),
      fauxAssistantMessage("Verified"),
    ]);
    expect(await runtime.startPlan(sessionId, await executionRequest("verify-goal"))).toEqual({
      ok: true,
    });
    await vi.waitFor(async () => expect((await workflowState()).goal?.status).toBe("completed"));
    expect((await workflowState()).goal?.id).toBe(before.goal!.id);
    expect((await workflowState()).plan?.status).toBe("ready");
    expect(await store.readAgentMode(sessionId)).toBe("orchestrate");
  });

  it("prioritizes delayed queued user input then continues the goal after that input completes", async () => {
    await store.setAgentMode(sessionId, "standard");
    let release = () => {};
    let queued: Promise<void> | undefined;
    const feedbackGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requests: string[] = [];
    faux.setResponses([
      acknowledgeInput(),
      workflowResponse("create_goal", {
        objective: "Handle feedback",
        criteria: ["Feedback verified"],
      }),
      async () => {
        preprocessing.entered = false;
        preprocessing.wait = feedbackGate;
        queued = runtime.send(sessionId, "New feedback", [
          {
            name: "note.txt",
            kind: "text",
            mimeType: "text/plain",
            size: 4,
            data: Buffer.from("note").toString("base64"),
          },
        ]);
        await vi.waitFor(() => expect(preprocessing.entered).toBe(true));
        return fauxAssistantMessage("Initial step done");
      },
      async (context) => {
        requests.push(textOf(context).at(-1) ?? "");
        return acknowledgeInput()();
      },
      fauxAssistantMessage("Feedback handled"),
      async (context) => {
        requests.push(textOf(context).at(-1) ?? "");
        const workflow = (await runtime.liveSnapshot(sessionId))!.state.workflow!;
        return toolResponse(
          fauxToolCall("update_goal", {
            ...(await workVersion()),
            goalId: workflow.goal!.id,
            revision: workflow.goal!.revision,
            progress: "Feedback verified",
            status: "completed",
          }),
        );
      },
      fauxAssistantMessage("Complete"),
    ]);
    try {
      await runtime.send(sessionId, "Handle feedback");
    } finally {
      release();
    }
    await queued;
    await vi.waitFor(async () =>
      expect((await runtime.liveSnapshot(sessionId))?.state.workflow?.goal?.status).toBe(
        "completed",
      ),
    );
    expect(requests[0]).toContain("New feedback");
    expect(requests[1]).toContain("自动续行");
  });

  it("pausing while automatic continuation is preparing prevents its later admission", async () => {
    await store.setAgentMode(sessionId, "standard");
    let release = () => {};
    const continuationGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    faux.setResponses([
      acknowledgeInput(),
      workflowResponse("create_goal", {
        objective: "Pause safely",
        criteria: ["Verified"],
      }),
      () => {
        preprocessing.entered = false;
        preprocessing.wait = continuationGate;
        return fauxAssistantMessage("Initial progress");
      },
    ]);
    await runtime.send(sessionId, "Pause safely");
    try {
      await vi.waitFor(() => expect(preprocessing.entered).toBe(true));
      expect(await runtime.controlGoal(sessionId, "pause")).toEqual({ ok: true });
    } finally {
      release();
    }
    await runtime.closeSession(sessionId);
    expect(faux.state.callCount).toBe(3);
    expect(
      (await store.loadMessages(sessionId)).messages.filter((message) => message.role === "user"),
    ).toHaveLength(1);
    await runtime.prepareSubagent(sessionId);
    expect((await runtime.liveSnapshot(sessionId))?.state.workflow?.goal?.status).toBe("paused");
  });

  it("a cancelled queue receipt cannot pause the goal after newer user input", async () => {
    await store.setAgentMode(sessionId, "standard");
    let release = () => {};
    let reached = false;
    const generationGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    faux.setResponses([
      acknowledgeInput(),
      workflowResponse("create_goal", {
        objective: "Use latest feedback",
        criteria: ["Latest feedback verified"],
      }),
      async () => {
        reached = true;
        await generationGate;
        return fauxAssistantMessage("Initial progress");
      },
      acknowledgeInput(),
      fauxAssistantMessage("Latest feedback handled"),
      async () => {
        const workflow = (await runtime.liveSnapshot(sessionId))!.state.workflow!;
        return toolResponse(
          fauxToolCall("update_goal", {
            ...(await workVersion()),
            goalId: workflow.goal!.id,
            revision: workflow.goal!.revision,
            progress: "Latest feedback verified",
            status: "completed",
          }),
        );
      },
      fauxAssistantMessage("Complete"),
    ]);
    const original = runtime.send(sessionId, "Use latest feedback");
    try {
      await vi.waitFor(() => expect(reached).toBe(true));
      await runtime.queue(sessionId, "Discard this feedback", "followUp");
      const queued = (await runtime.liveSnapshot(sessionId))!.state.queue.find(
        (item) => item.text === "Discard this feedback",
      );
      expect(queued).toBeDefined();
      await runtime.cancelQueued(sessionId, queued!.id);
      await runtime.queue(sessionId, "Use this newer feedback", "followUp");
    } finally {
      release();
    }
    await original;
    await vi.waitFor(async () =>
      expect((await runtime.liveSnapshot(sessionId))?.state.workflow?.goal?.status).toBe(
        "completed",
      ),
    );
    expect((await runtime.liveSnapshot(sessionId))?.state.workflow?.goal?.progress).toBe(
      "Latest feedback verified",
    );
  });

  it("working-style changes preserve read-only work", async () => {
    settings.permissionMode = "full";
    const target = path.join(directory, "next-work.txt");
    faux.setResponses([
      async () => {
        await store.setAgentMode(sessionId, "orchestrate");
        return toolResponse(fauxToolCall("write", { path: target, content: "wrong" }));
      },
      fauxAssistantMessage("Research finished"),
    ]);
    await seedPlanOnlyWork();
    await runtime.send(sessionId, "Research only");
    await expect(readFile(target)).rejects.toThrow();
    faux.setResponses([
      acknowledgeInput(),
      toolResponse(fauxToolCall("write", { path: target, content: "still forbidden" })),
      fauxAssistantMessage("Explained"),
    ]);
    await runtime.send(sessionId, "Explain further");
    await expect(readFile(target)).rejects.toThrow();
  });

  it("restores work restrictions before refreshing plugins or MCP tools", async () => {
    faux.setResponses([fauxAssistantMessage("Research")]);
    await seedPlanOnlyWork();
    await runtime.send(sessionId, "Research only");
    await store.setAgentMode(sessionId, "orchestrate");
    await runtime.closeSession(sessionId);
    await runtime.prepareSubagent(sessionId);
    const opened = (await store.open(sessionId))!;
    expect(
      await readDocument(opened.storage, RunPolicyDoc.definition.kind, opened.conversationId),
    ).toMatchObject({ work: { effects: "read-only" } });
    mcpTools = [
      defineTool({
        name: "mcp__late__write",
        description: "late",
        parameters: Type.Object({}),
        execute: async () => ({ output: [] }),
      }),
    ];
    for (const notify of mcpListeners) notify();
    await vi.waitFor(async () => {
      const agent = await readDocument(opened.storage, "pi.agent", opened.conversationId);
      expect(JSON.stringify(agent?.extensions)).not.toContain("test-plugin");
      expect(JSON.stringify(agent?.tools)).not.toContain("mcp__late__write");
      expect(JSON.stringify(agent?.tools)).not.toContain('"write"');
    });
  });

  it("tool_search 网关：延迟的 MCP 工具默认不进模型清单，搜索后装入会话模型工具", async () => {
    // 先跑一轮把会话运行时与首轮配置建出来（刷新只在已有运行时上生效）
    faux.setResponses([acknowledgeInput(), fauxAssistantMessage("hello")]);
    await runtime.send(sessionId, "warm up");
    mcpTools = [
      defineTool({
        name: "mcp__demo__call",
        description: "Search the demo knowledge base",
        parameters: Type.Object({}),
        deferred: true,
        execute: async () => ({ output: [] }),
      }),
    ];
    for (const notify of mcpListeners) notify();
    const opened = (await store.open(sessionId))!;
    // 刷新后：tool_search 常驻且扩展已选中；延迟工具处于「已启用但未装载」——
    // 未装载的延迟工具不会出现在模型的清单里（内核 modelTools 规则），故 modelTools 不含它。
    await vi.waitFor(async () => {
      const agent = await readDocument(opened.storage, "pi.agent", opened.conversationId);
      expect(JSON.stringify(agent?.extensions)).toContain("tool-search");
      expect(JSON.stringify(agent?.tools)).toContain(TOOL_SEARCH_TOOL_NAME);
      expect(JSON.stringify(agent?.tools)).toContain("mcp__demo__call");
      expect(JSON.stringify(agent?.modelTools ?? null)).not.toContain("mcp__demo__call");
    });
    faux.setResponses([
      acknowledgeInput(),
      toolResponse(fauxToolCall(TOOL_SEARCH_TOOL_NAME, { query: "demo knowledge base" })),
      fauxAssistantMessage("done"),
    ]);
    await runtime.send(sessionId, "find the demo tools");
    // 命中经 control.addTools 写进会话的 modelTools.add：下一轮开始对模型可见，跨压缩保留
    await vi.waitFor(async () => {
      const agent = await readDocument(opened.storage, "pi.agent", opened.conversationId);
      expect(JSON.stringify(agent?.modelTools)).toContain("mcp__demo__call");
    });
  });

  it("persists messages, authoritative entry links and system instructions", async () => {
    let request: TranscriptContext | undefined;
    faux.setResponses([
      (context) => {
        request = context;
        return fauxAssistantMessage("native answer");
      },
    ]);
    await runtime.send(sessionId, "first question", [], "optimistic-user");
    expect((await runtime.liveSnapshot(sessionId))?.state.running).toBe(false);
    const messages = (await store.loadMessages(sessionId)).messages;
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    const opened = await store.open(sessionId);
    const parentId = messages[1]?.parentId;
    if (opened == null || parentId === undefined || parentId === null)
      throw new Error("Missing native parent");
    expect(await opened.session.getEntry(parentId, BACKGROUND_CONTEXT)).toMatchObject({
      record: { kind: "pi.system" },
    });
    expect(request?.messages.some((message) => message.role === "system")).toBe(true);
    expect((await runtime.liveSnapshot(sessionId))?.state.admittedRequestIds).toContain(
      "optimistic-user",
    );
    expect(
      (await runtime.liveSnapshot(sessionId))?.state.messages.every((message) => message.entryId),
    ).toBe(true);
    expect(runtime.isRunning(sessionId)).toBe(false);
  });

  it("admits concurrent sends in order without aborting the first run", async () => {
    const requests: string[][] = [];
    faux.setResponses([
      (context) => {
        requests.push(textOf(context));
        return fauxAssistantMessage("one");
      },
      (context) => {
        requests.push(textOf(context));
        return fauxAssistantMessage("two");
      },
    ]);
    await Promise.all([runtime.send(sessionId, "first"), runtime.send(sessionId, "second")]);
    await expect
      .poll(
        async () =>
          (await store.loadMessages(sessionId)).messages.filter(
            (message) => message.role === "assistant",
          ).length,
      )
      .toBe(2);
    expect(requests[0]).toEqual(["first"]);
    expect(requests[1]).toEqual(["first", "second"]);
    expect((await runtime.liveSnapshot(sessionId))?.state.running).toBe(false);
  });

  it("runs plugin then host permission hooks and preserves tool result details", async () => {
    const execute = vi.fn(async () => ({
      output: [{ type: "text" as const, text: "tool value" }],
      details: { source: "native" },
    }));
    mcpTools = [
      defineTool({
        name: "mcp__test__call",
        description: "test",
        parameters: Type.Object({}),
        execute,
      }),
    ];
    faux.setResponses([
      acknowledgeInput(),
      toolResponse(fauxToolCall("mcp__test__call", {}, { id: "tool-1" })),
      fauxAssistantMessage("done"),
    ]);
    await runtime.send(sessionId, "use tool");
    expect(execute).toHaveBeenCalledOnce();
    expect(approvals.request).toHaveBeenCalledOnce();
    expect(approvals.request).toHaveBeenCalledWith(
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(pluginHost.dispatch.mock.calls.map(([name]) => name)).toEqual([
      "beforeTool",
      "afterTool",
    ]);
    const parts = (await store.loadMessages(sessionId)).messages.flatMap(
      (message) => message.parts,
    );
    expect(
      parts.find((part) => part.type === "tool-call" && part.toolName === "mcp__test__call"),
    ).toMatchObject({
      result: "tool value",
      details: { source: "native" },
      status: "done",
    });
  });

  it("a plugin block never executes the tool or requests host approval", async () => {
    const execute = vi.fn(async () => ({
      output: [{ type: "text" as const, text: "should not run" }],
    }));
    mcpTools = [
      defineTool({
        name: "mcp__test__call",
        description: "test",
        parameters: Type.Object({}),
        execute,
      }),
    ];
    pluginHost.dispatch.mockImplementation(async (name) =>
      name === "beforeTool" ? { block: "plugin denial", failures: [] } : { failures: [] },
    );
    faux.setResponses([
      acknowledgeInput(),
      toolResponse(fauxToolCall("mcp__test__call", {})),
      fauxAssistantMessage("blocked acknowledged"),
    ]);
    await runtime.send(sessionId, "use tool");
    expect(execute).not.toHaveBeenCalled();
    expect(approvals.request).not.toHaveBeenCalled();
    const parts = (await store.loadMessages(sessionId)).messages.flatMap(
      (message) => message.parts,
    );
    expect(
      parts.find((part) => part.type === "tool-call" && part.toolName === "mcp__test__call"),
    ).toMatchObject({ isError: true });
  });

  it("injects plugin context only into the next provider request", async () => {
    mcpTools = [
      defineTool({
        name: "mcp__test__call",
        description: "test",
        parameters: Type.Object({}),
        execute: async () => ({ output: [] }),
      }),
    ];
    pluginHost.dispatch.mockImplementation(async (name) =>
      name === "afterTool"
        ? { additionalContext: "private follow-up", failures: [] }
        : { failures: [] },
    );
    let request: TranscriptContext | undefined;
    faux.setResponses([
      acknowledgeInput(),
      toolResponse(fauxToolCall("mcp__test__call", {})),
      (context) => {
        request = context;
        return fauxAssistantMessage("done");
      },
    ]);
    await runtime.send(sessionId, "use tool");
    if (request === undefined) throw new Error("Missing model request");
    expect(textOf(request)).toContain("private follow-up");
    expect(
      (await store.loadMessages(sessionId)).messages.filter((message) => message.role === "user"),
    ).toHaveLength(1);
  });

  it("edits in place and sends a selected queued input as steering exactly once", async () => {
    let entered = false;
    let release = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    mcpTools = [
      defineTool({
        name: "mcp__test__hold",
        description: "hold the current step",
        parameters: Type.Object({}),
        execute: async (_args, _api, context) => {
          entered = true;
          context.abortSignal?.addEventListener("abort", release, { once: true });
          await hold;
          return { output: [] };
        },
      }),
    ];
    let nextRequest: string[] = [];
    faux.setResponses([
      acknowledgeInput(),
      toolResponse(fauxToolCall("mcp__test__hold", {})),
      (context) => {
        nextRequest = textOf(context);
        return fauxAssistantMessage("urgent addressed");
      },
      fauxAssistantMessage("follow-up addressed"),
      fauxAssistantMessage("last follow-up addressed"),
    ]);
    const sending = runtime.send(sessionId, "start");
    await expect.poll(() => entered).toBe(true);
    for (const text of ["first", "urgent", "last"])
      await runtime.queue(sessionId, text, "followUp");
    const original = (await runtime.liveSnapshot(sessionId))?.state.queue ?? [];
    const [first, urgent, last] = original;
    if (!first || !urgent || !last) throw new Error("Missing queued inputs");

    await expect(runtime.editQueued(sessionId, first.id, "edited first")).resolves.toBe(true);
    expect((await runtime.liveSnapshot(sessionId))?.state.queue).toEqual([
      { ...first, text: "edited first" },
      urgent,
      last,
    ]);
    await expect(runtime.editQueued(sessionId, last.id, "  ")).rejects.toThrow();
    await Promise.all([
      runtime.sendQueued(sessionId, urgent.id),
      runtime.sendQueued(sessionId, urgent.id),
    ]);
    const immediate = (await runtime.liveSnapshot(sessionId))?.state;
    expect(immediate?.running).toBe(true);
    expect(immediate?.queue.map((item) => item.id)).toEqual([first.id, last.id]);
    expect(
      immediate?.messages
        .filter((message) => message.role === "user")
        .map((message) =>
          message.parts
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join(""),
        ),
    ).toEqual(["start", "urgent"]);

    release();
    await sending;
    await expect.poll(() => runtime.isRunning(sessionId)).toBe(false);
    expect(nextRequest).toContain("urgent");
    expect(nextRequest).not.toContain("edited first");
    const final = (await store.loadMessages(sessionId)).messages.filter(
      (message) => message.role === "user",
    );
    expect(
      final.map((message) =>
        message.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join(""),
      ),
    ).toEqual(["start", "urgent", "edited first", "last"]);
    await expect(runtime.sendQueued(sessionId, urgent.id)).resolves.toBe(false);
    await expect(runtime.editQueued(sessionId, urgent.id, "too late")).resolves.toBe(false);
    await expect(runtime.sendQueued("other-session", first.id)).resolves.toBe(false);
  });

  it("can immediately send an input left queued after a failed run", async () => {
    let entered = false;
    let release = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    mcpTools = [
      defineTool({
        name: "mcp__test__hold",
        description: "hold the current step",
        parameters: Type.Object({}),
        execute: async (_args, _api, context) => {
          entered = true;
          context.abortSignal?.addEventListener("abort", release, { once: true });
          await hold;
          return { output: [] };
        },
      }),
    ];
    faux.setResponses([
      acknowledgeInput(),
      toolResponse(fauxToolCall("mcp__test__hold", {})),
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid request" }),
      fauxAssistantMessage("recovered"),
    ]);
    const sending = runtime.send(sessionId, "start");
    await expect.poll(() => entered).toBe(true);
    await runtime.send(sessionId, "send after failure", [
      {
        kind: "text",
        name: "notes.txt",
        mimeType: "text/plain",
        size: 5,
        data: Buffer.from("notes").toString("base64"),
        text: "notes",
      },
    ]);
    const beforeFailure = (await runtime.liveSnapshot(sessionId))?.state.queue[0];
    if (!beforeFailure) throw new Error("Missing queued attachment");
    expect(beforeFailure.text).toBe("send after failure");
    await runtime.editQueued(sessionId, beforeFailure.id, "edited with attachment");
    release();
    await sending;
    await expect.poll(() => runtime.isRunning(sessionId)).toBe(false);
    const queued = (await runtime.liveSnapshot(sessionId))?.state.queue[0];
    if (!queued) throw new Error("Missing queued input after failure");
    await expect(runtime.sendQueued(sessionId, queued.id)).resolves.toBe(true);
    await expect
      .poll(async () =>
        (await store.loadMessages(sessionId)).messages.some((message) =>
          message.parts.some((part) => part.type === "text" && part.text === "recovered"),
        ),
      )
      .toBe(true);
    expect((await runtime.liveSnapshot(sessionId))?.state.queue).toEqual([]);
    const saved = (await store.loadMessages(sessionId)).messages.find((message) =>
      message.parts.some((part) => part.type === "text" && part.text === "edited with attachment"),
    );
    expect(
      saved?.parts.some((part) => part.type === "attachment" && part.name === "notes.txt"),
    ).toBe(true);
  });

  it("withdraws queued input and propagates cancellation into a running tool", async () => {
    let entered = false;
    let aborted = false;
    mcpTools = [
      defineTool({
        name: "mcp__test__call",
        description: "test",
        parameters: Type.Object({}),
        execute: async (_args, _api, context) => {
          entered = true;
          await new Promise<void>((resolve) => {
            context.abortSignal?.addEventListener(
              "abort",
              () => {
                aborted = true;
                resolve();
              },
              { once: true },
            );
          });
          return { output: [] };
        },
      }),
    ];
    faux.setResponses([acknowledgeInput(), toolResponse(fauxToolCall("mcp__test__call", {}))]);
    const sending = runtime.send(sessionId, "hold tool");
    await expect.poll(() => entered).toBe(true);
    await runtime.queue(sessionId, "remove me", "followUp");
    await expect
      .poll(async () =>
        (await runtime.liveSnapshot(sessionId))?.state.queue.some((item) => /^\d+$/.test(item.id)),
      )
      .toBe(true);
    const queue = (await runtime.liveSnapshot(sessionId))?.state.queue;
    const queuedId = queue?.[0]?.id;
    if (!queuedId) throw new Error("Missing queued input");
    await runtime.cancelQueued(sessionId, queuedId);
    await runtime.stop(sessionId);
    await sending;
    expect(aborted).toBe(true);
    expect(runtime.isRunning(sessionId)).toBe(false);
    expect(
      (await store.loadMessages(sessionId)).messages.filter((message) => message.role === "user"),
    ).toHaveLength(1);
  });

  it("stop during queued attachment preprocessing cannot admit another native run", async () => {
    let entered = false;
    mcpTools = [
      defineTool({
        name: "mcp__test__call",
        description: "hold",
        parameters: Type.Object({}),
        execute: async (_args, _api, context) => {
          entered = true;
          await new Promise<void>((resolve) =>
            context.abortSignal?.addEventListener("abort", () => resolve(), { once: true }),
          );
          return { output: [] };
        },
      }),
    ];
    faux.setResponses([
      acknowledgeInput(),
      toolResponse(fauxToolCall("mcp__test__call", {})),
      fauxAssistantMessage("must not start"),
    ]);
    const original = runtime.send(sessionId, "original");
    await expect.poll(() => entered).toBe(true);
    let release = () => {};
    preprocessing.entered = false;
    preprocessing.wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = runtime.send(
      sessionId,
      "cancel this attachment",
      [
        {
          kind: "text",
          name: "note.txt",
          mimeType: "text/plain",
          size: 4,
          data: Buffer.from("note").toString("base64"),
        },
      ],
      "queued-optimistic",
    );
    try {
      await expect.poll(() => preprocessing.entered).toBe(true);
      await runtime.stop(sessionId);
    } finally {
      release();
    }
    await Promise.all([original, queued]);
    expect(faux.state.callCount).toBe(2);
    expect(
      (await store.loadMessages(sessionId)).messages.filter((message) => message.role === "user"),
    ).toHaveLength(1);
    expect((await runtime.liveSnapshot(sessionId))?.state.running).toBe(false);
    expect(
      events.some(
        ({ event }) => event.type === "input-cancelled" && event.messageId === "queued-optimistic",
      ),
    ).toBe(true);
  });

  it("stop during preprocessing prevents any later native submission or model call", async () => {
    let release = () => {};
    preprocessing.wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    faux.setResponses([fauxAssistantMessage("must not run")]);
    const sending = runtime.send(sessionId, "delayed input");
    try {
      await expect.poll(() => preprocessing.entered).toBe(true);
      await runtime.stop(sessionId);
      expect(runtime.isRunning(sessionId)).toBe(false);
    } finally {
      release();
    }
    await sending;
    expect(faux.state.callCount).toBe(0);
    expect((await store.loadMessages(sessionId)).messages).toEqual([]);
    expect((await runtime.liveSnapshot(sessionId))?.state.running).toBe(false);
  });

  it("forks and selects the edited native conversation", async () => {
    faux.setResponses([fauxAssistantMessage("old"), fauxAssistantMessage("edited")]);
    await runtime.send(sessionId, "original");
    await runtime.send(sessionId, "replacement", [], undefined, { rewindToEntryId: null });
    const messages = (await store.loadMessages(sessionId)).messages;
    expect(messages.map((message) => message.parts[0])).toEqual([
      { type: "text", text: "replacement" },
      { type: "text", text: "edited" },
    ]);
    expect(messages[0]?.parentId).toBeNull();
  });

  it("keeps observing events after an invalid rewind target", async () => {
    faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("still streaming")]);
    await runtime.send(sessionId, "first");
    await runtime.send(sessionId, "invalid", [], undefined, { rewindToEntryId: "entry:999999" });
    events = [];
    await runtime.send(sessionId, "valid after failure");
    expect((await runtime.liveSnapshot(sessionId))?.state.messages.at(-1)?.parts[0]).toEqual({
      type: "text",
      text: "still streaming",
    });
    expect((await runtime.liveSnapshot(sessionId))?.state.running).toBe(false);
  });

  it("reapplies current model, thinking and tools after native historical fork", async () => {
    faux.setResponses([fauxAssistantMessage("first")]);
    await runtime.send(sessionId, "first");
    const cutoff = (await store.loadMessages(sessionId)).messages.at(-1)?.entryId;
    if (cutoff === undefined) throw new Error("Missing cutoff");
    settings.services[0]?.models.push({ id: "second", reasoning: true });
    settings.thinkingLevel = "high";
    expect(await runtime.setModel(sessionId, { serviceId: "svc", modelId: "second" })).toEqual({
      ok: true,
    });
    mcpTools = [
      defineTool({
        name: "mcp__new__call",
        description: "new",
        parameters: Type.Object({}),
        execute: async () => ({ output: [] }),
      }),
    ];
    for (const notify of mcpListeners) notify();
    let actualModel: string | undefined;
    let actualThinking: string | undefined;
    let offered: string[] = [];
    faux.setResponses([
      acknowledgeInput(),
      (context, options, _state, model) => {
        actualModel = model.id;
        actualThinking = options?.reasoning;
        offered = context.messages.flatMap((message) =>
          message.role === "system" ? (message.toolsAdded ?? []).map((tool) => tool.name) : [],
        );
        return fauxAssistantMessage("second");
      },
    ]);
    // Null creates a fresh native conversation; a non-tip old cutoff forces a historical native fork.
    await runtime.send(sessionId, "new tail");
    faux.setResponses([
      acknowledgeInput(),
      (context, options, _state, model) => {
        actualModel = model.id;
        actualThinking = options?.reasoning;
        offered = context.messages.flatMap((message) =>
          message.role === "system" ? (message.toolsAdded ?? []).map((tool) => tool.name) : [],
        );
        return fauxAssistantMessage("fork answer");
      },
    ]);
    await runtime.send(sessionId, "retry with current choices", [], undefined, {
      rewindToEntryId: cutoff,
    });
    expect(actualModel).toBe("second");
    expect(actualThinking).toBe("high");
    expect(offered).toContain("mcp__new__call");
  });

  it("restores todo state at a retry cutoff instead of retaining the abandoned branch", async () => {
    faux.setResponses([
      acknowledgeInput(),
      toolResponse(fauxToolCall("todo", { todos: [{ text: "first task", status: "pending" }] })),
      fauxAssistantMessage("first plan"),
    ]);
    await runtime.send(sessionId, "plan one");
    const cutoff = (await store.loadMessages(sessionId)).messages.at(-1)?.entryId;
    if (cutoff === undefined) throw new Error("Missing todo cutoff");
    faux.setResponses([
      acknowledgeInput(),
      toolResponse(fauxToolCall("todo", { todos: [{ text: "abandoned task", status: "active" }] })),
      fauxAssistantMessage("second plan"),
    ]);
    await runtime.send(sessionId, "plan two");
    faux.setResponses([
      acknowledgeInput(),
      toolResponse(fauxToolCall("todo", { todos: [{ text: "first task", status: "done" }] })),
      fauxAssistantMessage("restored plan"),
    ]);
    await runtime.send(sessionId, "retry first plan", [], undefined, { rewindToEntryId: cutoff });
    const parts = (await store.loadMessages(sessionId)).messages.flatMap(
      (message) => message.parts,
    );
    expect(
      parts.filter((part) => part.type === "tool-call" && part.toolName === "todo").at(-1),
    ).toMatchObject({ details: { revision: 2, todos: [{ text: "first task", status: "done" }] } });
  });

  it("returns nothing for native manual compaction with no history", async () => {
    expect(await runtime.compact(sessionId)).toMatchObject({ ok: false, code: "nothing" });
  });

  it("keeps attachment envelopes and their images together through native submit and history", async () => {
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=";
    let request: TranscriptContext | undefined;
    faux.setResponses([
      (context) => {
        request = context;
        return fauxAssistantMessage("image received");
      },
    ]);
    await runtime.send(sessionId, "look", [
      {
        kind: "image",
        name: "pixel.png",
        mimeType: "image/png",
        size: Buffer.from(png, "base64").length,
        data: png,
        images: [{ mimeType: "image/png", data: png }],
      },
    ]);
    const content = request?.messages.find((message) => message.role === "user")?.content;
    expect(Array.isArray(content) && content.map((block) => block.type)).toEqual([
      "text",
      "text",
      "image",
    ]);
    const message = (await store.loadMessages(sessionId)).messages[0];
    expect(message?.parts[1]).toMatchObject({
      type: "attachment",
      kind: "image",
      name: "pixel.png",
      frames: [{ mimeType: "image/png" }],
    });
  });

  it("refreshes native MCP registrations only once the current work is idle", async () => {
    let release: (() => void) | undefined;
    let entered = false;
    mcpTools = [
      defineTool({
        name: "mcp__test__call",
        description: "hold",
        parameters: Type.Object({}),
        execute: async () => {
          entered = true;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return { output: [] };
        },
      }),
    ];
    const requests: TranscriptContext[] = [];
    faux.setResponses([
      acknowledgeInput(),
      toolResponse(fauxToolCall("mcp__test__call", {})),
      (context) => {
        requests.push(context);
        return fauxAssistantMessage("first done");
      },
      acknowledgeInput(),
      (context) => {
        requests.push(context);
        return fauxAssistantMessage("second done");
      },
    ]);
    const first = runtime.send(sessionId, "use original tools");
    await expect.poll(() => entered).toBe(true);
    mcpTools = [
      defineTool({
        name: "mcp__added__call",
        description: "added",
        parameters: Type.Object({}),
        execute: async () => ({ output: [] }),
      }),
    ];
    for (const notify of mcpListeners) notify();
    release?.();
    await first;
    // The native registry update completes on the idle boundary; an extra notify is harmless.
    for (const notify of mcpListeners) notify();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await runtime.send(sessionId, "use refreshed tools");
    const offered = (context: TranscriptContext | undefined) =>
      context?.messages.flatMap((message) =>
        message.role === "system" ? (message.toolsAdded ?? []).map((tool) => tool.name) : [],
      ) ?? [];
    expect(offered(requests[0])).not.toContain("mcp__added__call");
    expect(offered(requests[1])).toContain("mcp__added__call");
    expect(offered(requests[1])).toContain("ask_user");
    expect(offered(requests[1])).toContain("Task");
  });
  it("runs a child in the shared native family with the dispatch model and exact whitelist", async () => {
    let childModel: string | undefined;
    let childTools: string[] = [];
    faux.setResponses(
      Array.from({ length: 8 }, () => (context, _options, _state, model) => {
        const last = context.messages.filter((message) => message.role !== "system").at(-1);
        if (last?.role === "user" && textOf(context).at(-1) === "delegate")
          return toolResponse(
            fauxToolCall(
              "Task",
              {
                definition: {
                  name: "reader",
                  description: "read",
                  prompt: "Report your findings.",
                  tools: ["read"],
                },
                description: "read one file",
                task: "child-work",
              },
              { id: "native-child" },
            ),
          );
        if (last?.role === "user" && textOf(context).at(-1) === "child-work") {
          childModel = model.id;
          childTools = context.messages.flatMap((message) =>
            message.role === "system" ? (message.toolsAdded ?? []).map((tool) => tool.name) : [],
          );
          return fauxAssistantMessage("child-complete");
        }
        return fauxAssistantMessage("parent-complete");
      }),
    );
    await runtime.send(sessionId, "delegate");
    await vi.waitFor(async () =>
      expect((await runtime.listSubagents(sessionId))[0]?.status).toBe("completed"),
    );
    const [run] = await runtime.listSubagents(sessionId);
    expect(childModel).toBe("test");
    expect(childTools).toEqual(["read"]);
    if (!run) throw new Error("Missing child run");
    const childSession = await store.open(run.childSessionId);
    const rootSession = await store.open(sessionId);
    expect(childSession?.storage).toBe(rootSession?.storage);
    const messages = (await store.loadMessages(sessionId)).messages;
    expect(messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(
      messages
        .flatMap((message) => message.parts)
        .find((part) => part.type === "tool-call" && part.toolCallId === "native-child"),
    ).toMatchObject({ status: "done", details: { status: "completed", report: "child-complete" } });
  });

  it("cold direct child opening restores its family without a creation-promise cycle", async () => {
    const run = await seedPendingChild();
    faux.setResponses([fauxAssistantMessage("recovered child")]);
    await runtime.prepareSubagent(run.childSessionId);
    await vi.waitFor(async () =>
      expect((await runtime.listSubagents(sessionId))[0]?.status).toBe("completed"),
    );
    expect(
      (await store.loadMessages(run.childSessionId)).messages.filter(
        (message) => message.role === "user",
      ),
    ).toHaveLength(1);
  });

  it("a child preparation failure leaves the root usable and child preparation can be retried", async () => {
    const run = await seedPendingChild("unavailable");
    const service = settings.services[0];
    if (!service) throw new Error("Missing fixture provider");
    service.models.push({ id: "unavailable" });
    await runtime.prepareSubagent(sessionId);
    expect((await runtime.listSubagents(sessionId))[0]?.status).toBe("failed");
    service.models = service.models.filter((model) => model.id !== "unavailable");
    await runtime.prepareSubagent(run.childSessionId);
    faux.setResponses([fauxAssistantMessage("root still usable")]);
    await runtime.send(sessionId, "continue");
    expect((await store.loadMessages(sessionId)).messages.at(-1)?.parts[0]).toEqual({
      type: "text",
      text: "root still usable",
    });
  });
});
