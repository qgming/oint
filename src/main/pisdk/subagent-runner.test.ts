import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  type Conversation,
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_CONCURRENT_SUBAGENT_RUNS } from "@/shared/contracts/subagent";
import { RunPolicyDoc } from "./execution-policy";
import { parseSessionAddress, SubagentsDoc } from "./native-subagents";
import { createSessionStore, type SessionStore } from "./session-store";
import {
  createSubagentExtension,
  createSubagentRunner,
  type SubagentRunner,
} from "./subagent-runner";

function required<T>(value: T | undefined | null): T {
  if (value == null) throw new Error("Missing native test fixture value");
  return value;
}
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(options: { blocked?: boolean; many?: number } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oint-native-subagent-"));
  cleanup.push(() =>
    rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  );
  let store: SessionStore = createSessionStore(directory);
  cleanup.push(() => store.close());
  const rootSession = await store.create();
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  let release = () => {};
  let blocked = options.blocked === true;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let harness: Harness;
  let root: Conversation;
  let runner: SubagentRunner;
  let detach = () => {};
  let lastApi: ToolExecutionApi | undefined;
  const registry = createRegistry();
  const tasks = createSubagentExtension(async (id) => {
    if (blocked) await barrier;
    const address = required(parseSessionAddress(id));
    const child = required(await harness.conversation(required(address.conversationId), context));
    const extension = defineExtension({ name: `oint:${child.id}` });
    registry.install(extension);
    await child.configure(
      { extensions: [extension], model: { provider: "faux", modelId: "faux-1" } },
      context,
    );
  });
  const request = (id: string) => ({
    toolCallId: id,
    definition: {
      name: "reader",
      description: "read",
      prompt: "report",
      source: "builtin" as const,
    },
    description: "research",
    task: "child task",
  });
  const tool = defineTool({
    name: "Task",
    description: "delegate",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async (_args, api, callContext) => {
      lastApi = api;
      const first = await runner.start(request(api.callId), api, callContext);
      const second = await runner.start(request(api.callId), api, callContext);
      expect(first.childSessionId).toBe(second.childSessionId);
      return {
        content: [{ type: "text", text: first.childSessionId }],
        details: first as unknown as JsonValue,
      };
    },
  });
  registry.install(tasks.extension);
  const app = defineExtension({ name: "test-app", tools: [tool] });
  registry.install(app);
  faux.setResponses(
    Array.from({ length: 30 }, () => (input) => {
      const last = input.messages.filter((message) => message.role !== "system").at(-1);
      const text =
        typeof last?.content === "string"
          ? last.content
          : (last?.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("") ??
            "");
      if (text === "launch")
        return fauxAssistantMessage(
          Array.from({ length: options.many ?? 1 }, (_, index) =>
            fauxToolCall("Task", {}, { id: `call-${index}` }),
          ),
          { stopReason: "toolUse" },
        );
      return fauxAssistantMessage(text === "child task" ? "child report" : "parent done");
    }),
  );
  async function open() {
    const opened = required(await store.open(rootSession.id));
    harness = await opened.session.bindHarness(() =>
      Harness.open(opened.storage, { registry, models }, context),
    );
    root = required(await harness.conversation(opened.conversationId, context));
    await root.configure(
      { extensions: [app], model: { provider: "faux", modelId: "faux-1" } },
      context,
    );
    runner = createSubagentRunner({
      harness,
      conversation: () => root,
      familyId: rootSession.id,
      tasks,
      parent: async () => ({
        sessionId: rootSession.id,
        cwd: rootSession.cwd,
        parentModelId: "faux-1",
      }),
    });
    detach = await runner.attach();
  }
  await open();
  cleanup.push(async () => {
    detach();
    await harness.close(context);
  });
  return {
    get store() {
      return store;
    },
    get harness() {
      return harness;
    },
    get root() {
      return root;
    },
    get runner() {
      return runner;
    },
    directory,
    rootSession,
    faux,
    lastApi: () => lastApi,
    launch: async () =>
      (await root.submit({ type: "input", content: "launch" }, context)).wait(context),
    unblock: () => {
      blocked = false;
      release();
    },
    restart: async () => {
      detach();
      await harness.close(context);
      await store.close();
      store = createSessionStore(directory);
      await open();
      harness.resume();
    },
  };
}

