import type { Context, JsonRepresentation } from "@earendil-works/chord";
import type { ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
// 子智能体工具（Task / TaskWait / TaskList / TaskStop）：把「一件独立的工作交给另一条会话去跑」做成工具。
//
// 装配方式与 ask_user、作业四件套相同（见 tools/ask.ts 的 createAskTool 与 tools/jobs.ts 的 createJobTools）：
// sessionId、可用定义、运行管理器都由运行时按会话注入（createSubagentTools 的 deps），本文件保持无状态 ——
// 它只负责参数校验、给模型看的文案、以及 details 的组装；真正「跑起一条子会话」在 pisdk/subagent-runner.ts。
//
// 为什么这套工具由 runtime 注入、而不是在 buildTools 里直接装配：它们需要**父会话 id**、聊天运行时
// （子会话的 prompt 要走 getChatRuntime().send）与运行管理器，这三样只有 runtime.ts 拿得到 ——
// 于是 buildTools 只提供「第 5 个参数」这个插槽（见 tools.ts 的注释）。
//
// 子智能体自己**不会**拿到这四个工具：SUBAGENT_ASSIGNABLE_TOOLS 里没有它们，且 runtime 对子会话根本
// 不装配这套工具 —— 不允许嵌套委派（一个子智能体再派子智能体，主代理就彻底失去对进度与成本的掌握）。
//
// details 的形状（渲染层按它画主会话里的子智能体组件）：
// - Task  ：成功时就是这次运行的完整记录（SubagentRun，见 shared/contracts/subagent.ts），
//           失败（名字写错 / 并发上限 / 起不来）时是 { error }，渲染层按类型区分即可；
// - 其余三个：{ runs: SubagentRun[] }。

import { type TSchema, Type } from "typebox";
import {
  MAX_CONCURRENT_SUBAGENT_RUNS,
  normalizeSubagentName,
  type SubagentDefinition,
  type SubagentRun,
} from "@/shared/contracts/subagent";

/** 四个工具的名字：UI 图标表、权限层与测试都按它们登记 */
export const SUBAGENT_TOOL_NAMES = {
  task: "Task",
  wait: "TaskWait",
  list: "TaskList",
  stop: "TaskStop",
} as const;

/** 单次运行报告在主会话里最多保留多少字符；超出只保留前段并标注，避免一条报告挤掉整段上下文 */
const MAX_REPORT_CHARS = 8_000;
/** TaskWait 的默认与最长等待（秒）：默认 10 分钟够一次调研，硬上限防「等成挂死」 */
const DEFAULT_WAIT_SECONDS = 600;
const MAX_WAIT_SECONDS = 900;

export interface SubagentToolDeps {
  /** 父（主）会话 id：所有运行都挂在它下面 */
  sessionId: string;
  /** 父会话的工作目录（子会话继承它） */
  cwd: () => string;
  /** 当前可用的子智能体定义（已按 disabledSubagentNames 过滤） */
  definitions: () => Promise<SubagentDefinition[]>;
  /** 启动一次运行；返回启动后的运行记录。实现见 subagent-runner.ts */
  start: (
    request: SubagentStartRequest,
    api: ToolExecutionApi,
    context: Context,
  ) => Promise<SubagentRun>;
  wait: (
    delegationIds: string[] | undefined,
    mode: "all" | "any",
    minCompleted: number,
    timeoutSeconds: number,
    context: Context,
  ) => Promise<SubagentRun[]>;
  /**
   * 本会话的运行列表。实现必须给出「盘上 + 本进程」对账后的结果（runtime 注入 reconcileSubagentRuns）：
   * 只看内存的话，重启后 TaskList 看不到历史运行，并发上限也会漏掉上一次没跑完的那些。
   */
  list: () => Promise<SubagentRun[]>;
  stop: (delegationIds: string[]) => Promise<SubagentRun[]>;
  /** 父会话当前使用的模型 id，用于「继承主会话」的显示 */
  parentModelId: () => string;
  /**
   * 父会话此刻**真实拥有**的工具名（供临时定义的 `tools` 白名单校验）。
   *
   * 由 runtime 注入而不是在这里写死一份常量：MCP 工具名是运行时才存在的
   *（`mcp__<server>__call` 与 `mcp_tools`），写死的清单必然漏掉它们 ——
   * 而「漏掉」的表现是模型想给临时帮手开一个 MCP 工具却被判非法。
   *
   * 传进来的清单里**不含** Task 系列与 ask_user（子智能体本来就拿不到），
   * 所以模型也不会被提示去授一个授不出去的工具。
   */
  availableToolNames: () => string[];
}

export interface SubagentStartRequest {
  toolCallId: string;
  definition: SubagentDefinition;
  description: string;
  task: string;
  /** 重派（Task 的 resumeOf）时接续的那次委派 id：写进记录，面板与 TaskList 才看得出两条的关系 */
  resumedFrom?: string;
}

/** 派发失败时的 details：只有文案，没有运行记录（真的跑起来了才会是 SubagentRun） */
export interface SubagentToolErrorDetails {
  error: string;
}

/** Task 的 details：成功是运行记录，失败是错误说明 */
export type SubagentTaskDetails = SubagentRun | SubagentToolErrorDetails;

/** TaskWait / TaskList / TaskStop 的 details：一批运行记录（停止失败的那些不会出现在里面） */
export interface SubagentRunsDetails {
  runs: SubagentRun[];
}

/**
 * 四个工具的参数 schema 各不相同，装配处却只把它们当「同一批工具」放进数组 ——
 * 统一到调用方给的具体 schema，避免联合类型在 execute 参数位的逆变冲突（同 tools/jobs.ts 的写法）。
 */
type SubagentToolDefinition<
  TParameters extends TSchema,
  TDetails extends object,
> = ToolRegistration<TParameters, JsonRepresentation<TDetails>>;

/**
 * 失败回执：文本按仓库约定以 "Error:" 开头，
 * 同时显式带上 isError，让渲染层与测试不必去匹配文案前缀。
 */

const definitionSchema = Type.Object({
  name: Type.String({
    minLength: 1,
    description:
      'Name of the temporary subagent, lowercase, e.g. "changelog-writer". It is what the run is labelled with.',
  }),
  description: Type.String({
    minLength: 1,
    description:
      "One line on when to hand work to this temporary subagent; it is the only text the main model sees when choosing.",
  }),
  prompt: Type.String({
    minLength: 1,
    description:
      "The system prompt of the temporary subagent, used verbatim. Say what it must do and what to report back.",
  }),
  tools: Type.Optional(
    Type.Array(Type.String({ minLength: 1 }), {
      description:
        "Tool whitelist for THIS temporary subagent only: it gets exactly these tools and nothing else. " +
        "Omit it to give the temporary subagent every tool the main agent has (minus delegation). " +
        "Names must exist in this session (see the tool list in the Task description); an unknown name fails the call.",
    }),
  ),
});

const taskSchema = Type.Object({
  agent: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        'Name of the subagent to delegate to, as listed in the system prompt (e.g. "explorer"). Required unless "definition" is given.',
    }),
  ),
  resumeOf: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        'Delegation id of a previous run to restart, for a run that ended as "interrupted" (the process died while it was running). The new run reuses the stored agent, task and description, and records what it continues from.',
    }),
  ),
  description: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        'One short line describing what this delegation does (e.g. "Survey the retry logic"). REQUIRED unless "resumeOf" is given (then it is carried over): it is what the user sees next to the subagent in the conversation.',
    }),
  ),
  task: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        'The full instruction for the subagent. It cannot see this conversation, so state the goal, the scope, how to tell it is done, and what to report back. REQUIRED unless "resumeOf" is given (then the original instruction is reused).',
    }),
  ),
  definition: Type.Optional(
    Type.Object({
      name: definitionSchema.properties.name,
      description: definitionSchema.properties.description,
      prompt: definitionSchema.properties.prompt,
      tools: definitionSchema.properties.tools,
    }),
  ),
});

