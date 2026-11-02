/**
 * 插件界面的命令执行。
 *
 * 这一组盯的是**三道彼此独立的约束**（见 surface-exec.ts 的文件头）：
 * 命令白名单、参数不经过 shell、工作目录围栏。
 * 缺任何一道都能被绕过，所以每条各有一组用例。
 *
 * 真正执行的那几条用 `node` 本身当被测命令（测试环境里一定有），
 * 而不是 mock `spawn` —— 这一层的价值恰恰在"真的起了一个进程之后行为如何"。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execForPlugin, SurfaceExecError, type SurfaceExecRequest } from "./surface-exec";

let workspace: string;
let outside: string;

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "oint-exec-"));
  outside = await mkdtemp(path.join(tmpdir(), "oint-exec-outside-"));
});

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

/** 一份合法请求的底稿；各用例只改自己关心的那处 */
function request(overrides: Partial<SurfaceExecRequest> = {}): SurfaceExecRequest {
  return {
    command: "node",
    args: ["-e", "process.stdout.write('ok')"],
    cwd: workspace,
    allowedCommands: ["node"],
    allowedRoots: [workspace],
    ...overrides,
  };
}

describe("① 命令白名单", () => {
  it("不在白名单里 → 抛错，并列出白名单（作者一眼看得出写漏了什么）", async () => {
    await expect(execForPlugin(request({ command: "rm" }))).rejects.toThrow(/不在插件的命令白名单/);
  });

  it("空白名单 → 说清「没声明」，而不是列一个空表", async () => {
    // 空表报「不在白名单里（）」那种文案会让作者以为自己写了什么
    await expect(execForPlugin(request({ allowedCommands: [] }))).rejects.toThrow(
      /没有在清单里声明/,
    );
  });

  it("**带路径的命令名归一后仍能命中**（白名单写的是裸命令名）", async () => {
    // 白名单里只可能是 `node`（清单校验器强制裸命令名），而插件可能传完整路径 ——
    // 两者指向同一个程序，不该因为写法不同而被拒
    const result = await execForPlugin(request({ command: process.execPath }));
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("ok");
  });

  // `.exe` 解析与大小写不敏感都是 Windows 的语义；POSIX 上 NODE.EXE 本来就不存在
  it.runIf(process.platform === "win32")("大小写不敏感、`.exe` 后缀不影响（Windows）", async () => {
    const result = await execForPlugin(
      request({ command: "NODE.EXE", args: ["-e", "process.stdout.write('x')"] }),
    );
    expect(result.stdout).toBe("x");
  });

  it("空命令名 → 抛错", async () => {
    await expect(execForPlugin(request({ command: "" }))).rejects.toThrow(/不能为空/);
  });
});

describe("② 参数逐项传递，不经过 shell", () => {
  it("**shell 元字符只是普通字符**（这是不拼字符串的直接证据）", async () => {
    // 拼接实现下，这一条会变成"跑了两条命令"或"语法错误"；逐项传递下它就是一个字符串
    const result = await execForPlugin(
      request({ args: ["-e", "process.stdout.write(process.argv[1])", "; rm -rf /"] }),
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("; rm -rf /");
  });

  it("参数里的引号与反斜杠不被解释", async () => {
    const payload = 'he said "hi" \\ and left';
    const result = await execForPlugin(
      request({ args: ["-e", "process.stdout.write(process.argv[1])", payload] }),
    );
    expect(result.stdout).toBe(payload);
  });

  it("NUL 字符被拒（它会截断底层传给 execve 的字符串）", async () => {
    await expect(execForPlugin(request({ args: ["a\u0000b"] }))).rejects.toThrow(/NUL/);
  });

  it("参数过多 / 单个参数过长被拒", async () => {
    await expect(
      execForPlugin(request({ args: Array.from({ length: 100 }, () => "x") })),
    ).rejects.toThrow(/最多 64 个/);
    await expect(execForPlugin(request({ args: ["x".repeat(5000)] }))).rejects.toThrow(/最长/);
  });
});

describe("③ 工作目录围栏", () => {
  it("**cwd 在允许根之外 → 拒绝**（否则 `-C /etc` 这类参数能把命令指向任何地方）", async () => {
    await expect(execForPlugin(request({ cwd: outside }))).rejects.toThrow(/不在允许的工作目录内/);
  });

  it("cwd 在允许根之内 → 正常执行，且**子进程的 cwd 真的是它**", async () => {
    const result = await execForPlugin(
      request({ args: ["-e", "process.stdout.write(process.cwd())"] }),
    );
    // Windows 上盘符大小写可能不同，所以比大小写不敏感的包含
    expect(result.stdout.toLowerCase()).toContain(path.basename(workspace).toLowerCase());
  });

  it("不存在的 cwd 走 realpath 兜底后仍会被围栏判掉", async () => {
    await expect(execForPlugin(request({ cwd: path.join(outside, "nope") }))).rejects.toThrow(
      SurfaceExecError,
    );
  });
});

describe("退出码与输出", () => {
  it("**非 0 退出码不是异常** —— `git diff --quiet` 就是用它表达「有改动」", async () => {
    const result = await execForPlugin(request({ args: ["-e", "process.exit(3)"] }));
    expect(result.code).toBe(3);
    expect(result.stdout).toBe("");
  });

  it("stderr 单独收，不与 stdout 混在一起", async () => {
    const result = await execForPlugin(
      request({ args: ["-e", "process.stderr.write('bad'); process.stdout.write('good')"] }),
    );
    expect(result.stdout).toBe("good");
    expect(result.stderr).toBe("bad");
  });

  it("**超时会被杀掉**（不是「放弃等待」—— 留着它会继续占网络与磁盘）", async () => {
    const result = await execForPlugin(
      request({ args: ["-e", "setTimeout(() => {}, 10000)"], timeoutMs: 200 }),
    );
    expect(result.code).toBeNull();
    expect(result.stderr).toContain("超时");
  });

  it("输出超限时截断并标记（插件必须看得出来，否则它会去解析半个 JSON）", async () => {
    const result = await execForPlugin(
      request({ args: ["-e", "process.stdout.write('x'.repeat(600000))"] }),
    );
    expect(result.truncated).toBe(true);
    expect(result.stdout).toContain("输出被截断");
  });

  it("命令不存在 → 抛出可读错误（而不是一个空的成功结果）", async () => {
    await expect(
      execForPlugin(request({ command: "definitely-not-a-real-command-xyz" })),
    ).rejects.toThrow(/不在插件的命令白名单/);
  });
});
