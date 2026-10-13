import type { JsonRepresentation } from "@earendil-works/chord";
import type { ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import { requireToolEnv } from "./tool-env";
// 后台作业工具（与 pi 原生四件套 bash/read/write/edit 并列的自建工具）。
//
// 为什么需要这四个工具：内核的 bash 没有默认超时，一条 dev server / watch 会把整轮运行挂住。
// 作业的语义与 bash 相反 —— 它**活过这一轮**：起进程（bash_background），用 job_output 反复读
// 新增输出，用 job_list 看还在跑什么，用 job_kill 收摊（连进程树一起收）。
//
// 装配方式与 ask_user 相同（见 tools/ask.ts 的 createAskTool）：sessionId 与作业服务都由运行时
// 按会话创建后注入，工具本身无内部状态。**两处 buildTools 调用都要带上**（会话创建 + MCP 热替换），
// 否则 MCP 刷新一次这些工具就凭空消失。
//
// 权限：bash_background 与 bash 同级（走 command-guard 风险判定 + 审批）；job_output / job_list /
// job_kill 在 permissions.ts 的 LOW_RISK_TOOLS 里 —— 它们只读自己会话的作业状态，或杀掉自己
// 起的进程，不需要再弹一张「批准读日志」的卡。
//
// 工具文案用英文，与内核四件套及 todo 工具一致（它们的 description / 输出都是英文）；
// 面向维护者的注释仍是中文。

import { type Static, type TSchema, Type } from "typebox";
import type { JobInfo } from "@/shared/contracts/job";
import type { JobService } from "../jobs";

/** 四个工具的名字：权限层、UI 图标表与测试都按它们登记 */
export const BASH_BACKGROUND_TOOL_NAME = "bash_background";
export const JOB_OUTPUT_TOOL_NAME = "job_output";
export const JOB_LIST_TOOL_NAME = "job_list";
export const JOB_KILL_TOOL_NAME = "job_kill";

/** 工具名集合：权限层与装配处复用，避免几处各写一份字面量 */
export const BACKGROUND_JOB_TOOL_NAMES = {
  bashBackground: BASH_BACKGROUND_TOOL_NAME,
  output: JOB_OUTPUT_TOOL_NAME,
  list: JOB_LIST_TOOL_NAME,
  kill: JOB_KILL_TOOL_NAME,
} as const;

const START_DESCRIPTION =
  "Start a long-running shell command as a background job and return immediately with its job id. " +
  "The process keeps running across turns; use job_output to read its new output, job_list to see what is running, job_kill to stop it.\n\n" +
  "When to use: dev servers, watchers, `npm run dev`, anything expected to stay alive until you stop it; " +
  "long builds or test runs you want to let go on while you keep working; any command that would otherwise block this turn indefinitely.\n" +
  "When NOT to use: short commands that finish on their own (use bash — backgrounding them only adds a job to clean up); " +
  "commands whose output you need in order right now; commands that wait for input (a background job has no stdin).\n\n" +
  "Notes: the job runs in the session working directory; stdout and stderr are merged and buffered " +
  "(the first 8 KiB and the last 56 KiB are kept, anything between is dropped and reported as omitted); " +
  "when the job exits, a notification with its command, status and last output lines is delivered to you automatically.\n" +
  "Output: the new job id (`job-1`, `job-2`, ...), which the other job tools take as their `id` argument.";

const OUTPUT_DESCRIPTION =
  "Read what a background job has printed since the last read (drain semantics: each call returns only what is new).\n\n" +
  "When to use: right after bash_background, to see whether the server actually started; " +
  "to poll a running job for progress; to collect the tail of a job that just exited.\n" +
  "When NOT to use: for jobs of another session (only this session's jobs are visible); " +
  "to burn time waiting — pass a small waitMs and poll again instead.\n\n" +
  "Arguments: id (required, e.g. job-1); waitMs (optional, at most 30000) waits that long for new output or for the job to exit before returning.\n" +
  "Output: the new output text plus the job status and exit code. If output was dropped in between, the text shows `...[N bytes omitted]...` at that spot. " +
  "When there is nothing new the text says so explicitly.";

const LIST_DESCRIPTION =
  "List the background jobs of this session: id, status, command, start / end time, and whether their output was truncated.\n\n" +
  "When to use: before starting another long-running command, to see what is already running and reuse it; " +
  "when you no longer know a job id; to check which jobs are still alive before answering the user.\n" +
  "When NOT to use: to read output (use job_output) or to start something (use bash_background).\n\n" +
  "Output: one line per job, oldest first. Finished jobs stay listed so their buffered output can still be read.";

const KILL_DESCRIPTION =
  "Stop a background job and its whole process tree (child processes included).\n\n" +
  "When to use: the dev server / watcher is no longer needed, it must be restarted with different arguments, " +
  "or it hangs; before answering the user when a long-running command was only started for a check.\n" +
  'When NOT to use: for commands you started with bash (they are not jobs), or to "pause" a job — there is no pause, a killed job is gone.\n\n' +
  "Arguments: id (required, e.g. job-1).\n" +
  "Output: the job's final status (killed) and its exit code if it had one. Its buffered output stays readable afterwards.";

const startSchema = Type.Object({
  command: Type.String({
    minLength: 1,
    description:
      'Shell command to run in the background, e.g. "npm run dev". It runs in the session working directory unless cwd says otherwise.',
  }),
  cwd: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        "Working directory for the process. Omit to use the session working directory (the usual case).",
    }),
  ),
});

