import { randomUUID } from "node:crypto";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { type Static, type TSchema, Type } from "typebox";
import { detached } from "../native-state";
import {
  composeWorkflow,
  GoalDoc,
  PlanDoc,
  PlanExecutionDoc,
  summarizeWorkflow,
  WorkDoc,
  WorkflowCallDoc,
} from "../workflow";

export interface WorkflowToolOptions {
  isMain: () => boolean;
  continuationLimit?: () => number;
  onRestrictionChanged?: () => Promise<void>;
  requireAdmittedInput?: boolean;
}
const revision = Type.Integer({ minimum: 0 });
const workVersion = { workId: Type.String({ minLength: 1 }), workRevision: revision };
const goalSchema = Type.Object({
  scope: Type.Optional(
    Type.Union([Type.Literal("research"), Type.Literal("implementation")], {
      description:
        "Use research when the final deliverable is investigation or a plan; implementation (default) waits for effectful-work authorization before automatic continuation.",
    }),
  ),
  ...workVersion,
  objective: Type.String({ minLength: 1 }),
  criteria: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  continuationLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});
const updateSchema = Type.Object({
  ...workVersion,
  goalId: Type.String({ minLength: 1 }),
  revision,
  progress: Type.String({
    minLength: 1,
    description: "Actual progress and verification evidence.",
  }),
  status: Type.Union([Type.Literal("active"), Type.Literal("blocked"), Type.Literal("completed")]),
  reason: Type.Optional(Type.String()),
  objective: Type.Optional(Type.String({ minLength: 1 })),
  criteria: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
});
const planSchema = Type.Object({
  ...workVersion,
  planId: Type.Optional(Type.String({ minLength: 1 })),
  revision: Type.Optional(revision),
  title: Type.String({ minLength: 1, maxLength: 200 }),
  markdown: Type.String({ minLength: 1, maxLength: 60000 }),
  goalId: Type.Optional(Type.String({ minLength: 1 })),
});
const refSchema = Type.Object({ ...workVersion, planId: Type.String({ minLength: 1 }), revision });
const readPlanSchema = Type.Object({
  planId: Type.Optional(Type.String({ minLength: 1 })),
  revision: Type.Optional(revision),
});
const contractSchema = Type.Object({
  ...workVersion,
  effects: Type.Optional(Type.Union([Type.Literal("read-only"), Type.Literal("unrestricted")])),
  requiresReview: Type.Optional(Type.Boolean()),
  resolvedInputIds: Type.Array(Type.String({ minLength: 1 })),
  requirementsChanged: Type.Boolean({
    description:
      "True if feedback changes scope, approach or acceptance criteria; false for explanation/status questions.",
  }),
});
const readSchema = Type.Object({});
type Api = Parameters<ToolRegistration["execute"]>[1];
type ToolContext = Parameters<ToolRegistration["execute"]>[2];
const result = (text: string, error = false) => ({
  output: [{ type: "text" as const, text }],
  ...(error ? { isError: true } : {}),
});

