import type { JsonRepresentation } from "@earendil-works/chord";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { type Static, Type } from "typebox";
import { detached, TodoCallDoc, TodoDoc } from "../native-state";

export type TodoStatus = "pending" | "active" | "done" | "failed";

export interface TodoEntry {
  id: string;
  text: string;
  status: TodoStatus;
  reason?: string;
}

export interface TodoState {
  /** 本会话内的更新次数，从 1 开始；0 表示还没调用过 todo */
  revision: number;
  todos: TodoEntry[];
}

/** details 形状：渲染层的 TodoList 已按 { todos, revision } 对接，字段名不要改 */
export interface TodoToolDetails {
  todos: TodoEntry[];
  revision: number;
}

const todoSchema = Type.Object({
  todos: Type.Array(
    Type.Object({
      id: Type.Optional(
        Type.String({
          description:
            "Stable item id, copied from the previous update. Omit it for new items and one is assigned automatically (t1, t2, ...).",
        }),
      ),
      text: Type.String({
        minLength: 1,
        description:
          'One imperative line describing the work, e.g. "Add tests for todo.ts". Keep it short; it is rendered as a single checklist row.',
      }),
      status: Type.Union(
        [
          Type.Literal("pending"),
          Type.Literal("active"),
          Type.Literal("done"),
          Type.Literal("failed"),
        ],
        {
          description:
            '"pending" = not started, "active" = in progress (at most one or two at a time), "done" = finished, "failed" = attempted and did not work.',
        },
      ),
      reason: Type.Optional(
        Type.String({
          description:
            'Short note shown under the item, meaningful for "failed" (e.g. "tests rejected the null case").',
        }),
      ),
    }),
    {
      description:
        "The complete new list, in display order. Owned by this call: entries you omit disappear, and this order is the order the user sees.",
    },
  ),
});

type TodoToolParams = Static<typeof todoSchema>;
type TodoInputEntry = TodoToolParams["todos"][number];

const TODO_DESCRIPTION = `Create or update the session todo list: the single source of truth for multi-step work, shown to the user as a live checklist.

When to use it:
- At the start of any task that needs more than a couple of steps or touches several files: write the whole plan once, in order, before starting the first step.
- After each step: call it again with the same list where that step is "done" and the next one is "active", so the user can follow the progress instead of guessing what you are doing.
- When a step fails or the approach changes: mark it "failed" with a short reason, or rewrite the text and keep the id, instead of silently dropping it.
- When the task is finished: send the final table with every item "done" (and nothing "active" or "pending"), so the checklist does not stay half-finished after your answer.

When not to use it:
- Single-step work (one edit, one command, one question), pure questions, or research where you do not know the steps yet — the call would only add noise.
- As a status message or a chat log: one imperative line per item ("Add tests for todo.ts"), never paragraphs, and do not repeat the work you already described in your answer.
- To track things outside the user's request, or to keep state across sessions: the list dies with the session.
- Do not append to the list by hand: the "todos" array you send replaces the previous one entirely.

Arguments:
- todos (required): the complete new list, in display order. This is a whole-table replacement, not a patch: entries you omit are removed. Send back the ids you received for items that survive; for a new item, omit "id" or leave it out and an id (t1, t2, ...) is assigned for you, staying stable as long as the item text is unchanged.
  - text: one imperative line, required and non-empty.
  - status: "pending", "active" (in progress; keep it to at most one or two), "done", or "failed" (attempted and did not work).
  - reason: optional, only useful for "failed" — a short note shown under the item.
- An empty "todos" array is accepted and clears the list, but a finished task should end with all items "done" rather than with no list at all.

Output:
- A checklist for the model side with status markers "[ ]" pending, "[>]" active, "[x]" done and "[!]" failed, e.g. "[>] Implement search.ts (t1)", followed by the done/total count on the last line.
- The same table as structured details ({ todos, revision }) for the UI; revision starts at 1 and counts how many times the list was updated in this session.`;

