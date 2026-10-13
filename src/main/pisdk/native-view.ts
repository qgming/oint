import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { diffRevisions } from "@earendil-works/chord/delta";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  Conversation,
  ConversationDocToken,
  ConversationView,
  EntryRecord,
  Harness,
  InboxState,
  JsonObject,
  LiveState,
  SubmissionRecord,
  TaskRecord,
  UsageState,
} from "@earendil-works/pi-durable";
import type {
  ChatEvent,
  ChatLiveSnapshot,
  ChatLiveState,
  SessionCompaction,
} from "@/shared/contracts/chat";
import type { SessionTokenUsage } from "@/shared/contracts/session";
import type { WorkflowState } from "@/shared/contracts/workflow";
import { parseAttachmentEnvelope } from "./attachments";
import type { AppEntry, AppSessionHandle } from "./durable-session";
import { JobsDoc } from "./jobs";
import { mapEntriesToMessages } from "./message-mapper";
import { modelGenerationId, projectModelRetry } from "./model-retry";
import { type JobReportRecord, nativeReports, projectReportMessages } from "./native-reports";
import { ApprovalDoc, detached, TodoDoc } from "./native-state";
import { type NativeSubagent, SubagentsDoc } from "./native-subagents";
import {
  emptyWorkflow,
  GoalDoc,
  PlanDoc,
  PlanExecutionDoc,
  readWorkflow,
  WorkDoc,
} from "./workflow";

