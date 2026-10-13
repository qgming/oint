import { defineDoc } from "@earendil-works/pi-durable";
import { TOOL_SEARCH_TOOL_NAME } from "@earendil-works/pi-durable/tool-search";
import type { JsonRepresentation } from "@earendil-works/chord";
import type { AgentMode } from "@/shared/contracts/common";
import type { WorkContract } from "@/shared/contracts/workflow";
import { WEB_READ_ONLY_TOOL_NAMES } from "@/shared/contracts/web";

/** Each turn keeps its admitted permission ceiling, independent of next-turn choices. */
export const RunPolicyDoc = defineDoc<
  JsonRepresentation<{ mode: AgentMode | null; work: WorkContract | null }>
>({
  kind: "oint.run-policy.v2",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({ mode: null, work: null }),
});
export const WORKFLOW_TOOL_NAMES = [
  "read_workflow",
  "create_goal",
  "update_goal",
  "read_plan",
  "save_plan",
  "present_plan",
  "set_work_contract",
] as const;
type ToolEffect = "read" | "metadata" | "delegate" | "write" | "unknown";
const effects: Readonly<Record<string, ToolEffect>> = {
  read: "read",
  read_image: "read",
  glob: "read",
  grep: "read",
  ask_user: "metadata",
  todo: "metadata",
  // 检索延迟工具只读本会话元数据：受限工作里也允许（否则受限会话摸不到 MCP 工具）
  [TOOL_SEARCH_TOOL_NAME]: "read",
  ...Object.fromEntries(WEB_READ_ONLY_TOOL_NAMES.map((name) => [name, "read"])),
  ...Object.fromEntries(WORKFLOW_TOOL_NAMES.map((name) => [name, "metadata"])),
  Task: "delegate",
  TaskWait: "read",
  TaskList: "read",
  TaskStop: "metadata",
  job_output: "read",
  job_list: "read",
  job_kill: "metadata",
  write: "write",
  edit: "write",
  bash: "unknown",
};
export function workAllowsEffects(work: WorkContract | null): boolean {
  return (
    !work ||
    (work.pendingInputIds.length === 0 &&
      work.effects === "unrestricted" &&
      (!work.requiresReview || work.approvedPlanRef !== null))
  );
}
export function toolAllowedByWork(work: WorkContract | null, toolName: string): boolean {
  if (workAllowsEffects(work)) return true;
  const effect = effects[toolName] ?? "unknown";
  return effect === "read" || effect === "metadata" || effect === "delegate";
}
export function intersectWork(
  admitted: WorkContract | null,
  current: WorkContract | null,
): WorkContract | null {
  if (!admitted) return current;
  if (!current) return admitted;
  // A task from a previous work scope must never borrow the new scope's authority.
  if (admitted.workId !== current.workId)
    return { ...admitted, effects: "read-only", approvedPlanRef: null };
  return {
    ...current,
    effects:
      admitted.effects === "read-only" || current.effects === "read-only"
        ? "read-only"
        : "unrestricted",
    requiresReview: admitted.requiresReview || current.requiresReview,
    approvedPlanRef:
      admitted.approvedPlanRef &&
      current.approvedPlanRef &&
      admitted.approvedPlanRef.planId === current.approvedPlanRef.planId &&
      admitted.approvedPlanRef.revision === current.approvedPlanRef.revision
        ? current.approvedPlanRef
        : null,
    pendingInputIds: current.pendingInputIds,
  };
}
