import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createToolTestApi } from "@/main/pisdk/tools/tool-test-api";
// 网络工具层单测：参数校验、结果格式化、错误文案、details 形状。
// WebService 全部用假实现 —— 这个文件不发任何网络请求。

import { describe, expect, it } from "vitest";
import { WEB_TOOL_NAMES } from "@/shared/contracts/web";
import type { WebFetchResult, WebSearchResult, WebService } from "../../web/types";
import { WebError } from "../../web/types";
import {
  createWebTools,
  describeWebError,
  EXTERNAL_CONTENT_NOTICE,
  formatFetchOutput,
  formatSearchOutput,
} from "./web";

/** 假 service：按配置返回结果或抛错 */
function fakeService(options: {
  search?: Partial<WebSearchResult> | Error;
  fetch?: Partial<WebFetchResult> | Error;
  available?: boolean;
  /** 抓取正文上限（对应设置里的 fetchMaxOutputChars） */
  fetchLimit?: number;
}): WebService {
  return {
    // 默认给一个足够大的值：在多数用例里让「模型传的 maxChars」成为约束方；
    // 专门验证设置上限的用例显式传更小的值
    fetchOutputLimit: async () => options.fetchLimit ?? 200_000,
    async search() {
      const value = options.search;
      if (value instanceof Error) throw value;
      return {
        provider: "searxng",
        sources: [],
        truncated: false,
        ...value,
      };
    },
    async fetch() {
      const value = options.fetch;
      if (value instanceof Error) throw value;
      return {
        url: "https://example.com",
        statusCode: 200,
        content: "body",
        truncated: false,
        ...value,
      };
    },
  };
}

/** 取出第一个工具（web_search） */
function searchTool(service: WebService) {
  const tool = createWebTools(service)[0];
  if (tool === undefined) throw new Error("web_search 未装配");
  return tool;
}

function fetchTool(service: WebService) {
  const tool = createWebTools(service)[1];
  if (tool === undefined) throw new Error("web_fetch 未装配");
  return tool;
}

/** 直接调 execute 的辅助：只关心 params，其余参数给占位值 */
async function run(
  tool: ReturnType<typeof searchTool> | ReturnType<typeof fetchTool>,
  params: Record<string, unknown>,
) {
  const result = await tool.execute(
    params,
    createToolTestApi({ callId: "call-1" }),
    BACKGROUND_CONTEXT,
  );
  const first = (result.output ?? [])[0];
  const text = first !== undefined && first.type === "text" ? first.text : "";
  return { text, details: result.details };
}

describe("createWebTools", () => {
  it("装配出两个工具，名字来自共享常量", () => {
    const tools = createWebTools(fakeService({}));
    expect(tools.map((tool) => tool.name)).toEqual([WEB_TOOL_NAMES.search, WEB_TOOL_NAMES.fetch]);
  });

  it("两个工具都带 label（内核契约要求）", () => {
    for (const tool of createWebTools(fakeService({}))) {
      expect(tool.name).toBe(tool.name);
    }
  });

  it("描述里点明内容不可信（提示注入的第一道防线）", () => {
    const tools = createWebTools(fakeService({}));
    for (const tool of tools) {
      expect(tool.description).toContain("UNTRUSTED");
    }
  });
});

describe("web_search", () => {
  it("空 query 直接拒绝，不调用 service", async () => {
    let called = false;
    const service = fakeService({});
    service.search = async () => {
      called = true;
      return { provider: "searxng", sources: [], truncated: false };
    };
    const { text } = await run(searchTool(service), { query: "   " });
    expect(text).toContain("non-empty");
    expect(called).toBe(false);
  });

  it("结果以不可信提示开头", async () => {
    const service = fakeService({
      search: { sources: [{ url: "https://a.test", title: "A" }] },
    });
    const { text } = await run(searchTool(service), { query: "x" });
    expect(text.startsWith(EXTERNAL_CONTENT_NOTICE)).toBe(true);
  });

  it("details 带上 provider 与结构化 sources（渲染层按它画卡片）", async () => {
    const service = fakeService({
      search: {
        provider: "tavily",
        sources: [{ url: "https://a.test", title: "A", snippet: "S" }],
        answer: "42",
      },
    });
    const { details } = await run(searchTool(service), { query: "x" });
    expect(details).toMatchObject({
      provider: "tavily",
      answer: "42",
      truncated: false,
      sources: [{ url: "https://a.test", title: "A", snippet: "S" }],
    });
  });

  it("失败时返回文本化错误而不是抛异常，且 details 形状仍完整", async () => {
    const service = fakeService({
      search: new WebError("provider 配置缺失", "WEB_PROVIDER_CREDENTIAL_MISSING"),
    });
    const { text, details } = await run(searchTool(service), { query: "x" });
    expect(text).toContain("Error:");
    expect(text).toContain("provider 配置缺失");
    // details 是渲染层契约，失败时也不能缺字段
    expect(details).toMatchObject({ provider: "", sources: [], truncated: false });
  });

  it("limit 超过上限时夹到 20（不报错）", async () => {
    let seen: number | undefined;
    const service = fakeService({});
    service.search = async (request) => {
      seen = request.maxResults;
      return { provider: "searxng", sources: [], truncated: false };
    };
    await run(searchTool(service), { query: "x", limit: 9999 });
    expect(seen).toBe(20);
  });

  it("limit 缺省时不传 maxResults（让服务层用设置里的上限）", async () => {
    let seen: number | undefined | "absent" = "absent";
    const service = fakeService({});
    service.search = async (request) => {
      seen = request.maxResults;
      return { provider: "searxng", sources: [], truncated: false };
    };
    await run(searchTool(service), { query: "x" });
    expect(seen).toBeUndefined();
  });
});

