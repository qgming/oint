// MCP 聚合工具的单测。
//
// 它承担的是「一台 server 收敛成一个工具位」这件事，所以三类断言最要紧：
// 1. **索引**：description 里的工具清单必须有，且超长时要折叠（否则 94 个工具会把说明写成文档）；
// 2. **转发**：`{ tool, arguments }` 要原样落到 server 的对应工具上，details 里留下真实内层工具名；
// 3. **纠错**：工具名写错时回一份可用清单（而不是让模型再花一轮去查）。

import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { describe, expect, it, vi } from "vitest";
import type { McpRemoteTool } from "@/main/mcp/client";
import { qualifyMcpToolName } from "@/shared/contracts/mcp";
import type { McpToolCaller } from "./mcp";
import {
  buildGatewayDescription,
  buildGatewayIndex,
  createMcpGatewayTool,
  type McpGatewayServer,
} from "./mcp-gateway";

type GatewayTool = ReturnType<typeof createMcpGatewayTool>;
/** 只取测试要断言的两项：文本与 details（details 用宽松记录类型即可） */
type LooseResult = {
  output: { type: string; text?: string }[];
  details?: Record<string, unknown>;
};

function callTool(tool: GatewayTool, params: unknown): Promise<LooseResult> {
  return tool
    .execute(params, {} as Parameters<typeof tool.execute>[1], BACKGROUND_CONTEXT)
    .then((result) => result as unknown as LooseResult);
}

function gatewayServer(overrides: Partial<McpGatewayServer> = {}): McpGatewayServer {
  return {
    serverId: "demo",
    serverName: "Demo",
    tools: [
      { name: "search", description: "搜索" },
      { name: "fetch", description: "取回" },
    ],
    ...overrides,
  };
}

/** 假调用通道：记录每次转发，返回固定文本 */
function fakeCaller(result = { text: "ok", isError: false }) {
  const calls: { serverId: string; toolName: string; args: Record<string, unknown> }[] = [];
  const caller: McpToolCaller = {
    async callTool(serverId, toolName, args) {
      calls.push({ serverId, toolName, args });
      return { content: [{ type: "text" as const, text: result.text }], isError: result.isError };
    },
  };
  return { caller, calls };
}

/** 取出工具结果里的文本（测试里只关心这一项） */
function textOf(result: { output: { type: string; text?: string }[] }): string {
  return result.output.map((item) => item.text ?? "").join("\n");
}

describe("buildGatewayIndex", () => {
  it("每个工具一行，带截断后的说明", () => {
    const { lines, hidden } = buildGatewayIndex([
      { name: "search", description: "搜索文档" },
      { name: "fetch", description: "x".repeat(200) },
    ]);

    expect(hidden).toBe(0);
    expect(lines[0]).toBe("- search — 搜索文档");
    // 长说明被截断并加省略号：清单只用来选工具，不需要完整描述
    expect(lines[1]?.length).toBeLessThan(100);
    expect(lines[1]?.endsWith("…")).toBe(true);
  });

  it("工具超过上限时折叠成 hidden 计数（94 个工具的 server 不会把 description 撑爆）", () => {
    const tools = Array.from({ length: 94 }, (_, index) => ({
      name: `tool_${index}`,
      description: "说明",
    }));

    const { lines, hidden } = buildGatewayIndex(tools);

    expect(lines.length).toBeLessThan(94);
    expect(lines.length + hidden).toBe(94);
  });
});

describe("buildGatewayDescription", () => {
  it("说明里给出工具清单、调用方式与 mcp_tools 的用法", () => {
    const description = buildGatewayDescription(gatewayServer());

    expect(description).toContain("2 个工具");
    expect(description).toContain("- search — 搜索");
    expect(description).toContain('{"tool": "<上面列出的工具名>"');
    expect(description).toContain('mcp_tools({ server: "demo", tool: "<工具名>" })');
  });

  it("折叠时在说明里写明「另有 N 个」", () => {
    const tools = Array.from({ length: 60 }, (_, index) => ({
      name: `t${index}`,
      description: "",
    }));
    const description = buildGatewayDescription(gatewayServer({ tools }));

    expect(description).toMatch(/另有 \d+ 个未在此列出/);
  });
});