const outputSchema = Type.Object({
  id: Type.String({
    minLength: 1,
    description: 'Job id returned by bash_background or job_list, e.g. "job-1".',
  }),
  waitMs: Type.Optional(
    Type.Number({
      minimum: 0,
      maximum: 30_000,
      description:
        "Wait up to this many milliseconds for new output (or for the job to exit) before returning. Default 0: return whatever has accumulated.",
    }),
  ),
});

const listSchema = Type.Object({});

const killSchema = Type.Object({
  id: Type.String({
    minLength: 1,
    description: 'Job id to stop, e.g. "job-1".',
  }),
});

export type BashBackgroundToolParams = Static<typeof startSchema>;
export type JobOutputToolParams = Static<typeof outputSchema>;
export type JobListToolParams = Static<typeof listSchema>;
export type JobKillToolParams = Static<typeof killSchema>;

/** 单个作业的工具 details（渲染层与日志回填用，字段都可结构化克隆） */
export interface JobToolDetails {
  job: JobInfo;
}

/** job_list 的 details */
export interface JobListToolDetails {
  jobs: JobInfo[];
}

export interface JobToolDeps {
  /** 会话 id：作业按会话隔离，工具只能碰自己会话的作业（见 jobs.ts 的会话 fence） */
  sessionId: string;
  /** 作业服务：由 runtime 创建并与其他工具共用同一份 */
  jobs: JobService;
}

/**
 * 四个工具的参数 schema 各不相同，装配处却只把它们当「同一批工具」放进数组 ——
 * 统一到最宽的 TSchema，避免联合类型在 execute 参数位的逆变冲突。
 */
type JobToolDefinition<TDetails extends object> = ToolRegistration<
  TSchema,
  JsonRepresentation<TDetails>
>;

/** 状态 → 给模型看的一句话（有退出码就一并给出） */
function statusText(job: JobInfo): string {
  const code = job.exitCode === undefined ? "" : `, exit code ${job.exitCode}`;
  switch (job.status) {
    case "running":
      return "still running";
    case "exited":
      return `exited (code ${job.exitCode ?? 0})`;
    case "failed":
      return `failed (${job.exitCode === undefined ? "no exit code" : `code ${job.exitCode}`})`;
    case "killed":
      return `killed${code}`;
  }
}

/** 时间戳 → 本地时间；列表里只要可读，不需要机器精度 */
function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString();
}

/** 失败回执用的占位快照：作业可能根本没建起来，但 details 必须是完整的 JobInfo */
function placeholderJob(sessionId: string, id: string, command: string, cwd: string): JobInfo {
  return {
    id,
    sessionId,
    command,
    cwd,
    status: "failed",
    startedAt: Date.now(),
    totalBytes: 0,
    truncated: false,
  };
}

/** 一条作业的概要行（job_list 用） */
function summarize(job: JobInfo): string {
  const end = job.endedAt === undefined ? "" : `, ended ${formatTime(job.endedAt)}`;
  const truncated = job.truncated ? ", output truncated" : "";
  return `- ${job.id} [${job.status}] ${job.command} (started ${formatTime(job.startedAt)}${end}, ${job.totalBytes} bytes${truncated})`;
}

