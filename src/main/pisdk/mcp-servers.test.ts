import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { describe, expect, it, vi } from "vitest";
import type { McpCallResult, McpClient, McpHandshake, McpRemoteTool } from "@/main/mcp/client";
import {
  MCP_CATALOG_TOOL_NAME,
  type McpServerConfig,
  type McpServerView,
} from "@/shared/contracts/mcp";
import type { Settings } from "@/shared/contracts/settings";
import { DEFAULT_WEB_SEARCH_SETTINGS } from "@/shared/contracts/web";
import { BUILTIN_MCP_SERVERS } from "@/shared/mcp/builtin-servers";
import { createMcpServers, type McpServers } from "./mcp-servers";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function makeConfig(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: "mcp-a",
    name: "A",
    enabled: true,
    transport: "stdio",
    command: "noop",
    args: [],
    env: {},
    cwd: "",
    url: "",
    headers: {},
    createdAt: 1,
    ...overrides,
  };
}

/**
 * 除系统层用例以外，其余用例一律**把系统预设全部显式停用**。
 *
 * 理由：真实默认值会让每个用例都顺带连上三个远端 server（假客户端会为它们各建一条连接），
 * 于是 log 里混进无关条目、views 里混进九行系统预设 —— 每个断言都得先过滤一遍才能说话。
 * 系统层自身的行为由文件末尾那组用例专门覆盖（它们用真实默认值）。
 */
function allSystemDisabled(): Record<string, boolean> {
  return Object.fromEntries(BUILTIN_MCP_SERVERS.map((preset) => [preset.id, false]));
}

/** 只看用户层的视图行（系统预设那几行在每个用例里都存在） */
function userViews(views: McpServerView[]): McpServerView[] {
  return views.filter((view) => view.source === "user");
}

function makeSettings(
  mcpServers: McpServerConfig[],
  systemMcpServerEnabled: Record<string, boolean> = allSystemDisabled(),
): Settings {
  return {
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
    disabledSkillNames: [],
    disabledSubagentNames: [],
    mcpServers,
    systemMcpServerEnabled,
    webSearch: DEFAULT_WEB_SEARCH_SETTINGS,
  };
}

const READ_FILE: McpRemoteTool = {
  name: "read_file",
  description: "读文件",
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
};

/**
 * 只看「来自 MCP server 的工具」，滤掉内置的 `mcp_tools` 详情工具。
 *
 * 它恒定装配（只要连过 server），断言里每次都带上它会把「这台 server 暴露了什么」这件事淹掉。
 * 它自己的行为由 tools/mcp-catalog.test.ts 覆盖。
 */
function mcpToolNames(servers: McpServers): string[] {
  return servers
    .tools()
    .map((tool) => tool.name)
    .filter((name) => name !== MCP_CATALOG_TOOL_NAME);
}

interface FakeClient extends McpClient {
  readonly config: McpServerConfig;
}

/** 可控假客户端：connect 要么成功（带给定工具表）要么按 fail 抛错 */
function createFakeClient(options: {
  config: McpServerConfig;
  log: string[];
  tools?: McpRemoteTool[];
  fail?: string;
}): FakeClient {
  const closedListeners = new Set<(reason: string) => void>();
  return {
    config: options.config,
    label: `fake:${options.config.id}`,
    diagnostics: () => (options.fail === undefined ? "" : "stderr：boom"),
    async connect(): Promise<McpHandshake> {
      options.log.push(`connect:${options.config.id}`);
      if (options.fail !== undefined) throw new Error(options.fail);
      return {
        protocolVersion: "2025-06-18",
        serverName: `${options.config.id}-server`,
        serverVersion: "1.0.0",
      };
    },
    async listTools(): Promise<McpRemoteTool[]> {
      return options.tools ?? [];
    },
    async callTool(name: string): Promise<McpCallResult> {
      options.log.push(`call:${options.config.id}:${name}`);
      return { content: [{ type: "text", text: `ok:${name}` }], isError: false };
    },
    onToolsChanged() {
      return () => {};
    },
    onClosed(listener) {
      closedListeners.add(listener);
    },
    async close() {
      options.log.push(`close:${options.config.id}`);
      for (const listener of [...closedListeners]) listener("已主动关闭");
    },
  };
}