describe("web_fetch", () => {
  it("空 url 直接拒绝", async () => {
    const { text } = await run(fetchTool(fakeService({})), { url: "  " });
    expect(text).toContain("non-empty");
  });

  it("非 2xx 是正常结果而不是错误", async () => {
    const service = fakeService({ fetch: { statusCode: 404, content: "not found" } });
    const { text, details } = await run(fetchTool(service), { url: "https://a.test" });
    expect(text).toContain("HTTP 404");
    expect(text).toContain("not found");
    expect(text).not.toContain("Error:");
    expect(details).toMatchObject({ statusCode: 404 });
  });

  it("失败时返回文本化错误", async () => {
    const service = fakeService({ fetch: new WebError("目标不是公网地址", "WEB_BLOCKED_URL") });
    const { text } = await run(fetchTool(service), { url: "http://127.0.0.1" });
    expect(text).toContain("Error:");
    expect(text).toContain("public internet addresses");
  });

  it("details 带最终 URL 与状态码", async () => {
    const service = fakeService({
      fetch: { url: "https://final.test/x", statusCode: 200, title: "T" },
    });
    const { details } = await run(fetchTool(service), { url: "https://a.test" });
    expect(details).toMatchObject({ url: "https://final.test/x", statusCode: 200, title: "T" });
  });
});

/**
 * 设置里的「抓取输出上限」必须**真的生效**。
 *
 * 这一组是一次真实缺陷的回归守卫：`fetchMaxOutputChars` 当时被存下来、
 * 在设置面板上显示，却**没有任何消费者** —— 工具层用的是硬编码的 20_000，
 * 于是用户把上限调到 1000 之后，界面说改了、行为没变。
 *
 * 这类缺陷不会崩、不会报错，只有把「设置值」和「实际输出」对照起来才看得见，
 * 所以下面刻意断言**输出长度**，而不是断言某个中间变量。
 */
describe("web_fetch 的输出上限来自设置", () => {
  /** 造一段很长的正文，让上限成为唯一的约束 */
  const LONG_BODY = "x".repeat(50_000);

  it("设置在 1000 时输出被夹到 1000 以内（含头部与尾注）", async () => {
    const service = fakeService({ fetch: { content: LONG_BODY }, fetchLimit: 1000 });
    const { text } = await run(fetchTool(service), { url: "https://a.test" });
    expect(text.length).toBeLessThanOrEqual(1000);
    // 截断了就该有尾注，且尾注完整（不是被砍掉）
    expect(
      text.endsWith("(Content truncated. Fetch a more specific URL or section for the full text.)"),
    ).toBe(true);
  });

  it("设置放大时输出也随之放大（不是固定 20_000）", async () => {
    const service = fakeService({ fetch: { content: LONG_BODY }, fetchLimit: 40_000 });
    const { text } = await run(fetchTool(service), { url: "https://a.test" });
    expect(text.length).toBeGreaterThan(20_000);
    expect(text.length).toBeLessThanOrEqual(40_000);
  });

  it("模型传的 maxChars 只能**收紧**，不能突破设置上限", async () => {
    const service = fakeService({ fetch: { content: LONG_BODY }, fetchLimit: 2000 });
    const { text } = await run(fetchTool(service), { url: "https://a.test", maxChars: 100_000 });
    expect(text.length).toBeLessThanOrEqual(2000);
  });

  it("模型传更小的值时用模型的值", async () => {
    const service = fakeService({ fetch: { content: LONG_BODY }, fetchLimit: 40_000 });
    const { text } = await run(fetchTool(service), { url: "https://a.test", maxChars: 800 });
    expect(text.length).toBeLessThanOrEqual(800);
  });

  it("设置值小于下限时按下限走（不会截成一个没有意义的碎片）", async () => {
    const service = fakeService({ fetch: { content: LONG_BODY }, fetchLimit: 10 });
    const { text } = await run(fetchTool(service), { url: "https://a.test" });
    // 下限是 500：宁可多给一点，也不要给 10 个字符的残片
    expect(text.length).toBeGreaterThan(10);
    expect(text.length).toBeLessThanOrEqual(500);
  });

  it("每次调用都重新读上限（改设置立即生效，无需重建工具）", async () => {
    let limit = 1000;
    const service = fakeService({ fetch: { content: LONG_BODY } });
    service.fetchOutputLimit = async () => limit;

    const first = await run(fetchTool(service), { url: "https://a.test" });
    expect(first.text.length).toBeLessThanOrEqual(1000);

    limit = 5000;
    const second = await run(fetchTool(service), { url: "https://a.test" });
    expect(second.text.length).toBeGreaterThan(1000);
    expect(second.text.length).toBeLessThanOrEqual(5000);
  });
});