/** 取当前表里最小空闲的自动 id（t1、t2……），保证同一张表内不重复 */
function nextAutoId(used: ReadonlySet<string>): string {
  let index = 1;
  while (used.has(`t${index}`)) index += 1;
  return `t${index}`;
}

/**
 * 给整张新表补 id，按优先级：
 * 1. 模型显式给了 id 且本表内还没被占用 → 原样保留（它知道自己指的是哪一条）；
 * 2. 否则复用「上一次同文本条目」的 id —— 整表替换时文本不变就保持同一个 id，
 *    渲染层的 key 与进度 diff 才不会每轮抖动；
 * 3. 都没有才取最小空闲的 tN。
 * 每条旧 id 只复用一次（按出现顺序取），所以同文本的重复条目也不会撞 id。
 */
function assignIds(inputs: readonly TodoInputEntry[], previous: readonly TodoEntry[]): TodoEntry[] {
  const reusable = new Map<string, string[]>();
  for (const entry of previous) {
    const queue = reusable.get(entry.text);
    if (queue === undefined) reusable.set(entry.text, [entry.id]);
    else queue.push(entry.id);
  }

  const used = new Set<string>();
  const todos: TodoEntry[] = [];
  for (const input of inputs) {
    const provided = input.id?.trim();
    let id: string;
    if (provided !== undefined && provided !== "" && !used.has(provided)) {
      id = provided;
    } else {
      const candidate = reusable.get(input.text.trim())?.shift();
      id = candidate !== undefined && !used.has(candidate) ? candidate : nextAutoId(used);
    }
    used.add(id);
    const reason = input.reason?.trim();
    todos.push({
      id,
      text: input.text.trim(),
      status: input.status,
      ...(reason === undefined || reason === "" ? {} : { reason }),
    });
  }
  return todos;
}

/** 状态标记：与渲染层同一套语义，failed 用 "[!]" 与 "[x] 已完成" 区分开 */
const STATUS_MARKERS: Record<TodoStatus, string> = {
  pending: "[ ]",
  active: "[>]",
  done: "[x]",
  failed: "[!]",
};

/** 给模型看的清单摘要：每行一条 + 末行 done/total */
function summarize(todos: readonly TodoEntry[]): string {
  const done = todos.filter((entry) => entry.status === "done").length;
  const lines = todos.map((entry) => {
    const note = entry.status === "failed" && entry.reason ? ` — ${entry.reason}` : "";
    return `${STATUS_MARKERS[entry.status]} ${entry.text} (${entry.id})${note}`;
  });
  lines.push(`${done}/${todos.length} done`);
  return lines.join("\n");
}

/** Rewindable conversation document; task-scoped result makes replay atomic and idempotent. */
export function createTodoTool(): ToolRegistration<
  typeof todoSchema,
  JsonRepresentation<TodoToolDetails>
> {
  return {
    name: "todo",
    description: TODO_DESCRIPTION,
    parameters: todoSchema,
    replay: "safe",
    async execute(params, api, context) {
      const empty = params.todos.some((entry) => entry.text.trim() === "");
      const state = await api.commit(async (tx) => {
        const call = await tx.doc(TodoCallDoc, api.taskId);
        if (call.result) return detached(call.result);
        const state = await tx.doc(TodoDoc, api.conversationId);
        if (!empty) {
          state.todos = assignIds(params.todos, state.todos);
          state.revision += 1;
          call.result = { revision: state.revision, todos: state.todos };
        }
        return detached({ revision: state.revision, todos: state.todos });
      }, context);
      if (empty)
        return {
          output: [
            {
              type: "text",
              text: `Error: every todo needs a non-empty "text". The list was not changed (revision stays ${state.revision}).`,
            },
          ],
          details: state,
          isError: true,
        };
      const header =
        state.todos.length === 0
          ? `Todo list cleared (revision ${state.revision}).`
          : `Todo list updated (revision ${state.revision}):`;
      return {
        output: [{ type: "text", text: `${header}\n${summarize(state.todos)}` }],
        details: state,
      };
    },
  };
}
