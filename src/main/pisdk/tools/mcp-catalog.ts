// `mcp_tools`：读 MCP server 的工具清单与参数 schema 的**内置**工具。
//
// 为什么需要它：工具多的 server 会被收敛成一个聚合工具（`mcp__<serverId>__call`，见
// contracts/mcp.ts 的 MCP_GATEWAY_TOOL_NAME）。聚合省下了「几百个 schema 每轮都进请求体」，
// 代价是模型不再默认看到每个工具的参数定义 —— 这个工具就是那条**按需读取**的通道：
//
//   mcp_tools()                     → 所有 server（来源 / 状态 / 工具数 / 是否聚合）
//   mcp_tools({ server })           → 该 server 的全部工具名与用途
//   mcp_tools({ server, tool })     → 该工具的完整说明与原始 JSON Schema
//
// 它只读**已经在内存里的**能力清单（连接时 listTools 的结果），不额外发网络请求、
// 不触碰工作区，因此判为低风险、免审批（见 pisdk/permissions.ts 的 LOW_RISK_TOOLS）。

import type { ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import type { McpConnectionStatus, McpServerSource } from "@/shared/contracts/mcp";
import { MCP_CATALOG_TOOL_NAME } from "@/shared/contracts/mcp";
import { truncateForModel } from "./mcp";

/** 一条工具的目录项（schema 原样保留，只有被点名时才输出） */
export interface McpCatalogTool {
  name: string;
  description: string;
  inputSchema: unknown;
  readOnly?: boolean;
}

/** 一台 server 的目录项 */
export interface McpCatalogServer {
  serverId: string;
  serverName: string;
  source: McpServerSource;
  status: McpConnectionStatus;
  error?: string;
  tools: McpCatalogTool[];
}

/** 目录数据源：由连接管理器实现（它才知道当前连上了谁、有哪些工具） */
export interface McpCatalogSource {
  catalog(): McpCatalogServer[];
}

export type McpCatalogDetails = {
  /** 本次回答的层级：servers / tools / tool */
  level: "servers" | "tools" | "tool" | "error";
  serverId?: string;
  toolName?: string;
  /** 命中的条目数（error 时为 0） */
  count: number;
};

/** 单条说明在「工具清单」里的截断长度：清单只用来选工具，不需要完整描述 */
const TOOL_LINE_DESCRIPTION = 140;

const DESCRIPTION = [
  "读取 MCP server 的能力清单与参数定义（只读本地缓存，不发起任何外部调用）。",
  "",
  "用法：",
  "- 不传参数：列出所有 server（名称 / 来源 / 连接状态 / 工具数）；",
  '- 传 server：列出该 server 的全部工具及用途，例如 {"server": "context7"}；',
  '- 传 server + tool：返回该工具的完整说明与 JSON Schema，例如 {"server": "context7", "tool": "resolve-library-id"}。',
  "",
  "什么时候用：调用聚合工具 mcp__<server>__call 前，若不确定工具名或参数怎么写，先在这里查清楚；",
  "工具名写错时聚合工具也会回一份可用清单，但直接查这里更省一轮。",
].join("\n");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 一行摘要：名称 + 用途（用途按需截断，避免清单被长描述灌爆） */
function toolLine(tool: McpCatalogTool): string {
  const description = tool.description.replace(/\s+/g, " ").trim();
  if (description === "") return `- ${tool.name}`;
  const clipped =
    description.length > TOOL_LINE_DESCRIPTION
      ? `${description.slice(0, TOOL_LINE_DESCRIPTION)}…`
      : description;
  return `- ${tool.name}：${clipped}`;
}

/** 服务器清单：一行一台，末尾给下一步提示 */
function renderServers(servers: McpCatalogServer[]): string {
  if (servers.length === 0) {
    return "当前没有可用的 MCP server（系统预设可能在设置里被停用了）。";
  }
  const lines = servers.map((server) => {
    const parts = [
      server.source === "system" ? "系统预设" : "用户配置",
      server.status === "ready" ? "已连接" : server.status === "error" ? "连接失败" : "未连接",
      `${server.tools.length} 个工具`,
    ];
    const suffix = server.error === undefined ? "" : `（${server.error.slice(0, 80)}）`;
    return `- ${server.serverId}（${server.serverName}）｜${parts.join(" · ")}${suffix}`;
  });
  return [
    `共 ${servers.length} 台 MCP server：`,
    ...lines,
    "",
    '下一步：mcp_tools({ server: "<id>" }) 看某台的完整工具清单。',
  ].join("\n");
}

/** 单台的工具清单 */
function renderTools(server: McpCatalogServer): string {
  if (server.tools.length === 0) {
    return `${server.serverId} 当前没有列出任何工具（未连接，或该 server 只提供资源）。`;
  }
  return [
    `${server.serverId}（${server.serverName}）共 ${server.tools.length} 个工具：`,
    ...server.tools.map(toolLine),
    "",
    `调用方式：mcp__${server.serverId}__call，参数 {"tool": "<工具名>", "arguments": {...}}`,
    `参数细节：mcp_tools({ server: "${server.serverId}", tool: "<工具名>" })。`,
  ].join("\n");
}

/** 单个工具的完整定义 + 原始 schema */
function renderTool(server: McpCatalogServer, tool: McpCatalogTool): string {
  const schema =
    tool.inputSchema === undefined
      ? "（该 server 没有提供参数 schema）"
      : JSON.stringify(tool.inputSchema, null, 2);
  return [
    `工具：${server.serverId} / ${tool.name}`,
    tool.readOnly === true ? "该 server 声明它是只读工具。" : "",
    "",
    "说明：",
    tool.description.trim() === "" ? "（该 server 没有提供说明）" : tool.description.trim(),
    "",
    "参数 JSON Schema：",
    schema,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * 组装 `mcp_tools` 工具。
 *
 * 返回值三态：servers（没传 server）/ tools（传了 server）/ tool（传了 server + tool）。
 * 参数不认识时给一句可读错误而不是抛异常 —— 与 MCP 工具包装层同一口径。
 */
export function createMcpCatalogTool(source: McpCatalogSource): ToolRegistration {
  const parameters = Type.Object(
    {
      server: Type.Optional(
        Type.String({ description: "MCP server 的 id（不传则列出所有 server）" }),
      ),
      tool: Type.Optional(Type.String({ description: "工具名（要与 server 一起传）" })),
    },
    { additionalProperties: false },
  );

  return {
    name: MCP_CATALOG_TOOL_NAME,
    replay: "safe",
    description: DESCRIPTION,
    parameters,
    async execute(params): Promise<ToolExecutionResult<McpCatalogDetails>> {
      const args = isRecord(params) ? params : {};
      const serverId = typeof args.server === "string" ? args.server.trim() : "";
      const toolName = typeof args.tool === "string" ? args.tool.trim() : "";
      const servers = source.catalog();

      const fail = (text: string): ToolExecutionResult<McpCatalogDetails> => ({
        output: [{ type: "text", text: `Error: ${text}` }],
        details: { level: "error", count: 0 },
        isError: true,
      });

      if (serverId === "") {
        if (toolName !== "") {
          return fail('tool 必须与 server 一起传：mcp_tools({ server: "<id>", tool: "<name>" })。');
        }
        const listed = servers.filter(
          (server) => server.tools.length > 0 || server.status !== "idle",
        );
        const clipped = truncateForModel(renderServers(listed));
        return {
          output: [{ type: "text", text: clipped.text }],
          details: { level: "servers", count: listed.length },
        };
      }

      const server = servers.find((item) => item.serverId === serverId);
      if (server === undefined) {
        return fail(
          `没有这台 server：${serverId}。可用的是：${servers.map((item) => item.serverId).join(", ") || "（无）"}。`,
        );
      }

      if (toolName === "") {
        const clipped = truncateForModel(renderTools(server));
        return {
          output: [{ type: "text", text: clipped.text }],
          details: { level: "tools", serverId, count: server.tools.length },
        };
      }

      const tool = server.tools.find((item) => item.name === toolName);
      if (tool === undefined) {
        return fail(
          `这台 server 没有工具「${toolName}」。可用的是：${server.tools.map((item) => item.name).join(", ") || "（无）"}。`,
        );
      }
      const clipped = truncateForModel(renderTool(server, tool));
      return {
        output: [{ type: "text", text: clipped.text }],
        details: { level: "tool", serverId, toolName, count: 1 },
      };
    },
  };
}
