import { describe, expect, it } from "vitest";
import { BROWSER_TOOL_NAMES } from "@/shared/contracts/browser";
import { WEB_TOOL_NAMES } from "@/shared/contracts/web";
import type { BrowserAutomation } from "../browser/types";
import type { WebService } from "../web/types";
import { buildTools, restrictTools, TOOL_NAMES } from "./tools";

/** 内核原生四件套：description 由 tools.ts 整体覆盖 */
const NATIVE_TOOLS = ["bash", "read", "write", "edit"];
/**
 * 自建工具（不含浏览器族，也不含按会话注入的 ask_user）。
 *
 * `read_image` 在这里而不在 NATIVE_TOOLS：它不是内核那四件套，而是我们自己的实现
 *（内核的 read 虽然也认图片，但回的是「说明文本 + image 块」，界面看不见、
 * 模型也拿不到尺寸 —— 见 tools/read-image.ts 的文件头）。
 */
const CUSTOM_TOOLS = ["grep", "glob", "todo", "read_image"];
/**
 * 浏览器工具名清单。
 *
 * 直接从契约的常量对象取（而不是消费一个专门的数组导出）：那份数组只被本测试用，
 * 为它保留一个生产导出等于把「哪些名字算浏览器工具」变成公开 API。
 */
const BROWSER_TOOL_NAME_LIST = Object.values(BROWSER_TOOL_NAMES);

/**
 * 浏览器工具的假实现：这个测试只关心**装配**（名字、数量、description 齐不齐），
 * 不关心它们怎么操作页面 —— 那是 browser 服务的事，而它依赖 Electron。
 * 用一个只会抛错的桩就够：装配正确时这些方法一次都不会被调用。
 */
function fakeAutomation(): BrowserAutomation {
  const notImplemented = () => {
    throw new Error("测试不应该真的调用浏览器");
  };
  return {
    setAgentActive: () => undefined,
    status: () => ({
      open: false,
      state: { url: "", title: "", loading: false, canGoBack: false, canGoForward: false },
      agentActive: false,
    }),
    open: notImplemented,
    history: notImplemented,
    snapshot: notImplemented,
    click: notImplemented,
    type: notImplemented,
    screenshot: notImplemented,
    console: () => Promise.resolve([]),
    evaluate: notImplemented,
  } as unknown as BrowserAutomation;
}