const waitSchema = Type.Object({
  delegationIds: Type.Optional(
    Type.Array(Type.String({ minLength: 1 }), {
      description:
        "Delegation ids to converge on (the id returned by Task). Omit to wait for every run of this session.",
    }),
  ),
  mode: Type.Optional(
    Type.Union([Type.Literal("all"), Type.Literal("any")], {
      description:
        '"all" (default) waits for every requested run; "any" returns as soon as minCompleted of them are settled.',
    }),
  ),
  minCompleted: Type.Optional(
    Type.Number({
      minimum: 1,
      description: 'For mode "any": how many runs must settle before returning. Default 1.',
    }),
  ),
  timeoutSeconds: Type.Optional(
    Type.Number({
      minimum: 1,
      maximum: MAX_WAIT_SECONDS,
      description: `How long to wait at most, in seconds. Default ${DEFAULT_WAIT_SECONDS}, capped at ${MAX_WAIT_SECONDS}. A timeout is not a failure: unfinished runs come back as still running.`,
    }),
  ),
});

const listSchema = Type.Object({});

const stopSchema = Type.Object({
  delegationIds: Type.Array(Type.String({ minLength: 1 }), {
    minItems: 1,
    description: "Delegation ids to stop, e.g. the id returned by Task or listed by TaskList.",
  }),
});

