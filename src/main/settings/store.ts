import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "@/main/app/paths";
import { writeFileAtomic } from "@/main/storage/atomic-write";
import {
  ALL_THINKING_LEVELS,
  normalizeAgentMode,
  type ThinkingLevel,
} from "@/shared/contracts/common";
import { isValidMcpServerId, type McpServerConfig } from "@/shared/contracts/mcp";
import type { ModelServiceConfig, Settings } from "@/shared/contracts/settings";
import {
  DEFAULT_WEB_SEARCH_SETTINGS,
  WEB_SEARCH_PROVIDERS,
  type WebSearchProvider,
  type WebSearchProviderConfig,
  type WebSearchSettings,
} from "@/shared/contracts/web";

/** safeStorage 的最小接口，便于在测试中注入假实现 */
export type Crypto = {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
};

/** 加密 apiKey 的落盘格式 */
export interface EncryptedKey {
  v: 1;
  enc: true;
  data: string;
}

type PersistedApiKey = string | EncryptedKey;
type PersistedService = Omit<ModelServiceConfig, "apiKey"> & { apiKey: PersistedApiKey };
/**
 * webSearch 的落盘形状：与 WebSearchSettings 同形，但每个 provider 的 apiKey 换成
 * 可能加密的值。
 *
 * 用映射类型而不是逐个列出五个 provider：漏一个就会让那个 provider 的 Key 明文落盘，
 * 而这正是这里要避免的。WebSearchProvider 是字面量联合，映射类型因此是穷举的。
 */
type PersistedWebSearchSettings = Omit<WebSearchSettings, WebSearchProvider | "provider"> & {
  provider: WebSearchProvider;
} & {
  [K in WebSearchProvider]: Omit<WebSearchProviderConfig, "apiKey"> & { apiKey: PersistedApiKey };
};
type PersistedSettings = Omit<Settings, "services" | "webSearch"> & {
  services: PersistedService[];
  webSearch: PersistedWebSearchSettings;
};
type Warn = (message: string) => void;

/** 完整 Settings 默认值；读文件时缺失字段一律以此兜底 */
export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  language: "zh-CN",
  density: "comfortable",
  chatFont: "",
  chatFontSize: 14,
  services: [],
  defaultModel: null,
  thinkingLevel: "medium",
  permissionMode: "default",
  agentMode: "standard",
  goalContinuationLimit: 10,
  disabledSkillNames: [],
  disabledSubagentNames: [],
  mcpServers: [],
  systemMcpServerEnabled: {},
  webSearch: DEFAULT_WEB_SEARCH_SETTINGS,
};

export interface SettingsStoreOptions {
  /** 注入加密实现；缺省时动态加载 Electron safeStorage，不可用则回退明文 */
  crypto?: Crypto;
  /** 警告日志输出，默认 console.warn */
  warn?: Warn;
}

export interface SettingsStore {
  load(): Promise<Settings>;
  save(next: Settings): Promise<void>;
}

