import { randomUUID } from "node:crypto";
import type { JsonRepresentation } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ConversationId, defineDoc, type Harness, type Tx } from "@earendil-works/pi-durable";
import type {
  GoalControl,
  GoalState,
  PlanExecutionReceipt,
  PlanRef,
  PlanState,
  WorkContract,
  WorkflowResult,
  WorkflowState,
} from "@/shared/contracts/workflow";
import { detached } from "./native-state";

export interface GoalDocument {
  revision: number;
  goal: GoalState | null;
}
export interface PlanDocument {
  revision: number;
  plan: PlanState | null;
  history: PlanState[];
}
export interface WorkDocument {
  revision: number;
  work: WorkContract | null;
  authorizationRequestId: string | null;
}
export interface ExecutionDocument {
  revision: number;
  receipts: Record<string, PlanExecutionReceipt>;
}

export const GoalDoc = defineDoc<JsonRepresentation<GoalDocument>>({
  kind: "oint.goal.v2",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({ revision: 0, goal: null }),
});
export const PlanDoc = defineDoc<JsonRepresentation<PlanDocument>>({
  kind: "oint.plan.v2",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({ revision: 0, plan: null, history: [] }),
});
export const WorkDoc = defineDoc<JsonRepresentation<WorkDocument>>({
  kind: "oint.work.v2",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({ revision: 0, work: null, authorizationRequestId: null }),
});
export const PlanExecutionDoc = defineDoc<JsonRepresentation<ExecutionDocument>>({
  kind: "oint.plan-execution.v2",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ revision: 0, receipts: {} }),
});
export const WorkflowCallDoc = defineDoc<{
  signature: string | null;
  result: { text: string; error: boolean } | null;
}>({
  kind: "oint.workflow-call.v2",
  version: 1,
  scope: "task",
  initial: () => ({ signature: null, result: null }),
});
export const emptyWorkflow = (): WorkflowState => ({
  revision: 0,
  goal: null,
  plan: null,
  work: null,
  execution: null,
});

/** Full Markdown and execution copies are loaded on demand, not repeated in every prompt. */
export function summarizeWorkflow(state: WorkflowState) {
  const { markdown: _markdown, ...plan } = state.plan ?? { markdown: "" };
  return {
    goal: state.goal,
    work: state.work,
    plan: state.plan ? plan : null,
    execution: state.execution
      ? {
          requestId: state.execution.requestId,
          planRef: state.execution.planRef,
          status: state.execution.status,
        }
      : null,
  };
}