/** 组装被测对象：设置可随时替换，客户端按配置建 */
function setup(
  initial: McpServerConfig[],
  overrides: Partial<Record<string, { fail?: string }>> = {},
) {
  const log: string[] = [];
  let current = makeSettings(initial);
  const servers = createMcpServers({
    getSettings: async () => current,
    warn: () => undefined,
    createClient: (config) =>
      createFakeClient({
        config,
        log,
        tools: [READ_FILE],
        ...(overrides[config.id]?.fail === undefined ? {} : { fail: overrides[config.id]?.fail }),
      }),
  });
  return {
    log,
    servers,
    setServers: (next: McpServerConfig[]) => {
      current = makeSettings(next);
    },
  };
}

/**
 * 调用工具的 execute：harness 的完整签名是六个参数，测试只关心前两个。
 *
 * 这里刻意用宽松类型而不是精确的 AppToolContext：本文件关心的是「工具收集与转发」，
 * 不是工具执行的上下文契约（那由各工具自己的 test 覆盖）。
 */
type LooseTool = {
  name: string;
  description: string;
  execute: (
    id: string,
    params: unknown,
  ) => Promise<{ output: { type: string; text?: string }[]; details?: Record<string, unknown> }>;
};

function looseTool(tools: ToolRegistration[], name: string): LooseTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`工具不存在：${name}`);
  return {
    ...tool,
    execute: (_id, params) =>
      tool.execute(params, {} as Parameters<typeof tool.execute>[1], BACKGROUND_CONTEXT),
  } as LooseTool;
}
describe("createMcpServers", () => {
  it("reload：只连接已启用的 server，工具名带 mcp__<id>__ 前缀", async () => {
    const config = makeConfig();
    const disabled = makeConfig({ id: "mcp-b", enabled: false, createdAt: 2 });
    const { log, servers } = setup([config, disabled]);

    const views = await servers.reload();

    expect(log).toEqual(["connect:mcp-a"]);
    // 工具清单里恒定带一个 mcp_tools（内置详情工具，只要有 server 就装配）+
    // 这台用户 server 的一个聚合工具（无论它有多少内层工具，都只占一个工具位）
    expect(mcpToolNames(servers)).toEqual(["mcp__mcp-a__call"]);
    // 视图里除了两台用户 server，还有**全部**系统预设（本组用例把它们都显式停用了，
    // 所以它们只作为 idle 行出现 —— 停用的预设也要显示，否则用户没法重新打开）
    const users = userViews(views);
    expect(users).toHaveLength(2);
    expect(users[0]?.state.status).toBe("ready");
    expect(users[0]?.state.serverName).toBe("mcp-a-server");
    expect(users[1]?.state).toEqual({ status: "idle", tools: [] });
    expect(views.filter((view) => view.source === "system")).toHaveLength(
      BUILTIN_MCP_SERVERS.length,
    );
  });

  it("reload：配置没变时不重连（幂等）", async () => {
    const { log, servers } = setup([makeConfig()]);

    await servers.reload();
    await servers.reload();

    expect(log.filter((line) => line === "connect:mcp-a")).toHaveLength(1);
  });

  it("reload：并发调用不会给同一个 server 叠两条连接", async () => {
    const { log, servers } = setup([makeConfig()]);

    await Promise.all([servers.reload(), servers.reload()]);

    expect(log.filter((line) => line === "connect:mcp-a")).toHaveLength(1);
  });

  it("reload：连接参数变了要重连（名字变了不用）", async () => {
    const { log, servers, setServers } = setup([makeConfig()]);

    await servers.reload();
    setServers([makeConfig({ name: "改了个名字" })]);
    await servers.reload();
    expect(log.filter((line) => line === "connect:mcp-a")).toHaveLength(1);

    setServers([makeConfig({ args: ["--stdio"] })]);
    await servers.reload();
    expect(log.filter((line) => line === "connect:mcp-a")).toHaveLength(2);
  });

  it("reload：server 被停用或删除时断开连接并撤下工具", async () => {
    const { log, servers, setServers } = setup([makeConfig()]);

    await servers.reload();
    setServers([makeConfig({ enabled: false })]);
    const views = await servers.reload();

    expect(log).toContain("close:mcp-a");
    expect(mcpToolNames(servers)).toEqual([]);
    expect(userViews(views)[0]?.state.status).toBe("idle");

    setServers([]);
    await servers.reload();
    expect(mcpToolNames(servers)).toEqual([]);
  });

  it("连接失败：状态记成 error 并带诊断，下一次 reload 会重试", async () => {
    const { log, servers } = setup([makeConfig()], { "mcp-a": { fail: "握手失败" } });

    const views = await servers.reload();

    const failing = userViews(views)[0];
    expect(failing?.state.status).toBe("error");
    expect(failing?.state.error).toContain("握手失败");
    expect(failing?.state.error).toContain("stderr：boom");
    expect(mcpToolNames(servers)).toEqual([]);

    // 失败不能把「正在连接」标记留下来，否则永远不再重试
    await servers.reload();
    expect(log.filter((line) => line === "connect:mcp-a")).toHaveLength(2);
  });

  /**
   * 单台重连（卡片右上角那个按钮）。
   *
   * 与 reload 的关键差别是「不打扰别人」：reload 按设置对账整张连接表，
   * 而这一条只断开并重连指定的那一台 —— 所以已连接的另一台不该被关掉或重连。
   */
  it("reconnect：只断开并重连指定那一台，不碰其它连接", async () => {
    const second = makeConfig({ id: "mcp-b", createdAt: 2 });
    const { log, servers } = setup([makeConfig(), second]);
    await servers.reload();
    log.length = 0;

    const views = await servers.reconnect("mcp-a");

    expect(log).toEqual(["close:mcp-a", "connect:mcp-a"]);
    expect(log).not.toContain("close:mcp-b");
    expect(userViews(views).find((view) => view.config.id === "mcp-a")?.state.status).toBe("ready");
  });

  it("reconnect：连接失败后可以单独重试（失败的那台再连一次）", async () => {
    const { log, servers } = setup([makeConfig()], { "mcp-a": { fail: "握手失败" } });
    await servers.reload();
    expect(log.filter((line) => line === "connect:mcp-a")).toHaveLength(1);

    const views = await servers.reconnect("mcp-a");

    expect(log.filter((line) => line === "connect:mcp-a")).toHaveLength(2);
    expect(userViews(views)[0]?.state.status).toBe("error");
  });

  it("reconnect：停用的 server 只断开、不重连（它的配置不在生效列表里）", async () => {
    const { log, servers, setServers } = setup([makeConfig()]);
    await servers.reload();
    setServers([makeConfig({ enabled: false })]);
    await servers.reload();
    log.length = 0;

    const views = await servers.reconnect("mcp-a");

    expect(log).not.toContain("connect:mcp-a");
    expect(userViews(views)[0]?.state.status).toBe("idle");
  });

  it("subscribe：工具集合变化时收到通知", async () => {
    const { servers } = setup([makeConfig()]);
    let notified = 0;
    const unsubscribe = servers.subscribe(() => {
      notified += 1;
    });

    await servers.reload();
    expect(notified).toBeGreaterThan(0);

    unsubscribe();
    const before = notified;
    await servers.reload();
    expect(notified).toBe(before);
  });

  it("callTool：转发给对应连接；未连接时抛错", async () => {
    const { log, servers } = setup([makeConfig()]);

    await expect(servers.callTool("mcp-a", "read_file", {})).rejects.toThrow("未连接");

    await servers.reload();
    await expect(servers.callTool("mcp-a", "read_file", {})).resolves.toEqual({
      content: [{ type: "text", text: "ok:read_file" }],
      isError: false,
    });
    expect(log).toContain("call:mcp-a:read_file");
  });

  it("probe：不写状态、失败也不抛异常", async () => {
    const { servers } = setup([makeConfig()]);

    const ok = await servers.probe(makeConfig({ id: "mcp-draft" }));
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.tools.map((tool) => tool.qualifiedName)).toEqual(["mcp__mcp-draft__read_file"]);
    }

    const bad = await servers.probe(makeConfig({ id: "mcp-X" }));
    expect(bad).toEqual({ ok: false, reason: "服务器 ID 非法：mcp-X" });

    // 试连不该在连接表里留下条目：用户层视图里只有设置里那台 mcp-a
    expect(userViews(await servers.views()).map((view) => view.config.id)).toEqual(["mcp-a"]);
  });

  it("dispose：断开全部连接，之后 reload 不再连接", async () => {
    const { log, servers } = setup([makeConfig()]);

    await servers.reload();
    await servers.dispose();

    expect(log).toContain("close:mcp-a");
    expect(mcpToolNames(servers)).toEqual([]);
    await expect(servers.reload()).resolves.toEqual([]);
    expect(log.filter((line) => line === "connect:mcp-a")).toHaveLength(1);
  });
});

