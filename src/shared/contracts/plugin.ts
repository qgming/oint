export const PLUGIN_PERMISSIONS = [
  "ui.panel",
  "ui.window",
  "ui.modal",
  "ui.theme",
  "notify",
  "storage",
  "skills.contribute",
  "prompts.contribute",
  "subagents.contribute",
  "commands.register",
  "agent.tool.register",
  "shell.exec",
  "net.fetch",
  "mcp.server.local",
  "mcp.server.remote",
  "hostHooks.register",
  "clipboard.write",
] as const;

export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number];

export interface PluginSurfaceDecl {
  id: string;
  kind: "panel" | "window" | "modal";

  title: string | { en: string; "zh-CN": string };

  icon?: string;
  order?: number;

  entry: string;
  shape?: "panel" | "widget";
  width?: number;
  height?: number;
  alwaysOnTop?: boolean;
  resizable?: boolean;
  skipTaskbar?: boolean;

  openAt?: "enable" | "command";
}

export type PluginHookName = "beforeTool" | "afterTool";

export interface PluginPackage {
  name: string;
  version: string;
  description: string;

  id: string;
  permissions: PluginPermission[];
  net?: { domains: string[] };

  shell?: { exec: string[] };

  /** Chord agent 入口（相对插件根目录，源码直载：.ts 由子进程用 Node 类型剥离加载） */
  agentFacet?: string;

  hooks: PluginHookName[];
  surfaces: PluginSurfaceDecl[];
}

export interface PluginManifestIssue {
  path: string;
  message: string;

  severity: "error" | "warning";
}

export type PluginManifestResult =
  | { ok: true; manifest: PluginPackage; warnings: PluginManifestIssue[] }
  | { ok: false; issues: PluginManifestIssue[] };

export type PluginSource = "builtin" | "user" | "dev";

export type PluginState = "disabled" | "loading" | "running" | "load_error" | "invalid" | "crashed";

export interface PluginContributionSummary {
  panels: number;

  modals: number;
  windows: number;
  commands: number;
  skills: number;
  prompts: number;
  subagents: number;
  mcpServers: number;
  tools: number;
}

export interface PluginContributionNames {
  skills: string[];
  prompts: string[];
  subagents: string[];
  mcpServers: string[];
}

export interface PluginPermissionView {
  id: string;

  scope?: string;

  risk: "low" | "medium" | "high";
}

export interface PluginCommandView {
  id: string;
  pluginId: string;
  pluginName: string;

  name: string;
  description: string;
}

export type PluginSurfaceOpenResult = { kind: "window" } | { kind: "panel" } | { kind: "modal" };

export interface PluginSurfaceClosedEvent {
  pluginId: string;
  surfaceId: string;
  kind: "panel" | "modal";
}

export interface PluginSurfaceInfo {
  id: string;
  kind: "panel" | "window" | "modal";
  title: string;

  url: string;

  partition: string;

  width?: number;
  height?: number;
}

export interface PluginView {
  id: string;
  name: string;
  version: string;
  description: string;
  source: PluginSource;

  removable: boolean;

  enabled: boolean;

  state: PluginState;

  error?: string;
  contributions: PluginContributionSummary;

  contributionNames: PluginContributionNames;

  hooks: PluginHookName[];

  hasCode: boolean;
  permissions: PluginPermissionView[];

  newlyRequested: string[];
  surfaces: PluginSurfaceInfo[];
  installedAt?: number;
  updatedAt?: number;
}

export interface PluginDiagnostic {
  pluginId: string;

  seq: number;
  level: "warn" | "error";

  event: string;
  message: string;
  at: number;
}

export interface PluginMutationResult {
  canceled: boolean;

  views: PluginView[];

  diagnostics: string[];
}

export interface PluginListResult {
  views: PluginView[];
  diagnostics: string[];
}
