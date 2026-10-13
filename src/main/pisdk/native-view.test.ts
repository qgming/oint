import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { applyImmutable } from "@earendil-works/chord/delta";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  type ConversationRetryPolicy,
  type ConversationView,
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  MemoryStorage,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatLiveSnapshot, ChatViewFrame } from "@/shared/contracts/chat";
import type { SubagentRun } from "@/shared/contracts/subagent";
import { AppSessionHandle } from "./durable-session";
import { JobsDoc } from "./jobs";
import { mapEntriesToMessages } from "./message-mapper";
import { MODEL_RETRY_POLICY } from "./model-retry";
import { compactionReceipt } from "./native-operations";
import { ApprovalDoc } from "./native-state";
import { type NativeSubagent, SubagentsDoc } from "./native-subagents";
import { createNativeView } from "./native-view";
import { beginWork, GoalDoc, PlanDoc, readWorkflow, registerWorkInput } from "./workflow";

const close: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const end of close.splice(0).reverse()) await end();
});
async function fixture(
  tools: ToolRegistration[] = [],
  retry: Partial<ConversationRetryPolicy> = { enabled: false },
) {
  const provider = fauxProvider({ models: [{ id: "test" }], tokensPerSecond: 100000 });
  const models = createModels();
  models.setProvider(provider.provider);
  const registry = createRegistry();
  registry.install(defineExtension({ name: "test", tools }));
  const storage = new MemoryStorage();
  const harness = await Harness.open(
    storage,
    { models, registry, settings: { retry, stream: { maxRetries: 0 } } },
    context,
  );
  const conversation = await harness.root(context, {
    agent: { model: { provider: provider.provider.id, modelId: "test" } },
  });
  const session = new AppSessionHandle(
    storage,
    { id: "fixture", createdAt: 1 },
    conversation.id,
    () => {},
  );
  await session.bindHarness(async () => harness);
  close.push(() => session.close());
  await conversation.commit(async (tx) => {
    await tx.doc(SubagentsDoc, conversation.id);
    await tx.doc(JobsDoc, conversation.id);
    await tx.doc(ApprovalDoc, conversation.id);
  }, context);
  const frames: ChatViewFrame[] = [];
  const view = await createNativeView({
    harness,
    conversation,
    session,
    emit: (event) => {
      if (event.type === "view") frames.push(structuredClone(event.frame));
    },
  });
  close.push(() => view.stop());
  return { provider, registry, storage, harness, conversation, session, view, frames };
}
function replay(frames: ChatViewFrame[]): ChatLiveSnapshot | undefined {
  let result: ChatLiveSnapshot | undefined;
  for (const frame of frames) {
    if ("state" in frame) result = frame;
    else {
      if (!result || frame.previousRevision !== result.revision) throw new Error("Revision gap");
      result = {
        generation: frame.generation,
        revision: frame.revision,
        state: applyImmutable(result.state, frame.ops),
      };
    }
  }
  return result;
}

