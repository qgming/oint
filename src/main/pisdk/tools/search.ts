import type { JsonRepresentation } from "@earendil-works/chord";
import type { ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import { requireToolEnv } from "./tool-env";
// 主进程自定义工具：grep / glob（只读检索，与 pi 原生四件套 bash/read/write/edit 并列）。
//
// 为什么要自己写：内核只给 bash/read/write/edit。用 bash 跑 grep/rg 依赖外部可执行文件与
// shell 引号转义（Windows 上尤其容易写错），read 又只能按文件读、不做检索。这两个工具把
// 「按模式找内容 / 找文件」变成一次结构化调用：结果里带相对检索根的路径与行号，
// 实现上不依赖任何外部二进制（纯 Node 遍历），与 exec-env 的 bash 通道完全独立。
//
// 路径边界（与 DSH 的 glob/grep 对齐）：
// - `path` 只决定「检索根」，**不是**围栏：可以是工作目录之外的任意绝对路径；
// - 会话工作目录只作为相对路径的解析基准（缺省 "."），越界与否交给上层权限门判定；
// - 因此这里不调用 validatePathAccess —— 该守卫仍用于 read/write/edit 等变更类路径。
//
// 仍然保留的边界（与「工作目录」无关，属遍历自身的健壮性）：
// - realpath 归一 + 存在性校验：root 稳定可比对，路径不存在时明确报错而非空结果；
// - 遍历不跟随符号链接（只认 dirent.isDirectory()/isFile()）；
// - 跳过依赖/构建产物目录、超过 1 MiB 的大文件与二进制文件。

import type { Dirent } from "node:fs";
import { open, readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { Type } from "typebox";
import { validateRealPathAccess } from "@/main/security/path-guard";

/** 递归检索时跳过的目录名：依赖、版本库与构建产物，既没有检索价值又会淹没结果 */
const SKIPPED_DIR_NAMES: readonly string[] = [
  "node_modules",
  ".git",
  "dist",
  "dist-electron",
  "build",
  "out",
  ".venv",
];

/** 单文件参与检索的大小上限（1 MiB）：再大就当产物处理，避免把内存与上下文都吃光 */
const MAX_FILE_BYTES = 1024 * 1024;

/** 二进制嗅探窗口：前 8 KiB 出现 NUL 字节即判为二进制（与 git/grep 的启发式一致） */
const SNIFF_BYTES = 8 * 1024;

/** 单行输出的字符上限：压缩后的单行文件可能有上百万字符，原样回灌会直接吃掉上下文 */
const MAX_LINE_CHARS = 400;

const GREP_DEFAULT_LIMIT = 100;
const GREP_MAX_LIMIT = 500;
const GLOB_DEFAULT_LIMIT = 200;
const GLOB_MAX_LIMIT = 1000;

/** grep/glob 共用的 details：给日志与调试用；渲染层目前只认 todo 的 details 形状 */
export interface BaseSearchDetails {
  /** 实际检索的根（绝对路径，已归一） */
  root: string;
  /** 本次实际返回的条数（被 limit 截断时等于 limit） */
  matches: number;
  /** 是否还有结果没返回（被 limit 截断） */
  truncated: boolean;
}

export interface GrepToolDetails extends BaseSearchDetails {
  /** 命中所在的不重复文件数 */
  files: number;
}

export type GlobToolDetails = BaseSearchDetails;

/** 遍历输出的一项：绝对路径 + 相对检索根的路径（统一 "/" 分隔，跨平台一致） */
interface WalkedFile {
  abs: string;
  rel: string;
  name: string;
}

/** 英文单复数：复数形式显式传入 —— 直接拼 "s" 会得到 "matchs" 这类错词（match 的复数是 matches） */
function count(amount: number, singular: string, plural = `${singular}s`): string {
  return `${amount} ${amount === 1 ? singular : plural}`;
}

/** 统一出口：output 是给模型看的文本，details 随结果一起留档 */
function textResult<TDetails>(text: string, details: TDetails) {
  return {
    output: [{ type: "text" as const, text }],
    details,
    isError: text.startsWith("Error:"),
  };
}

/** limit 归一：缺省/非有限值取默认值，其余取整并夹到 [1, max] */
function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(Math.floor(value), max));
}