function cloneDefaults(): Settings {
  return {
    ...DEFAULT_SETTINGS,
    services: [],
    disabledSkillNames: [],
    disabledSubagentNames: [],
    mcpServers: [],
    systemMcpServerEnabled: {},
    webSearch: cloneWebSearchSettings(DEFAULT_WEB_SEARCH_SETTINGS),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isEncryptedKey(value: unknown): value is EncryptedKey {
  if (!isRecord(value)) return false;
  return value.v === 1 && value.enc === true && typeof value.data === "string";
}

function encryptionAvailable(crypto: Crypto | null): boolean {
  if (!crypto) return false;
  try {
    return crypto.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/** 深合并仅覆盖顶层字段；services 数组整体替换，不逐元素合并 */
function mergeWithDefaults(raw: unknown, crypto: Crypto | null, warn: Warn): Settings {
  const base = cloneDefaults();
  if (!isRecord(raw)) return base;
  const merged: Record<string, unknown> = { ...base };
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const value = raw[key];
    if (value !== undefined) merged[key] = value;
  }
  return {
    ...(merged as unknown as Settings),
    defaultModel: normalizeModelRef(raw.defaultModel),
    permissionMode: normalizePermissionMode(raw.permissionMode),
    agentMode: normalizeAgentMode(raw.agentMode) ?? DEFAULT_SETTINGS.agentMode,
    goalContinuationLimit:
      typeof raw.goalContinuationLimit === "number" && Number.isInteger(raw.goalContinuationLimit)
        ? Math.max(1, Math.min(100, raw.goalContinuationLimit))
        : 10,
    language: normalizeLanguage(raw.language),
    services: normalizeServices(raw.services, crypto, warn),
    disabledSkillNames: Array.isArray(raw.disabledSkillNames)
      ? raw.disabledSkillNames.filter((name) => typeof name === "string")
      : base.disabledSkillNames,
    // 禁用名列表按字符串过滤
    disabledSubagentNames: Array.isArray(raw.disabledSubagentNames)
      ? raw.disabledSubagentNames.filter((name) => typeof name === "string")
      : base.disabledSubagentNames,
    // MCP server 列表：逐条归一（命令/参数/环境变量可能是任意 JSON），非法条目直接丢掉
    mcpServers: normalizeMcpServers(raw.mcpServers),
    // 系统预设的显式启停：只留布尔值；非法值与空键直接丢掉（丢掉的会回落到预设默认值）
    systemMcpServerEnabled: normalizeBooleanRecord(raw.systemMcpServerEnabled),
    // 网络搜索：provider 子对象逐字段归一，apiKey 走与 services 相同的解密路径
    webSearch: normalizeWebSearch(raw.webSearch, crypto, warn),
  };
}

function normalizeModelRef(raw: unknown): Settings["defaultModel"] {
  if (!isRecord(raw)) return null;
  const { serviceId, modelId } = raw;
  if (typeof serviceId !== "string" || typeof modelId !== "string") return null;
  return { serviceId, modelId };
}

/** 审批模式容错：非法取值一律回落到 default（安全侧弹卡询问） */
function normalizePermissionMode(raw: unknown): Settings["permissionMode"] {
  return raw === "ai_review" || raw === "full" ? raw : "default";
}

/** 语言容错：非法取值回落到默认语言（提示词、占位文案都按它索引） */
function normalizeLanguage(raw: unknown): Settings["language"] {
  return raw === "en-US" ? "en-US" : "zh-CN";
}

function normalizeServices(raw: unknown, crypto: Crypto | null, warn: Warn): ModelServiceConfig[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord).map((item) => ({
    id: asString(item.id),
    name: asString(item.name),
    baseUrl: asString(item.baseUrl),
    wireFormat: item.wireFormat === "openai-responses" ? "openai-responses" : "openai-completions",
    models: normalizeModelEntries(item.models),
    apiKey: decodeApiKey(item.apiKey, crypto, warn),
  }));
}

/** 字符串键值表归一：只留「键非空且值确实是字符串」的项，顺序保持文件里的原样 */
function normalizeStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const record: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key !== "" && typeof item === "string") record[key] = item;
  }
  return record;
}

/**
 * 布尔键值表归一（系统 MCP 预设的启停表）。
 *
 * 只留真正的布尔值：磁盘上的 JSON 可能被手改过，一个 `"false"` 字符串若被当成真值，
 * 用户会看到「明明关了却还在连」—— 丢掉它反而是对的（回落到预设默认值，行为可预期）。
 */
function normalizeBooleanRecord(value: unknown): Record<string, boolean> {
  if (!isRecord(value)) return {};
  const record: Record<string, boolean> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key !== "" && typeof item === "boolean") record[key] = item;
  }
  return record;
}

/**
 * MCP server 归一化。
 *
 * 丢掉 id 非法的条目而不是修正它：id 是限定名 `mcp__<id>__<tool>` 的解析依据，
 * 一个坏 id 会让权限门的「按 server 批量授权」静默失效 —— 这类数据宁可不存在。
 * transport 只认 stdio / http，其余回落到 stdio（本地子进程是 MCP 的主用法）。
 */
function normalizeMcpServers(raw: unknown): McpServerConfig[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(isRecord)
    .map((item): McpServerConfig => {
      const id = asString(item.id);
      return {
        id,
        name: asString(item.name),
        // 缺省视为启用：用户写下的配置默认就该生效，关闭是明确动作
        enabled: typeof item.enabled === "boolean" ? item.enabled : true,
        transport: item.transport === "http" ? "http" : "stdio",
        command: asString(item.command),
        args: Array.isArray(item.args) ? item.args.filter((arg) => typeof arg === "string") : [],
        env: normalizeStringRecord(item.env),
        cwd: asString(item.cwd),
        url: asString(item.url),
        headers: normalizeStringRecord(item.headers),
        createdAt: typeof item.createdAt === "number" ? item.createdAt : Date.now(),
      };
    })
    .filter((server) => isValidMcpServerId(server.id));
}

