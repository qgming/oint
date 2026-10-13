// 执行环境装配：为 Agent 提供受路径守卫约束的 NodeExecutionEnv 包装。

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ExecutionEnv,
  err,
  FileError,
  type WatchTarget,
} from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { buildChildEnv } from "@/main/security/child-env";
import { isInsidePath, normalizePath, resolveRealPath } from "@/main/security/path-guard";

/** bash 路径解析缓存：undefined 同样缓存，表示该平台已确认不可用 */
const bashPathCache = new Map<NodeJS.Platform, string | undefined>();

/** System32/Sysnative 下的 bash.exe 是 WSL 入口，未安装发行版时执行必失败，须排除 */
const WSL_BASH_PATTERN = /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/i;

/** 同步执行探测命令；任何失败都静默返回空数组 */
function probe(command: string, args: string[]): string[] {
  try {
    const stdout = execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
      windowsHide: true,
    });
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "");
  } catch {
    return [];
  }
}

/** 过滤 WSL 入口与空串后，返回第一个真实存在的路径 */
function firstExisting(candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    if (candidate === "" || WSL_BASH_PATTERN.test(candidate)) continue;
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Windows 常见 Git Bash 安装位置，按优先级排列 */
function windowsBashCandidates(): string[] {
  const candidates: string[] = [];
  const { ProgramFiles, "ProgramFiles(x86)": programFilesX86, LOCALAPPDATA } = process.env;
  if (ProgramFiles) candidates.push(path.win32.join(ProgramFiles, "Git", "bin", "bash.exe"));
  if (programFilesX86) candidates.push(path.win32.join(programFilesX86, "Git", "bin", "bash.exe"));
  candidates.push(
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    "C:\\Git\\bin\\bash.exe",
  );
  if (LOCALAPPDATA) {
    candidates.push(path.win32.join(LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"));
  }
  return candidates;
}

/** 由 where git.exe 的结果推导同级 ..\bin\bash.exe */
function bashFromGit(): string | undefined {
  for (const gitPath of probe("where", ["git.exe"])) {
    const derived = path.win32.join(path.win32.dirname(gitPath), "..", "bin", "bash.exe");
    if (existsSync(derived) && !WSL_BASH_PATTERN.test(derived)) return derived;
  }
  return undefined;
}

/** 解析可用的 bash 可执行路径；解析失败返回 undefined（交给 NodeExecutionEnv 自行回退） */
export function resolveBashPath(platform: NodeJS.Platform = process.platform): string | undefined {
  if (bashPathCache.has(platform)) return bashPathCache.get(platform);

  let resolved: string | undefined;
  if (platform === "win32") {
    resolved = firstExisting(windowsBashCandidates());
    // where 可能把 System32 的 WSL 入口排在真实 Git Bash 之前，必须过滤
    resolved ??= firstExisting(probe("where", ["bash.exe"]));
    resolved ??= bashFromGit();
  } else {
    resolved = firstExisting(["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash"]);
  }

  bashPathCache.set(platform, resolved);
  return resolved;
}

export interface CreateExecEnvOptions {
  /** 会话工作目录；同时作为路径守卫的根 */
  cwd: string;
  /** 额外允许访问的根目录（如数据目录、技能目录）；默认包含 cwd */
  allowedRoots?: string[];
  /**
   * **完全访问**（`settings.permissionMode === "full"`）时返回 true：路径守卫不再校验
   * 允许根，任意路径（绝对、相对、~、file://）都可读写 —— 与 Windows 管理员同一份文件视图。
   *
   * 用 getter 而不是布尔：权限模式可以在会话中途切换，每个文件操作现查一次。
   * 它只放开「允许根校验」，`exec` 的环境变量白名单（child-env）不在此列 ——
   * 那管的是凭据外泄，不是路径边界。
   */
  unrestricted?: () => boolean;
}

/** 路径守卫校验结果 */
type GuardedPath = { ok: true; path: string } | { ok: false; error: FileError };

/** 与 NodeExecutionEnv 一致的归一逻辑：支持 ~ 与 file://，相对路径按会话 cwd 解析 */
function toAbsolutePath(requested: string, cwd: string): string {
  let normalized = requested;
  if (normalized === "~") {
    normalized = homedir();
  } else if (
    normalized.startsWith("~/") ||
    (process.platform === "win32" && normalized.startsWith("~\\"))
  ) {
    normalized = path.join(homedir(), normalized.slice(2));
  } else if (normalized.startsWith("file://")) {
    try {
      normalized = fileURLToPath(normalized);
    } catch {
      // 保留原样：与 NodeExecutionEnv 行为一致，越界与否交由守卫判定
    }
  }
  return path.isAbsolute(normalized) ? path.resolve(normalized) : path.resolve(cwd, normalized);
}

/** 路径越界错误：FileErrorCode 无专用码，用 permission_denied 表达 */
function outsideRootError(absolutePath: string, reason: string): FileError {
  return new FileError("permission_denied", `路径越界：${reason}`, normalizePath(absolutePath));
}

/**
 * 创建受路径守卫约束的执行环境。
 *
 * 两条边界，能力完全不同，不要混为一谈：
 *
 * 1. **路径类方法有守卫**：readFile / writeFile / listDir 等先校验目标落在 allowedRoots 内
 *    （**先解析 realpath**，见 guard），越界返回 FileError。
 *    例外：完全访问模式（`unrestricted` 返回 true）跳过允许根校验。
 *
 * 2. **`exec` 不受路径守卫约束**：它仍然可以跑任意命令、读写任意路径 —— 路径守卫
 *    在这一层**不构成任何限制**。管住它的是上层权限门（pisdk/permissions.ts）：
 *    shell 工具一律判为 high，必须用户点头。
 *    **但它受限的地方是环境变量**：子进程只拿到白名单（见 exec 的说明与
 *    main/security/child-env.ts），所以「跑一条 env 把凭据读出来」这条路已经封了。
 *    jobs.ts 里那条后台作业走同一个 exec，因此同款生效。
 */
export async function createExecEnv(options: CreateExecEnvOptions): Promise<ExecutionEnv> {
  const cwd = normalizePath(options.cwd);
  const roots = [cwd, ...(options.allowedRoots ?? [])].map((root) => normalizePath(root));
  const inner = new NodeExecutionEnv({ cwd, shellPath: resolveBashPath() });

  /**
   * 允许根本身的 realpath，**只在第一次校验时算一遍**。
   *
   * 为什么要 memo：每个文件操作都要判包含，而根在一次会话里不会变。不缓存的话
   * 每次 read/write/list 都要为每个根各跑一次 realpath —— 对一个热路径来说是纯浪费。
   */
  let realRootsPromise: Promise<string[]> | undefined;
  const realRoots = (): Promise<string[]> =>
    (realRootsPromise ??= Promise.all(roots.map((root) => resolveRealPath(root))));

  /**
   * 校验请求路径：**解析 realpath 之后**必须位于任一允许根内。
   *
   * 与旧实现的差别只有一处，但那处是安全边界：旧的是纯字符串比较，一个指向禁区
   *（如 `~/.oint/settings.json`）的符号链接，其字面路径在根内就会被放行。现在两侧
   * 都过 realpath 再比，链接会被解析到真实目标、包含判定随之失败。
   *
   * 目标不存在时 `resolveRealPath` 会退到「最近的存在祖先」，所以「新建文件」照常放行 ——
   * 这与「拒绝越界」不冲突：越界的判断发生在解析之后，而不是「存在与否」上。
   */
  async function guard(requested: string): Promise<GuardedPath> {
    const absolute = toAbsolutePath(requested, cwd);
    // 完全访问：跳过允许根校验（也免掉 realpath —— 它只服务于包含判定），直接放行
    if (options.unrestricted?.()) return { ok: true, path: absolute };
    const resolved = await resolveRealPath(absolute);
    const allowed = (await realRoots()).some((root) => isInsidePath(resolved, root));
    return allowed
      ? { ok: true, path: resolved }
      : { ok: false, error: outsideRootError(absolute, `路径不在允许的工作目录内: ${resolved}`) };
  }

  return {
    id: inner.id,
    get cwd() {
      return inner.cwd;
    },

    async absolutePath(requested, context) {
      const check = await guard(requested);
      if (!check.ok) return err<never, FileError>(check.error);
      return inner.absolutePath(check.path, context);
    },

    joinPath(parts, context) {
      return inner.joinPath(parts, context);
    },

    async readTextFile(requested, context) {
      const check = await guard(requested);
      if (!check.ok) return err<never, FileError>(check.error);
      return inner.readTextFile(check.path, context);
    },

    async openTextLineReader(requested, context) {
      const check = await guard(requested);
      if (!check.ok) return err<never, FileError>(check.error);
      return inner.openTextLineReader(check.path, context);
    },

    async readTextLines(requested, options, context) {
      const check = await guard(requested);
      if (!check.ok) return err<never, FileError>(check.error);
      return inner.readTextLines(check.path, options, context);
    },

    async readBinaryFile(requested, context) {
      const check = await guard(requested);
      if (!check.ok) return err<never, FileError>(check.error);
      return inner.readBinaryFile(check.path, context);
    },

    async writeFile(requested, content, context) {
      const check = await guard(requested);
      if (!check.ok) return err<never, FileError>(check.error);
      return inner.writeFile(check.path, content, context);
    },

    async appendFile(requested, content, context) {
      const check = await guard(requested);
      if (!check.ok) return err<never, FileError>(check.error);
      return inner.appendFile(check.path, content, context);
    },

    async truncateFile(requested, size, context) {
      const check = await guard(requested);
      if (!check.ok) return err<never, FileError>(check.error);
      return inner.truncateFile(check.path, size, context);
    },

    async flushFile(requested, context) {
      const check = await guard(requested);
      if (!check.ok) return err<never, FileError>(check.error);
      return inner.flushFile(check.path, context);
    },

    async renameFile(source, destination, context) {
      const sourceCheck = await guard(source);
      if (!sourceCheck.ok) return err<never, FileError>(sourceCheck.error);
      const destinationCheck = await guard(destination);
      if (!destinationCheck.ok) return err<never, FileError>(destinationCheck.error);
      return inner.renameFile(sourceCheck.path, destinationCheck.path, context);
    },

    async fileInfo(requested, context) {
      const check = await guard(requested);
      if (!check.ok) return err<never, FileError>(check.error);
      return inner.fileInfo(check.path, context);
    },

    async listDir(requested, context) {
      const check = await guard(requested);
      if (!check.ok) return err<never, FileError>(check.error);
      return inner.listDir(check.path, context);
    },

    async openBinaryReader(requested, options, context) {
      const check = await guard(requested);
      if (!check.ok) return err<never, FileError>(check.error);
      return inner.openBinaryReader(check.path, options, context);
    },

    async openDirReader(requested, context) {
      const check = await guard(requested);
      if (!check.ok) return err<never, FileError>(check.error);
      return inner.openDirReader(check.path, context);
    },

    async watch(targets, onChange, context) {
      // 每个被监视的目标都先过允许根：watcher 的目标可能尚不存在（创建它算一次变化），
      // guard 对不存在的路径会退到最近的存在祖先，语义与其它文件方法一致。
      const guarded: WatchTarget[] = [];
      for (const target of targets) {
        const check = await guard(target.path);
        if (!check.ok) return err<never, FileError>(check.error);
        guarded.push({ ...target, path: check.path });
      }
      return inner.watch(guarded, onChange, context);
    },

    async canonicalPath(requested, context) {
      const check = await guard(requested);
      if (!check.ok) return err<never, FileError>(check.error);
      return inner.canonicalPath(check.path, context);
    },

    async exists(requested, context) {
      const check = await guard(requested);
      if (!check.ok) return err<never, FileError>(check.error);
      return inner.exists(check.path, context);
    },

    async createDir(requested, options, context) {
      const check = await guard(requested);
      if (!check.ok) return err<never, FileError>(check.error);
      return inner.createDir(check.path, options, context);
    },

    async remove(requested, options, context) {
      const check = await guard(requested);
      if (!check.ok) return err<never, FileError>(check.error);
      return inner.remove(check.path, options, context);
    },

    createTempDir(prefix, context) {
      return inner.createTempDir(prefix, context);
    },

    createTempFile(options, context) {
      return inner.createTempFile(options, context);
    },

    /**
     * 跑 shell 命令。
     *
     * **环境变量：`inheritEnv: false` + 白名单**（见 main/security/child-env.ts）。
     *
     * 这一步不能省，而且不能只靠构造 `NodeExecutionEnv` 时传 `shellEnv`：内核的
     * `getShellEnv` 在默认参数下是 `{...process.env, ...baseEnv, ...extraEnv}` ——
     * `process.env` 铺在最底下，所以传 `shellEnv` 只是**覆盖**，没被覆盖到的凭据
     * 照样进子进程。只有 `inheritEnv: false` 才是**排除**。
     *
     * 收紧之前，一条被批准的 `env` 或 `cat ~/.oint/settings.json` 就能把主进程里的
     * `OINT_HOME` 与各类 `*_TOKEN` 读走；而现在子进程拿到的只有白名单里那几项，
     * 加上调用方通过 `options.env` 显式给的。
     */
    exec(command, options, context) {
      return inner.exec(
        command,
        { ...options, inheritEnv: false, env: buildChildEnv(process.env, options?.env) },
        context,
      );
    },

    cleanup(context) {
      return inner.cleanup(context);
    },
  };
}