/** 正则元字符转义（单字符版），用于把通配模式里其余字符按字面量处理 */
function escapeRegExpChar(char: string): string {
  return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}

/**
 * 把通配模式编译成「整串匹配」的正则：
 * - "**" 后跟 "/" → 零到多层目录（"**" + "/*.ts" 既能命中根下的 a.ts，也能命中 src/deep/a.ts）；
 * - "**" → 任意字符（可跨目录）；"*" → 单层目录内的任意字符；"?" → 单层目录内的单个字符；
 * - 其余字符按字面量转义。
 * glob 的 pattern 与 grep 的 include 共用这一份实现（include 传入的是文件名，本来就没有分隔符）。
 */
function compileWildcard(pattern: string): RegExp {
  let source = "";
  let index = 0;
  while (index < pattern.length) {
    const char = pattern.charAt(index);
    if (char === "*" && pattern.charAt(index + 1) === "*") {
      index += 2;
      if (pattern.charAt(index) === "/") {
        source += "(?:[^/]*/)*";
        index += 1;
      } else {
        source += ".*";
      }
    } else if (char === "*") {
      source += "[^/]*";
      index += 1;
    } else if (char === "?") {
      source += "[^/]";
      index += 1;
    } else {
      source += escapeRegExpChar(char);
      index += 1;
    }
  }
  return new RegExp(`^${source}$`);
}

/** 目录名是否在跳过清单里 */
function isSkippedDir(name: string): boolean {
  return SKIPPED_DIR_NAMES.includes(name);
}

/**
 * 深度优先遍历目录下的普通文件。
 * 按名称排序（readdir 的顺序由操作系统决定）保证同一棵树给出同样的顺序；
 * 目录不可读（权限、竞态删除）时安静跳过：检索工具不该因为一棵子树失败而整体报错。
 */
async function* walkDirectory(dir: string, relBase: string): AsyncGenerator<WalkedFile> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    const rel = relBase === "" ? entry.name : `${relBase}/${entry.name}`;
    if (entry.isDirectory()) {
      if (isSkippedDir(entry.name)) continue;
      yield* walkDirectory(abs, rel);
    } else if (entry.isFile()) {
      // 软链接既不是 isDirectory 也不是 isFile，天然被排除：不会顺着链接读到工作目录之外
      yield { abs, rel, name: entry.name };
    }
  }
}

/** 遍历入口：path 指向单个文件时只处理该文件，指向目录时递归 */
async function* walkTarget(root: string, isFile: boolean): AsyncGenerator<WalkedFile> {
  if (isFile) {
    const name = path.basename(root);
    yield { abs: root, rel: name, name };
    return;
  }
  yield* walkDirectory(root, "");
}

type RootResolution = { ok: true; root: string; isFile: boolean } | { ok: false; message: string };

/**
 * 解析检索根，失败时给出可直接回给模型的文案（不抛异常）。
 *
 * ## 围栏：`allowedRoots` 传了才判，但**生产路径一定传**
 *
 * 早先这里刻意不做围栏，理由写在旧注释里：「`path` 可以是工作目录之外的任意绝对路径，
 * 越界与否由上层权限门决定」。那个理由在**只有权限门**的前提下成立 —— 但 `grep` 与
 * `glob` 在 `pisdk/permissions.ts` 里被判为 **low 风险**，而权限门对 low **直接放行、
 * 连审批卡都不创建**。于是 `grep { path: "~/.oint", pattern: "apiKey" }` 成了一次
 * **零确认的凭据读取**：`settings.json` 是文本、远小于 1 MiB 的跳过阈值，唯一的拦截
 * 是二进制嗅探。
 *
 * 现在两道判据合起来才成立：**权限门管"要不要问人"，这道围栏管"能不能到那儿"**。
 * 判据用 realpath 版本（不是纯字符串）—— 否则一个指向禁区的符号链接就能绕过。
 *
 * 仍然保留两道与围栏无关的校验：
 * - realpath 归一：软链接指向哪里都按真实路径报告，`root` 是稳定可比对的绝对路径；
 * - 存在性校验：路径不存在时给出明确文案，而不是回一个空结果集。
 * 遍历本身依旧不跟随符号链接（见 walkDirectory），所以「根是软链接」不会让遍历越走越远。
 */