/** 只接受有限正数；其余（字符串、NaN、0、负数）视为未设置 */
function asOptionalPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** 整数夹取：非有限值/非数字回落 fallback，其余取整并夹到 [min, max] */
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(Math.floor(value), max));
}

/** 非空字符串，否则 undefined（用于「可选的字符串字段」归一） */
function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * webSearch 深拷贝：provider 子对象必须各自展开。
 *
 * 不这么做的话，设置面板改一个 provider 的字段会串到另一个
 *（`DEFAULT_WEB_SEARCH_SETTINGS.searxng` 与 clone 出来的对象共享同一个引用）。
 */
export function cloneWebSearchSettings(source: WebSearchSettings): WebSearchSettings {
  return {
    ...source,
    searxng: { ...source.searxng },
    tavily: { ...source.tavily },
    exa: { ...source.exa },
    serper: { ...source.serper },
    brave: { ...source.brave },
  };
}

/**
 * webSearch 归一化。
 *
 * 逐字段白名单而不是整体 spread：磁盘上的 JSON 可能被手改过，
 * 一个 `provider: "openai"` 或 `maxResults: -1` 不该让整个设置加载失败 ——
 * 与 normalizeServices / normalizeMcpServers 同一口径。
 *
 * apiKey 走与 services[].apiKey **同一个** decodeApiKey：加密可用性只有一处判断。
 */
export function normalizeWebSearch(
  raw: unknown,
  crypto: Crypto | null,
  warn: Warn,
): WebSearchSettings {
  const base = cloneWebSearchSettings(DEFAULT_WEB_SEARCH_SETTINGS);
  if (!isRecord(raw)) return base;

  const providerConfig = (key: WebSearchProvider): WebSearchProviderConfig => {
    const src = isRecord(raw[key]) ? (raw[key] as Record<string, unknown>) : {};
    // 从默认值出发，只用**类型正确**的磁盘值覆盖它：
    // 这样「字段缺失」与「字段类型不对」都自然回落到默认，不需要为每个字段各写一次判断。
    const merged: WebSearchProviderConfig = { ...base[key] };

    // apiKey 单独走解密路径（其余字段都是明文）
    merged.apiKey = decodeApiKey(src.apiKey, crypto, warn);

    if (src.searchDepth === "basic" || src.searchDepth === "advanced") {
      merged.searchDepth = src.searchDepth;
    }
    if (src.type === "neural" || src.type === "keyword") {
      merged.type = src.type;
    }
    if (typeof src.includeAnswer === "boolean") {
      merged.includeAnswer = src.includeAnswer;
    }
    // instances 允许显式空串（那表示「用内置清单」），所以不能按「非空才要」处理
    if (typeof src.instances === "string") {
      merged.instances = src.instances;
    }
    for (const field of ["gl", "hl", "country", "searchLang"] as const) {
      const value = asNonEmptyString(src[field]);
      if (value !== undefined) merged[field] = value;
    }
    return merged;
  };

  const provider = WEB_SEARCH_PROVIDERS.find((candidate) => candidate === raw.provider);

  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : base.enabled,
    provider: provider ?? base.provider,
    searxng: providerConfig("searxng"),
    tavily: providerConfig("tavily"),
    exa: providerConfig("exa"),
    serper: providerConfig("serper"),
    brave: providerConfig("brave"),
    maxResults: clampInt(raw.maxResults, 1, 20, base.maxResults),
    fetchMaxOutputChars: clampInt(
      raw.fetchMaxOutputChars,
      1_000,
      1_000_000,
      base.fetchMaxOutputChars,
    ),
    fetchTimeoutMs: clampInt(raw.fetchTimeoutMs, 1_000, 120_000, base.fetchTimeoutMs),
  };
}

/** webSearch 落盘：把每个 provider 的 apiKey 加密，其余字段原样 */
export function persistWebSearch(
  settings: WebSearchSettings,
  crypto: Crypto | null,
): PersistedWebSearchSettings {
  return {
    enabled: settings.enabled,
    provider: settings.provider,
    maxResults: settings.maxResults,
    fetchMaxOutputChars: settings.fetchMaxOutputChars,
    fetchTimeoutMs: settings.fetchTimeoutMs,
    searxng: persistProviderConfig(settings.searxng, crypto),
    tavily: persistProviderConfig(settings.tavily, crypto),
    exa: persistProviderConfig(settings.exa, crypto),
    serper: persistProviderConfig(settings.serper, crypto),
    brave: persistProviderConfig(settings.brave, crypto),
  };
}