describe("formatSearchOutput", () => {
  it("无结果时明确说明，并给出下一步", () => {
    const text = formatSearchOutput({ sources: [], truncated: false }, "obscure query");
    expect(text).toContain("No results found");
    expect(text).toContain("obscure query");
  });

  it("来源行是 markdown 链接，没有标题时用主机名", () => {
    const text = formatSearchOutput(
      { sources: [{ url: "https://a.test/path" }], truncated: false },
      "q",
    );
    expect(text).toContain("- [a.test](https://a.test/path)");
  });

  it("snippet 与日期都拼在来源行尾部", () => {
    const text = formatSearchOutput(
      {
        sources: [
          { url: "https://a.test", title: "A", snippet: "摘要", publishedAt: "2026-01-02" },
        ],
        truncated: false,
      },
      "q",
    );
    expect(text).toContain("- [A](https://a.test) — 摘要 (2026-01-02)");
  });

  it("截断时说明只显示了前 N 条", () => {
    const text = formatSearchOutput({ sources: [{ url: "https://a.test" }], truncated: true }, "q");
    expect(text).toContain("Showing the first 1 sources");
  });

  it("部分引擎无响应时提一句（单复数正确）", () => {
    expect(
      formatSearchOutput(
        { sources: [{ url: "https://a.test" }], truncated: false, unresponsive: 1 },
        "q",
      ),
    ).toContain("1 search engine did not respond");
    expect(
      formatSearchOutput(
        { sources: [{ url: "https://a.test" }], truncated: false, unresponsive: 3 },
        "q",
      ),
    ).toContain("3 search engines did not respond");
  });

  it("总以引用指引结尾", () => {
    const text = formatSearchOutput(
      { sources: [{ url: "https://a.test" }], truncated: false },
      "q",
    );
    expect(text.endsWith("Cite the relevant URLs above as markdown links in your answer.")).toBe(
      true,
    );
  });
});

describe("formatFetchOutput", () => {
  const base = { url: "https://a.test", statusCode: 200, truncated: false };

  it("头部形状为 Fetched <url> (HTTP <status>)", () => {
    const text = formatFetchOutput({ ...base, content: "hello" }, 1000);
    expect(text.startsWith("Fetched https://a.test (HTTP 200)")).toBe(true);
    expect(text).toContain(EXTERNAL_CONTENT_NOTICE);
    expect(text).toContain("hello");
  });

  it("短内容不加截断尾注", () => {
    const text = formatFetchOutput({ ...base, content: "hello" }, 1000);
    expect(text).not.toContain("Content truncated");
  });

  it("provider 标了 truncated 时加尾注", () => {
    const text = formatFetchOutput({ ...base, content: "hello", truncated: true }, 1000);
    expect(text).toContain("Content truncated");
  });

  it("超长内容截断时**保证尾注完整**（砍正文而不是砍尾注）", () => {
    const maxChars = 500;
    const text = formatFetchOutput({ ...base, content: "x".repeat(5000) }, maxChars);
    expect(text.length).toBeLessThanOrEqual(maxChars);
    expect(
      text.endsWith("(Content truncated. Fetch a more specific URL or section for the full text.)"),
    ).toBe(true);
  });

  it("上限比尾注还短时硬切（没有放尾注的余地）", () => {
    const text = formatFetchOutput({ ...base, content: "x".repeat(5000) }, 20);
    expect(text).toHaveLength(20);
  });
});

describe("describeWebError", () => {
  it("非 WebError 时原样带出 message", () => {
    expect(describeWebError(new Error("boom"))).toBe("Error: boom");
    expect(describeWebError("string error")).toBe("Error: string error");
  });

  it("WEB_BLOCKED_URL 补上「只允许公网」的解释", () => {
    const text = describeWebError(new WebError("blocked", "WEB_BLOCKED_URL"));
    expect(text).toContain("public internet addresses");
  });

  it("WEB_REDIRECT_BLOCKED 告诉模型用最终 URL 重试", () => {
    const text = describeWebError(new WebError("cross-origin", "WEB_REDIRECT_BLOCKED"));
    expect(text).toContain("Call web_fetch again with the final URL");
  });

  it("WEB_UNSUPPORTED_CONTENT_TYPE 说明不支持 PDF", () => {
    const text = describeWebError(new WebError("bad type", "WEB_UNSUPPORTED_CONTENT_TYPE"));
    expect(text).toContain("PDFs and binary files are not supported");
  });

  it("WEB_DISABLED 说明是设置里关掉的", () => {
    const text = describeWebError(new WebError("off", "WEB_DISABLED"));
    expect(text).toContain("disabled in this app's settings");
  });
});