const TASK_DESCRIPTION =
  "把一个独立任务派给子智能体执行：它有自己的会话与上下文，跑完后把报告交回来。" +
  "本工具**立即返回**（不会等它跑完），你可以继续做别的事，最后用 TaskWait 收敛结果。\n\n" +
  "什么时候用：\n" +
  "- 一件能独立完成、且不依赖你后续判断的工作：调研一个模块、跑一遍测试并归类失败原因、按明确方案改一小片代码；\n" +
  "- 要翻很多文件、很多日志才能得出结论的事 —— 让子智能体去翻，把结论带回来，你的上下文留给综合与决策；\n" +
  "- 同时推进的多件独立工作：在同一条消息里发多个 Task，它们会并行跑。\n" +
  "什么时候不要用：\n" +
  "- 两三个工具调用就能做完的事：派遣本身也有开销，自己做更快；\n" +
  "- 需要用户拍板的事（提问、确认方案、挑环境）：子智能体不能与用户交互，这类事必须你自己做；\n" +
  "- 前后强依赖、必须一步一步看着结果走的活：拆不成独立任务就别硬拆；\n" +
  "- 你马上就要交付的最终结论：报告要由你综合后给出，不要把整段对话原样外包。\n\n" +
  "已经派出去的运行变成 interrupted（意外终止）时：上一个进程在它跑的时候退出了，没人叫它停，\n" +
  "我们也没有任何错误信息 —— **结果未知**。接下来怎么办由你决定：这件事还重要就用 resumeOf 重新\n" +
  "派一次（不用把任务全文再抄一遍），否则如实告诉用户它被打断了、以及你已经知道的部分。\n\n" +
  "可用的子智能体：见系统提示里的 <available_subagents> 清单（内置的与用户自定义的都在那里），\n" +
  "只干一次的特殊分工也可以用 definition 临时定义一个。\n" +
  "**内置与用户定义的子智能体拿到的工具和你一样全**（唯一例外是不能继续委派），\n" +
  "所以「这个子智能体有没有能力跑测试」这类判断不用你操心；只有**临时定义**可以按需收窄工具。\n\n" +
  "参数：\n" +
  "- description：**必填且用户可见**（用 resumeOf 时可省略，沿用原来那句），一句话说明这次派发在做什么；\n" +
  "  写「调研 X 模块的重试逻辑」这样的一行。\n" +
  "- agent：要派的子智能体名，取自 <available_subagents> 清单（例如 explorer / fixer）。\n" +
  "- definition：或者临时定义一个子智能体（name / description / prompt / tools），只活在这次运行里、不落盘；\n" +
  "  与 agent 二选一。其中 tools 是**可选的白名单**：给了就只给那几个工具，不给就给全部；\n" +
  "  名字必须真实存在（用错名字这次派发会被拒绝，并把可用清单回给你）。\n" +
  "- task：交给它的任务全文，要自包含 —— 目标、范围、判定标准、要交付什么都要写清（用 resumeOf 时可省略）。\n" +
  "- resumeOf：重派一次意外终止的运行：给它那个运行的 id，就按原来那份 agent / task / description 重新跑，\n" +
  "  并记下「接续的是哪一次」（旧记录留在列表里，是历史，不会被覆盖）。**还在跑的运行不要用它** ——\n" +
  "  那种情况用 " +
  SUBAGENT_TOOL_NAMES.wait +
  " 收敛它，别把同一件事跑两遍。\n\n" +
  "输出与后续：返回这次运行的记录（含 delegationId），状态是 running。\n" +
  "**跑完之后你不用主动来问**：子智能体交回报告时会被自动送到你这里（父会话正在跑就插进当前轮次，\n" +
  "空闲就起一轮新运行）—— 所以派完可以先继续做手上的事，报告到了自然会出现。\n" +
  "要主动查时：用 " +
  SUBAGENT_TOOL_NAMES.wait +
  " 收敛结果（报告会完整给你），用 " +
  SUBAGENT_TOOL_NAMES.list +
  " 看进度、用 " +
  SUBAGENT_TOOL_NAMES.stop +
  " 停掉做偏的活。同一个会话里最多同时跑 " +
  `${MAX_CONCURRENT_SUBAGENT_RUNS} 个子智能体，超了会被拒绝（先收敛几个再派）。`;