describe("native background delegation", () => {
  it("persists the dispatch constraint ceiling through family reopen", async () => {
    const f = await fixture({ blocked: true });
    await f.harness.commit(async (tx) => {
      const policy = await tx.doc(RunPolicyDoc, f.root.id);
      policy.mode = "orchestrate";
      policy.work = {
        workId: "research",
        revision: 1,
        requirementsRevision: 0,
        effects: "read-only",
        requiresReview: true,
        pendingInputIds: [],
        approvedPlanRef: null,
      };
    }, context);
    await f.launch();
    const [run] = await f.runner.list();
    const child = required(await f.store.open(required(run).childSessionId));
    const childId = child.conversationId;
    expect(await f.harness.snapshot(RunPolicyDoc, childId, context)).toMatchObject({
      mode: "orchestrate",
      work: { workId: "research", effects: "read-only" },
    });
    await f.restart();
    expect(await f.harness.snapshot(RunPolicyDoc, childId, context)).toMatchObject({
      work: { workId: "research", effects: "read-only" },
    });
    f.unblock();
    await f.runner.wait(undefined, "all", 1, 5, context);
  });
  it("returns immediately, creates one child per task, shares storage, and never wakes the parent", async () => {
    const f = await fixture({ blocked: true });
    await f.launch();
    const [run] = await f.runner.list();
    expect(run?.status).toBe("running");
    expect(
      (await readdir(path.join(f.directory, "sessions-v1"))).filter((file) =>
        file.endsWith(".sqlite"),
      ),
    ).toEqual([`${f.rootSession.id}.sqlite`]);
    const child = required(await f.store.open(required(run).childSessionId));
    const parent = required(await f.store.open(f.rootSession.id));
    expect(child.storage).toBe(parent.storage);
    const native = await f.harness.snapshot(SubagentsDoc, f.root.id, context);
    expect(Object.keys(required(native).runs)).toHaveLength(1);
    f.unblock();
    const complete = await f.runner.wait(undefined, "all", 1, 5, context);
    expect(complete[0]).toMatchObject({ status: "completed", report: "child report" });
    const history = (await f.root.entries({}, 100, undefined, context)).items;
    expect(
      history.some((entry) =>
        entry.model?.some((message) => message.role === "toolResult" && message.isError),
      ),
    ).toBe(false);
    const parentUsers = history.filter((entry) => entry.kind === "pi.user");
    expect(parentUsers).toHaveLength(1);
    expect(
      (await f.store.loadMessages(required(run).childSessionId)).messages.length,
    ).toBeGreaterThan(0);
    await child.session.close();
    expect((await f.root.agent(context)).model?.modelId).toBe("faux-1");
    await f.store.remove(f.rootSession.id);
    expect(await f.store.open(required(run).childSessionId)).toBeUndefined();
  });

  it("resumes native reporter after closing storage, without a duplicate child or input", async () => {
    const f = await fixture({ blocked: true });
    await f.launch();
    const before = await f.runner.list();
    await f.restart();
    f.unblock();
    const after = await f.runner.wait(undefined, "all", 1, 5, context);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      childSessionId: required(before[0]).childSessionId,
      status: "completed",
    });
    const child = required(await f.store.open(required(after[0]).childSessionId));
    expect(
      (await child.session.allEntries()).filter((entry) => entry.record.kind === "pi.user"),
    ).toHaveLength(1);
  });

  it("serializes concurrent admissions in one native commit and preserves timeout and stop semantics", async () => {
    const f = await fixture({ blocked: true, many: MAX_CONCURRENT_SUBAGENT_RUNS + 1 });
    await f.launch();
    const runs = await f.runner.list();
    expect(runs).toHaveLength(MAX_CONCURRENT_SUBAGENT_RUNS);
    expect(await f.runner.wait(undefined, "any", 2, 0.01, context)).toHaveLength(runs.length);
    await f.runner.stop(required(runs[0]).delegationId);
    const waiting = f.runner.wait(undefined, "any", 2, 5, context);
    await f.runner.stop(required(runs[1]).delegationId);
    expect((await waiting).filter((run) => run.status === "aborted")).toHaveLength(2);
    await f.runner.abortAll("parent new input");
    expect((await f.runner.list()).every((run) => run.status === "aborted")).toBe(true);
    f.unblock();
  });
});
