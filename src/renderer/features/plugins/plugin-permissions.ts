// 插件权限与贡献物的**展示投影**：把主进程给的 PluginPermissionView 变成界面要的
// 「文案键 + 样式类」。纯函数，无 React 依赖 —— 所以可以直接单测（见同名 .test.ts）。
//
// 三条刻意的边界：
//
// 1. **风险档位不在这里推断**。`PluginPermissionView.risk` 由主进程给，这里只把
//    三个档位映射成样式。判据是宿主的能力面而不是界面偏好；放到渲染层会让
//    「同一个权限在两处显示成不同颜色」成为可能。
//
// 2. **文案键是字面量表，不是拼串**。`plugins.perm.${id}` 这种拼法有两个问题：
//    scripts/check-i18n.mjs 抓的是编译期字面量键，拼串会让漏译逃过门禁；
//    而权限 id 自带点号（`ui.panel`），拼出来会撞上 i18next 的点号嵌套语义。
//
// 3. **表外的权限不静默**。返回 undefined 时界面显示 id 原文 + 一句「未知权限」——
//    而不是空白。插件可以声明宿主还没实现的权限（或宿主删掉了旧权限），
//    那时用户至少要看到「有个东西我不认识」，而不是一行凭空少了一项。

import {
  PLUGIN_PERMISSIONS,
  type PluginContributionNames,
  type PluginContributionSummary,
  type PluginPermissionView,
} from "@/shared/contracts/plugin";

export type PluginRisk = PluginPermissionView["risk"];

/**
 * 权限 chip 的三档样式。
 *
 * 配色取自本仓库既有的告警/错误口径（`text-amber-600 dark:text-amber-400` 与
 * `border-red-600/25 bg-red-600/[0.08]`，见 approval-card / SubagentsPanel）——
 * 不新造一套颜色，否则同一个界面里两种「警告黄」会同时出现。
 */
const RISK_CHIP: Readonly<Record<PluginRisk, string>> = {
  low: "border-border/60 text-muted-foreground",
  medium: "border-amber-600/25 bg-amber-600/[0.08] text-amber-600 dark:text-amber-400",
  high: "border-red-600/25 bg-red-600/[0.08] text-red-600 dark:text-red-400",
};

/** 权限 chip 的样式（含边框与底色），供徽标类组件直接用 */
export function riskChipClass(risk: PluginRisk): string {
  return RISK_CHIP[risk];
}

/**
 * 显示顺序：高 → 中 → 低。
 *
 * **高的排前面**，与 PI-Desktop 的权限弹窗同一口径。理由不是审美：用户扫一眼
 * 权限列表时该先看到「这个插件能删我的文件」，而不是「它想开一个面板」。
 */
const RISK_ORDER: Readonly<Record<PluginRisk, number>> = { high: 0, medium: 1, low: 2 };

/** 按风险从高到低排序（稳定：同档保持原顺序） */
export function sortPermissions(
  permissions: readonly PluginPermissionView[],
): PluginPermissionView[] {
  return [...permissions].sort((a, b) => RISK_ORDER[a.risk] - RISK_ORDER[b.risk]);
}

/**
 * 权限 id → 展示元数据。
 *
 * ## ⚠️ 为什么是 `{ labelKey: "..." }` 而不是裸的字符串映射
 *
 * 因为 **scripts/check-i18n.mjs 只抓 `labelKey:` 这类字段**（见它源码里的 KEY_FIELD_RE，
 * 覆盖 `labelKey` / `descriptionKey` / `hintKey` / `messageKey`）。
 * 写成 `{ "ui.panel": "plugins.perm.uiPanel" }` 的话，这 22 个键**从门禁眼皮底下溜过去** ——
 * 这不是推测，是实测：改成裸映射时扫描总数是 **614**，权限与贡献物的键一个都不在里面。
 *
 * 后果与那个门禁当初存在的理由一模一样：i18next 缺键时**原样返回键名**，
 * 于是打错一个字母（`plugins.perm.uiPanell`）不会有任何东西变红，
 * 界面上直接显示那个字面量 —— 组件渲染成功、断言也能过，只有肉眼看界面才发现。
 *
 * 所以这个形状是**约束，不是风格**：改动前先确认门禁还看得见。
 *
 * ## 覆盖面
 *
 * 这一批对应插件 API 里**已定义**的能力表。
 * 新增权限时这里必须同步加一条 —— 漏了不会报错，但界面会退化成显示权限 id。
 */