function persistProviderConfig(
  config: WebSearchProviderConfig,
  crypto: Crypto | null,
): Omit<WebSearchProviderConfig, "apiKey"> & { apiKey: PersistedApiKey } {
  const { apiKey, ...rest } = config;
  return { ...rest, apiKey: encodeApiKey(apiKey, crypto) };
}

/**
 * 校验思考档位：只留本仓五档、去重、按强弱顺序排好；空数组视为「没有信息」（undefined）。
 *
 * 顺序必须归一：档位列表要参与「就近降级」的比较，留着用户在磁盘上写乱的顺序会让结果
 * 依赖文件内容而不是规则。
 */
function normalizeThinkingLevels(value: unknown): ThinkingLevel[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const levels = ALL_THINKING_LEVELS.filter((level) => value.includes(level));
  return levels.length > 0 ? [...levels] : undefined;
}

/**
 * 模型条目归一化。除了剔除非法的数字/布尔，还负责一次**字段迁移**：
 *
 * 旧版本用 `input: ("text"|"image")[]` 存模态，现在只留一个 `acceptsImages` 布尔。
 * 老设置文件里没有 acceptsImages 但有 input 时，按「列表里有没有 image」还原 ——
 * 不迁移的话用户之前勾的图片支持会在升级后静默丢失（变成「跟随目录」）。
 */
function normalizeModelEntries(raw: unknown): ModelServiceConfig["models"] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord).map((item) => {
    const entry: ModelServiceConfig["models"][number] = { id: asString(item.id) };
    const name = typeof item.name === "string" ? item.name : "";
    if (name !== "") entry.name = name;
    const contextWindow = asOptionalPositiveNumber(item.contextWindow);
    if (contextWindow !== undefined) entry.contextWindow = contextWindow;
    const maxTokens = asOptionalPositiveNumber(item.maxTokens);
    if (maxTokens !== undefined) entry.maxTokens = maxTokens;
    if (typeof item.reasoning === "boolean") entry.reasoning = item.reasoning;

    const acceptsImages =
      typeof item.acceptsImages === "boolean"
        ? item.acceptsImages
        : Array.isArray(item.input)
          ? item.input.includes("image")
          : undefined;
    if (acceptsImages !== undefined) entry.acceptsImages = acceptsImages;

    const thinkingLevels = normalizeThinkingLevels(item.thinkingLevels);
    if (thinkingLevels !== undefined) entry.thinkingLevels = thinkingLevels;
    return entry;
  });
}
/** 解密 apiKey：字符串视为旧格式明文；加密对象在无密钥环时置空并告警 */
function decodeApiKey(raw: unknown, crypto: Crypto | null, warn: Warn): string {
  if (typeof raw === "string") return raw;
  if (!isEncryptedKey(raw)) return "";
  if (crypto === null || !encryptionAvailable(crypto)) {
    warn("检测到加密的 apiKey，但当前环境无法解密，已置空");
    return "";
  }
  try {
    return crypto.decryptString(Buffer.from(raw.data, "base64"));
  } catch (error) {
    warn(`apiKey 解密失败，已置空: ${String(error)}`);
    return "";
  }
}

/** 加密 apiKey：safeStorage 不可用时原样返回明文字符串 */
function encodeApiKey(plain: string, crypto: Crypto | null): PersistedApiKey {
  if (plain === "" || crypto === null || !encryptionAvailable(crypto)) return plain;
  return { v: 1, enc: true, data: crypto.encryptString(plain).toString("base64") };
}

function toPersisted(settings: Settings, crypto: Crypto | null): PersistedSettings {
  return {
    ...settings,
    services: settings.services.map((service) => ({
      ...service,
      apiKey: encodeApiKey(service.apiKey, crypto),
    })),
    webSearch: persistWebSearch(settings.webSearch, crypto),
  };
}