describe("createMcpGatewayTool", () => {
  it("工具名是 mcp__<serverId>__call（保留限定名形状，权限规则才能前缀匹配）", () => {
    const { caller } = fakeCaller();
    const tool = createMcpGatewayTool(gatewayServer(), caller);

    expect(tool.name).toBe("mcp__demo__call");
    // 同一形状也能被解析回 serverId —— 按 server 授权与统计都依赖这一点
    expect(qualifyMcpToolName("demo", "call")).toBe(tool.name);
  });

  it("把 { tool, arguments } 转发到对应的内层工具，details 记真实工具名", async () => {
    const { caller, calls } = fakeCaller({ text: "结果文本", isError: false });
    const tool = createMcpGatewayTool(gatewayServer(), caller);

    const result = await callTool(tool, { tool: "fetch", arguments: { url: "https://x" } });

    expect(calls).toEqual([{ serverId: "demo", toolName: "fetch", args: { url: "https://x" } }]);
    expect(textOf(result)).toBe("结果文本");
    expect(result.details?.toolName).toBe("fetch");
    expect(result.details?.qualifiedName).toBe("mcp__demo__fetch");
    expect(result.details?.isError).toBe(false);
  });

  it("缺 arguments 时按空对象调用（有些工具本来就不需要参数）", async () => {
    const { caller, calls } = fakeCaller();
    const tool = createMcpGatewayTool(gatewayServer(), caller);

    await callTool(tool, { tool: "search" });

    expect(calls[0]?.args).toEqual({});
  });

  it("工具名不存在时回可用清单，且不发起调用", async () => {
    const { caller, calls } = fakeCaller();
    const tool = createMcpGatewayTool(gatewayServer(), caller);

    const result = await callTool(tool, { tool: "nope" });

    expect(calls).toEqual([]);
    expect(textOf(result)).toContain("没有工具「nope」");
    expect(textOf(result)).toContain("search, fetch");
    expect(result.details?.isError).toBe(true);
  });

  it("缺 tool 参数时同样给可用清单", async () => {
    const { caller } = fakeCaller();
    const tool = createMcpGatewayTool(gatewayServer(), caller);

    const result = await callTool(tool, {});

    expect(textOf(result)).toContain("缺少 tool 参数");
    expect(textOf(result)).toContain("search, fetch");
  });

  it("server 报错时把 isError 透传给 details，文本加 Error: 前缀", async () => {
    const { caller } = fakeCaller({ text: "参数不合法", isError: true });
    const tool = createMcpGatewayTool(gatewayServer(), caller);

    const result = await callTool(tool, { tool: "search" });

    expect(textOf(result)).toContain("Error:");
    expect(textOf(result)).toContain("参数不合法");
    expect(result.details?.isError).toBe(true);
  });

  it("调用抛异常时文本化，不让异常冒出去", async () => {
    const caller: McpToolCaller = {
      async callTool() {
        throw new Error("连接已断开");
      },
    };
    const tool = createMcpGatewayTool(gatewayServer(), caller);

    const result = await callTool(tool, { tool: "search" });

    expect(textOf(result)).toContain("连接已断开");
    expect(result.details?.isError).toBe(true);
  });

  it("超长输出被截断（与逐个展开同一条截断规则）", async () => {
    const { caller } = fakeCaller({ text: "x".repeat(80_000), isError: false });
    const tool = createMcpGatewayTool(gatewayServer(), caller);

    const result = await callTool(tool, { tool: "fetch" });

    expect(textOf(result)).toContain("结果过长已截断");
    expect(result.details?.truncated).toBe(true);
  });
});

/** 没有任何工具时也不能抛：说明与调用都要给出可读结果 */
describe("空工具表", () => {
  it("说明里写 0 个工具，调用回「没有工具」而不是异常", async () => {
    const { caller } = fakeCaller();
    const tool = createMcpGatewayTool(gatewayServer({ tools: [] }), caller);

    expect(tool.description).toContain("0 个工具");
    const result = await callTool(tool, { tool: "search" });
    expect(textOf(result)).toContain("没有工具「search」");
    expect(textOf(result)).toContain("（无）");
  });
});

/** 只是为了让 README 里的形状断言有个锚点：聚合工具名与远端工具名长得一样 */
describe("聚合工具与远端工具的命名关系", () => {
  it("聚合工具名 = qualifyMcpToolName(serverId, 'call')", () => {
    const remote: McpRemoteTool = { name: "call", description: "", inputSchema: {} };
    expect(qualifyMcpToolName("x", remote.name)).toBe("mcp__x__call");
  });
});

describe("native content and cancellation", () => {
  it("passes images through and budgets all text blocks together", async () => {
    const tool = createMcpGatewayTool(gatewayServer(), {
      callTool: async () => ({
        content: [
          { type: "text", text: "a".repeat(30_000) },
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
          { type: "text", text: "b".repeat(30_000) },
        ],
        isError: false,
      }),
    });
    const result = await callTool(tool, { tool: "search" });
    expect(result.output.some((block) => block.type === "image")).toBe(true);
    expect(textOf(result).length).toBeLessThan(51_000);
    expect(result.details?.truncated).toBe(true);
  });

  it("forwards the Chord abort signal and does not convert cancellation into a tool error", async () => {
    const controller = new AbortController();
    const called = vi.fn(async (_server, _tool, _args, signal?: AbortSignal) => {
      expect(signal).toBe(controller.signal);
      controller.abort(new Error("cancelled"));
      signal?.throwIfAborted();
      return { content: [], isError: false };
    });
    const tool = createMcpGatewayTool(gatewayServer(), { callTool: called });
    await expect(
      tool.execute(
        { tool: "search" },
        {} as Parameters<typeof tool.execute>[1],
        withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
      ),
    ).rejects.toThrow("cancelled");
    expect(called).toHaveBeenCalledOnce();
  });
});