const WAIT_DESCRIPTION =
  "等待子智能体运行收敛，返回每个运行的状态与报告。\n\n" +
  "什么时候用：Task 返回之后，你需要它的结论才能继续（写最终答复、做下一步决定）时；\n" +
  "一次可以只等其中几个（delegationIds），也可以等全部。\n" +
  "什么时候不要用：\n" +
  "- 还有别的活可以先做时：先做完再等，光等是纯消耗；\n" +
  "- 想「看进度」时：用 " +
  SUBAGENT_TOOL_NAMES.list +
  "，不要反复 TaskWait 空等。\n\n" +
  '参数：delegationIds（不传 = 本会话所有运行）、mode（"all" 默认等全部；"any" 只要有 minCompleted 个收敛就返回）、\n' +
  `minCompleted（默认 1）、timeoutSeconds（默认 ${DEFAULT_WAIT_SECONDS}，最长 ${MAX_WAIT_SECONDS}）。\n` +
  "输出：每个运行一块内容 —— 代理名、状态、报告（报告过长会被截断并标注）。\n" +
  "**等待超时不是失败**：还没跑完的运行会以 running 返回，你可以先做别的、稍后再等。";

const LIST_DESCRIPTION =
  "列出本会话的所有子智能体运行：代理名、状态、描述、轮次 / 工具调用次数、已耗时。\n\n" +
  "什么时候用：想知道有哪些还在跑、跑了多久、刚才派出去的是哪个 id；TaskWait 之前先看一眼谁已经完成。\n" +
  "什么时候不要用：要看某次运行的结果 —— 用 " +
  SUBAGENT_TOOL_NAMES.wait +
  " 收敛它；想停掉一次运行 —— 用 " +
  SUBAGENT_TOOL_NAMES.stop +
  "。\n\n" +
  "某一行显示 interrupted 时：上一个进程在这次运行期间退出了，**结果未知**（不是失败，也没人叫它停），\n" +
  "要不要重来由你决定 —— 还重要就用 " +
  SUBAGENT_TOOL_NAMES.task +
  ' {resumeOf: "<那一行的 id>"} 重派一次；不重要就如实告诉用户它被打断了，并说明你已经知道的部分。\n\n' +
  "无参数。输出一行一个运行，按派发顺序排列。";

const STOP_DESCRIPTION =
  "停止子智能体运行（连同它当前那一步）。\n\n" +
  "什么时候用：**只用于你已经决定这项工作不该继续下去的场合** —— 任务做偏了、另一个子智能体已经给出结论、\n" +
  "用户改了方向、它明显卡住了。\n" +
  "什么时候不要用：只是想看进度（用 " +
  SUBAGENT_TOOL_NAMES.list +
  "）；想快点拿到结果（停止不会让它更快，别用它「催」）；还在正常推进的运行也别停 ——\n" +
  "停掉的活不会有人替你补上。\n\n" +
  "参数：delegationIds（要停的运行 id，至少一个）。\n" +
  "输出：每个运行停止后的状态（aborted = 已停止；已经结束的不受影响）。";

/**
 * 临时定义的工具白名单归一化：去空白、去重、丢掉空串。
 *
 * **不做「认识的才留」的过滤** —— 那件事要用父会话此刻真实拥有的工具名来判断，
 * 只有 Task 的执行路径知道（`deps.availableToolNames()`），见下面的 `normalizeWhitelist`。
 * 空数组与 undefined 同义：不限制。
 */