/** Only non-forked execution receipts can supply authorization; the work doc keeps its restriction floor. */
export function composeWorkflow(
  goal: GoalDocument | null,
  plan: PlanDocument | null,
  work: WorkDocument | null,
  executions: ExecutionDocument | null,
): WorkflowState {
  const contract = work?.work ? detached(work.work) : null;
  const authorized = work?.authorizationRequestId
    ? executions?.receipts[work.authorizationRequestId]
    : null;
  if (
    contract &&
    authorized?.status === "admitted" &&
    authorized.workId === contract.workId &&
    authorized.plan.requirementsRevision === contract.requirementsRevision
  ) {
    contract.effects = "unrestricted";
    contract.approvedPlanRef = detached(authorized.planRef);
  }
  const execution =
    Object.values(executions?.receipts ?? {})
      .filter((item) => item.workId === contract?.workId && item.status !== "released")
      .at(-1) ?? null;
  return detached({
    revision:
      (goal?.revision ?? 0) +
      (plan?.revision ?? 0) +
      (work?.revision ?? 0) +
      (executions?.revision ?? 0),
    goal: goal?.goal ?? null,
    plan: plan?.plan ?? null,
    work: contract,
    execution,
  });
}
export async function readWorkflow(
  harness: Harness,
  conversationId: ConversationId,
): Promise<WorkflowState> {
  return harness.commit(
    async (tx) =>
      composeWorkflow(
        await tx.doc(GoalDoc, conversationId),
        await tx.doc(PlanDoc, conversationId),
        await tx.doc(WorkDoc, conversationId),
        await tx.doc(PlanExecutionDoc, conversationId),
      ),
    BACKGROUND_CONTEXT,
  );
}
export async function mutateGoal(
  harness: Harness,
  conversationId: ConversationId,
  mutate: (state: GoalDocument) => void,
): Promise<WorkflowState> {
  await harness.commit(async (tx) => {
    const doc = await tx.doc(GoalDoc, conversationId);
    mutate(doc);
    doc.revision += 1;
  }, BACKGROUND_CONTEXT);
  return readWorkflow(harness, conversationId);
}
export async function controlGoal(
  harness: Harness,
  conversationId: ConversationId,
  action: GoalControl,
): Promise<WorkflowResult> {
  return harness.commit(async (tx) => {
    const doc = await tx.doc(GoalDoc, conversationId);
    if (!doc.goal || ["completed", "ended"].includes(doc.goal.status))
      return { ok: false, code: "missing", message: "No unfinished goal" };
    doc.goal.status = action === "pause" ? "paused" : action === "end" ? "ended" : "active";
    doc.goal.revision += 1;
    if (action === "resume") {
      doc.goal.continuationCount = 0;
      delete doc.goal.reason;
    }
    doc.revision += 1;
    return { ok: true };
  }, BACKGROUND_CONTEXT);
}
export async function beginWork(
  harness: Harness,
  conversationId: ConversationId,
  options: { workId?: string; effects?: WorkContract["effects"]; requiresReview?: boolean } = {},
): Promise<WorkContract> {
  return harness.commit(async (tx) => {
    const doc = await tx.doc(WorkDoc, conversationId);
    const goals = await tx.doc(GoalDoc, conversationId);
    if (goals.goal?.status === "active" || goals.goal?.status === "blocked") {
      goals.goal.status = "paused";
      goals.goal.reason = "已开始另一项工作";
      goals.goal.revision++;
      goals.revision++;
    }
    const plans = await tx.doc(PlanDoc, conversationId);
    if (plans.plan && plans.plan.status !== "archived") {
      plans.plan.status = "archived";
      plans.revision++;
    }
    doc.work = {
      workId: options.workId ?? randomUUID(),
      revision: 1,
      requirementsRevision: 0,
      effects: options.effects ?? "unrestricted",
      requiresReview: options.requiresReview ?? false,
      pendingInputIds: [],
      approvedPlanRef: null,
    };
    doc.authorizationRequestId = null;
    doc.revision += 1;
    return detached(doc.work);
  }, BACKGROUND_CONTEXT);
}
export async function registerWorkInput(
  harness: Harness,
  conversationId: ConversationId,
  inputId: string,
): Promise<WorkflowState> {
  await harness.commit(async (tx) => {
    const doc = await tx.doc(WorkDoc, conversationId);
    if (doc.work && !doc.work.pendingInputIds.includes(inputId)) {
      doc.work.pendingInputIds.push(inputId);
      doc.work.revision += 1;
      doc.revision += 1;
    }
  }, BACKGROUND_CONTEXT);
  return readWorkflow(harness, conversationId);
}
export async function resolveWorkInput(
  harness: Harness,
  conversationId: ConversationId,
  inputId: string,
  options: { requirementsChanged: boolean },
): Promise<WorkflowState> {
  await harness.commit(async (tx) => {
    const doc = await tx.doc(WorkDoc, conversationId);
    if (!doc.work?.pendingInputIds.includes(inputId)) return;
    doc.work.pendingInputIds = doc.work.pendingInputIds.filter((id) => id !== inputId);
    if (options.requirementsChanged) {
      doc.work.requirementsRevision += 1;
      doc.work.approvedPlanRef = null;
      doc.authorizationRequestId = null;
    }
    doc.work.revision += 1;
    doc.revision += 1;
  }, BACKGROUND_CONTEXT);
  return readWorkflow(harness, conversationId);
}
export async function readPlan(
  harness: Harness,
  conversationId: ConversationId,
  ref?: PlanRef,
): Promise<PlanState | null> {
  const doc = await harness.snapshot(PlanDoc, conversationId, BACKGROUND_CONTEXT);
  if (!ref) return detached(doc?.plan ?? null);
  const plans = [...(doc?.history ?? []), ...(doc?.plan ? [doc.plan] : [])];
  return detached(
    plans.find((plan) => plan.id === ref.planId && plan.revision === ref.revision) ?? null,
  );
}
export async function archivePlan(
  harness: Harness,
  conversationId: ConversationId,
  ref: PlanRef,
): Promise<WorkflowResult> {
  return harness.commit(async (tx) => {
    const doc = await tx.doc(PlanDoc, conversationId);
    if (!doc.plan || doc.plan.id !== ref.planId || doc.plan.revision !== ref.revision)
      return { ok: false, code: "stale" };
    doc.plan.status = "archived";
    doc.revision += 1;
    const work = await tx.doc(WorkDoc, conversationId);
    if (work.authorizationRequestId) {
      work.authorizationRequestId = null;
      work.revision += 1;
      if (work.work) work.work.revision += 1;
    }
    return { ok: true };
  }, BACKGROUND_CONTEXT);
}
export type { PlanExecutionRequest } from "@/shared/contracts/workflow";

