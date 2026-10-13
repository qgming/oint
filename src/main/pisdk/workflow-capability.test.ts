import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { type ToolRegistration, UserEntry } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { intersectWork, toolAllowedByWork, workAllowsEffects } from "./execution-policy";
import { openNativeStateTest } from "./native-state-test";
import { createWorkflowTools } from "./tools/workflow";
import {
  admitPlanExecution,
  archivePlan,
  beginWork,
  controlGoal,
  readPlan,
  readWorkflow,
  registerWorkInput,
  releasePlanExecution,
  reservePlanExecution,
  WorkDoc,
} from "./workflow";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function setup(isMain = true) {
  const test = await openNativeStateTest();
  cleanups.push(test.close);
  const work = await beginWork(test.harness, test.root.id);
  const tools = createWorkflowTools({ isMain: () => isMain, continuationLimit: () => 4 });
  const call = async (name: string, params: Record<string, unknown>) => {
    const tool = tools.find((t) => t.name === name) as ToolRegistration;
    return (await test.invoke((api, ctx) => tool.execute(params, api, ctx))).result;
  };
  const state = () => readWorkflow(test.harness, test.root.id);
  const version = async () => {
    const current = (await state()).work!;
    return { workId: current.workId, workRevision: current.revision };
  };
  const save = async (markdown = "# Approach\nImplement and verify") => {
    const current = await state();
    await call("save_plan", {
      ...(await version()),
      title: "Approach",
      markdown,
      ...(current.plan ? { planId: current.plan.id, revision: current.plan.revision } : {}),
    });
    const plan = (await state()).plan!;
    await call("present_plan", { ...(await version()), planId: plan.id, revision: plan.revision });
    return (await state()).plan!;
  };
  return { ...test, work, call, state, version, save };
}
describe("shared planning and work contracts", () => {
  it("saves native Markdown, preserves versions, and does not create goals or execution", async () => {
    const t = await setup();
    const p1 = await t.save();
    const p2 = await t.save("# Approach\nRevised");
    expect(p2.revision).toBe(2);
    expect(await readPlan(t.harness, t.root.id, { planId: p1.id, revision: 1 })).toMatchObject({
      markdown: p1.markdown,
    });
    expect(await t.state()).toMatchObject({
      goal: null,
      execution: null,
      work: { effects: "unrestricted" },
    });
    expect(p2).not.toHaveProperty("path");
  });
  it("rejects stale writes, empty content and cross-work goal associations", async () => {
    const t = await setup();
    await t.save();
    expect(
      await t.call("save_plan", { ...(await t.version()), title: "x", markdown: "x" }),
    ).toMatchObject({ isError: true });
    const p = (await t.state()).plan!;
    expect(
      await t.call("save_plan", {
        ...(await t.version()),
        planId: p.id,
        revision: p.revision,
        title: " ",
        markdown: "x",
      }),
    ).toMatchObject({ isError: true });
    expect(
      await t.call("save_plan", {
        ...(await t.version()),
        planId: p.id,
        revision: p.revision,
        title: "x",
        markdown: "x",
        goalId: "other",
      }),
    ).toMatchObject({ isError: true });
  });
  it("acknowledges explanations without altering plan revision or starting work", async () => {
    const t = await setup();
    const plan = await t.save();
    await registerWorkInput(t.harness, t.root.id, "explain");
    expect(workAllowsEffects((await t.state()).work)).toBe(false);
    await t.call("set_work_contract", {
      ...(await t.version()),
      resolvedInputIds: ["explain"],
      requirementsChanged: false,
    });
    expect((await t.state()).plan).toEqual(plan);
    expect(workAllowsEffects((await t.state()).work)).toBe(true);
  });
  it("tightens constraints but rejects model self-approval or widening", async () => {
    const t = await setup();
    await t.call("set_work_contract", {
      ...(await t.version()),
      effects: "read-only",
      requiresReview: true,
      resolvedInputIds: [],
      requirementsChanged: false,
    });
    expect(
      await t.call("set_work_contract", {
        ...(await t.version()),
        effects: "unrestricted",
        requiresReview: false,
        resolvedInputIds: [],
        requirementsChanged: false,
      }),
    ).toMatchObject({ isError: true });
    const contract = (await t.state()).work;
    for (const name of ["read", "glob", "todo", "save_plan", "Task"])
      expect(toolAllowedByWork(contract, name)).toBe(true);
    for (const name of ["write", "edit", "bash", "browser_click", "mcp__plugin__read"])
      expect(toolAllowedByWork(contract, name)).toBe(false);
  });
  it("keeps the admitted ceiling after current-work choices change", async () => {
    const t = await setup();
    const admitted = { ...t.work, effects: "read-only" as const };
    expect(workAllowsEffects(intersectWork(admitted, t.work))).toBe(false);
    expect(workAllowsEffects(intersectWork(t.work, { ...t.work, workId: "another-work" }))).toBe(
      false,
    );
  });
  it("rolls back plan authorization when native input admission fails", async () => {
    const t = await setup();
    await beginWork(t.harness, t.root.id, { effects: "read-only", requiresReview: true });
    const plan = await t.save();
    await reservePlanExecution(t.harness, t.root.id, {
      ...(await t.version()),
      planId: plan.id,
      revision: plan.revision,
      requestId: "atomic",
    });
    await expect(
      admitPlanExecution(t.harness, t.root.id, "atomic", "input", async () => {
        throw new Error("Cancelled input");
      }),
    ).rejects.toThrow("Cancelled input");
    expect((await t.state()).execution?.status).toBe("reserved");
    expect(workAllowsEffects((await t.state()).work)).toBe(false);
  });
  it("new work can own a new goal while the previous scope stays paused and its plan archived", async () => {
    const t = await setup();
    await t.call("create_goal", {
      ...(await t.version()),
      objective: "First",
      criteria: ["Verified"],
    });
    const plan = await t.save();
    await beginWork(t.harness, t.root.id);
    expect((await t.state()).goal?.status).toBe("paused");
    expect((await t.state()).plan).toMatchObject({ id: plan.id, status: "archived" });
    expect(
      await t.call("create_goal", {
        ...(await t.version()),
        objective: "Second",
        criteria: ["Verified"],
      }),
    ).not.toHaveProperty("isError");
    expect((await t.state()).goal?.objective).toBe("Second");
  });
  it("requires processed feedback and rejects stale reservations", async () => {
    const t = await setup();
    const plan = await t.save();
    const request = {
      requestId: "r",
      ...(await t.version()),
      planId: plan.id,
      revision: plan.revision,
    };
    await registerWorkInput(t.harness, t.root.id, "change");
    expect(await reservePlanExecution(t.harness, t.root.id, request)).toMatchObject({
      ok: false,
      code: "stale",
    });
    await t.call("set_work_contract", {
      ...(await t.version()),
      resolvedInputIds: ["change"],
      requirementsChanged: true,
    });
    expect(
      await reservePlanExecution(t.harness, t.root.id, { ...request, ...(await t.version()) }),
    ).toMatchObject({ ok: false, code: "stale" });
  });
  it("reserves once, releases cancelled reservations, and rejects duplicate execution", async () => {
    const t = await setup();
    const plan = await t.save();
    const request = {
      requestId: "r",
      ...(await t.version()),
      planId: plan.id,
      revision: plan.revision,
    };
    expect(await reservePlanExecution(t.harness, t.root.id, request)).toMatchObject({ ok: true });
    expect(await reservePlanExecution(t.harness, t.root.id, request)).toMatchObject({ ok: true });
    expect(
      await reservePlanExecution(t.harness, t.root.id, { ...request, requestId: "r2" }),
    ).toMatchObject({ ok: false, code: "busy" });
    await releasePlanExecution(t.harness, t.root.id, "r");
    expect(await reservePlanExecution(t.harness, t.root.id, request)).toMatchObject({ ok: false });
    const retry = { ...request, requestId: "retry" };
    await reservePlanExecution(t.harness, t.root.id, retry);
    expect(await admitPlanExecution(t.harness, t.root.id, "retry", "input")).toMatchObject({
      ok: true,
    });
    expect(await admitPlanExecution(t.harness, t.root.id, "retry", "input")).toMatchObject({
      ok: true,
    });
    expect(
      await reservePlanExecution(t.harness, t.root.id, { ...request, requestId: "duplicate" }),
    ).toMatchObject({ ok: false, code: "stale" });
    expect(await releasePlanExecution(t.harness, t.root.id, "retry")).toMatchObject({ ok: false });
  });
  it("new plan revisions revoke required approval and forks keep the restriction floor", async () => {
    const t = await setup();
    await beginWork(t.harness, t.root.id, { effects: "read-only", requiresReview: true });
    const plan = await t.save();
    await reservePlanExecution(t.harness, t.root.id, {
      ...(await t.version()),
      planId: plan.id,
      revision: 1,
      requestId: "r",
    });
    await admitPlanExecution(t.harness, t.root.id, "r", "input");
    expect(workAllowsEffects((await t.state()).work)).toBe(true);
    const floor = await t.harness.snapshot(WorkDoc, t.root.id, context);
    expect(floor?.work?.effects).toBe("read-only");
    const marker = await t.harness.commit(
      (tx) =>
        tx.appendEntry(UserEntry, t.root.id, {
          model: [{ role: "user", content: "checkpoint", timestamp: 1 }],
        }),
      context,
    );
    const fork = await t.root.fork(marker.id, { ownership: { kind: "ownerless" } }, context);
    expect((await readWorkflow(t.harness, fork.id)).execution).toBeNull();
    expect(workAllowsEffects((await readWorkflow(t.harness, fork.id)).work)).toBe(false);
    await t.save("# New approach");
    expect(workAllowsEffects((await t.state()).work)).toBe(false);
  });
  it("archives plans without granting permission or changing mode", async () => {
    const t = await setup();
    const plan = await t.save();
    expect(
      await archivePlan(t.harness, t.root.id, { planId: plan.id, revision: plan.revision }),
    ).toEqual({ ok: true });
    expect((await t.state()).plan?.status).toBe("archived");
  });
  it("tracks goal evidence independently, caps continuations and preserves manual pause", async () => {
    const t = await setup();
    expect(
      await t.call("create_goal", { ...(await t.version()), objective: " ", criteria: [] }),
    ).toMatchObject({ isError: true });
    await t.call("create_goal", {
      ...(await t.version()),
      objective: "Deliver",
      criteria: ["Verified"],
      continuationLimit: 99,
    });
    const goal = (await t.state()).goal!;
    expect(goal.continuationLimit).toBe(4);
    expect(
      await t.call("update_goal", {
        ...(await t.version()),
        goalId: goal.id,
        revision: goal.revision,
        progress: "pending",
        status: "blocked",
      }),
    ).toMatchObject({ isError: true });
    await controlGoal(t.harness, t.root.id, "pause");
    expect(
      await t.call("update_goal", {
        ...(await t.version()),
        goalId: goal.id,
        revision: goal.revision + 1,
        progress: "done",
        status: "completed",
      }),
    ).toMatchObject({ isError: true });
    await t.save();
    expect((await t.state()).goal?.status).toBe("paused");
  });
  it("denies workflow access to child agents", async () => {
    const t = await setup(false);
    expect(await t.call("read_workflow", {})).toMatchObject({ isError: true });
    expect(
      await t.call("save_plan", { ...(await t.version()), title: "x", markdown: "x" }),
    ).toMatchObject({ isError: true });
  });
});