/** All work styles share these tools; none can grant execution permission. */
export function createWorkflowTools(options: WorkflowToolOptions) {
  const mainOnly = () => result("Only the main AI may access the conversation workflow.", true);
  async function snapshot(api: Api, context: ToolContext) {
    return api.commit(
      async (tx) =>
        composeWorkflow(
          await tx.doc(GoalDoc, api.conversationId),
          await tx.doc(PlanDoc, api.conversationId),
          await tx.doc(WorkDoc, api.conversationId),
          await tx.doc(PlanExecutionDoc, api.conversationId),
        ),
      context,
    );
  }
  const read: ToolRegistration<typeof readSchema> = {
    name: "read_workflow",
    parameters: readSchema,
    replay: "safe",
    description:
      "Read current work constraints, pending input IDs, goal and plan summary. Use returned IDs and revisions for mutations; full plan text is available through read_plan.",
    async execute(_params, api, context) {
      return options.isMain()
        ? result(JSON.stringify(summarizeWorkflow(await snapshot(api, context))))
        : mainOnly();
    },
  };
  const readPlan: ToolRegistration<typeof readPlanSchema> = {
    name: "read_plan",
    parameters: readPlanSchema,
    replay: "safe",
    description:
      "Read current or a specified saved plan version including Markdown. Does not change permissions or start execution.",
    async execute(params, api, context) {
      if (!options.isMain()) return mainOnly();
      const doc = await api.commit(
        async (tx) => detached(await tx.doc(PlanDoc, api.conversationId)),
        context,
      );
      const selected =
        params.planId === undefined && params.revision === undefined
          ? doc.plan
          : [...doc.history, ...(doc.plan ? [doc.plan] : [])].find(
              (p) => p.id === params.planId && p.revision === params.revision,
            );
      return selected ? result(JSON.stringify(selected)) : result("Plan version not found.", true);
    },
  };
  type Mutation = "create" | "update" | "save" | "present" | "contract";
  type Params =
    | Static<typeof goalSchema>
    | Static<typeof updateSchema>
    | Static<typeof planSchema>
    | Static<typeof refSchema>
    | Static<typeof contractSchema>;
  async function mutate(kind: Mutation, params: Params, api: Api, context: ToolContext) {
    if (!options.isMain()) return mainOnly();
    const signature = JSON.stringify([kind, params]);
    const output = await api.commit(async (tx) => {
      const call = await tx.doc(WorkflowCallDoc, api.taskId);
      if (call.result)
        return call.signature === signature
          ? detached(call.result)
          : { text: "Tool invocation was replayed with different arguments.", error: true };
      const goals = await tx.doc(GoalDoc, api.conversationId);
      const plans = await tx.doc(PlanDoc, api.conversationId);
      const works = await tx.doc(WorkDoc, api.conversationId);
      const executions = await tx.doc(PlanExecutionDoc, api.conversationId);
      const work = works.work;
      let error: string | undefined;
      if (!work || work.workId !== params.workId || work.revision !== params.workRevision)
        error = "Work changed; reread workflow and use its current workId and revision.";
      else if (kind === "create") {
        const p = params as Static<typeof goalSchema>;
        if (
          goals.goal?.workId === work.workId &&
          !["completed", "ended"].includes(goals.goal.status)
        )
          error = "An unfinished goal exists; update it instead.";
        else if (!p.objective.trim() || !p.criteria.length || p.criteria.some((c) => !c.trim()))
          error = "Objective and acceptance criteria must be non-empty.";
        else {
          goals.goal = {
            scope: p.scope ?? "implementation",
            id: randomUUID(),
            workId: work.workId,
            revision: 1,
            objective: p.objective.trim(),
            criteria: p.criteria.map((c) => c.trim()),
            status: "active",
            progress: "",
            continuationCount: 0,
            continuationLimit: Math.max(
              1,
              Math.min(
                100,
                Math.floor(options.continuationLimit?.() ?? 10),
                Math.floor(p.continuationLimit ?? 100),
              ),
            ),
          };
          goals.revision++;
        }
      } else if (kind === "update") {
        const p = params as Static<typeof updateSchema>;
        const goal = goals.goal;
        if (
          !goal ||
          goal.workId !== work.workId ||
          ["paused", "completed", "ended"].includes(goal.status)
        )
          error = "No editable goal in this work. A paused goal needs user resume.";
        else if (goal.id !== p.goalId || goal.revision !== p.revision)
          error = "Goal changed; reread workflow.";
        else if (
          !p.progress.trim() ||
          (p.objective !== undefined && !p.objective.trim()) ||
          (p.criteria !== undefined && (!p.criteria.length || p.criteria.some((c) => !c.trim())))
        )
          error = "Progress, objective and criteria must be non-empty.";
        else if (p.status === "blocked" && !p.reason?.trim())
          error = "A blocked goal requires a concrete reason.";
        else {
          goal.progress = p.progress.trim();
          goal.status = p.status;
          goal.revision++;
          goals.revision++;
          if (p.reason?.trim()) goal.reason = p.reason.trim();
          else delete goal.reason;
          if (p.objective) goal.objective = p.objective.trim();
          if (p.criteria) goal.criteria = p.criteria.map((c) => c.trim());
        }
      } else if (kind === "contract") {
        const p = params as Static<typeof contractSchema>;
        const unread =
          options.requireAdmittedInput &&
          (
            await Promise.all(
              p.resolvedInputIds.map((id) => tx.submissionByRequest(api.conversationId, id)),
            )
          ).some((input) => !input || input.entry === undefined);
        if (unread)
          error =
            "Input has not reached the conversation yet. Do not acknowledge unseen or cancelled input.";
        else if (
          (p.effects === "unrestricted" && work.effects === "read-only") ||
          (p.requiresReview === false && work.requiresReview)
        )
          error = "Only a user control can broaden work constraints or remove required review.";
        else if (p.resolvedInputIds.some((id) => !work.pendingInputIds.includes(id)))
          error = "Input changed; reread pending input IDs.";
        else {
          const tightened = p.effects === "read-only" || p.requiresReview === true;
          if (p.effects !== undefined) work.effects = p.effects;
          if (p.requiresReview !== undefined) work.requiresReview = p.requiresReview;
          work.pendingInputIds = work.pendingInputIds.filter(
            (id) => !p.resolvedInputIds.includes(id),
          );
          if (p.requirementsChanged) work.requirementsRevision++;
          if (p.requirementsChanged || tightened) {
            works.authorizationRequestId = null;
            work.approvedPlanRef = null;
          }
          work.revision++;
          works.revision++;
        }
      } else if (kind === "save") {
        const p = params as Static<typeof planSchema>;
        const previous = plans.plan;
        if (work.pendingInputIds.length)
          error = "Handle pending feedback with set_work_contract before saving a plan.";
        else if (
          !p.title.trim() ||
          !p.markdown.trim() ||
          p.markdown.length > 60000 ||
          p.title.length > 200
        )
          error = "Plan title and Markdown must be non-empty and within size limits.";
        else if (
          p.goalId &&
          (!goals.goal ||
            goals.goal.id !== p.goalId ||
            goals.goal.workId !== work.workId ||
            ["ended", "completed"].includes(goals.goal.status))
        )
          error = "Plan must reference an unfinished goal in this work.";
        else if (
          previous?.workId === work.workId &&
          previous.status !== "archived" &&
          (p.planId !== previous.id || p.revision !== previous.revision)
        )
          error = "Plan changed; provide its current planId and revision.";
        else if (
          (!previous || previous.workId !== work.workId || previous.status === "archived") &&
          (p.planId !== undefined || p.revision !== undefined)
        )
          error = "Start a new plan without a previous reference.";
        else {
          if (previous) plans.history.push(detached(previous));
          const replacing = previous?.workId === work.workId && previous.status !== "archived";
          plans.plan = {
            id: replacing ? previous.id : randomUUID(),
            workId: work.workId,
            revision: replacing ? previous.revision + 1 : 1,
            requirementsRevision: work.requirementsRevision,
            title: p.title.trim(),
            markdown: p.markdown.trim(),
            status: "draft",
            ...(p.goalId ? { goalId: p.goalId } : {}),
          };
          plans.revision++;
          if (work.requiresReview) {
            works.authorizationRequestId = null;
            work.approvedPlanRef = null;
            work.revision++;
            works.revision++;
          }
        }
      } else {
        const p = params as Static<typeof refSchema>;
        const plan = plans.plan;
        if (work.pendingInputIds.length)
          error = "Handle pending feedback before presenting this plan.";
        else if (
          !plan ||
          plan.status === "archived" ||
          plan.workId !== work.workId ||
          plan.id !== p.planId ||
          plan.revision !== p.revision ||
          plan.requirementsRevision !== work.requirementsRevision
        )
          error = "Plan changed; save or read the current version.";
        else {
          plan.status = "ready";
          plans.revision++;
        }
      }
      call.signature = signature;
      call.result = {
        text:
          error ??
          JSON.stringify(summarizeWorkflow(composeWorkflow(goals, plans, works, executions))),
        error: error !== undefined,
      };
      return detached(call.result);
    }, context);
    if (!output.error && (kind === "contract" || kind === "save"))
      await options.onRestrictionChanged?.();
    return result(output.text, output.error);
  }
  function mutation<S extends TSchema>(
    name: string,
    kind: Mutation,
    parameters: S,
    description: string,
  ): ToolRegistration<S> {
    return {
      name,
      parameters,
      description,
      replay: "safe",
      execute: (params, api, context) => mutate(kind, params as Params, api, context),
    };
  }
  return [
    read,
    mutation(
      "create_goal",
      "create",
      goalSchema,
      "Track substantial user work with verifiable acceptance criteria. Optional for simple requests; a goal does not grant permissions. Read workflow first.",
    ),
    mutation(
      "update_goal",
      "update",
      updateSchema,
      "Record actual progress and evidence. Complete only when every acceptance criterion is verified; todos alone are insufficient. Never resume a user-paused goal.",
    ),
    readPlan,
    mutation(
      "save_plan",
      "save",
      planSchema,
      "Save a complete Markdown approach in either working style. Read current IDs/revisions first. This neither grants permission nor executes work. Keep execution progress in todo.",
    ),
    mutation(
      "present_plan",
      "present",
      refSchema,
      "Publish a saved plan version for viewing or user review. Only wait when the current work requires review or forbids implementation; otherwise continue authorized work.",
    ),
    mutation(
      "set_work_contract",
      "contract",
      contractSchema,
      "Acknowledge pending user input before effectful tools. Only-plan requests set effects read-only; review-first requests set requiresReview true. requirementsChanged is false for explanations/status. You may narrow constraints but never remove user restrictions or grant approval. Use current IDs/revision from read_workflow.",
    ),
  ] as const;
}