/** 组装四个工具；sessionId 与作业服务在创建时固定（照 tools/ask.ts 的 createAskTool 模式） */
export function createJobTools(deps: JobToolDeps): ToolRegistration[] {
  const { sessionId, jobs } = deps;

  const bashBackground: JobToolDefinition<JobToolDetails> = {
    name: BASH_BACKGROUND_TOOL_NAME,

    description: START_DESCRIPTION,
    parameters: startSchema,
    async execute(
      rawParams,
      api,
      context,
    ): Promise<ToolExecutionResult<JsonRepresentation<JobToolDetails>>> {
      const params = rawParams as BashBackgroundToolParams;
      const cwd = params.cwd ?? requireToolEnv(api).cwd;
      const toolCallId = api.callId;
      let job: JobInfo;
      try {
        // 带上这次调用的 id：作业结束时 runtime 靠它把结论回填到**这次调用**上，
        // 而不是往对话里发一条新消息（见 job-delivery 的文件头）
        job = await jobs.start({
          sessionId,
          command: params.command,
          cwd,
          toolCallId,
          api,
          context,
        });
      } catch (error) {
        // 起不来是**可以继续的事实**：把原因写进内容让模型换个做法，而不是让整轮运行失败
        const detail = error instanceof Error ? error.message : String(error);
        return {
          output: [{ type: "text", text: `Error: could not start the background job: ${detail}` }],
          details: { job: placeholderJob(sessionId, "job-0", params.command, cwd) },
        };
      }
      return {
        output: [
          {
            type: "text",
            text:
              `Started ${job.id} (pid ${job.pid ?? "unknown"}) in ${cwd}: ${job.command}\n` +
              `Use ${JOB_OUTPUT_TOOL_NAME} {"id":"${job.id}"} to read its output, ` +
              `${JOB_LIST_TOOL_NAME} to see all jobs, ${JOB_KILL_TOOL_NAME} to stop it. ` +
              "You will be notified with its last output lines when it exits.",
          },
        ],
        details: { job },
      };
    },
  };

  const jobOutput: JobToolDefinition<JobToolDetails> = {
    name: JOB_OUTPUT_TOOL_NAME,

    description: OUTPUT_DESCRIPTION,
    parameters: outputSchema,
    async execute(
      rawParams,
      _api,
      context,
    ): Promise<ToolExecutionResult<JsonRepresentation<JobToolDetails>>> {
      const params = rawParams as JobOutputToolParams;
      let result: Awaited<ReturnType<JobService["read"]>>;
      try {
        result = await jobs.read(sessionId, params.id, {
          context,
          ...(params.waitMs === undefined ? {} : { waitMs: params.waitMs }),
        });
      } catch (error) {
        if (context.abortSignal?.aborted) throw error;
        const detail = error instanceof Error ? error.message : String(error);
        return {
          output: [{ type: "text", text: `Error: ${detail}` }],
          details: { job: placeholderJob(sessionId, params.id, "", "") },
        };
      }
      const { job, output, running } = result;
      const dropped = job.truncated ? ", some output dropped" : "";
      const header = `${job.id} ${statusText(job)} — ${job.totalBytes} bytes total${dropped}:`;
      const trimmed = output.replace(/\s+$/, "");
      const body =
        trimmed !== ""
          ? trimmed
          : running
            ? "(no new output yet)"
            : "(no new output; the job has exited)";
      return {
        output: [{ type: "text", text: `${header}\n${body}` }],
        details: { job },
      };
    },
  };

  const jobList: JobToolDefinition<JobListToolDetails> = {
    name: JOB_LIST_TOOL_NAME,

    description: LIST_DESCRIPTION,
    parameters: listSchema,
    async execute(): Promise<ToolExecutionResult<JsonRepresentation<JobListToolDetails>>> {
      const all = await jobs.list(sessionId);
      const text =
        all.length === 0
          ? "No background jobs in this session."
          : `${all.length} background job(s):\n${all.map(summarize).join("\n")}`;
      return { output: [{ type: "text", text }], details: { jobs: all } };
    },
  };

  const jobKill: JobToolDefinition<JobToolDetails> = {
    name: JOB_KILL_TOOL_NAME,

    description: KILL_DESCRIPTION,
    parameters: killSchema,
    async execute(rawParams): Promise<ToolExecutionResult<JsonRepresentation<JobToolDetails>>> {
      const params = rawParams as JobKillToolParams;
      let job: JobInfo;
      try {
        job = await jobs.kill(sessionId, params.id);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return {
          output: [{ type: "text", text: `Error: ${detail}` }],
          details: { job: placeholderJob(sessionId, params.id, "", "") },
        };
      }
      return {
        output: [
          {
            type: "text",
            text:
              (job.status === "killed"
                ? `${job.id} killed (${job.command}).\n`
                : `${job.id} was already ${job.status}${
                    job.exitCode === undefined ? "" : ` (exit code ${job.exitCode})`
                  } (${job.command}).\n`) +
              `Its buffered output is still available with ${JOB_OUTPUT_TOOL_NAME} {"id":"${job.id}"}.`,
          },
        ],
        details: { job },
      };
    },
  };

  return [bashBackground, jobOutput, jobList, jobKill];
}