function normalizeToolList(tools: readonly string[] | undefined): string[] | undefined {
  if (tools === undefined) return undefined;
  const cleaned = [...new Set(tools.map((tool) => tool.trim()).filter((tool) => tool !== ""))];
  return cleaned.length === 0 ? undefined : cleaned;
}

/**
 * 白名单校验：返回规范化后的白名单，或者一条给模型看的错误。
 *
 * 三条规则都是刻意的：
 * - **不认识的名字直接报错**（而不是静默丢掉）：名字是主模型写的，把可用清单回给它，
 *   下一轮就能改对；静默丢掉会让它以为「我已经限制了工具」，而子智能体实际拿到了别的组合。
 *   这与 MCP 聚合工具对未知工具名的处理是同一套口径；
 * - **以父会话真实工具名为准**：清单由 runtime 注入（含 MCP 工具），这里不写死常量 ——
 *   写死的清单必然漏掉运行时才存在的工具名；
 * - **过滤后为空也算错**：白名单全被丢掉等于「什么工具都不给」，那不是模型想要的结果，
 *   子智能体也会白跑一轮 —— 直接拒绝比让它空转好。
 */
export function normalizeWhitelist(
  tools: readonly string[] | undefined,
  available: readonly string[],
): { ok: true; tools?: string[] } | { ok: false; reason: string } {
  const wanted = normalizeToolList(tools);
  if (wanted === undefined) return { ok: true };
  const known = new Set(available);
  const unknown = wanted.filter((tool) => !known.has(tool));
  if (unknown.length > 0) {
    return {
      ok: false,
      reason: `tools 里有这个会话里不存在的工具：${unknown.join(", ")}。可用的工具：${available.join(", ")}。`,
    };
  }
  return { ok: true, tools: wanted };
}

/** 失败回执：文本给模型，isError 给渲染层与测试（内核只把工具抛错当错误，见文件头注释） */
function errorResult<TDetails extends object>(details: TDetails, text: string) {
  return {
    output: [{ type: "text" as const, text: `Error: ${text}` }],
    details,
    isError: true as const,
  };
}

/** 主 AI 临时定义的子智能体：只活在这次运行里（source: "temp"），模型/档位跟随主会话 */
function temporaryDefinition(input: {
  name: string;
  description: string;
  prompt: string;
  tools?: string[];
}): SubagentDefinition {
  return {
    // 名字要能被面板与日志安全地当标识用；归一后为空（例如给了一串符号）时兜一个固定名
    name: normalizeSubagentName(input.name) || "temp",
    description: input.description.trim(),
    prompt: input.prompt,
    ...(input.tools === undefined ? {} : { tools: input.tools }),
    model: null,
    source: "temp",
  };
}