export function usageTotals(ledger: UsageState | undefined): SessionTokenUsage {
  const result = {
    uncachedInputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  for (const bucket of [
    ...Object.values(ledger?.models ?? {}),
    ...Object.values(ledger?.tools ?? {}),
  ]) {
    result.uncachedInputTokens += bucket.input;
    result.outputTokens += bucket.output;
    result.cacheReadTokens += bucket.cacheRead;
    result.cacheWriteTokens += bucket.cacheWrite;
  }
  return result;
}

export interface ViewExtras {
  workflow?: WorkflowState;
  agents?: { runs: Record<string, NativeSubagent> };
  jobs?: { entries: Record<string, JobReportRecord> };
  approvals?: { entries: Record<string, { ownerTaskId: number; record?: unknown }> };
  submission?: SubmissionRecord;
  submissions?: readonly SubmissionRecord[];
  compaction?: TaskRecord<JsonValue, JsonValue, JsonValue>;
}

function entryTime(entry: EntryRecord, fallback: number): number {
  const message = entry.model?.[0];
  return message && "timestamp" in message ? message.timestamp : fallback;
}

/** Pure projection: stream text, retained tool output and queue always come from native documents. */
export function projectConversationView(
  view: ConversationView,
  extras: ViewExtras = {},
  createdAt = 0,
  parents?: ReadonlyMap<number, string | null>,
): ChatLiveState {
  const live = view.docs["pi.live"] as LiveState | undefined;
  const inbox = view.docs["pi.inbox"] as InboxState | undefined;
  const records = [...view.entries].sort((left, right) => left.id - right.id);
  const entries: AppEntry[] = records.map((record, index) => ({
    record,
    entryId: `entry:${record.id}`,
    parentId: parents?.get(record.id) ?? (index ? `entry:${records[index - 1]?.id}` : null),
    sequence: record.id,
    createdAt: entryTime(record, createdAt),
  }));
  let messages = mapEntriesToMessages(entries).messages;
  const partial = live?.generation?.message as AssistantMessage | undefined;
  if (partial) {
    const latestId = records.at(-1)?.id ?? 0;
    const projected = mapEntriesToMessages([
      {
        record: {
          id: 1,
          conversationId: view.conversation.id,
          kind: "pi.assistant",
          model: [partial],
        } as unknown as EntryRecord,
        entryId: "partial",
        parentId: latestId ? `entry:${latestId}` : null,
        sequence: 0,
        createdAt: partial.timestamp,
      },
    ]).messages[0];
    if (projected) {
      delete projected.entryId;
      projected.id = `live:${live?.run?.taskId ?? view.conversation.id}:${latestId}`;
      projected.status = "streaming";
      if (live?.run)
        projected.generationId = modelGenerationId(view.conversation.id, live.run.taskId);
      messages.push(projected);
    }
  }
  // Steering has been sent by the user. Show it immediately while the native
  // scheduler waits for the current model/tool step to reach a safe boundary.
  // Its durable user entry replaces this projection when the inbox consumes it.
  for (const item of inbox?.items ?? []) {
    if (item.mode !== "steer" || !live?.run) continue;
    const projected = mapEntriesToMessages([
      {
        record: {
          id: item.id,
          conversationId: view.conversation.id,
          kind: "pi.user",
          model: [{ role: "user", content: item.content, timestamp: createdAt }],
        } as unknown as EntryRecord,
        entryId: `steer:${item.id}`,
        parentId: null,
        sequence: 0,
        createdAt,
      },
    ]).messages[0];
    if (projected) {
      delete projected.entryId;
      projected.id = `steer:${item.id}`;
      messages.push(projected);
    }
  }
  const slots = new Map((live?.tools ?? []).map((slot) => [slot.callId, slot]));
  const pendingApprovals = new Set(
    Object.values(extras.approvals?.entries ?? {})
      .filter((record) => !record.record)
      .map((record) => record.ownerTaskId),
  );
  messages = messages.map((message) => ({
    ...message,
    parts: message.parts.map((part) => {
      if (part.type !== "tool-call") return part;
      const slot = slots.get(part.toolCallId);
      if (!slot)
        return part.status === "running" && !live?.run
          ? { ...part, status: "error" as const, isError: true, result: "工具执行已中断" }
          : part;
      if (slot.status === "done" && slot.entry === undefined)
        return { ...part, status: "error" as const, isError: true, result: "工具执行已中断" };
      return {
        ...part,
        status:
          slot.taskId !== undefined && pendingApprovals.has(slot.taskId)
            ? ("pending-approval" as const)
            : slot.status === "done"
              ? part.status
              : ("running" as const),
        ...(slot.output === undefined ? {} : { partialOutput: slot.output }),
        ...(slot.details === undefined ? {} : { details: slot.details }),
      };
    }),
  }));
  const reports = nativeReports(
    Object.values(extras.agents?.runs ?? {}).map((record) => record.run),
    Object.values(extras.jobs?.entries ?? {}),
  );
  messages = projectReportMessages(messages, reports);
  const submission = extras.submission;
  if (
    !live?.run &&
    submission?.type === "input" &&
    submission.status === "unanswered" &&
    !["aborted", "reset"].includes(submission.reason)
  ) {
    const afterInput = messages.filter(
      (message) =>
        message.role === "assistant" &&
        Number(message.entryId?.slice(6) ?? 0) > (submission.entry ?? Infinity),
    );
    if (!afterInput.some((message) => message.status === "error"))
      messages.push({
        id: `receipt:${submission.id}`,
        role: "assistant",
        status: "error",
        createdAt: messages.at(-1)?.createdAt ?? createdAt,
        parts: [],
        error: typeof submission.detail === "string" ? submission.detail : submission.reason,
      });
  }
  const nativeCompaction = extras.compaction;
  const liveCompaction = live?.compactions?.at(-1);
  const compactEntry = records.filter((entry) => entry.kind === "pi.compaction").at(-1);
  /**
   * 1.2.0 起内核在 live 上保留「最近的未解决压缩失败」（直到哪次压缩真的产出摘要才清除）。
   * 它补上了两个此前的盲区：失败任务的 live 状态被移除后（事件错过 / 窗口重开）无从展示，
   * 以及失败之后又被手动取消/无内容可压时，最近一次尝试的终态会掩盖那次真实失败。
   */
  const compactionFailure = live?.compactionFailure;
  let compaction: SessionCompaction | null = null;
  if (nativeCompaction || liveCompaction || compactEntry || compactionFailure) {
    const input = nativeCompaction?.input as { reason?: string } | undefined;
    const reason = liveCompaction?.reason ?? input?.reason ?? compactionFailure?.reason ?? "manual";
    const outcome = nativeCompaction?.state.outcome;
    const result =
      outcome?.status === "completed"
        ? (outcome.result as { entryId?: number; submissionId?: number })
        : undefined;
    const complete =
      !!compactEntry && (!nativeCompaction || compactEntry.byTaskId === nativeCompaction.id);
    const phase = liveCompaction
      ? "running"
      : complete
        ? "completed"
        : outcome && outcome.status !== "completed" && outcome.status !== "aborted"
          ? "failed"
          : "cancelled";
    const timestamp = compactEntry
      ? entryTime(compactEntry, createdAt)
      : (messages.at(-1)?.createdAt ?? createdAt);
    compaction = {
      phase,
      reason: reason === "threshold" || reason === "overflow" ? reason : "manual",
      startedAt: timestamp,
      ...(phase === "running" ? {} : { endedAt: timestamp }),
      ...(phase === "completed"
        ? {
            summaryPreview: (compactEntry?.model ?? [])
              .map((message) =>
                typeof message.content === "string"
                  ? message.content
                  : message.content
                      .flatMap((part) => (part.type === "text" ? [part.text] : []))
                      .join(""),
              )
              .join("\n")
              .slice(0, 200),
            retainedCount: view.entries.length - 1,
          }
        : {}),
      ...(phase === "failed"
        ? { error: outcome && "error" in outcome ? JSON.stringify(outcome.error) : "压缩失败" }
        : {}),
    };
    if (result?.submissionId && !complete && outcome?.status === "completed")
      compaction.phase = "running";
    // 未解决的失败覆盖「最近一次尝试」的终态：运行中的压缩不动（内核成功后会清掉失败记录，
    // 所以它存在即意味着还没有成功收尾；取消/无内容可压都不会把它清掉）。
    if (compactionFailure !== undefined && compaction.phase !== "running") {
      const failedReason =
        compactionFailure.reason === "threshold" || compactionFailure.reason === "overflow"
          ? compactionFailure.reason
          : "manual";
      compaction = {
        ...compaction,
        phase: "failed",
        reason: failedReason,
        endedAt: compaction.endedAt ?? timestamp,
        error: compactionFailure.error,
      };
    }
  }
  return detached({
    conversationId: view.conversation.id,
    messages,
    reports: Object.fromEntries(reports),
    admittedRequestIds: (extras.submissions ?? []).flatMap((record) =>
      record.requestId ? [record.requestId] : [],
    ),
    running: live?.run !== undefined,
    runId: live?.run ? String(live.run.taskId) : null,
    queue: (inbox?.items ?? []).flatMap((item) =>
      item.mode === "write" || (item.mode === "steer" && live?.run !== undefined)
        ? []
        : [
            {
              id: String(item.id),
              mode: item.mode,
              text:
                typeof item.content === "string"
                  ? item.content
                  : item.content
                      .flatMap((part) =>
                        part.type === "text" && parseAttachmentEnvelope(part.text) === null
                          ? [part.text]
                          : [],
                      )
                      .join(""),
            },
          ],
    ),
    usage: usageTotals(view.docs["pi.usage"] as UsageState | undefined),
    compaction,
    retry: projectModelRetry(view.conversation.id, records, live, submission),
    workflow: extras.workflow ?? emptyWorkflow(),
  });
}

let generation = Date.now() * 1000;
export async function createNativeView(input: {
  harness: Harness;
  conversation: Conversation;
  session: AppSessionHandle;
  emit: (event: ChatEvent) => void;
  onIdle?: () => void;
}) {
  const { harness, conversation, session } = input;
  await conversation.commit(async (tx) => {
    await tx.doc(TodoDoc, conversation.id);
    await tx.doc(GoalDoc, conversation.id);
    await tx.doc(PlanDoc, conversation.id);
    await tx.doc(WorkDoc, conversation.id);
    await tx.doc(PlanExecutionDoc, conversation.id);
  }, context);
  const watch = await conversation.watch(context);
  const extras: ViewExtras = {};
  const watches: { stop(): Promise<unknown> }[] = [watch];
  const mount = ++generation;
  let revision = 0;
  let snapshot: ChatLiveSnapshot | undefined;
  let pending = Promise.resolve();
  let stopped = false;
  let workflowDirty = true;
  const tasks = await session.storage.scanTasks(
    { conversationId: conversation.id, kind: "pi.compaction" },
    Number.MAX_SAFE_INTEGER,
    undefined,
    context,
  );
  extras.compaction = tasks.items.at(-1);
  const submissions = await session.storage.scanSubmissions(
    { conversationId: conversation.id },
    Number.MAX_SAFE_INTEGER,
    undefined,
    context,
  );
  const submitted = new Map(
    submissions.items
      .filter((record) => record.type === "input")
      .map((record) => [record.id, record]),
  );
  extras.submission = [...submitted.values()].at(-1);
  const parents = new Map<number, string | null>();
  async function publish() {
    if (stopped) return;
    if (workflowDirty) {
      workflowDirty = false;
      extras.workflow = await readWorkflow(harness, conversation.id);
    }
    const current = watch.value;
    await Promise.all(
      current.entries
        .filter((entry) => !parents.has(entry.id))
        .map(async (entry) => {
          const stored = await session.getEntry(`entry:${entry.id}`, context);
          parents.set(entry.id, stored?.parentId ?? null);
        }),
    );
    if (stopped) return;
    const visible = new Set<number>(current.entries.map((entry) => entry.id));
    for (const id of parents.keys()) if (!visible.has(id)) parents.delete(id);
    const queued = new Set(
      ((watch.value.docs["pi.inbox"] as InboxState | undefined)?.items ?? []).map(
        (item) => item.id,
      ),
    );
    for (const [id, record] of submitted)
      if (
        id !== extras.submission?.id &&
        !queued.has(id) &&
        (record.entry === undefined || !visible.has(record.entry))
      )
        submitted.delete(id);
    extras.submissions = [...submitted.values()];
    const state = projectConversationView(current, extras, session.metadata.createdAt, parents);
    const prior = snapshot;
    const ops = prior
      ? diffRevisions(prior.state as unknown as JsonValue, state as unknown as JsonValue)
      : [];
    if (prior && !ops.length) return;
    snapshot = { generation: mount, revision: ++revision, state };
    input.emit({
      type: "view",
      frame: prior
        ? { generation: mount, revision, previousRevision: prior.revision, ops }
        : snapshot,
    });
    if (prior?.state.running && !state.running) input.onIdle?.();
  }
  function schedule() {
    pending = pending.then(publish).catch((error) => console.warn("投影视图失败", error));
    return pending;
  }
  async function observe<T extends JsonObject>(
    token: ConversationDocToken<T>,
    update: (value: Readonly<T> | null) => void,
  ) {
    const doc = await harness.watchDoc(token, conversation.id, context);
    if (!doc) return;
    watches.push(doc);
    update(doc.value);
    doc.start(async (value) => {
      update(value);
      await schedule();
    });
  }
  await observe(SubagentsDoc, (value) => {
    extras.agents = value ?? undefined;
  });
  await observe(JobsDoc, (value) => {
    extras.jobs = value ?? undefined;
  });
  await observe(ApprovalDoc, (value) => {
    extras.approvals = value ?? undefined;
  });
  const unsubscribe = harness.subscribeCommits((publication) => {
    let changed = false;
    for (const change of publication.changes) {
      if (
        change.type === "document" &&
        change.conversationId === conversation.id &&
        [GoalDoc, PlanDoc, WorkDoc, PlanExecutionDoc].some(
          (doc) => doc.definition.kind === change.record.kind,
        )
      ) {
        workflowDirty = true;
        changed = true;
      }
      if (
        change.type === "task" &&
        change.value.conversationId === conversation.id &&
        change.value.kind === "pi.compaction" &&
        change.value.id >= (extras.compaction?.id ?? 0)
      ) {
        extras.compaction = change.value;
        changed = true;
      }
      if (
        change.type === "submission" &&
        change.value.conversationId === conversation.id &&
        change.value.type === "input" &&
        change.value.id >= (extras.submission?.id ?? 0)
      ) {
        extras.submission = change.value;
        submitted.set(change.value.id, change.value);
        changed = true;
      }
    }
    if (changed)
      queueMicrotask(() => {
        void schedule();
      });
  });
  await publish();
  watch.start(async () => {
    await schedule();
  });
  return {
    get snapshot(): ChatLiveSnapshot {
      if (!snapshot) throw new Error("原生视图未初始化");
      return snapshot;
    },
    async flush() {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await pending;
    },
    async stop() {
      stopped = true;
      unsubscribe();
      await Promise.all(watches.map((value) => value.stop()));
      await pending;
    },
  };
}
export type NativeView = Awaited<ReturnType<typeof createNativeView>>;