/**
 * 系统预设层。
 *
 * 这一组用**真实默认值**（不再全部停用）：验的是「开箱即用的那三个真的连上了」，
 * 以及「用户在设置里的启停选择 / 同名用户配置」有没有被正确尊重。
 */
describe("createMcpServers：系统预设层", () => {
  /** 默认设置：mcpServers 为空、systemMcpServerEnabled 为空（= 跟随预设的 defaultEnabled） */
  function systemSetup(
    mcpServers: McpServerConfig[] = [],
    systemMcpServerEnabled: Record<string, boolean> = {},
  ) {
    const log: string[] = [];
    let current = makeSettings(mcpServers, systemMcpServerEnabled);
    const servers = createMcpServers({
      getSettings: async () => current,
      warn: () => undefined,
      createClient: (config) => createFakeClient({ config, log, tools: [READ_FILE] }),
    });
    return {
      log,
      servers,
      setServers: (next: McpServerConfig[], enabled: Record<string, boolean> = {}) => {
        current = makeSettings(next, enabled);
      },
    };
  }

  it("默认全部预设都连上（这一批就是出厂可用集）", async () => {
    const { log, servers } = systemSetup();

    const views = await servers.reload();

    const defaultOn = BUILTIN_MCP_SERVERS.filter((preset) => preset.defaultEnabled).map(
      (preset) => preset.id,
    );
    expect(defaultOn).toHaveLength(BUILTIN_MCP_SERVERS.length);
    expect(log.filter((line) => line.startsWith("connect:")).sort()).toEqual(
      defaultOn.map((id) => `connect:${id}`).sort(),
    );

    // 视图里有**全部**预设，每一条都标成 system，且都连上了
    expect(views.filter((view) => view.source === "system")).toHaveLength(
      BUILTIN_MCP_SERVERS.length,
    );
    expect(views.every((view) => view.source === "system")).toBe(true);
    expect(views.filter((view) => view.state.status === "ready")).toHaveLength(
      BUILTIN_MCP_SERVERS.length,
    );
  });

  it("系统预设的工具带 mcp__<预设 id>__ 前缀，且名字就是预设里的品牌名", async () => {
    const { servers } = systemSetup();

    await servers.reload();

    expect(mcpToolNames(servers)).toContain("mcp__context7__call");
    const views = await servers.views();
    const context7 = views.find((view) => view.config.id === "context7");
    expect(context7?.config.name).toBe("Context7");
    expect(context7?.config.transport).toBe("http");
    expect(context7?.config.url).toBe("https://mcp.context7.com/mcp");
  });

  it("设置里的显式选择优先：关掉某台后它不再连接（视图里仍在，标成停用）", async () => {
    const { log, servers } = systemSetup([], { context7: false, wikipedia: false });

    const views = await servers.reload();

    expect(log).not.toContain("connect:context7");
    expect(log).not.toContain("connect:wikipedia");
    // 其余预设不受影响
    expect(log).toContain("connect:deepwiki");
    expect(views.find((view) => view.config.id === "context7")?.config.enabled).toBe(false);
    expect(views.find((view) => view.config.id === "deepwiki")?.config.enabled).toBe(true);
  });

  it("同 id 的用户配置整条胜出：只连一次，系统那一条标成被覆盖", async () => {
    const mine = makeConfig({
      id: "context7",
      name: "我的 Context7",
      transport: "http",
      command: "",
      url: "https://self-hosted.example/mcp",
    });
    const { log, servers } = systemSetup([mine]);

    const views = await servers.reload();

    // 只连一次，且连的是用户那条配置（同 id 不允许出现两条连接）
    expect(log.filter((line) => line === "connect:context7")).toHaveLength(1);
    const system = views.find((view) => view.config.id === "context7" && view.source === "system");
    const user = views.find((view) => view.config.id === "context7" && view.source === "user");
    expect(system?.overridden).toBe(true);
    expect(system?.state.status).toBe("idle");
    expect(user?.overridden).toBe(true);
    expect(user?.state.status).toBe("ready");
    expect(user?.config.name).toBe("我的 Context7");
  });

  it("用户把同 id 配置停用：系统预设也不会顶上来（用户配置整条胜出）", async () => {
    const mine = makeConfig({ id: "deepwiki", enabled: false, transport: "http", command: "" });
    const { log, servers } = systemSetup([mine]);

    await servers.reload();

    expect(log).not.toContain("connect:deepwiki");
  });

  it("delete/停用系统预设后重连不再连它，工具也撤下", async () => {
    const { log, servers, setServers } = systemSetup();

    await servers.reload();
    expect(mcpToolNames(servers).length).toBeGreaterThan(0);

    // 关掉全部默认开的预设
    setServers([], Object.fromEntries(BUILTIN_MCP_SERVERS.map((preset) => [preset.id, false])));
    const views = await servers.reload();

    expect(mcpToolNames(servers)).toEqual([]);
    expect(log.filter((line) => line.startsWith("close:")).length).toBeGreaterThan(0);
    expect(views.every((view) => view.state.status === "idle")).toBe(true);
  });
});