import type { PlanExecutionRequest } from "@/shared/contracts/workflow";
export type PlanExecutionResult = WorkflowResult & { receipt?: PlanExecutionReceipt };
export async function reservePlanExecution(
  harness: Harness,
  conversationId: ConversationId,
  request: PlanExecutionRequest,
): Promise<PlanExecutionResult> {
  return harness.commit(async (tx) => {
    const executions = await tx.doc(PlanExecutionDoc, conversationId);
    const old = executions.receipts[request.requestId];
    if (old) {
      if (
        old.workId !== request.workId ||
        old.planRef.planId !== request.planId ||
        old.planRef.revision !== request.revision ||
        old.workRevision !== request.workRevision
      )
        return {
          ok: false,
          code: "invalid",
          message: "Execution request id was reused with different input",
        };
      if (old.status === "released")
        return { ok: false, code: "stale", message: "Released request requires a new request id" };
      return { ok: true, receipt: detached(old) };
    }
    const workDoc = await tx.doc(WorkDoc, conversationId);
    const work = workDoc.work;
    const plan = (await tx.doc(PlanDoc, conversationId)).plan;
    if (!work || !plan) return { ok: false, code: "missing" };
    if (
      work.workId !== request.workId ||
      work.revision !== request.workRevision ||
      plan.workId !== work.workId ||
      plan.id !== request.planId ||
      plan.revision !== request.revision ||
      plan.status !== "ready" ||
      plan.requirementsRevision !== work.requirementsRevision
    )
      return {
        ok: false,
        code: "stale",
        message: "Plan or work changed; review the current version",
      };
    if (work.pendingInputIds.length)
      return { ok: false, code: "busy", message: "User input is awaiting handling" };
    if (
      Object.values(executions.receipts).some(
        (item) =>
          item.workId === work.workId &&
          item.planRef.planId === plan.id &&
          item.planRef.revision === plan.revision &&
          item.status === "admitted",
      )
    )
      return { ok: false, code: "stale", message: "This plan version has already been started" };
    if (
      Object.values(executions.receipts).some(
        (item) => item.workId === work.workId && item.status === "reserved",
      )
    )
      return { ok: false, code: "busy", message: "An execution is already reserved" };
    const planRef = { planId: plan.id, revision: plan.revision };
    const receipt: PlanExecutionReceipt = {
      requestId: request.requestId,
      workId: work.workId,
      workRevision: work.revision,
      planRef,
      plan: detached(plan),
      contract: { ...detached(work), effects: "unrestricted", approvedPlanRef: planRef },
      status: "reserved",
    };
    executions.receipts[request.requestId] = receipt;
    executions.revision += 1;
    return { ok: true, receipt: detached(receipt) };
  }, BACKGROUND_CONTEXT);
}
export async function admitPlanExecution(
  harness: Harness,
  conversationId: ConversationId,
  requestId: string,
  inputId: string,
  submit?: (tx: Tx) => Promise<void>,
): Promise<PlanExecutionResult> {
  return harness.commit(async (tx) => {
    const executions = await tx.doc(PlanExecutionDoc, conversationId);
    const receipt = executions.receipts[requestId];
    if (!receipt) return { ok: false, code: "missing" };
    if (receipt.status === "admitted")
      return receipt.inputId === inputId
        ? { ok: true, receipt: detached(receipt) }
        : { ok: false, code: "invalid" };
    if (receipt.status !== "reserved") return { ok: false, code: "stale" };
    const workDoc = await tx.doc(WorkDoc, conversationId);
    const work = workDoc.work;
    const plan = (await tx.doc(PlanDoc, conversationId)).plan;
    if (
      !work ||
      work.workId !== receipt.workId ||
      work.revision !== receipt.workRevision ||
      work.pendingInputIds.length ||
      !plan ||
      plan.status !== "ready" ||
      plan.id !== receipt.planRef.planId ||
      plan.revision !== receipt.planRef.revision
    )
      return { ok: false, code: "stale", message: "Execution reservation became stale" };
    // The host creates the native input and generation in this same transaction.
    // A failed or cancelled submission cannot leave authorization behind.
    await submit?.(tx);
    receipt.status = "admitted";
    receipt.inputId = inputId;
    workDoc.authorizationRequestId = requestId;
    workDoc.revision += 1;
    executions.revision += 1;
    return { ok: true, receipt: detached(receipt) };
  }, BACKGROUND_CONTEXT);
}
export async function releasePlanExecution(
  harness: Harness,
  conversationId: ConversationId,
  requestId: string,
): Promise<WorkflowResult> {
  return harness.commit(async (tx) => {
    const doc = await tx.doc(PlanExecutionDoc, conversationId);
    const receipt = doc.receipts[requestId];
    if (!receipt) return { ok: false, code: "missing" };
    if (receipt.status === "admitted")
      return { ok: false, code: "invalid", message: "An admitted execution cannot be released" };
    receipt.status = "released";
    doc.revision += 1;
    return { ok: true };
  }, BACKGROUND_CONTEXT);
}
/** 执行轮次完整跑完后打上终态标记；失败或被中止的回执保持原样，界面继续可见。 */
export async function completePlanExecution(
  harness: Harness,
  conversationId: ConversationId,
  requestId: string,
): Promise<void> {
  await harness.commit(async (tx) => {
    const doc = await tx.doc(PlanExecutionDoc, conversationId);
    const receipt = doc.receipts[requestId];
    if (receipt?.status !== "admitted" || receipt.finished) return;
    receipt.finished = true;
    doc.revision += 1;
  }, BACKGROUND_CONTEXT);
}
