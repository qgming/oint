import type { Context } from "@earendil-works/chord";
import { awaitWithContext, BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AgentDoc,
  AssistantEntry,
  type Conversation,
  configure,
  defineExtension,
  defineTask,
  type Harness,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import type { ThinkingLevel } from "@/shared/contracts/common";
import {
  MAX_CONCURRENT_SUBAGENT_RUNS,
  type SubagentEventEnvelope,
  type SubagentRun,
} from "@/shared/contracts/subagent";
import { RunPolicyDoc } from "./execution-policy";
import { detached } from "./native-state";
import { childSessionId, SubagentsDoc } from "./native-subagents";
import type { SubagentStartRequest } from "./tools/subagent";

export interface SubagentRunnerParent {
  sessionId: string;
  cwd: string;
  parentModelId: string;
  parentThinkingLevel?: ThinkingLevel;
}

/** Completed background owner isolates child work from ordinary parent idle/abort. */
const Anchor = defineTask<null, { phase: "done" }, null>({
  name: "oint.subagent-anchor",
  version: 1,
  initial: () => ({ phase: "done" }),
  phases: {
    done: (_task, api, context) =>
      api.commit(
        () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
        context,
      ),
  },
  abort: (_task, api, context) =>
    api.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

export function createSubagentExtension(prepare: (sessionId: string) => Promise<void>) {
  const Reporter = defineTask<{ delegationId: string }, { phase: "deliver" }, null>({
    name: "oint.subagent-reporter",
    version: 1,
    initial: () => ({ phase: "deliver" }),
    phases: {
      deliver: async (task, api, context) => {
        const record = (await api.snapshot(SubagentsDoc, api.conversationId, context))?.runs[
          task.input.delegationId
        ];
        if (!record) throw new Error("子智能体任务缺少持久记录");
        try {
          await awaitWithContext(prepare(record.run.childSessionId), context);
          const child = await api.conversation(record.conversationId, context);
          if (!child) throw new Error("子智能体会话不存在");
          const submission = await child.submit(
            { type: "input", content: record.run.task, requestId: `subagent:${task.id}` },
            context,
          );
          const result = await submission.wait(context);
          await api.commit(async (tx) => {
            const stored = (await tx.doc(SubagentsDoc, api.conversationId)).runs[
              task.input.delegationId
            ];
            if (stored && stored.run.status === "running") {
              stored.run.endedAt = api.now();
              stored.run.updatedAt = api.now();
              if (result.status === "unanswered") {
                stored.run.status = result.reason === "aborted" ? "aborted" : "failed";
                stored.run.error = result.reason;
              } else if (result.type === "input") {
                const answer = (await tx.entry(AssistantEntry, result.answer))?.model?.[0];
                stored.run.status = "completed";
                if (answer?.role === "assistant")
                  stored.run.report = answer.content
                    .flatMap((part) => (part.type === "text" ? [part.text] : []))
                    .join("");
              }
            }
            return { status: "terminal", outcome: { status: "completed", result: null } };
          }, context);
        } catch (error) {
          context.abortSignal?.throwIfAborted();
          await api.commit(async (tx) => {
            const stored = (await tx.doc(SubagentsDoc, api.conversationId)).runs[
              task.input.delegationId
            ];
            if (stored?.run.status === "running") {
              Object.assign(stored.run, {
                status: "failed",
                error: String(error),
                endedAt: api.now(),
                updatedAt: api.now(),
              });
            }
            return { status: "terminal", outcome: { status: "completed", result: null } };
          }, context);
        }
      },
    },
    abort: async (task, api, context) => {
      await api.commit(async (tx) => {
        const stored = (await tx.doc(SubagentsDoc, api.conversationId)).runs[
          task.input.delegationId
        ];
        if (stored?.run.status === "running")
          Object.assign(stored.run, {
            status: "aborted",
            endedAt: api.now(),
            updatedAt: api.now(),
          });
        return { status: "terminal", outcome: { status: "aborted" } };
      }, context);
    },
  });
  return {
    extension: defineExtension({ name: "oint.subagent-tasks", tasks: [Anchor, Reporter] }),
    Reporter,
  };
}

type NativeTasks = ReturnType<typeof createSubagentExtension>;
export function createSubagentRunner(input: {
  harness: Harness;
  conversation: () => Conversation;
  familyId: string;
  parent: () => Promise<SubagentRunnerParent>;
  tasks: NativeTasks;
  emit?: (event: SubagentEventEnvelope) => void;
  report?: (run: SubagentRun) => void;
}) {
  const context = BACKGROUND_CONTEXT;
  const { harness } = input;
  const list = async (): Promise<SubagentRun[]> =>
    Object.values(
      (await harness.snapshot(SubagentsDoc, input.conversation().id, context))?.runs ?? {},
    )
      .map((record) => record.run)
      .sort((a, b) => a.startedAt - b.startedAt);
  const records = async () =>
    (await harness.snapshot(SubagentsDoc, input.conversation().id, context))?.runs ?? {};

  async function start(
    request: SubagentStartRequest,
    api: ToolExecutionApi,
    callContext: Context,
  ): Promise<SubagentRun> {
    const parent = await input.parent();
    return api.commit(async (tx) => {
      const state = await tx.doc(SubagentsDoc, api.conversationId);
      const existing = Object.values(state.runs).find(
        (record) => record.sourceTaskId === api.taskId,
      );
      if (existing) return detached(existing.run);
      const active = [];
      for (const record of Object.values(state.runs)) {
        const task = await tx.task(record.reporterTaskId);
        if (record.run.status === "running" || task?.state.status !== "terminal")
          active.push(record.run);
      }
      if (active.length >= MAX_CONCURRENT_SUBAGENT_RUNS)
        throw new Error(
          `已经有 ${active.length} 个子智能体在跑（上限 ${MAX_CONCURRENT_SUBAGENT_RUNS}）：${active.map((run) => `${run.agentName} (${run.delegationId})`).join("、")}`,
        );
      const background = { ownership: { kind: "conversation" }, background: true } as const;
      const anchorTaskId = await tx.createTask(Anchor, null, background);
      const child = await tx.createConversation({
        ownership: { kind: "task", taskId: anchorTaskId },
      });
      const parentPolicy = await tx.doc(RunPolicyDoc, api.conversationId);
      const childPolicy = await tx.doc(RunPolicyDoc, child.id);
      childPolicy.mode = parentPolicy.mode;
      childPolicy.work = detached(parentPolicy.work);
      const inherited = await tx.doc(AgentDoc, child.id);
      inherited.extensions = [`oint:${child.id}`];
      await configure(tx, child.id, {
        cwd: parent.cwd,
        ...(request.definition.model
          ? {
              model: {
                provider: request.definition.model.serviceId,
                modelId: request.definition.model.modelId,
              },
            }
          : {}),
        thinkingLevel: request.definition.thinkingLevel ?? parent.parentThinkingLevel ?? "off",
      });
      const reporterTaskId = await tx.createTask(
        input.tasks.Reporter,
        { delegationId: request.toolCallId },
        background,
      );
      const run: SubagentRun = {
        delegationId: request.toolCallId,
        sessionId: parent.sessionId,
        parentToolCallId: request.toolCallId,
        childSessionId: childSessionId(input.familyId, child.id),
        agentName: request.definition.name,
        agentSource: request.definition.source,
        description: request.description,
        task: request.task,
        status: "running",
        startedAt: Date.now(),
        model: request.definition.model ?? null,
        modelId: inherited.model?.modelId ?? parent.parentModelId,
        thinkingLevel: request.definition.thinkingLevel ?? parent.parentThinkingLevel ?? "off",
        ...(request.definition.tools ? { tools: request.definition.tools } : {}),
        turns: 0,
        toolCalls: 0,
        ...(request.resumedFrom ? { resumedFrom: request.resumedFrom } : {}),
      };
      state.runs[request.toolCallId] = {
        run,
        definition: structuredClone(request.definition),
        conversationId: child.id,
        anchorTaskId,
        reporterTaskId,
        sourceTaskId: api.taskId,
      };
      return run;
    }, callContext);
  }

  async function stop(
    id: string,
    reason = "主代理停止了这次运行",
    status: "aborted" | "failed" = "aborted",
  ): Promise<SubagentRun | undefined> {
    const record = (await records())[id];
    if (!record) return undefined;
    if (record.run.status !== "running") return record.run;
    await input.conversation().commit(async (tx) => {
      const stored = (await tx.doc(SubagentsDoc, input.conversation().id)).runs[id];
      if (stored?.run.status === "running")
        Object.assign(stored.run, {
          status,
          error: reason,
          endedAt: Date.now(),
          updatedAt: Date.now(),
        });
    }, context);
    await harness.abortTask(record.reporterTaskId, context);
    await (await harness.conversation(record.conversationId, context))?.abort(context, {
      background: true,
    });
    await harness.waitForTask(record.reporterTaskId, context);
    return (await records())[id]?.run;
  }

  async function wait(
    ids: string[] | undefined,
    mode: "all" | "any",
    minCompleted: number,
    timeoutSeconds: number,
    callContext: Context,
  ): Promise<SubagentRun[]> {
    const watch = await harness.watchDoc(SubagentsDoc, input.conversation().id, callContext);
    if (!watch) return [];
    const initial = Object.values(watch.value?.runs ?? {}).map((record) => record.run);
    const selected = new Set(
      initial
        .filter((run) => !ids?.length || ids.includes(run.delegationId))
        .map((run) => run.delegationId),
    );
    if (!selected.size) {
      await watch.stop();
      return [];
    }
    const needed =
      mode === "all" ? selected.size : Math.max(1, Math.min(minCompleted, selected.size));
    const selectedRuns = (state: typeof watch.value) =>
      Object.values(state?.runs ?? {})
        .map((record) => record.run)
        .filter((run) => selected.has(run.delegationId));
    let latest = selectedRuns(watch.value);
    try {
      await new Promise<void>((resolve, reject) => {
        const finish = () => {
          clearTimeout(timer);
          callContext.abortSignal?.removeEventListener("abort", abort);
          resolve();
        };
        const abort = () => {
          clearTimeout(timer);
          reject(callContext.abortSignal?.reason ?? new Error("等待已取消"));
        };
        const timer = setTimeout(finish, Math.max(0, timeoutSeconds) * 1000);
        callContext.abortSignal?.addEventListener("abort", abort, { once: true });
        watch.start(async (state) => {
          latest = selectedRuns(state);
          if (latest.filter((run) => run.status !== "running").length >= needed) finish();
        });
        if (callContext.abortSignal?.aborted) abort();
        else if (latest.filter((run) => run.status !== "running").length >= needed) finish();
      });
      return latest;
    } finally {
      await watch.stop();
    }
  }

  async function attach(): Promise<() => void> {
    const recovered = await records();
    for (const record of Object.values(recovered)) {
      const child = await harness.conversation(record.conversationId, context);
      if (!child) continue;
      let cursor: import("@earendil-works/pi-durable").Cursor | undefined;
      let turns = 0,
        toolCalls = 0,
        lastEntryId = 0;
      do {
        const page = await child.entries({}, 500, cursor, context);
        for (const entry of page.items) {
          lastEntryId = Math.max(lastEntryId, entry.id);
          const message = entry.model?.[0];
          if (message?.role === "assistant") turns++;
          else if (message?.role === "toolResult") toolCalls++;
        }
        cursor = page.next;
      } while (cursor !== undefined);
      await input.conversation().commit(async (tx) => {
        const stored = (await tx.doc(SubagentsDoc, input.conversation().id)).runs[
          record.run.delegationId
        ];
        if (stored && (stored.progressEntryId ?? 0) <= lastEntryId) {
          Object.assign(stored.run, { turns, toolCalls });
          stored.progressEntryId = lastEntryId;
        }
      }, context);
    }
    await input.conversation().commit(async (tx) => {
      await tx.doc(SubagentsDoc, input.conversation().id);
    }, context);
    const watch = await harness.watchDoc(SubagentsDoc, input.conversation().id, context);
    watch?.start(async (state) => {
      for (const record of Object.values(state?.runs ?? {})) {
        input.emit?.({
          sessionId: record.run.sessionId,
          event: { type: "run-updated", run: record.run },
        });
        if (record.run.status !== "running") input.report?.(record.run);
      }
    });
    // Native entry IDs make this derived progress projection idempotent across replay and restart.
    const unsubscribe = harness.subscribeCommits((publication) => {
      const entries = publication.changes.flatMap((change) =>
        change.type === "entry" ? [change.value] : [],
      );
      if (!entries.length) return;
      queueMicrotask(() => {
        void input
          .conversation()
          .commit(async (tx) => {
            const state = await tx.doc(SubagentsDoc, input.conversation().id);
            for (const entry of entries) {
              const stored = Object.values(state.runs).find(
                (record) => record.conversationId === entry.conversationId,
              );
              if (!stored || entry.id <= (stored.progressEntryId ?? 0)) continue;
              stored.progressEntryId = entry.id;
              const message = entry.model?.[0];
              if (message?.role === "assistant") {
                stored.run.turns++;
                const text = message.content
                  .flatMap((part) => (part.type === "text" ? [part.text] : []))
                  .join("");
                if (text) stored.run.report = text;
              } else if (message?.role === "toolResult") stored.run.toolCalls++;
              stored.run.updatedAt = Date.now();
            }
          }, context)
          .catch(() => undefined);
      });
    });
    return () => {
      unsubscribe();
      void watch?.stop();
    };
  }
  return {
    start,
    list,
    stop,
    wait,
    attach,
    abortAll: async (reason: string) => {
      for (const run of await list())
        if (run.status === "running") await stop(run.delegationId, reason);
    },
  };
}

export type SubagentRunner = ReturnType<typeof createSubagentRunner>;