async function resolveSearchRoot(
  requested: string | undefined,
  cwd: string,
  allowedRoots?: readonly string[],
  unrestricted?: () => boolean,
): Promise<RootResolution> {
  const requestedRoot = path.resolve(cwd, requested ?? ".");
  const realRoot = await realpath(requestedRoot).catch(() => undefined);
  if (realRoot === undefined) {
    return { ok: false, message: `Path not found: ${requestedRoot}` };
  }
  const info = await stat(realRoot).catch(() => undefined);
  if (info === undefined) {
    return { ok: false, message: `Path not found: ${realRoot}` };
  }
  if (allowedRoots !== undefined && allowedRoots.length > 0 && !unrestricted?.()) {
    const access = await validateRealPathAccess(realRoot, [...allowedRoots]);
    if (!access.ok) {
      /*
        文案刻意与 read/write 的越界错误同款（都说「不在允许的工作目录内」）：
        模型在两种工具上看到同一句话，才会学到同一条边界。
        同时给出去哪儿找：这句话出现的场合几乎都是「想搜工作目录外面」。
      */
      return {
        ok: false,
        message:
          `Path outside the allowed workspace: ${realRoot}. ` +
          `Search only inside the session working directory and the configured resource folders.`,
      };
    }
  }
  return { ok: true, root: realRoot, isFile: info.isFile() };
}