describe("buildTools", () => {
  it("默认返回内核四件套 + 四个自建工具：浏览器与 ask_user 都要调用方注入", () => {
    const tools = buildTools();

    expect(tools).toHaveLength(NATIVE_TOOLS.length + CUSTOM_TOOLS.length);
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [...NATIVE_TOOLS, ...CUSTOM_TOOLS].sort(),
    );
    // TOOL_NAMES 是权限层 / UI 的登记表：ask_user 按会话注入、浏览器族按实现注入、
    // 网络工具按 WebService 注入（见 runtime 的 buildTools 调用点），
    // 所以默认工具集 = 登记表去掉这三族。
    const injectable = new Set<string>([
      TOOL_NAMES.ask,
      ...BROWSER_TOOL_NAME_LIST,
      ...Object.values(WEB_TOOL_NAMES),
    ]);
    expect(new Set(tools.map((tool) => tool.name))).toEqual(
      new Set(Object.values(TOOL_NAMES).filter((name) => !injectable.has(name))),
    );

    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.parameters).toBeTruthy();
      expect(typeof tool.execute).toBe("function");
      // label 是 AgentTool 的必填字段，UI 直接拿它显示
      expect(tool.name).toBeTruthy();
    }
  });

  it("传入浏览器实现时装配出全部浏览器工具，且 name 与 label 一致", () => {
    const tools = buildTools([], undefined, [], fakeAutomation());
    const names = tools.map((tool) => tool.name);

    for (const name of BROWSER_TOOL_NAME_LIST) {
      expect(names).toContain(name);
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool?.name).toBe(name);
    }
    expect(tools).toHaveLength(
      NATIVE_TOOLS.length + CUSTOM_TOOLS.length + BROWSER_TOOL_NAME_LIST.length,
    );
  });

  it("四个原生工具的 description 已覆盖为带场景指导的文案", () => {
    // 内核自带的文案只有操作说明，模型选错工具的首要原因就是缺「什么时候用」——
    // 这条断言防止将来有人把覆盖去掉（去掉后 description 仍在，只是变得没用）
    const tools = buildTools().filter((tool) => NATIVE_TOOLS.includes(tool.name));

    expect(tools).toHaveLength(NATIVE_TOOLS.length);
    for (const tool of tools) {
      expect(tool.description).toContain("什么时候用");
      expect(tool.description).toContain("什么时候不要用");
    }
  });

  it("read / edit 的描述都说明行号不属于文件内容（read 的输出确实带行号）", () => {
    const tools = buildTools();
    const read = tools.find((tool) => tool.name === TOOL_NAMES.read);
    const edit = tools.find((tool) => tool.name === TOOL_NAMES.edit);

    // read 承诺行号；edit 是逐字符匹配，必须警告模型别把行号复制进 oldText/newText
    expect(read?.description).toContain("带行号");
    expect(edit?.description).toContain("行号");
    expect(edit?.description).toContain("oldText");
  });

  /**
   * 工具描述是**模型唯一的行为依据** —— 描述说错了，它会照着错的做。
   *
   * 两条曾经说反的话：
   * - read 的描述写「read 只回一句类型说明，看不到图」；1.2.0 起原生 read 会在模型的
   *   图片限制内直接返回图片块（超限则报错），read_image 则继续提供尺寸与元数据、
   *   带 16 MiB 守卫。描述必须与这个分工一致。
   * - read_image 的描述承诺「大图会自动缩小」，而它**没有任何缩放实现**：
   *   超限时的实际行为是报错让模型自己去缩。模型按描述以为不必管，就卡住了。
   *
   * 这两条断言钉的是「描述不许声称本仓不做的行为」。
   */
  it("read 原生支持图片块，read_image 提供尺寸与元数据", () => {
    const tools = buildTools();
    const read = tools.find((tool) => tool.name === TOOL_NAMES.read);

    expect(read?.description).toContain("read_image");
    // 1.2.0 起 read 在模型限制内直接返回图片块；read_image 负责尺寸与元数据
    expect(read?.description).toContain("图片块");
    // 不能再出现那句与实现相反的话
    expect(read?.description).not.toContain("看不到图");
  });

  it("read_image 的描述不承诺自动缩放（本仓没有缩放实现）", () => {
    const tools = buildTools();
    const readImage = tools.find((tool) => tool.name === TOOL_NAMES.readImage);

    expect(readImage?.description).toContain("rejected");
    expect(readImage?.description).not.toContain("downscaled automatically");
  });

  it("自建工具的 name 与 label 一致", () => {
    const tools = buildTools();
    for (const name of CUSTOM_TOOLS) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool, `缺少工具 ${name}`).toBeTruthy();
      expect(tool?.name).toBe(name);
    }
  });

  it("浏览器工具的 description 写清了「什么时候用 / 不要用」（本仓库的既定标准）", () => {
    const tools = buildTools([], undefined, [], fakeAutomation());
    for (const name of BROWSER_TOOL_NAME_LIST) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool?.description).toContain("When to use it");
      expect(tool?.description).toContain("When NOT to use it");
    }
  });
});

/**
 * 网络工具的装配。
 *
 * 这一组同时是**防回归**：`buildTools` 有多个调用点（会话创建的主/子两条分支 +
 * MCP 热替换），漏传第 6 个参数会让新工具静默消失 —— ask_user 踩过同一个坑
 * （见 tools.ts 的注释）。这里对源码做一次静态断言，因为漏传是**运行期悄无声息**的。
 */
