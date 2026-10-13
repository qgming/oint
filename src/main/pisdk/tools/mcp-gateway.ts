// MCP 聚合工具：把一台 server 的 N 个工具收敛成**一个**宿主工具 `mcp__<serverId>__call`。
//
// ## 为什么需要它
//
// MCP server 的工具数是不可预知的：实测见过 94 个工具的 server。每个工具的 JSON Schema
// 每轮都会进请求体，几十台 server 叠起来就是几百个 schema —— 上下文与费用双输，
// 还会撞上工具数上限被静默截断。聚合之后，一台 server 恒定只占**一个**工具位，
// 细节由内置工具 `mcp_tools` 按需读取（见 tools/mcp-catalog.ts）。
//
// ## 为什么名字仍然是 `mcp__<serverId>__call`
//
// 保留限定名的三段形状，图的是两件事：
// 1. `parseMcpToolName` 照常解析出 serverId —— UI 工具卡片、日志、按 server 统计都不用改；
// 2. 权限规则 `mcp__<serverId>__*` 是前缀匹配，天然覆盖这个聚合工具 ——
//    「信任这台 server」与「始终允许」那两条链路一行都不用改。
//
// ## 参数为什么是 `{ tool, arguments }` 而不是动态展开
//
// 动态展开要求我们在本地拼出一个「所有内层工具并集」的 schema，那既不合法（同名参数含义冲突），
// 也把省下来的上下文又还回去了。`{ tool, arguments }` 是通用形状，代价是模型需要知道内层工具名 ——
// 这个信息放在 description 的**紧凑索引**里（工具名 + 一句话），以及 `mcp_tools` 的完整清单里。