/**
 * 工具暴露策略（`auto` / `gateway` / `direct`）。
 *
 * 这一组是这次改动的核心：MCP server 的工具数不可预知（实测见过 94 个），
 * 全量展开会把几百个 schema 塞进每轮请求。策略只要错一点，
 * 表现就是「工具多得离谱」或「模型找不到工具」，所以三种模式都要钉住。
 */
describe("createMcpServers：一律聚合", () => {
  const MANY_TOOLS: McpRemoteTool[] = Array.from({ length: 5 }, (_, index) => ({
    name: `tool_${index}`,
    description: `工具 ${index}`,
    inputSchema: { type: "object", properties: {} },
  }));

  function gatewaySetup(tools: McpRemoteTool[]) {
    const log: string[] = [];
    // 系统预设全部停用：这一组只看聚合本身，34 台预设的假客户端会把断言淹掉
    const settings = makeSettings([makeConfig()], allSystemDisabled());
    const servers = createMcpServers({
      getSettings: async () => settings,
      warn: () => undefined,
      createClient: (config) => createFakeClient({ config, log, tools }),
    });
    return { log, servers };
  }

  it("工具再多也只占一个工具位（这是它存在的理由）", async () => {
    const { servers } = gatewaySetup(MANY_TOOLS);

    await servers.reload();

    expect(mcpToolNames(servers)).toEqual(["mcp__mcp-a__call"]);
    const gateway = looseTool(servers.tools(), "mcp__mcp-a__call");
    // 索引里仍然列得出内层工具名，模型不必先探一次
    expect(gateway.description).toContain("tool_0");
    expect(gateway.description).toContain("5 个工具");
  });

  it("只有 1 个内层工具的 server 同样聚合（行为统一，不看工具数分支）", async () => {
    const { servers } = gatewaySetup([READ_FILE]);

    await servers.reload();

    expect(mcpToolNames(servers)).toEqual(["mcp__mcp-a__call"]);
  });

  it("聚合工具真的能调到内层工具（转发链路通）", async () => {
    const { log, servers } = gatewaySetup(MANY_TOOLS);
    await servers.reload();

    const gateway = looseTool(servers.tools(), "mcp__mcp-a__call");
    const result = await gateway.execute("call-1", {
      tool: "tool_2",
      arguments: { x: 1 },
    });

    // 假客户端把调用记进 log：mcp-a 的 tool_2 被调到
    expect(log).toContain("call:mcp-a:tool_2");
    expect(JSON.stringify(result)).toContain("ok:tool_2");
  });

  it("mcp_tools 详情工具随 server 一起装配，三层都能读", async () => {
    const { servers } = gatewaySetup(MANY_TOOLS);
    await servers.reload();

    const catalog = looseTool(servers.tools(), MCP_CATALOG_TOOL_NAME);

    // 第一层：服务器清单
    const list = await catalog.execute("call-1", {});
    expect(JSON.stringify(list)).toContain("mcp-a");
    expect(JSON.stringify(list)).toContain("用户配置");

    // 第二层：该 server 的工具清单（模型靠它拿到内层工具名与调用方式）
    const tools = await catalog.execute("call-2", { server: "mcp-a" });
    expect(JSON.stringify(tools)).toContain("tool_0");
    expect(JSON.stringify(tools)).toContain("mcp__mcp-a__call");

    // 第三层：单个工具的完整 schema
    const one = await catalog.execute("call-3", { server: "mcp-a", tool: "tool_1" });
    expect(JSON.stringify(one)).toContain("工具：mcp-a / tool_1");
  });

  it("没有连接任何 server 时不装配 mcp_tools（不占工具位）", async () => {
    const { servers } = gatewaySetup(MANY_TOOLS);
    // 注意：没有 reload，entries 为空

    expect(servers.tools().map((tool) => tool.name)).toEqual([]);
  });
});