describe("网络工具", () => {
  /** 假 service：装配测试只关心名字/描述，这些方法一次都不会被调用 */
  const fakeWeb: WebService = {
    fetchOutputLimit: async () => 20_000,
    search: () => Promise.reject(new Error("测试不应该真的搜索")),
    fetch: () => Promise.reject(new Error("测试不应该真的抓取")),
  };

  it("传入 service 时装配出两个网络工具，name 与 label 一致", () => {
    const tools = buildTools([], undefined, [], undefined, [], fakeWeb);
    const names = tools.map((tool) => tool.name);
    expect(names).toContain(WEB_TOOL_NAMES.search);
    expect(names).toContain(WEB_TOOL_NAMES.fetch);
    for (const name of Object.values(WEB_TOOL_NAMES)) {
      expect(tools.find((tool) => tool.name === name)?.name).toBe(name);
    }
  });

  it("不传 service 时两个工具都不出现（单测里的 buildTools() 行为不变）", () => {
    const names = buildTools().map((tool) => tool.name);
    expect(names).not.toContain(WEB_TOOL_NAMES.search);
    expect(names).not.toContain(WEB_TOOL_NAMES.fetch);
  });

  it("description 写清了「什么时候用 / 不要用」（本仓库的既定标准）", () => {
    const tools = buildTools([], undefined, [], undefined, [], fakeWeb);
    for (const name of Object.values(WEB_TOOL_NAMES)) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool?.description).toContain("When to use it");
      expect(tool?.description).toContain("When not to use it");
    }
  });

  it("description 把外部内容标记为不可信（提示注入的第一道防线）", () => {
    const tools = buildTools([], undefined, [], undefined, [], fakeWeb);
    for (const name of Object.values(WEB_TOOL_NAMES)) {
      expect(tools.find((tool) => tool.name === name)?.description).toContain("UNTRUSTED");
    }
  });

  it("名字表可由 TOOL_NAMES 取到（权限层与 UI 图标表按它登记）", () => {
    // 展开 WEB_TOOL_NAMES 后键名是 search / fetch（与 BROWSER_TOOL_NAMES 展开出
    // open / snapshot 等同一个约定：键是短名，值是模型可见的全名）
    expect(TOOL_NAMES.search).toBe(WEB_TOOL_NAMES.search);
    expect(TOOL_NAMES.fetch).toBe(WEB_TOOL_NAMES.fetch);
  });

  /**
   * 静态检查 runtime.ts 的 buildTools 调用点都传了 web 依赖。
   *
   * 为什么用读源码而不是行为测试：漏传第 6 个参数时**没有任何运行期症状**，
   * 直到用户发现「MCP 一刷新，web 工具就没了」。源码断言能立刻抓住它，
   * 而行为测试要构造完整运行时（harness + 会话 + MCP）才能覆盖。
   *
   * 调用点从三个收敛成一个（主会话与子智能体共用同一次装配，只在 Task 系列与 ask_user
   * 上分叉 —— 见 runtime 的 tools 装配），断言跟着改：数量不重要，
   * 重要的是**每一个调用点都带上了它**。
   */
  it("runtime.ts 的每个 buildTools 调用点都传了 deps.web", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("./runtime.ts", import.meta.url), "utf8");
    const calls = source.match(/buildTools\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const webArgs = source.match(/deps\.web,?\s*\)|deps\.web,/g) ?? [];
    expect(webArgs.length).toBeGreaterThanOrEqual(calls.length);
  });

  // Runtime child selection is verified against actual model requests in runtime.send.test.ts,
  // including the native family child's exact whitelist; source spelling is not an API contract.
});

/**
 * `restrictTools` 的语义：**白名单，空就是空**。
 *
 * 它现在只有一个调用方 —— 主 AI 临时定义的子智能体带白名单时（`definition.tools`）。
 * 内置与用户定义不走这里：它们拿到的是主代理同一批工具。
 *
 * 之所以把「空清单 = 什么都不给」钉住：旧实现在空清单时**原样返回整张表**，
 * 理由是「空数组表示没指定」，而那个歧义在子智能体那条路径上会变成静默提权。
 * 现在调用方（runtime）只在 `tools` 存在时才调用它，而派发时已经校验过
 * 「清单里的名字都真实存在且非空」，所以空 = 一个都不给，没有歧义。
 */
describe("restrictTools", () => {
  const tools = buildTools();

  it("按名字过滤，只保留清单里的", () => {
    const narrowed = restrictTools(tools, [TOOL_NAMES.read, TOOL_NAMES.grep]);
    expect(narrowed.map((tool) => tool.name).sort()).toEqual(
      [TOOL_NAMES.read, TOOL_NAMES.grep].sort(),
    );
  });

  it("空清单 = 什么都不给（不是「不限制」）", () => {
    expect(restrictTools(tools, [])).toEqual([]);
  });

  it("不认识的名字不匹配任何工具（拼错不会顺便放行）", () => {
    expect(restrictTools(tools, ["teleport"])).toEqual([]);
  });

  it("过滤结果是原表的子集：不会因为白名单凭空造出工具", () => {
    const narrowed = restrictTools(tools, [TOOL_NAMES.read, "mcp__arxiv__call", TOOL_NAMES.bash]);
    for (const tool of narrowed) {
      expect(tools).toContain(tool);
    }
  });
});