import type { ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import { McpAbortError } from "@earendil-works/pi-mcp";
import { Type } from "typebox";
import type { McpCallResult } from "@/main/mcp/client";
import { mcpGatewayToolName, qualifyMcpToolName } from "@/shared/contracts/mcp";
import { type McpToolCaller, type McpToolDetails, truncateMcpContent } from "./mcp";

/** description 里最多列几个工具名（其余折叠成一句提示） */
const MAX_INDEXED_TOOLS = 40;
/** 索引里单条说明的截断长度 */
const INDEX_DESCRIPTION_CHARS = 60;
/** 整个索引的字符上限：宁可少列几个，也不要把 description 变成一篇文档 */
const MAX_INDEX_CHARS = 1400;

/** 一台 server 的聚合视图（由连接管理器在收集工具时给出） */
export interface McpGatewayServer {
  serverId: string;
  /** server 的展示名 */
  serverName: string;
  /** server 的一句话说明（系统预设用 i18n 文案；用户 server 没有则省略） */
  summary?: string;
  /** 当前可用的内层工具（名字 + 说明），顺序即索引顺序 */
  tools: readonly { name: string; description: string }[];
}

export type McpGatewayDetails = McpToolDetails & {
  /** 被调用的内层工具名 */
  innerTool: string;
};

/** 内层工具的紧凑索引：`- 名字 — 一句话`，超出预算就折叠 */
export function buildGatewayIndex(tools: McpGatewayServer["tools"]): {
  lines: string[];
  hidden: number;
} {
  const lines: string[] = [];
  let used = 0;
  let hidden = 0;
  for (const tool of tools) {
    if (lines.length >= MAX_INDEXED_TOOLS) {
      hidden += 1;
      continue;
    }
    const raw = tool.description.replace(/\s+/g, " ").trim();
    const description =
      raw.length > INDEX_DESCRIPTION_CHARS ? `${raw.slice(0, INDEX_DESCRIPTION_CHARS)}…` : raw;
    const line = description === "" ? `- ${tool.name}` : `- ${tool.name} — ${description}`;
    if (used + line.length + 1 > MAX_INDEX_CHARS) {
      hidden += 1;
      continue;
    }
    used += line.length + 1;
    lines.push(line);
  }
  return { lines, hidden };
}

/** 聚合工具的 description：server 是谁 + 工具索引 + 怎么调 + 出错会怎样 */
export function buildGatewayDescription(server: McpGatewayServer): string {
  const { lines, hidden } = buildGatewayIndex(server.tools);
  const parts = [
    `「${server.serverName}」这台 MCP server 的 ${server.tools.length} 个工具已收敛成一个入口（避免几百个工具定义每轮都进上下文）。`,
  ];
  if (server.summary !== undefined && server.summary.trim() !== "")
    parts.push(server.summary.trim());
  parts.push(
    [
      "可用工具：",
      ...(lines.length === 0 ? ["（这台 server 当前没有列出工具）"] : lines),
      ...(hidden > 0 ? [`（另有 ${hidden} 个未在此列出，用 mcp_tools 查看完整清单）`] : []),
    ].join("\n"),
  );
  parts.push(
    [
      `调用方式：{"tool": "<上面列出的工具名>", "arguments": { ...该工具的参数... }}。`,
      '参数不确定时先调 mcp_tools({ server: "' +
        server.serverId +
        '", tool: "<工具名>" }) 拿完整 JSON Schema，不要猜字段名。',
      "工具名写错会返回可用清单；输出过长会被截断，需要更多内容时缩小查询范围。",
      "只依据真实返回作答，不要编造执行结果。",
    ].join("\n"),
  );
  return parts.join("\n\n");
}

/**
 * 组装聚合工具。
 *
 * 三个收尾与逐个展开时一致（见 tools/mcp.ts）：结果截断、失败文本化、details 回填。
 * 额外的一件：**工具名不认识时把可用清单回给模型**，省掉一次「再查一遍」的往返。
 */
export function createMcpGatewayTool(
  server: McpGatewayServer,
  caller: McpToolCaller,
): ToolRegistration {
  const qualifiedName = mcpGatewayToolName(server.serverId);
  const known = new Map(server.tools.map((tool) => [tool.name, tool]));

  const parameters = Type.Object(
    {
      tool: Type.String({ description: "要调用的工具名（见 description 里的工具清单）" }),
      arguments: Type.Optional(
        Type.Unsafe<Record<string, unknown>>({
          type: "object",
          description: "该工具的参数对象；不确定字段名时先用 mcp_tools 查 schema",
          additionalProperties: true,
        }),
      ),
    },
    { additionalProperties: false },
  );

  return {
    name: qualifiedName,
    description: buildGatewayDescription(server),
    parameters,
    async execute(params, _api, context): Promise<ToolExecutionResult<McpGatewayDetails>> {
      const signal = context?.abortSignal;
      signal?.throwIfAborted();
      const args =
        typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};
      const innerTool = typeof args.tool === "string" ? args.tool.trim() : "";
      const innerArgs =
        typeof args.arguments === "object" && args.arguments !== null
          ? (args.arguments as Record<string, unknown>)
          : {};
      const started = Date.now();
      const details = (
        isError: boolean,
        truncated: boolean,
        toolName: string,
      ): McpGatewayDetails => ({
        qualifiedName: qualifyMcpToolName(server.serverId, toolName),
        serverId: server.serverId,
        toolName,
        innerTool: toolName,
        isError,
        truncated,
        durationMs: Date.now() - started,
      });

      if (innerTool === "") {
        return {
          isError: true,
          output: [
            {
              type: "text",
              text: `Error: 缺少 tool 参数。可用工具：${[...known.keys()].join(", ") || "（这台 server 没有列出工具）"}。`,
            },
          ],
          details: details(true, false, ""),
        };
      }
      if (!known.has(innerTool)) {
        return {
          isError: true,
          output: [
            {
              type: "text",
              text: `Error: 「${server.serverName}」没有工具「${innerTool}」。可用工具：${[...known.keys()].join(", ") || "（无）"}。`,
            },
          ],
          details: details(true, false, innerTool),
        };
      }

      try {
        const result: McpCallResult = await caller.callTool(
          server.serverId,
          innerTool,
          innerArgs,
          signal,
        );
        const clipped = truncateMcpContent(result.content);
        const content = result.isError
          ? [{ type: "text" as const, text: "Error: MCP 工具返回错误。" }, ...clipped.content]
          : clipped.content;
        return {
          output: content,
          isError: result.isError,
          details: details(result.isError, clipped.truncated, innerTool),
        };
      } catch (error) {
        if (signal?.aborted || error instanceof McpAbortError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        return {
          output: [{ type: "text", text: `Error: 调用 MCP 工具失败：${message}` }],
          isError: true,
          details: details(true, false, innerTool),
        };
      }
    },
  };
}