/** 创建一个基于指定数据目录的设置存储；测试传入临时目录，生产使用 dataDir() */
export function createSettingsStore(
  baseDir: string,
  options: SettingsStoreOptions = {},
): SettingsStore {
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const filePath = path.join(baseDir, "settings.json");
  let warnedFallback = false;
  /**
   * 解析结果缓存。
   *
   * 为什么必须有：`load()` 原本每次都读盘 + 解析，而它在**每次工具调用**（权限门要看
   * permissionMode 与规则）、每次发送（对齐模型与思考档位）、每次审批预审里都会被调到。
   * 十次工具调用就是十次磁盘读 + JSON.parse。
   *
   * 语义（有意选定的权衡）：**进程内以内存为准**。
   * - `save()` 之后缓存立刻更新为新值，界面写入立即生效；
   * - 用户手改 `settings.json` 不会在进程内被察觉，需要重启应用。
   * 反向选择（每次校验 mtime）会让「读设置」重新变成一个系统调用，也就抵消了这次缓存 —— 而
   * 手改配置文件后重启，本来就是本仓其它配置（AGENTS.md、技能目录）的既有约定。
   */
  let cache: { value: Settings; crypto: Crypto | null } | null = null;

  async function resolveCrypto(): Promise<Crypto | null> {
    const crypto = options.crypto ?? (await resolveSharedCrypto());
    if (crypto && !encryptionAvailable(crypto) && !warnedFallback) {
      warnedFallback = true;
      warn("safeStorage 加密不可用，apiKey 将以明文存储");
    }
    return crypto;
  }

  async function load(): Promise<Settings> {
    if (cache !== null) return cache.value;
    const crypto = await resolveCrypto();
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        warn(`读取设置失败，已回退默认值: ${String(error)}`);
      }
      const value = cloneDefaults();
      cache = { value, crypto };
      return value;
    }
    const value = mergeWithDefaults(raw, crypto, warn);
    cache = { value, crypto };
    return value;
  }

  async function save(next: Settings): Promise<void> {
    const crypto = await resolveCrypto();
    /**
     * **写侧归一 —— 与读侧同一套判据。**
     *
     * 早先这里直接 `toPersisted(next)`：`toPersisted` 是 `{...settings, services, webSearch}`，
     * 于是**渲染层送来的任意额外键会被 spread 落盘**，而所有校验
     *（`normalizePermissionMode` 非法回落 default、`clampInt`、`normalizeMcpServers`…）
     * **只在 `load()` 里生效**。
     *
     * 后果不是理论问题：渲染层可以写 `permissionMode: "full"`，缓存立即更新
     *（下面那行 `cache = ...`），**审批链当场失效**。今天渲染层是我们自己的代码所以
     * 不算漏洞，但插件界面一旦进入渲染层，`window.oint.settings.write` 就是全套权限 ——
     * 这正是插件界面进入渲染层时需要堵住的缺口。
     *
     * 跑一遍 `mergeWithDefaults` 一次解决两件事：
     *  - 非法值被归一（`"full"` 是合法值，但 `"whatever"` 会回落 `default`）；
     *  - **DEFAULT_SETTINGS 之外的键根本不会被复制**，因为它是按那份键表逐项取的。
     *
     * 代价是每次写入多一次纯内存的对象归一（微秒级），而收益是「读到的」与「写下去的」
     * 从此走同一条路 —— 不再有一类值只在重启后才被发现非法。
     */
    const normalized = mergeWithDefaults(next, crypto, warn);
    const payload = `${JSON.stringify(toPersisted(normalized, crypto), null, 2)}\n`;
    await mkdir(path.dirname(filePath), { recursive: true });
    // 先写临时文件再 rename，避免中断时留下半截 JSON
    await writeFileAtomic(filePath, payload);
    // 落盘成功后才更新缓存：写失败时内存态不该「看起来已经保存了」。
    // 缓存的是**归一后**的那份 —— 否则界面读回来的值与盘上的不一致。
    cache = { value: normalized, crypto };
  }

  return { load, save };
}

// 动态加载避免 vitest（无 Electron 运行时）在 import 阶段失败；结果缓存一次
let sharedCrypto: Crypto | null | undefined;

async function resolveSharedCrypto(): Promise<Crypto | null> {
  if (sharedCrypto !== undefined) return sharedCrypto;
  try {
    const electron = await import("electron");
    const candidate = electron.safeStorage as Partial<Crypto> | undefined;
    sharedCrypto =
      candidate && typeof candidate.isEncryptionAvailable === "function"
        ? (candidate as Crypto)
        : null;
  } catch {
    sharedCrypto = null;
  }
  return sharedCrypto;
}

let defaultStore: SettingsStore | null = null;

/** 默认单例：设置文件位于数据根（~/.oint 或 OINT_HOME 指定的目录），首次调用时才解析 */
export function getSettingsStore(): SettingsStore {
  defaultStore ??= createSettingsStore(dataDir());
  return defaultStore;
}

export async function loadSettings(): Promise<Settings> {
  return getSettingsStore().load();
}

export async function saveSettings(next: Settings): Promise<void> {
  return getSettingsStore().save(next);
}
