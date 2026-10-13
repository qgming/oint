import { createToolTestApi } from "@/main/pisdk/tools/tool-test-api";
// bash 结果的退出码与 spill 契约（pi-durable 1.2.0 起的内核语义）：
// - 成功：输出就是合并后的 stdout/stderr，不再附加 [exited with code 0] 标记；
// - 非零退出：返回**错误结果**（isError=true），输出完整保留，exit_code 诊断给出退出码 —— 模型从诊断里读它；
// - 超时：依旧抛内核文案（harness 会把抛错转成错误结果），不加工；
// - spill：完整输出的路径现在来自 full_output 诊断，且该路径必须能被 read 打开（spill 目录在允许根里）。
//
// 用真实 shell 跑（与 exec-env.test.ts 同一个姿态）：没有可用 shell 的环境直接跳过断言。

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createExecEnv } from "../exec-env";
import { buildTools } from "../tools";

let root: string;
let env: ExecutionEnv;

type BashOutcome =
  | { ok: true; text: string; isError: boolean; diagnostics: string[] }
  | { ok: false; error: Error };

/** 走装配后的 bash 工具，异常也收进返回值里方便断言 */
async function runBash(command: string, timeout?: number): Promise<BashOutcome> {
  const tool = buildTools().find((candidate) => candidate.name === "bash");
  if (tool === undefined) throw new Error("缺少 bash 工具");
  let output = "";
  const diagnostics: string[] = [];
  try {
    const result = await tool.execute(
      { command, ...(timeout === undefined ? {} : { timeout }) },
      createToolTestApi({
        env,
        callId: "call-bash",
        output: (chunk) => {
          output += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
        },
        diagnostic: (item) => diagnostics.push(item.message),
      }),
      BACKGROUND_CONTEXT,
    );
    // 1.2.0：output 通常省略（流式输出就是内容）；给出时优先它。诊断 = api 诊断 + 结果诊断。
    const text =
      result.output?.map((block) => (block.type === "text" ? block.text : "")).join("\n") ?? output;
    return {
      ok: true,
      text,
      isError: result.isError === true,
      diagnostics: [...diagnostics, ...(result.diagnostics ?? []).map((item) => item.message)],
    };
  } catch (error) {
    const caught = error instanceof Error ? error : new Error(String(error));
    return {
      ok: false,
      error:
        output === ""
          ? caught
          : new Error(`${output.trimEnd()}\n\n${caught.message}`, { cause: caught }),
    };
  }
}

/** 本机没有可用 shell（CI 的裸 Windows 等）：用例不判定失败，其余错误照常交给断言 */
function skipIfNoShell(outcome: BashOutcome): boolean {
  if (outcome.ok) return false;
  const code = (outcome.error.cause as { code?: string } | undefined)?.code;
  return code === "shell_unavailable" || code === "spawn_error";
}

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "oint-bash-"));
  // 允许根与会话环境一致（见 runtime 的 sessionAllowedRoots）：系统临时目录必须在里面，
  // 否则 bash spill 的 "Full output: <path>" 读不了，这条链就没法端到端验证
  env = await createExecEnv({ cwd: root, allowedRoots: [os.tmpdir()] });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("bash 退出码", () => {
  it("成功：输出就是命令输出本身，不再附加退出码标记", async () => {
    const outcome = await runBash("echo hello");
    if (skipIfNoShell(outcome)) return;
    if (!outcome.ok) throw outcome.error;

    expect(outcome.isError).toBe(false);
    expect(outcome.text).toBe("hello\n");
    expect(outcome.diagnostics.join("\n")).not.toContain("exited with code");
  });

  it("非零退出：stderr 合并进输出，结果标记为错误并带 exit_code 诊断", async () => {
    const outcome = await runBash("echo boom 1>&2; exit 3");
    if (skipIfNoShell(outcome)) return;
    if (!outcome.ok) throw outcome.error;

    expect(outcome.isError).toBe(true);
    expect(outcome.text).toBe("boom\n");
    expect(outcome.diagnostics.join("\n")).toContain("Command exited with code 3");
  });

  /**
   * 显式给足超时（默认 5 秒在这个用例上偏紧）。
   *
   * 这里真的起了 `sleep 5` 再等它被 1 秒的超时杀掉，所以本身就要花掉 1–2 秒；
   * 而全量跑时 vitest 会并行起几十个 worker、每个都要 spawn 真实 shell，
   * 机器一忙这个用例就会顶穿默认的 5 秒 —— 那是**测试环境的负载**，
   * 不是被测行为的问题。断言本身仍然严格（文案必须逐字一致）。
   */
  it("超时的既有文案原样保留（没有退出码可报的异常不加工）", { timeout: 20_000 }, async () => {
    const outcome = await runBash("sleep 5", 1);
    if (skipIfNoShell(outcome)) return;
    if (outcome.ok) throw new Error(`应当超时，却得到：${outcome.text}`);

    expect(outcome.error.message).toBe("Command timed out after 1 seconds");
  });
});

describe("超长输出的 spill 文件", () => {
  it("截断后给出的 Full output 路径能被 read 直接打开（spill 目录在允许根里）", async () => {
    const outcome = await runBash(
      "node -e \"for (let i = 0; i < 4000; i++) console.log('spill-line-' + i);\"",
    );
    if (skipIfNoShell(outcome)) return;
    if (!outcome.ok) throw outcome.error;

    // 路径在 full_output 诊断里（1.2.0 起是诊断而不是正文尾注）
    const spilled = [outcome.text, ...outcome.diagnostics].join("\n");
    const spillPath = /Full output: ([^\]\n]+)/.exec(spilled)?.[1];
    expect(spillPath).toBeTruthy();
    if (spillPath === undefined) return;
    try {
      const read = buildTools().find((candidate) => candidate.name === "read");
      if (read === undefined) throw new Error("缺少 read 工具");
      const readResult = await read.execute(
        { path: spillPath },
        createToolTestApi({ env, callId: "call-read" }),
        BACKGROUND_CONTEXT,
      );
      const text = (readResult.output ?? [])
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("\n");
      // spill 在系统临时目录下：曾经的允许根只有工作目录与数据目录，read 会直接拒绝这条路径
      expect(text.startsWith("   1\tspill-line-0")).toBe(true);
    } finally {
      // 落盘目录是内核为这次 spill 新建的一次性目录：验证完就清掉，别留在系统临时目录里
      await rm(path.dirname(spillPath), { recursive: true, force: true });
    }
  });
});
