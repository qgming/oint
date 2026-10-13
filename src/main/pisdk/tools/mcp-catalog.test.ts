// `mcp_tools` 详情工具的单测。
//
// 它是聚合形态下**唯一**能看到完整参数 schema 的通道，所以三层查询（servers / tools / tool）
// 与三条错误路径（服务器不存在、工具不存在、tool 没配 server）都要钉住 ——
// 这条链断了，模型只能靠猜字段名调聚合工具。

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { describe, expect, it } from "vitest";
import { MCP_CATALOG_TOOL_NAME } from "@/shared/contracts/mcp";
import { createMcpCatalogTool, type McpCatalogServer } from "./mcp-catalog";

function server(overrides: Partial<McpCatalogServer> = {}): McpCatalogServer {
  return {
    serverId: "demo",
    serverName: "Demo",
    source: "system",
    status: "ready",
    tools: [
      {
        name: "search",
        description: "搜索文档",
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
      },
      { name: "fetch", description: "", inputSchema: undefined },
    ],
    ...overrides,
  };
}

/** 只取测试要断言的两项：文本与 details（details 用宽松记录类型即可） */
type LooseResult = {
  output: { type: string; text?: string }[];
  details?: Record<string, unknown>;
};

function makeTool(servers: McpCatalogServer[]) {
  const tool = createMcpCatalogTool({ catalog: () => servers });
  return {
    name: tool.name,
    description: tool.description,
    execute: (_id: string, params: unknown): Promise<LooseResult> =>
      tool
        .execute(params, {} as Parameters<typeof tool.execute>[1], BACKGROUND_CONTEXT)
        .then((result) => result as unknown as LooseResult),
  };
}

function textOf(result: { output: { type: string; text?: string }[] }): string {
  return result.output.map((item) => item.text ?? "").join("\n");
}

describe("createMcpCatalogTool", () => {
  it("工具名是内置的 mcp_tools（低风险、免审批，见 permissions.ts）", () => {
    const tool = makeTool([server()]);
    expect(tool.name).toBe(MCP_CATALOG_TOOL_NAME);
    expect(tool.name).toBe("mcp_tools");
  });

  it("不传参数：列出所有 server 的来源 / 状态 / 工具数 / 暴露形态", async () => {
    const tool = makeTool([
      server(),
      server({ serverId: "user-one", serverName: "我的", source: "user" }),
    ]);

    const result = await tool.execute("call-1", {});

    const text = textOf(result);
    expect(text).toContain("共 2 台");
    expect(text).toContain("demo（Demo）｜系统预设 · 已连接 · 2 个工具");
    expect(text).toContain("user-one（我的）｜用户配置 · 已连接 · 2 个工具");
    expect(result.details).toMatchObject({ level: "servers", count: 2 });
  });

  it("连接失败时把原因带出来（排查「这台为什么没工具」全靠它）", async () => {
    const tool = makeTool([server({ status: "error", error: "HTTP 401", tools: [] })]);

    const text = textOf(await tool.execute("call-1", {}));

    expect(text).toContain("连接失败");
    expect(text).toContain("HTTP 401");
  });

  it("传 server：列出工具清单与调用方式（恒定走聚合工具）", async () => {
    const tool = makeTool([server()]);

    const text = textOf(await tool.execute("call-1", { server: "demo" }));

    expect(text).toContain("- search：搜索文档");
    expect(text).toContain('mcp__demo__call，参数 {"tool": "<工具名>", "arguments": {...}}');
    expect(await tool.execute("call-1", { server: "demo" })).toMatchObject({
      details: { level: "tools", serverId: "demo", count: 2 },
    });
  });

  it("传 server + tool：给出完整说明与原始 JSON Schema", async () => {
    const tool = makeTool([server()]);

    const result = await tool.execute("call-1", { server: "demo", tool: "search" });

    const text = textOf(result);
    expect(text).toContain("工具：demo / search");
    expect(text).toContain("搜索文档");
    expect(text).toContain('"q"');
    expect(result.details).toMatchObject({
      level: "tool",
      serverId: "demo",
      toolName: "search",
      count: 1,
    });
  });

  it("没有 schema 的工具如实说明，不编一个空 schema 出来", async () => {
    const tool = makeTool([server()]);

    const text = textOf(await tool.execute("call-1", { server: "demo", tool: "fetch" }));

    expect(text).toContain("没有提供参数 schema");
  });

  it("server 不存在：报错并列出可用的 id", async () => {
    const tool = makeTool([server()]);

    const result = await tool.execute("call-1", { server: "nope" });

    expect(textOf(result)).toContain("没有这台 server：nope");
    expect(textOf(result)).toContain("demo");
    expect(result.details?.level).toBe("error");
  });

  it("工具不存在：报错并列出该 server 的工具", async () => {
    const tool = makeTool([server()]);

    const result = await tool.execute("call-1", { server: "demo", tool: "nope" });

    expect(textOf(result)).toContain("没有工具「nope」");
    expect(textOf(result)).toContain("search, fetch");
  });

  it("只传 tool 不传 server：拒绝并说明正确用法", async () => {
    const tool = makeTool([server()]);

    const result = await tool.execute("call-1", { tool: "search" });

    expect(textOf(result)).toContain("tool 必须与 server 一起传");
  });

  it("一台 server 都没有时给可读空态（不是空白输出）", async () => {
    const tool = makeTool([]);

    const text = textOf(await tool.execute("call-1", {}));

    expect(text).toContain("没有可用的 MCP server");
  });

  it("返回是文本而不是异常：所有失败路径都走 Error: 前缀", async () => {
    const tool = makeTool([server()]);

    const result = await tool.execute("call-1", { server: "nope" });

    expect(textOf(result).startsWith("Error: ")).toBe(true);
  });
});