/** 秒数 → 可读耗时；运行时长按人类可读给，不必机器精度 */
function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} 分 ${String(seconds % 60).padStart(2, "0")} 秒`;
}

/**
 * 状态 → 给模型看的一句话；running 也要说得明白「它没失败，只是还没完」。
 *
 * interrupted 必须与 aborted / failed 分开说：没有人叫它停，我们也没有错误信息 ——
 * 唯一确定的是「拥有它的进程在它跑的时候没了」。说成「失败」会让模型去猜一个不存在的错误，
 * 说成「已停止」会让它以为有人（用户或自己）做过决定。
 */
function statusText(run: SubagentRun, now: number): string {
  const elapsed = formatElapsed((run.endedAt ?? now) - run.startedAt);
  const progress = `${run.turns} 轮 / ${run.toolCalls} 次工具调用`;
  let text: string;
  switch (run.status) {
    case "running":
      text = `仍在运行（已跑 ${elapsed}，${progress}）`;
      break;
    case "completed":
      text = `已完成（用时 ${elapsed}，${progress}）`;
      break;
    case "aborted":
      text = `已停止（用时 ${elapsed}，${progress}）${run.error === undefined ? "" : `：${run.error}`}`;
      break;
    case "denied":
      text = `未能启动（${run.error ?? "未给出原因"}）`;
      break;
    case "interrupted":
      text = `已意外终止（进程在它运行期间退出，结果未知，用时 ${elapsed}，${progress}）`;
      break;
    case "failed":
      text = `运行失败（用时 ${elapsed}，${progress}）：${run.error ?? "未给出原因"}`;
      break;
  }
  // 重派的运行要说清它接续的是哪一次：否则列表里会出现两条看不出关系的记录（旧的那条停在 interrupted）
  return run.resumedFrom === undefined ? text : `${text}；接续 ${run.resumedFrom}`;
}

/** 报告截断：留着长度信息，模型才知道「下面这份不完整」 */
function truncateReport(report: string): string {
  if (report.length <= MAX_REPORT_CHARS) return report;
  return (
    `${report.slice(0, MAX_REPORT_CHARS)}\n\n` +
    `［报告已截断：原文 ${report.length} 字符，这里只保留前 ${MAX_REPORT_CHARS} 字符］`
  );
}

/** TaskWait 的一块内容：代理名 + 状态 + 报告；没有报告时明确说没有，别让模型以为内容丢了 */
function describeRun(run: SubagentRun, now: number): string {
  const header = `[${run.agentName}] ${statusText(run, now)} · id=${run.delegationId}\n任务：${run.description}`;
  if (run.report === undefined || run.report.trim() === "") {
    return `${header}\n报告：${run.status === "running" ? "（还没产出最终报告）" : "（没有产出报告）"}`;
  }
  return `${header}\n报告：\n${truncateReport(run.report)}`;
}

/** TaskList 的一行：紧凑到能一眼扫完，不为省几行牺牲可读性 */
function summarizeRun(run: SubagentRun, now: number): string {
  return `- ${run.agentName} [${run.status}] ${run.description} · ${run.turns} 轮 / ${run.toolCalls} 次工具调用 · ${statusText(
    run,
    now,
  )} · id=${run.delegationId}`;
}

/**
 * 构造四个子智能体工具。
 *
 * 需要父会话 id、可用定义与运行管理器，所以由运行时按会话创建后注入 tools.ts 的 buildTools
 * （第 5 个参数，见该函数注释）。工具本身没有内部状态：一次调用就是一次「问运行管理器」。
 */
export function createSubagentTools(deps: SubagentToolDeps): ToolRegistration[] {
  const task: SubagentToolDefinition<typeof taskSchema, SubagentTaskDetails> = {
    name: SUBAGENT_TOOL_NAMES.task,

    description: TASK_DESCRIPTION,
    parameters: taskSchema,
    replay: "safe",
    async execute(params, api, context) {
      const toolCallId = api.callId;
      // 重派：先按 id 找出要接续的那次运行（用对账后的列表 —— 索引里的历史运行也在里面）。
      // 未知 id 与「还在跑」都当场拒绝：前者会让模型以为重来过了，后者会真的把同一件事跑两遍
      const resumeOf = params.resumeOf?.trim() ?? "";
      let known: SubagentRun[] | undefined;
      let resumed: SubagentRun | undefined;
      if (resumeOf !== "") {
        known = await deps.list();
        resumed = known.find((run) => run.delegationId === resumeOf);
        if (resumed === undefined) {
          return errorResult<SubagentToolErrorDetails>(
            { error: `没有这次运行：${resumeOf}` },
            `没有 id 为「${resumeOf}」的运行记录（用 ${SUBAGENT_TOOL_NAMES.list} 看本会话有哪些运行）。`,
          );
        }
        if (resumed.status === "running") {
          return errorResult<SubagentToolErrorDetails>(
            { error: "这次运行还在跑" },
            `运行「${resumeOf}」还在跑，不要重派：用 ${SUBAGENT_TOOL_NAMES.wait} {"delegationIds":["${resumeOf}"]} ` +
              "收敛它，拿到结果之后再决定要不要重来。",
          );
        }
      }

      // description / task 在 resumeOf 时可以省略：重派是「接着干同一件事」，
      // 让模型把长任务全文再抄一遍没有意义，还容易抄漏
      const description = (params.description ?? resumed?.description ?? "").trim();
      if (description === "") {
        return errorResult<SubagentToolErrorDetails>(
          { error: "description 为空" },
          "description 不能为空：它是用户看到的那句话，说明这次派发在做什么。",
        );
      }
      const taskText = (params.task ?? resumed?.task ?? "").trim();
      if (taskText === "") {
        return errorResult<SubagentToolErrorDetails>(
          { error: "task 为空" },
          "task 不能为空：子智能体看不到这段对话，它只有你在 task 里写下的内容。",
        );
      }

      // 重派不许换人：记录里的 agentName 与真正跑起来的子智能体必须是同一个（换了人就该新开一次派发，
      // 否则「接续」只是个说法，列表里那条旧记录说的就不是这件事）
      if (resumed !== undefined) {
        const owner = normalizeSubagentName(resumed.agentName);
        const requested = params.agent === undefined ? "" : normalizeSubagentName(params.agent);
        const provided =
          params.definition === undefined ? "" : normalizeSubagentName(params.definition.name);
        if ((requested !== "" && requested !== owner) || (provided !== "" && provided !== owner)) {
          return errorResult<SubagentToolErrorDetails>(
            { error: "agent 与要接续的运行不符" },
            `运行「${resumed.delegationId}」属于子智能体「${resumed.agentName}」：要接续它就不能换成别的子智能体，` +
              "想换人就新开一次 Task。",
          );
        }
      }

      let definition: SubagentDefinition;
      if (params.definition !== undefined) {
        /**
         * 临时定义可以带工具白名单：这是**唯一**能收窄子智能体工具的地方。
         *
         * 校验放在这里（而不是装配子会话时）是为了能把错误**当次**回给主模型：
         * 它写错工具名时立刻拿到可用清单，下一轮就能改对，而不是让一个空转的子智能体
         * 跑完再回一份「我什么也做不了」的报告。
         */
        const whitelist = normalizeWhitelist(params.definition.tools, deps.availableToolNames());
        if (!whitelist.ok) {
          return errorResult<SubagentToolErrorDetails>({ error: "tools 不合法" }, whitelist.reason);
        }
        definition = temporaryDefinition({
          ...params.definition,
          ...(whitelist.tools === undefined ? {} : { tools: whitelist.tools }),
        });
      } else {
        // 重派时按**旧记录里的名字**重新解析定义：文件可能被改过或删了，
        // 沿用当时那一份会让「设置里看到的定义」与「实际跑的是什么」悄悄对不上
        const requested = resumed === undefined ? (params.agent?.trim() ?? "") : resumed.agentName;
        if (requested === "") {
          return errorResult<SubagentToolErrorDetails>(
            { error: "缺少 agent" },
            "必须给出 agent（要派的子智能体名），或者用 definition 临时定义一个。",
          );
        }
        const available = await loadDefinitions(deps);
        const name = normalizeSubagentName(requested);
        const found = available.find((candidate) => normalizeSubagentName(candidate.name) === name);
        if (found === undefined) {
          const names = available.map((candidate) => candidate.name);
          if (resumed !== undefined) {
            const listed =
              names.length === 0
                ? "当前也没有任何可用的子智能体"
                : `现在可用的是：${names.join("、")}`;
            return errorResult<SubagentToolErrorDetails>(
              { error: `子智能体 ${requested} 已不存在` },
              `运行「${resumed.delegationId}」原来的子智能体「${requested}」现在不存在了（定义可能被删掉、改了名，` +
                `或者它本来就是上一次临时定义的）；${listed}。` +
                "可以用 definition 临时定义一个同名的子智能体，或自己做这件事。",
            );
          }
          return errorResult<SubagentToolErrorDetails>(
            { error: `没有名为 ${requested} 的子智能体` },
            names.length === 0
              ? `没有名为「${requested}」的子智能体，当前也没有任何可用的子智能体（设置里可能关掉了子智能体）。` +
                  "可以用 definition 临时定义一个，或自己做这件事。"
              : `没有名为「${requested}」的子智能体；可用的是：${names.join("、")}。` +
                  "也可以用 definition 临时定义一个。",
          );
        }
        definition = found;
      }

      let run: SubagentRun;
      try {
        run = await deps.start(
          {
            toolCallId,
            definition,
            description,
            task: taskText,
            ...(resumed === undefined ? {} : { resumedFrom: resumed.delegationId }),
          },
          api,
          context,
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return errorResult<SubagentToolErrorDetails>(
          { error: detail },
          `子智能体没能启动：${detail}`,
        );
      }
      // 旧记录不动（它是历史）：这里只说清「这条新的接续了哪一条」，模型与用户才不会把两条看混
      const resumedNote =
        resumed === undefined
          ? ""
          : `它接续的是 ${resumed.delegationId}（那一条按历史保留，状态不会被它改写）。`;
      return {
        output: [
          {
            type: "text",
            text:
              `已派给子智能体「${run.agentName}」（${run.description}），运行 id：${run.delegationId}。` +
              resumedNote +
              `它在后台继续跑，现在可以接着做别的事，需要它的结论时用 ` +
              `${SUBAGENT_TOOL_NAMES.wait} {"delegationIds":["${run.delegationId}"]} 收敛。`,
          },
        ],
        details: run,
      };
    },
  };

  const wait: SubagentToolDefinition<typeof waitSchema, SubagentRunsDetails> = {
    name: SUBAGENT_TOOL_NAMES.wait,

    description: WAIT_DESCRIPTION,
    parameters: waitSchema,
    replay: "safe",
    async execute(params, _api, context) {
      const mode = params.mode ?? "all";
      const minCompleted = params.minCompleted ?? 1;
      const timeoutSeconds = Math.min(
        Math.max(params.timeoutSeconds ?? DEFAULT_WAIT_SECONDS, 1),
        MAX_WAIT_SECONDS,
      );
      const runs = await deps.wait(
        params.delegationIds,
        mode,
        minCompleted,
        timeoutSeconds,
        context,
      );
      if (runs.length === 0) {
        return {
          output: [
            {
              type: "text",
              text:
                "没有可等的子智能体运行" +
                (params.delegationIds === undefined
                  ? "（本会话还没派过）。"
                  : `（${params.delegationIds.join("、")} 都不是本会话的运行 id，用 ${SUBAGENT_TOOL_NAMES.list} 看当前有哪些）。`),
            },
          ],
          details: { runs },
        };
      }
      const now = Date.now();
      return {
        output: runs.map((run) => ({ type: "text" as const, text: describeRun(run, now) })),
        details: { runs },
      };
    },
  };

  const list: SubagentToolDefinition<typeof listSchema, SubagentRunsDetails> = {
    name: SUBAGENT_TOOL_NAMES.list,

    description: LIST_DESCRIPTION,
    parameters: listSchema,
    replay: "safe",
    async execute() {
      // 对账后的列表（盘上 + 本进程）：重启后也要能一眼看到上次那些没跑完的运行
      const runs = await deps.list();
      const now = Date.now();
      const text =
        runs.length === 0
          ? "本会话还没有子智能体运行。"
          : `子智能体运行（${runs.length} 个）：\n${runs.map((run) => summarizeRun(run, now)).join("\n")}`;
      return { output: [{ type: "text", text }], details: { runs } };
    },
  };

  const stop: SubagentToolDefinition<typeof stopSchema, SubagentRunsDetails> = {
    name: SUBAGENT_TOOL_NAMES.stop,

    description: STOP_DESCRIPTION,
    parameters: stopSchema,
    async execute(params) {
      const requested = [...new Set(params.delegationIds)];
      const stopped = await deps.stop(requested);
      const known = new Set(stopped.map((run) => run.delegationId));
      const missing = requested.filter((id) => !known.has(id));
      const now = Date.now();
      const lines = stopped.map(
        (run) => `- [${run.agentName}] ${statusText(run, now)} · id=${run.delegationId}`,
      );
      if (missing.length > 0) {
        lines.push(
          `- 没有找到这些运行：${missing.join("、")}（用 ${SUBAGENT_TOOL_NAMES.list} 看当前有哪些）。`,
        );
      }
      return { output: [{ type: "text", text: lines.join("\n") }], details: { runs: stopped } };
    },
  };

  return [task, wait, list, stop];
}

/**
 * 取一次可用定义；目录读取失败按「没有可用定义」处理并记日志。
 *
 * 这里刻意不让异常冒出去：一次目录读取失败不该让整次 Task 调用失败 ——
 * 失败回执里会说明「没有可用的子智能体」，模型据此自己决定要不要自己做。
 */
async function loadDefinitions(deps: SubagentToolDeps): Promise<SubagentDefinition[]> {
  try {
    return await deps.definitions();
  } catch (error) {
    console.warn(
      `读取子智能体定义失败，按无定义处理：${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}