/** 文件前 8 KiB 是否含 NUL 字节（含则视为二进制，不参与 grep） */
async function isBinaryFile(filePath: string): Promise<boolean> {
  const handle = await open(filePath, "r").catch(() => undefined);
  if (handle === undefined) return true;
  try {
    const head = Buffer.allocUnsafe(SNIFF_BYTES);
    const { bytesRead } = await handle.read(head, 0, SNIFF_BYTES, 0);
    return head.subarray(0, bytesRead).includes(0);
  } catch {
    return true;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** 去掉行尾的 CR：CRLF 文件里 "foo$" 这类锚定模式否则会匹配不上，输出里也会多出控制字符 */
function stripCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/** 截断超长行，避免压缩文件把上下文吃光 */
function clipLine(line: string): string {
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;
}

const grepSchema = Type.Object({
  pattern: Type.String({
    description:
      'JavaScript regular expression source, matched against each line separately (case-sensitive, no flags). Example: "createTodoState" or "TODO|FIXME".',
  }),
  path: Type.Optional(
    Type.String({
      description:
        'File or directory to search. Relative paths resolve against the working directory; an absolute path outside it is also accepted. Defaults to "."',
    }),
  ),
  include: Type.Optional(
    Type.String({
      description:
        'Only scan files whose name matches this wildcard filter: "*" for any characters, "?" for one character. Example: "*.ts".',
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: `Maximum number of matching lines to return. Default ${GREP_DEFAULT_LIMIT}, hard cap ${GREP_MAX_LIMIT}.`,
    }),
  ),
});

const GREP_DESCRIPTION = `Search file contents and return every matching line as "path:line:text".

When to use it:
- Find where a name, string or shape lives: a function/type/variable, an error message, a config key, a TODO, a log line. The search is recursive and only reports files that actually contain a hit, so it is much cheaper than reading files one by one: to locate "createTodoState", grep for it instead of opening candidate files.
- Enumerate the call sites of a symbol before changing its signature, or check whether a value is hard-coded somewhere else.
- Verify that something is really gone (a stray "console.log", an old import): zero hits is a real answer and is reported explicitly.

When not to use it:
- Do not use it to read a file whose path you already know: use "read" (with offset/limit for large files).
- Do not use it for structural questions the compiler already answers ("who imports this module", "what type does this return"): run the typecheck or test command with bash instead.
- Do not shell out to grep/rg through bash: those binaries are not available on every machine, their quoting breaks on paths with spaces, and they skip files inconsistently. This tool is the supported path.
- Do not pass a shell glob as "pattern" ("src/**/*.ts" belongs in "include"); "pattern" is a JavaScript regular expression. Cases are not folded and patterns never match across lines.

Arguments:
- pattern (required): JavaScript regular expression source tested against each line separately (case-sensitive, no flags). In JSON a backslash is escaped, so "\\\\s" in the tool call is the regex \\s. Prefer a distinctive literal ("createTodoState") over a loose one ("e").
- path: file or directory to search. A relative path resolves against the working directory; an absolute path outside it also works, in which case hits are reported relative to that root. Defaults to ".". A file is scanned directly, a directory is walked recursively.
- include: optional file-name filter with "*" (any characters) and "?" (one character). Examples: "*.ts", "*.test.tsx", "package.json". It is matched against the file name only, never the directory part, and supports no braces or alternatives.
- limit: maximum number of matching lines returned. Default ${GREP_DEFAULT_LIMIT}; values above ${GREP_MAX_LIMIT} are clamped, values below 1 are raised to 1.

Output:
- One line per hit in the form "relative/path.ts:42:the matching line", listed path by path, followed by a summary line naming the number of matches, the number of files searched and the root.
- A matching line longer than ${MAX_LINE_CHARS} characters is cut and ends with "…".
- No hits: an explicit "No matches for ..." line with the number of files searched — never an empty answer.
- Too many hits: the summary says the limit was reached and that more matches exist, so refine "pattern"/"include" or raise "limit".
Automatically skipped: directories ${SKIPPED_DIR_NAMES.join(", ")}; files larger than 1 MiB; binary files (a NUL byte within the first 8 KiB); symbolic links are never followed. The reported paths are relative to the resolved root, so a search outside the working directory reports the same shape of path.

Keep patterns simple: a regex with nested quantifiers tested against a very long minified line can be extremely slow.`;

/**
 * 检索工具的选项。
 *
 * `allowedRoots` 是**这道围栏唯一的来源**：不传 = 不做围栏（单测与不关心会话边界的
 * 调用方走这条）。生产路径必须传 —— runtime 的两处 buildTools 都把
 * `sessionAllowedRoots(cwd, appPath)` 交进来。
 *
 * `unrestricted` 是「完全访问」的放行口（与 exec-env 同一口径）：返回 true 时跳过围栏，
 * 任意路径可检索。getter 现查，权限模式中途切换立即生效。
 */
export interface SearchToolOptions {
  allowedRoots?: readonly string[];
  unrestricted?: () => boolean;
}

/** 构造 grep 工具（只读；path 决定检索根，相对路径按会话工作目录解析） */
export function createGrepTool(
  options: SearchToolOptions = {},
): ToolRegistration<typeof grepSchema, JsonRepresentation<GrepToolDetails>> {
  return {
    name: "grep",

    description: GREP_DESCRIPTION,
    parameters: grepSchema,
    async execute(params, api, context) {
      context.abortSignal?.throwIfAborted();
      const env = requireToolEnv(api);
      const requestedRoot = path.resolve(env.cwd, params.path ?? ".");
      const failure = (message: string): ToolExecutionResult<JsonRepresentation<GrepToolDetails>> =>
        textResult(`Error: ${message}`, {
          root: requestedRoot,
          matches: 0,
          files: 0,
          truncated: false,
        });
      const resolution = await resolveSearchRoot(
        params.path,
        env.cwd,
        options.allowedRoots,
        options.unrestricted,
      );
      if (!resolution.ok) return failure(resolution.message);

      let pattern: RegExp;
      try {
        pattern = new RegExp(params.pattern);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return failure(
          `invalid regular expression ${JSON.stringify(params.pattern)} (${detail}). "pattern" is a JavaScript regex source, not a shell glob.`,
        );
      }

      const limit = clampLimit(params.limit, GREP_DEFAULT_LIMIT, GREP_MAX_LIMIT);
      const include =
        params.include === undefined || params.include === ""
          ? null
          : compileWildcard(params.include);
      const matches: string[] = [];
      const files = new Set<string>();
      let scanned = 0;
      let truncated = false;

      for await (const file of walkTarget(resolution.root, resolution.isFile)) {
        if (include !== null && !include.test(file.name)) continue;
        const info = await stat(file.abs).catch(() => undefined);
        if (info === undefined || info.size > MAX_FILE_BYTES) continue;
        if (await isBinaryFile(file.abs)) continue;
        const content = await readFile(file.abs, "utf8").catch(() => undefined);
        if (content === undefined) continue;
        scanned += 1;

        const lines = content.split("\n");
        for (let index = 0; index < lines.length; index += 1) {
          const line = stripCarriageReturn(lines[index] ?? "");
          if (!pattern.test(line)) continue;
          if (matches.length >= limit) {
            truncated = true;
            break;
          }
          matches.push(`${file.rel}:${index + 1}:${clipLine(line)}`);
          files.add(file.rel);
        }
        if (truncated) break;
      }

      const details: GrepToolDetails = {
        root: resolution.root,
        matches: matches.length,
        files: files.size,
        truncated,
      };
      if (matches.length === 0) {
        return textResult(
          `No matches for ${JSON.stringify(params.pattern)} under ${resolution.root} — ${count(scanned, "file")} searched. Skipped: ${SKIPPED_DIR_NAMES.join(", ")}; files over 1 MiB, binary files and symbolic links are ignored.`,
          details,
        );
      }
      const summary = truncated
        ? `Limit ${limit} reached under ${resolution.root} — more matches exist; refine "pattern" or "include", or raise "limit" (max ${GREP_MAX_LIMIT}). Showing the first ${matches.length} matches after ${count(scanned, "file")} searched.`
        : `${count(matches.length, "match", "matches")} in ${count(files.size, "file")} under ${resolution.root} (${count(scanned, "file")} searched).`;
      return textResult([...matches, summary].join("\n"), details);
    },
  };
}

const globSchema = Type.Object({
  pattern: Type.String({
    description:
      'Glob pattern matched against the path relative to the search root. "**" crosses directories, "*" stays within one segment, "?" is one character. Example: "**/*.ts".',
  }),
  path: Type.Optional(
    Type.String({
      description:
        'Directory to search. Relative paths resolve against the working directory; an absolute path outside it is also accepted. Defaults to "."',
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: `Maximum number of paths to return. Default ${GLOB_DEFAULT_LIMIT}, hard cap ${GLOB_MAX_LIMIT}.`,
    }),
  ),
});

const GLOB_DESCRIPTION = `List files whose path matches a glob pattern, newest modification time first.

When to use it:
- Find a file whose name or extension you know but whose location you do not: "**/*.test.ts", "src/**/ipc*.ts", "tsconfig*.json".
- Survey a tree before reading anything ("which sources exist in src/main?"), or confirm that a file you expect is really there — zero matches is a real answer and is reported as such.
- Re-check what changed recently: the listing is sorted by modification time, so files you just created come first.

When not to use it:
- Not for searching file contents: use grep.
- Not for listing a directory that needs no pattern, and not for symlinks: glob returns regular files only, never directories, and it does not follow symbolic links or descend into skipped directories.
- Not a shell command line: there is no brace expansion ("*.{ts,tsx}" does not work), no "!" negation and no multiple patterns per call — pass one pattern and use "*", "?" and "**".

Arguments:
- pattern (required): glob pattern matched against the path relative to the search root, with "*" for any characters inside one directory segment, "?" for a single character and "**" for any number of directories. "**/*.ts" matches both "a.ts" and "src/deep/a.ts"; "src/*.ts" matches only the first level of "src".
- path: directory to search. A relative path resolves against the working directory; an absolute path outside it also works, in which case paths are reported relative to that root. Defaults to ".".
- limit: maximum number of paths returned. Default ${GLOB_DEFAULT_LIMIT}; values above ${GLOB_MAX_LIMIT} are clamped. Because the list is newest-first, a cut keeps the most recently modified files.

Output:
- One relative path per line, newest first (equal timestamps are ordered alphabetically), followed by a summary line with the file count and the search root.
- No match: an explicit "No files match ..." line — never an empty answer.
- Truncated: the summary says the limit was reached and that more files match, so narrow the pattern or raise "limit".
Automatically skipped: directories ${SKIPPED_DIR_NAMES.join(", ")}; symbolic links are never followed. Paths are reported relative to the resolved root.`;

/** 构造 glob 工具（只读；path 决定检索根，相对路径按会话工作目录解析） */
export function createGlobTool(
  options: SearchToolOptions = {},
): ToolRegistration<typeof globSchema, JsonRepresentation<GlobToolDetails>> {
  return {
    name: "glob",

    description: GLOB_DESCRIPTION,
    parameters: globSchema,
    async execute(params, api, context) {
      context.abortSignal?.throwIfAborted();
      const env = requireToolEnv(api);
      const requestedRoot = path.resolve(env.cwd, params.path ?? ".");
      const failure = (message: string): ToolExecutionResult<JsonRepresentation<GlobToolDetails>> =>
        textResult(`Error: ${message}`, { root: requestedRoot, matches: 0, truncated: false });
      const resolution = await resolveSearchRoot(
        params.path,
        env.cwd,
        options.allowedRoots,
        options.unrestricted,
      );
      if (!resolution.ok) return failure(resolution.message);

      const pattern = compileWildcard(params.pattern);
      const limit = clampLimit(params.limit, GLOB_DEFAULT_LIMIT, GLOB_MAX_LIMIT);
      const found: { rel: string; mtimeMs: number }[] = [];

      for await (const file of walkTarget(resolution.root, resolution.isFile)) {
        if (!pattern.test(file.rel)) continue;
        const info = await stat(file.abs).catch(() => undefined);
        if (info === undefined) continue;
        found.push({ rel: file.rel, mtimeMs: info.mtimeMs });
      }
      // 最新的在前；时间戳相同时按路径字典序，保证顺序稳定可复现
      found.sort(
        (left, right) =>
          right.mtimeMs - left.mtimeMs ||
          (left.rel < right.rel ? -1 : left.rel > right.rel ? 1 : 0),
      );

      const listed = found.slice(0, limit);
      const truncated = found.length > limit;
      const details: GlobToolDetails = {
        root: resolution.root,
        matches: listed.length,
        truncated,
      };
      if (listed.length === 0) {
        return textResult(
          `No files match ${JSON.stringify(params.pattern)} under ${resolution.root}. Skipped: ${SKIPPED_DIR_NAMES.join(", ")}; symbolic links are ignored.`,
          details,
        );
      }
      const summary = truncated
        ? `${count(limit, "file")} listed (limit ${limit}) under ${resolution.root}, newest first — more files match; narrow "pattern" or raise "limit" (max ${GLOB_MAX_LIMIT}).`
        : `${count(listed.length, "file")} under ${resolution.root}, newest first.`;
      return textResult([...listed.map((entry) => entry.rel), summary].join("\n"), details);
    },
  };
}