describe("committed native conversation projection", () => {
  it("projects independent goal, plan and work documents and restores their composed view", async () => {
    const f = await fixture();
    const work = await beginWork(f.harness, f.conversation.id, {
      effects: "read-only",
      requiresReview: true,
    });
    await f.harness.commit(async (tx) => {
      const goals = await tx.doc(GoalDoc, f.conversation.id);
      goals.goal = {
        id: "goal",
        workId: work.workId,
        revision: 1,
        objective: "Research",
        scope: "research",
        criteria: ["Plan delivered"],
        status: "active",
        progress: "",
        continuationCount: 0,
        continuationLimit: 2,
      };
      goals.revision++;
      const plans = await tx.doc(PlanDoc, f.conversation.id);
      plans.plan = {
        id: "plan",
        workId: work.workId,
        revision: 1,
        requirementsRevision: 0,
        status: "ready",
        title: "Approach",
        markdown: "# Approach\nInvestigate and verify",
      };
      plans.revision++;
    }, context);
    await f.view.flush();
    expect(f.view.snapshot.state.workflow).toEqual(
      await readWorkflow(f.harness, f.conversation.id),
    );
    const originalPlan = f.view.snapshot.state.workflow!.plan;
    await registerWorkInput(f.harness, f.conversation.id, "explain");
    await f.view.flush();
    expect(f.view.snapshot.state.workflow!.plan).toEqual(originalPlan);
    expect(f.view.snapshot.state.workflow!.work?.pendingInputIds).toEqual(["explain"]);
    const reopened = await createNativeView({
      harness: f.harness,
      conversation: f.conversation,
      session: f.session,
      emit: () => {},
    });
    close.push(() => reopened.stop());
    expect(reopened.snapshot.state.workflow).toEqual(f.view.snapshot.state.workflow);
    expect(reopened.snapshot.state.workflow!.execution).toBeNull();
    expect(replay(f.frames)).toEqual(f.view.snapshot);
  });

  it("exhausts exactly five retries, preserves every attempt, and restores terminal feedback", async () => {
    const f = await fixture([], { ...MODEL_RETRY_POLICY, baseDelayMs: 1 });
    f.provider.setResponses(
      Array.from({ length: 7 }, (_, index) =>
        fauxAssistantMessage(`partial ${index}`, {
          stopReason: "error",
          errorMessage: `503 outage ${index}`,
        }),
      ),
    );
    await (await f.conversation.submit({ type: "input", content: "work" }, context)).wait(context);
    await f.view.flush();
    const state = f.view.snapshot.state;
    expect(f.provider.state.callCount).toBe(6);
    expect(state.retry).toMatchObject({
      phase: "failed",
      attempt: 5,
      maxAttempts: 5,
      error: "503 outage 5",
    });
    const attempts = state.messages.filter((message) => message.role === "assistant");
    expect(attempts).toHaveLength(6);
    expect(new Set(attempts.map((message) => message.generationId)).size).toBe(1);
    expect(attempts.at(-1)?.generationId).toBe(state.retry?.generationId);
    expect(attempts.map((message) => message.parts)).toEqual(
      Array.from({ length: 6 }, (_, index) => [{ type: "text", text: `partial ${index}` }]),
    );
    expect(state.messages.filter((message) => message.role === "user")).toHaveLength(1);
    const page = await f.session.newestPage(40, undefined, context);
    expect(mapEntriesToMessages(page.entries).messages).toEqual(state.messages);
    const reopened = await createNativeView({
      harness: f.harness,
      conversation: f.conversation,
      session: f.session,
      emit: () => {},
    });
    close.push(() => reopened.stop());
    expect(reopened.snapshot.state.retry).toEqual(state.retry);
    expect(replay(f.frames)).toEqual(f.view.snapshot);
  });

  it("keeps feedback throughout a retry request, clears on success, and never repeats a tool", async () => {
    let toolCalls = 0;
    const tool = defineTool({
      name: "once",
      parameters: Type.Object({}),
      description: "execute once",
      execute: async () => {
        toolCalls++;
        return { output: [{ type: "text", text: "saved" }] };
      },
    });
    const f = await fixture([tool], { ...MODEL_RETRY_POLICY, baseDelayMs: 1 });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let retryEntered = false;
    f.provider.setResponses([
      fauxAssistantMessage(fauxToolCall("once", {}, { id: "once-1" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("kept partial", {
        stopReason: "error",
        errorMessage: "Request timed out.",
      }),
      async () => {
        retryEntered = true;
        await gate;
        return fauxAssistantMessage("recovered");
      },
    ]);
    const request = await f.conversation.submit({ type: "input", content: "work" }, context);
    try {
      await expect.poll(() => retryEntered).toBe(true);
      await f.view.flush();
      expect(f.view.snapshot.state.retry).toMatchObject({
        phase: "retrying",
        attempt: 1,
        maxAttempts: 5,
        error: "Request timed out.",
      });
      const reopened = await createNativeView({
        harness: f.harness,
        conversation: f.conversation,
        session: f.session,
        emit: () => {},
      });
      close.push(() => reopened.stop());
      expect(reopened.snapshot.state.retry).toEqual(f.view.snapshot.state.retry);
    } finally {
      release();
    }
    await request.wait(context);
    await f.view.flush();
    expect(f.view.snapshot.state.retry).toBeNull();
    expect(toolCalls).toBe(1);
    expect(f.provider.state.callCount).toBe(3);
    expect(
      f.view.snapshot.state.messages.filter((message) => message.role === "user"),
    ).toHaveLength(1);
    expect(
      f.view.snapshot.state.messages.some((message) => message.error === "Request timed out."),
    ).toBe(true);
  });

  it.each(["401 invalid API key", "429 insufficient_quota", "400 invalid model"])(
    "reports permanent error %s immediately with zero retries",
    async (error) => {
      const f = await fixture([], { ...MODEL_RETRY_POLICY, baseDelayMs: 1 });
      f.provider.setResponses([
        fauxAssistantMessage("", { stopReason: "error", errorMessage: error }),
      ]);
      await (await f.conversation.submit({ type: "input", content: "work" }, context)).wait(
        context,
      );
      await f.view.flush();
      expect(f.provider.state.callCount).toBe(1);
      expect(f.view.snapshot.state.retry).toMatchObject({ phase: "failed", attempt: 0, error });
    },
  );

  it("cancels a retry backoff without another model request or terminal error banner", async () => {
    const f = await fixture([], { ...MODEL_RETRY_POLICY, baseDelayMs: 10_000 });
    f.provider.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 down" }),
    ]);
    const request = await f.conversation.submit({ type: "input", content: "work" }, context);
    await expect.poll(() => f.view.snapshot.state.retry?.phase).toBe("retrying");
    await f.conversation.abort(context);
    await request.wait(context);
    await f.view.flush();
    expect(f.provider.state.callCount).toBe(1);
    expect(f.view.snapshot.state.running).toBe(false);
    expect(f.view.snapshot.state.retry).toBeNull();
  });

  it("cancels an in-flight retry and clears its restored feedback", async () => {
    const f = await fixture([], { ...MODEL_RETRY_POLICY, baseDelayMs: 1 });
    let entered = false;
    let aborted = false;
    f.provider.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 down" }),
      async (_messages, options) => {
        entered = true;
        await new Promise<void>((resolve) => {
          const abort = () => {
            aborted = true;
            resolve();
          };
          if (options?.signal?.aborted) abort();
          else options?.signal?.addEventListener("abort", abort, { once: true });
        });
        return fauxAssistantMessage("", { stopReason: "aborted" });
      },
    ]);
    const request = await f.conversation.submit({ type: "input", content: "work" }, context);
    await expect.poll(() => entered).toBe(true);
    await f.conversation.abort(context);
    await request.wait(context);
    await f.view.flush();
    expect(aborted).toBe(true);
    expect(f.provider.state.callCount).toBe(2);
    expect(f.view.snapshot.state.retry).toBeNull();
  });

  it("clears old failures on a new run and resets the budget after a successful tool generation", async () => {
    const f = await fixture(
      [
        defineTool({
          name: "once",
          parameters: Type.Object({}),
          description: "execute once",
          execute: async () => ({ output: [{ type: "text", text: "saved" }] }),
        }),
      ],
      { ...MODEL_RETRY_POLICY, baseDelayMs: 1 },
    );
    f.provider.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 bad key" }),
    ]);
    await (await f.conversation.submit({ type: "input", content: "first" }, context)).wait(context);
    await f.view.flush();
    const oldGeneration = f.view.snapshot.state.retry?.generationId;
    expect(oldGeneration).toBeDefined();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    f.provider.setResponses([
      async () => {
        entered = true;
        await gate;
        return fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 brief" });
      },
      fauxAssistantMessage(fauxToolCall("once", {}, { id: "once-2" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 final" }),
    ]);
    const request = await f.conversation.submit({ type: "input", content: "second" }, context);
    try {
      await expect.poll(() => entered).toBe(true);
      await f.view.flush();
      expect(f.view.snapshot.state.retry).toBeNull();
    } finally {
      release();
    }
    await request.wait(context);
    await f.view.flush();
    expect(f.view.snapshot.state.retry).toMatchObject({
      phase: "failed",
      attempt: 0,
      error: "401 final",
    });
    expect(f.view.snapshot.state.retry?.generationId).not.toBe(oldGeneration);
  });

  it("streams the native view and produces the same final messages as paged history", async () => {
    const f = await fixture();
    f.provider.setResponses([fauxAssistantMessage("complete reply")]);
    await (
      await f.conversation.submit(
        { type: "input", content: "hello", requestId: "optimistic" },
        context,
      )
    ).wait(context);
    await f.view.flush();
    expect(f.view.snapshot.state.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(f.view.snapshot.state.admittedRequestIds).toContain("optimistic");
    expect(f.view.snapshot.state.running).toBe(false);
    expect(f.view.snapshot.state.usage.outputTokens).toBeGreaterThan(0);
    expect(replay(f.frames)).toEqual(f.view.snapshot);
    expect(f.view.snapshot.state.messages.every((message) => message.id === message.entryId)).toBe(
      true,
    );
  });
  it("reconnects during a running tool with retained output, details and no replayed user input", async () => {
    let release = () => {};
    let entered = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tool = defineTool({
      name: "hold",
      parameters: Type.Object({}),
      description: "hold",
      execute: async (_args, api, context) => {
        api.output("retained output");
        await api.details({ stage: "waiting" }, context);
        entered = true;
        await gate;
        return { output: [{ type: "text", text: "finished" }], details: { stage: "done" } };
      },
    });
    const f = await fixture([tool]);
    f.provider.setResponses([
      fauxAssistantMessage(fauxToolCall("hold", {}, { id: "hold-1" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    const running = await f.conversation.submit({ type: "input", content: "work" }, context);
    try {
      await expect.poll(() => entered).toBe(true);
      const connected = await createNativeView({
        harness: f.harness,
        conversation: f.conversation,
        session: f.session,
        emit: () => {},
      });
      close.push(() => connected.stop());
      expect(
        connected.snapshot.state.messages
          .flatMap((message) => message.parts)
          .find((part) => part.type === "tool-call"),
      ).toMatchObject({
        partialOutput: "retained output",
        details: { stage: "waiting" },
        status: "running",
      });
      expect(
        connected.snapshot.state.messages.filter((message) => message.role === "user"),
      ).toHaveLength(1);
    } finally {
      release();
    }
    await running.wait(context);
    await f.view.flush();
    expect(
      f.view.snapshot.state.messages
        .flatMap((message) => message.parts)
        .find((part) => part.type === "tool-call"),
    ).toMatchObject({ status: "done", result: "finished", details: { stage: "done" } });
  });
  it("observes native bounded-watch reset and catches up without reconstructing missing events", async () => {
    const f = await fixture();
    const delayed = await f.conversation.watch(context);
    close.push(() => delayed.stop());
    for (let index = 0; index < 125; index++)
      await f.conversation.commit(
        (tx) =>
          tx.appendEntry(f.conversation.id, {
            kind: "pi.user",
            model: [{ role: "user", content: `message ${index}`, timestamp: index }],
          }),
        context,
      );
    let recovered: ConversationView | undefined;
    let reset = false;
    delayed.start(async (value, ops) => {
      recovered = value;
      reset ||= ops[0]?.[0] === "r";
    });
    await expect.poll(() => recovered?.entries.length).toBe(125);
    expect(reset).toBe(true);
    await f.view.flush();
    expect(f.view.snapshot.state.messages).toHaveLength(125);
    expect(replay(f.frames)).toEqual(f.view.snapshot);
  });
  it("publishes durable reports after the original tool entry leaves active context without a model wake", async () => {
    const run: SubagentRun = {
      delegationId: "delegate",
      parentToolCallId: "delegate",
      sessionId: "root",
      childSessionId: "root~child",
      agentName: "reader",
      agentSource: "builtin",
      description: "read",
      task: "read",
      status: "running",
      startedAt: 1,
      model: null,
      modelId: "test",
      thinkingLevel: "off",
      turns: 0,
      toolCalls: 0,
    };
    const tool = defineTool({
      name: "Task",
      description: "delegate",
      parameters: Type.Object({}),
      execute: async () => ({ output: [{ type: "text", text: "started" }] }),
    });
    const f = await fixture([tool]);
    f.provider.setResponses([
      fauxAssistantMessage(fauxToolCall("Task", {}, { id: "delegate" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("parent done"),
    ]);
    await (await f.conversation.submit({ type: "input", content: "delegate" }, context)).wait(
      context,
    );
    await f.conversation.commit(
      (tx) =>
        tx.appendEntry(f.conversation.id, {
          kind: "pi.compaction",
          head: "self",
          model: [{ role: "user", content: "summary", timestamp: 9 }],
        }),
      context,
    );
    await f.view.flush();
    expect(f.view.snapshot.state.messages).toEqual([]);
    const calls = f.provider.state.callCount;
    await f.conversation.commit(async (tx) => {
      (await tx.doc(SubagentsDoc, f.conversation.id)).runs.delegate = {
        run: { ...run, status: "completed", report: "durable report" },
      } as unknown as NativeSubagent;
    }, context);
    await f.view.flush();
    expect(f.view.snapshot.state.reports.delegate?.text).toContain("durable report");
    expect(f.view.snapshot.state.running).toBe(false);
    expect(f.provider.state.callCount).toBe(calls);
    const reopened = await createNativeView({
      harness: f.harness,
      conversation: f.conversation,
      session: f.session,
      emit: () => {},
    });
    close.push(() => reopened.stop());
    expect(reopened.snapshot.state.reports.delegate).toEqual(
      f.view.snapshot.state.reports.delegate,
    );
  });
  it("projects native failed submission receipts and declined manual compaction", async () => {
    const f = await fixture();
    const compact = await f.conversation.compact(undefined, context);
    expect((await compactionReceipt(f.harness, compact)).status).toBe("declined");
    f.provider.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider failed" }),
    ]);
    await (await f.conversation.submit({ type: "input", content: "fail" }, context)).wait(context);
    await f.view.flush();
    expect(f.view.snapshot.state.running).toBe(false);
    expect(f.view.snapshot.state.messages.some((message) => message.status === "error")).toBe(true);
    expect(f.view.snapshot.state.compaction?.phase).toBe("cancelled");
  });
});