describe("native MCP lifecycle races", () => {
  it("dispose closes an initializing connection and prevents its late result from becoming ready", async () => {
    const connected = deferred<McpHandshake>();
    let started = false;
    let closed = false;
    const servers = createMcpServers({
      getSettings: async () => makeSettings([makeConfig()]),
      createClient: (config) => ({
        ...createFakeClient({ config, log: [], tools: [READ_FILE] }),
        async connect() {
          started = true;
          return connected.promise;
        },
        async close() {
          closed = true;
          connected.resolve({
            serverName: "late",
            serverVersion: "1",
            protocolVersion: "2025-06-18",
          });
        },
      }),
    });
    const reload = servers.reload();
    await vi.waitFor(() => expect(started).toBe(true));
    await servers.dispose();
    await reload;
    expect(closed).toBe(true);
    expect(servers.tools()).toEqual([]);
    expect(userViews(await servers.views())[0]?.state.status).toBe("idle");
  });
  it("coalesces notifications and ignores results from a replaced client", async () => {
    const log: string[] = [];
    let changed: (() => void) | undefined;
    const blocked = deferred<McpRemoteTool[]>();
    let calls = 0;
    let creations = 0;
    const servers = createMcpServers({
      getSettings: async () => makeSettings([makeConfig()]),
      warn: () => {},
      createClient: (config) => {
        const client = createFakeClient({ config, log, tools: [READ_FILE] });
        creations += 1;
        if (creations !== 1) return client;
        return {
          ...client,
          onToolsChanged(listener) {
            changed = listener;
            return () => {};
          },
          async listTools() {
            calls += 1;
            return calls === 1 ? [READ_FILE] : blocked.promise;
          },
        };
      },
    });
    await servers.reload();
    changed?.();
    changed?.();
    changed?.();
    expect(calls).toBe(2);
    await servers.reconnect("mcp-a");
    blocked.resolve([{ ...READ_FILE, name: "stale" }]);
    await Promise.resolve();
    await Promise.resolve();
    expect(userViews(await servers.views())[0]?.state.tools.map((tool) => tool.name)).toEqual([
      "read_file",
    ]);
    expect(calls).toBe(2);
    await servers.dispose();
  });

  it("refreshes again when another notification arrives during a refresh", async () => {
    let changed: (() => void) | undefined;
    const blocked = deferred<McpRemoteTool[]>();
    let calls = 0;
    const servers = createMcpServers({
      getSettings: async () => makeSettings([makeConfig()]),
      warn: () => {},
      createClient: (config) => ({
        ...createFakeClient({ config, log: [] }),
        onToolsChanged(listener) {
          changed = listener;
          return () => {};
        },
        async listTools() {
          calls += 1;
          if (calls === 2) return blocked.promise;
          return [{ ...READ_FILE, name: calls === 1 ? "first" : "latest" }];
        },
      }),
    });
    await servers.reload();
    changed?.();
    changed?.();
    changed?.();
    blocked.resolve([READ_FILE]);
    await vi.waitFor(() => expect(calls).toBe(3));
    expect(userViews(await servers.views())[0]?.state.tools[0]?.name).toBe("latest");
    await servers.dispose();
  });

  it("serializes config changes during connection and ends on the latest configuration", async () => {
    let current = makeSettings([makeConfig()]);
    const blocked = deferred<void>();
    const log: string[] = [];
    let started = false;
    const servers = createMcpServers({
      getSettings: async () => current,
      warn: () => {},
      createClient: (config) => {
        const client = createFakeClient({ config, log });
        return {
          ...client,
          async connect() {
            if (config.command === "noop") {
              started = true;
              await blocked.promise;
            }
            return client.connect();
          },
        };
      },
    });
    const first = servers.reload();
    await vi.waitFor(() => expect(started).toBe(true));
    current = makeSettings([makeConfig({ command: "updated" })]);
    const second = servers.reload();
    blocked.resolve();
    await Promise.all([first, second]);
    expect(log.filter((line) => line.startsWith("connect:"))).toHaveLength(2);
    expect(log.filter((line) => line.startsWith("close:"))).toHaveLength(1);
    expect(userViews(await servers.views())[0]?.config.command).toBe("updated");
    await servers.dispose();
  });

  it("dispose prevents delayed settings reads and queued reconnects from spawning clients", async () => {
    const settings = deferred<Settings>();
    const createClient = vi.fn((config) => createFakeClient({ config, log: [] }));
    const servers = createMcpServers({ getSettings: () => settings.promise, createClient });
    const reload = servers.reload();
    await Promise.resolve();
    const reconnect = servers.reconnect("mcp-a");
    const dispose = servers.dispose();
    settings.resolve(makeSettings([makeConfig()]));
    await Promise.all([reload, reconnect, dispose]);
    expect(createClient).not.toHaveBeenCalled();
    await servers.reconnect("mcp-a");
    expect(createClient).not.toHaveBeenCalled();
  });
});