const PERMISSION_META: Readonly<Record<string, { labelKey: string }>> = {
  "ui.panel": { labelKey: "plugins.perm.uiPanel" },
  "ui.window": { labelKey: "plugins.perm.uiWindow" },
  "ui.modal": { labelKey: "plugins.perm.uiModal" },
  "ui.theme": { labelKey: "plugins.perm.uiTheme" },
  notify: { labelKey: "plugins.perm.notify" },
  storage: { labelKey: "plugins.perm.storage" },
  "skills.contribute": { labelKey: "plugins.perm.skillsContribute" },
  "prompts.contribute": { labelKey: "plugins.perm.promptsContribute" },
  "subagents.contribute": { labelKey: "plugins.perm.subagentsContribute" },
  "commands.register": { labelKey: "plugins.perm.commandsRegister" },
  "agent.tool.register": { labelKey: "plugins.perm.agentToolRegister" },
  "shell.exec": { labelKey: "plugins.perm.shellExec" },
  "net.fetch": { labelKey: "plugins.perm.netFetch" },
  "mcp.server.local": { labelKey: "plugins.perm.mcpServerLocal" },
  "mcp.server.remote": { labelKey: "plugins.perm.mcpServerRemote" },
  "hostHooks.register": { labelKey: "plugins.perm.hostHooksRegister" },
  "clipboard.write": { labelKey: "plugins.perm.clipboardWrite" },
};

/** 权限 id 的文案键；表外返回 undefined（界面据此显示 id 原文 + 「未知权限」） */
export function permissionLabelKey(id: string): string | undefined {
  return PERMISSION_META[id]?.labelKey;
}

/**
 * 这个权限今天有没有执行点 —— 表在共享契约里（`UNENFORCED_PLUGIN_PERMISSIONS`）。
 *
 * **判据不在渲染层**：一条权限"生不生效"是宿主的事实，不是界面偏好。放在这里转发
 * 只是为了让界面代码读起来短一点（与 `riskChipClass` 同样的转发手法）。
 *
 * 界面据此在权限行上打一枚「未生效」标记。不标的话，权限卡会把
 * 「读取文件 · 范围：工作区」当成一条已经在管着的规则展示给用户，
 * 而它今天既没有 API 也没有校验点（详见契约里那张表的注释）。
 */
export function isPermissionEnforced(id: string): boolean {
  return (PLUGIN_PERMISSIONS as readonly string[]).includes(id);
}

/**
 * 贡献物的展示顺序与文案键。
 *
 * 顺序按「用户最可能关心」排：界面（一眼能看见的）→ 能力（模型能用的）→ 数据。
 * 与 PluginContributionSummary 的字段顺序不一致是**刻意的**：结构体按领域分组，
 * 这里按可读性排。
 *
 * 形状与 PERMISSION_META 相同（`{ labelKey }` 而不是裸字符串）—— 理由见那一处的说明，
 * 一句话：**裸映射会被 check-i18n 漏掉**。
 */
const CONTRIBUTION_META = {
  panels: { labelKey: "plugins.contrib.panels" },
  modals: { labelKey: "plugins.contrib.modals" },
  windows: { labelKey: "plugins.contrib.windows" },
  commands: { labelKey: "plugins.contrib.commands" },
  skills: { labelKey: "plugins.contrib.skills" },
  prompts: { labelKey: "plugins.contrib.prompts" },
  subagents: { labelKey: "plugins.contrib.subagents" },
  mcpServers: { labelKey: "plugins.contrib.mcpServers" },
  tools: { labelKey: "plugins.contrib.tools" },
} as const satisfies Record<keyof PluginContributionSummary, { labelKey: string }>;

export interface ContributionChip {
  key: string;
  count: number;
}

/**
 * 贡献物**名字**的展示行 —— 只有这四类有名字。
 *
 * 形状与 `CONTRIBUTION_META` 一致（对象字面量 + `labelKey` 字段），理由见 `PERMISSION_META`：
 * 裸映射会被 `scripts/check-i18n.mjs` 漏掉，而漏掉的后果是界面上直接显示键名。
 *
 * `commands` / `tools` 不在其中：它们是**运行期**由插件进程报的，磁盘上数不出名字来
 *（见 shared/contracts/plugin.ts 的 PluginContributionNames）。
 */
export const CONTRIBUTION_NAME_ROWS = [
  { field: "skills", labelKey: "plugins.contrib.skills" },
  { field: "prompts", labelKey: "plugins.contrib.prompts" },
  { field: "subagents", labelKey: "plugins.contrib.subagents" },
  { field: "mcpServers", labelKey: "plugins.contrib.mcpServers" },
] as const satisfies readonly {
  field: keyof PluginContributionNames;
  labelKey: string;
}[];

/**
 * 把计数摘要变成「有哪几项」的 chip 列表。
 *
 * **计数为 0 的项直接丢掉**：一个只贡献面板的插件不该在界面上写「技能 0 · MCP 0」——
 * 零不是信息，它只是把真正的那一项淹掉。
 */
export function contributionChips(summary: PluginContributionSummary): ContributionChip[] {
  const out: ContributionChip[] = [];
  for (const [field, meta] of Object.entries(CONTRIBUTION_META)) {
    const count = summary[field as keyof PluginContributionSummary];
    if (count > 0) out.push({ key: meta.labelKey, count });
  }
  return out;
}

/** 贡献物总数 —— 列表行上「贡献 3 项」用；为 0 时界面显示「无贡献物」而不是「贡献 0 项」 */
export function contributionTotal(summary: PluginContributionSummary): number {
  return Object.values(summary).reduce((sum, count) => sum + count, 0);
}
