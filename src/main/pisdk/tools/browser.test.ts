import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createToolTestApi } from "@/main/pisdk/tools/tool-test-api";
// 浏览器工具的行为测试：只覆盖**不依赖 Electron** 的那一层。
//
// 重点验三件容易写错的事：
//   1. **动作分发**。browser_act 把六个动作合并成一个工具，参数校验与「哪个动作需要哪些参数」
//      全靠工具层把关 —— 少一个校验就会把 undefined 送进主进程，报出看不懂的错。
//   2. **标签透传**。所有工具都有可选的 `tab`，必须原样传下去；漏传会让多标签场景下
//      模型指着的那个标签被悄悄换掉（而人看到的是「它点错了页面」）。
//   3. **提示条计数**。并行调用时先结束的那个不该把「模型正在操作」清掉。
//
// 真实的页面行为（快照内容、点击坐标、串行队列）留给主进程与端到端验收：那是 Electron
// 里的时序，在这里假装测它只会制造「测试通过但功能坏了」的假象。

import type { ToolRegistration } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import {
  BROWSER_TOOL_NAMES,
  type BrowserConsoleReport,
  type BrowserDialogPolicy,
  type BrowserErrorCode,
  type BrowserNetworkReport,
  type BrowserWaitResult,
} from "@/shared/contracts/browser";
import type {
  BrowserActionOutcome,
  BrowserAutomation,
  BrowserOptionMatch,
  BrowserPressOutcome,
  BrowserSelectOutcome,
  BrowserTabOperations,
} from "../../browser/types";
import { createBrowserTools } from "./browser";

/** 一个可观测的假实现：记录操作顺序、活跃标记、以及每次请求的 tabId */
function trackingAutomation(
  options: {
    /** 覆盖 wait 的返回值：超时分文的用例要把它改成 matched: false */
    wait?: BrowserWaitResult;
    /** 覆盖 network 的返回值：空缓冲 / 无失败 / 有省略的用例按需给 */
    network?: BrowserNetworkReport;
    /** 覆盖 console 的返回值：Electron 噪音被过滤的用例按需给 */
    console?: BrowserConsoleReport;
    /** 覆盖 screenshot 的 warning：全白图告警的用例按需给 */
    screenshotWarning?: string;
    /** 坐标点击 / 悬停 / 拖拽报回来的「谁收下了」（默认 "canvas" / "slider"） */
    clickPointHit?: string;
    hoverPointHit?: string;
    dragHit?: string;
  } = {},
) {
  const events: string[] = [];
  let activeDepth = 0;
  const maxActiveDepth = { value: 0 };
  /** 每次 tab() 收到的参数（多标签透传的判据） */
  const requestedTabs: (string | undefined)[] = [];
  /** 每个标签各自被标记的活跃次数（提示条按标签计数） */
  const activeByTab = new Map<string, number>();

  /** 模拟一次耗时操作，并在期间标记「正在操作」 */
  async function act(name: string): Promise<void> {
    activeDepth += 1;
    maxActiveDepth.value = Math.max(maxActiveDepth.value, activeDepth);
    events.push(`enter:${name}`);
    await new Promise((r) => setTimeout(r, 5));
    events.push(`exit:${name}`);
    activeDepth -= 1;
  }

  const opsFor = (tabId: string): BrowserTabOperations => ({
    tabId,
    setAgentActive(active, note) {
      activeByTab.set(tabId, (activeByTab.get(tabId) ?? 0) + (active ? 1 : -1));
      events.push(
        `active:${active ? "on" : "off"}:${tabId}${note === undefined ? "" : `:${note}`}`,
      );
    },
    history: async (action) => {
      await act(`history:${action}`);
      return {
        url: "https://example.com/",
        title: "Example",
        loading: false,
        canGoBack: false,
        canGoForward: false,
      };
    },
    snapshot: async () => {
      await act("snapshot");
      return {
        url: "https://example.com/",
        title: "Example",
        generation: 1,
        text: "hi",
        truncated: false,
        elements: [],
      };
    },
    click: async (ref: string): Promise<BrowserActionOutcome> => {
      await act(`click:${ref}`);
      return { name: "button", navigated: false, effect: "hit" };
    },
    /**
     * 坐标点击的假实现：把落点记进事件流（测试据此断言「ref 路径与坐标路径没有串味」），
     * 命中者用 options.clickPointHit 覆盖（默认 "canvas"，即那种 ref 够不到的目标）。
     */
    clickPoint: async (x: number, y: number): Promise<BrowserActionOutcome> => {
      await act(`clickPoint:${x},${y}`);
      return {
        name: options.clickPointHit ?? "canvas",
        navigated: false,
        effect: "hit",
        detail: `坐标 (${x}, ${y})：这次点击由 canvas 收下。`,
      };
    },
    drag: async (from, to): Promise<BrowserActionOutcome> => {
      await act(`drag:${from.x},${from.y}->${to.x},${to.y}`);
      return {
        name: options.dragHit ?? "slider",
        navigated: false,
        effect: "hit",
        detail: `拖拽 (${from.x}, ${from.y}) → (${to.x}, ${to.y})：按下落在 slider 上。`,
      };
    },
    hoverPoint: async (x: number, y: number): Promise<BrowserActionOutcome> => {
      await act(`hoverPoint:${x},${y}`);
      return {
        name: options.hoverPointHit ?? "canvas",
        navigated: false,
        effect: "hit",
        detail: `坐标 (${x}, ${y})：悬停落在 canvas 上。`,
      };
    },
    type: async (ref: string): Promise<BrowserActionOutcome> => {
      await act(`type:${ref}`);
      return { name: "field", navigated: false, effect: "hit" };
    },
    press: async (key: string, ref?: string): Promise<BrowserPressOutcome> => {
      await act(`press:${key}`);
      return {
        name: ref === undefined ? "" : "button",
        navigated: false,
        keys: key.toLowerCase(),
        effect: "hit",
      };
    },
    hover: async (ref: string): Promise<BrowserActionOutcome> => {
      await act(`hover:${ref}`);
      return { name: "menu", navigated: false, effect: "hit" };
    },
    select: async (ref: string, match: BrowserOptionMatch): Promise<BrowserSelectOutcome> => {
      await act(`select:${ref}:${match.kind}`);
      return {
        name: "country",
        navigated: false,
        effect: "hit",
        value: match.kind === "value" ? match.value : "us",
        label: "United States",
      };
    },
    scroll: async (deltaY: number, deltaX?: number): Promise<BrowserActionOutcome> => {
      await act(`scroll:${deltaY}:${deltaX ?? 0}`);
      return {
        name: "(page)",
        navigated: false,
        effect: "hit",
        detail: "window.scrollY: 0 → 600",
      };
    },
    wait: async () => {
      await act("wait");
      return options.wait ?? { matched: true, waitedMs: 12, detail: "the element is visible now" };
    },
    screenshot: async () => {
      await act("screenshot");
      return {
        data: "AAAA",
        mimeType: "image/png" as const,
        width: 10,
        height: 10,
        ...(options.screenshotWarning === undefined ? {} : { warning: options.screenshotWarning }),
      };
    },
    console: async (): Promise<BrowserConsoleReport> => {
      await act("console");
      return options.console ?? { entries: [], dropped: 0 };
    },
    network: async (): Promise<BrowserNetworkReport> => {
      await act("network");
      return (
        options.network ?? {
          entries: [
            {
              url: "https://example.com/api/items",
              method: "POST",
              status: 500,
              resourceType: "fetch",
              durationMs: 120,
              at: 1,
            },
            {
              url: "https://cdn.example.com/app.js",
              method: "GET",
              status: 0,
              resourceType: "script",
              error: "net::ERR_CONNECTION_RESET",
              durationMs: 0,
              at: 2,
            },
          ],
          total: 2,
          omitted: 0,
          bufferEmpty: false,
          noFailures: false,
        }
      );
    },
    dialog: async (policy: BrowserDialogPolicy) => {
      await act("dialog");
      return { policy, handledSinceLastRead: 0 };
    },
    evaluate: async () => {
      await act("evaluate");
      return { ok: true as const, value: '"x"' };
    },
  });

  const automation: BrowserAutomation = {
    status: () => ({
      open: true,
      tabs: [
        { tabId: "t1", active: true, url: "https://example.com/", title: "Example" },
        { tabId: "t2", active: false, url: "https://docs.example.com/", title: "Docs" },
      ],
      agentActive: true,
    }),
    listTabs: () => [
      { tabId: "t1", active: true, url: "https://example.com/", title: "Example" },
      { tabId: "t2", active: false, url: "https://docs.example.com/", title: "Docs" },
    ],
    open: async () => {
      await act("open");
      return {
        url: "https://example.com/",
        title: "Example",
        loading: false,
        canGoBack: false,
        canGoForward: false,
      };
    },
    tab: (tabId?: string) => {
      requestedTabs.push(tabId);
      return opsFor(tabId ?? "t1");
    },
  };

  return { automation, events, maxActiveDepth, requestedTabs, activeByTab };
}

/** 调用一个工具并取回给模型看的文本（要断言文案的用例用它） */
async function callText(
  tools: ToolRegistration[],
  name: string,
  args: Record<string, unknown> = {},
): Promise<string> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`缺少工具 ${name}`);
  const result = await tool.execute(args, createToolTestApi({ callId: "t1" }), BACKGROUND_CONTEXT);
  const part = (result.output ?? [])[0];
  if (part === undefined || part.type !== "text") throw new Error(`${name} 没有返回文本`);
  return part.text;
}

/** 取出某个工具并调用它（参数按各自 schema 给最小合法值） */
async function call(
  tools: ToolRegistration[],
  name: string,
  args: Record<string, unknown> = {},
): Promise<void> {
  await callText(tools, name, args);
}

/**
 * 调用一个工具并取回**完整结果**（output 各块 + details）。
 *
 * `callText` 只回第一块文本，够不着两件事：图片块（截图工具会同时回文本与 image），
 * 以及 details。断言「模型看得见什么」与「渲染层拿得到什么」时必须区分这两处 ——
 * 截图的全白告警就是因为只进了 output 而曾经整个丢掉。
 */
async function callResult<TDetails = unknown>(
  tools: ToolRegistration[],
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ output: { type: string; text?: string }[]; details: TDetails }> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`缺少工具 ${name}`);
  return (await tool.execute(args, createToolTestApi({ callId: "t1" }), BACKGROUND_CONTEXT)) as {
    output: { type: string; text?: string }[];
    details: TDetails;
  };
}

/** 调用一个工具并取回它抛出的错误文案（参数校验的用例用它） */
async function callError(
  tools: ToolRegistration[],
  name: string,
  args: Record<string, unknown> = {},
): Promise<string> {
  try {
    await call(tools, name, args);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error(`${name} 本应报错，却成功了`);
}

/**
 * 造一个主进程风格的 BrowserToolError。
 *
 * 刻意不 import src/main/browser/errors.ts 的类：工具层是靠**结构**（code 在冻结的
 * 错误码名单里 + detail）识别失败的，测试也按同一口径构造 —— 这样两侧可以各自
 * 独立落地，而这条契约（字段名与错误码）仍然被钉死在这里。
 */
function browserFailure(
  code: BrowserErrorCode,
  message: string,
  detail?: Record<string, unknown>,
): Error {
  const error = new Error(message) as Error & {
    code: BrowserErrorCode;
    detail?: Record<string, unknown>;
  };
  error.code = code;
  if (detail !== undefined) error.detail = detail;
  return error;
}

/** 假实现 + 按需让某个操作抛错（失败渲染的用例用它） */
function automationThrowing(method: keyof BrowserTabOperations, error: Error): BrowserAutomation {
  const { automation } = trackingAutomation();
  const originalTab = automation.tab.bind(automation);
  return {
    ...automation,
    tab: (tabId?: string) => ({
      ...originalTab(tabId),
      [method]: async () => Promise.reject(error),
    }),
  } as unknown as BrowserAutomation;
}

/** 假实现 + 覆盖某个操作的返回值（成功路径字段渲染的用例用它） */
function automationReturning(
  method: keyof BrowserTabOperations,
  value: unknown,
): BrowserAutomation {
  const { automation } = trackingAutomation();
  const originalTab = automation.tab.bind(automation);
  return {
    ...automation,
    tab: (tabId?: string) => ({ ...originalTab(tabId), [method]: async () => value }),
  } as unknown as BrowserAutomation;
}

describe("浏览器工具", () => {
  it("工具集与 BROWSER_TOOL_NAMES 一致：九个名字一个不多一个不少", () => {
    const { automation } = trackingAutomation();
    const tools = createBrowserTools(automation);
    const names: readonly string[] = Object.values(BROWSER_TOOL_NAMES);

    // 合并后的上限就是九个：再加工具要先说明「为什么它不能并进现有动作」
    expect(names).toHaveLength(9);
    expect(tools).toHaveLength(names.length);
    const missing = names.filter((name) => tools.every((tool) => tool.name !== name));
    expect(missing, `缺少这些工具：${missing.join("、")}`).toEqual([]);
    // 反向也查一遍：名字写错（常量表里没有）或重复同样算失败
    expect([...tools.map((tool) => tool.name)].sort()).toEqual([...names].sort());
  });

  it("每个工具都接受 tab 并原样透传（多标签下指错标签=点错页面）", async () => {
    const { automation, requestedTabs } = trackingAutomation();
    const tools = createBrowserTools(automation);

    const args: Record<string, Record<string, unknown>> = {
      browser_open: { url: "example.com", tab: "t2" },
      browser_history: { action: "back", tab: "t2" },
      browser_snapshot: { tab: "t2" },
      browser_act: { action: "click", ref: "e1", tab: "t2" },
      browser_wait: { text: "done", tab: "t2" },
      browser_screenshot: { tab: "t2" },
      browser_logs: { type: "console", tab: "t2" },
      browser_dialog: { action: "dismiss", tab: "t2" },
      browser_evaluate: { code: "1", tab: "t2" },
    };

    for (const name of Object.values(BROWSER_TOOL_NAMES)) {
      await call(tools, name, args[name] ?? {});
    }

    // 除 browser_open 走 automation.open 的分支外，其余八个都必须带着 "t2" 去要句柄
    expect(requestedTabs.filter((tabId) => tabId === "t2")).toHaveLength(8);
  });

  it("browser_act 按动作分派：六个动作各自打到对应的操作上", async () => {
    const { automation, events } = trackingAutomation();
    const tools = createBrowserTools(automation);

    await call(tools, "browser_act", { action: "click", ref: "e1" });
    await call(tools, "browser_act", { action: "type", ref: "e2", text: "hi", submit: true });
    await call(tools, "browser_act", { action: "press", key: "Enter", ref: "e3" });
    await call(tools, "browser_act", { action: "hover", ref: "e4" });
    await call(tools, "browser_act", { action: "select", ref: "e5", value: "us" });
    await call(tools, "browser_act", { action: "scroll", deltaY: 600 });

    const entered = events.filter((event) => event.startsWith("enter:"));
    expect(entered).toEqual([
      "enter:click:e1",
      "enter:type:e2",
      "enter:press:Enter",
      "enter:hover:e4",
      "enter:select:e5:value",
      "enter:scroll:600:0",
    ]);
  });

  /**
   * 坐标路径：canvas / 图片热区这一类**没有可点 ref** 的目标只能按 x/y 点。
   *
   * 这里钉三件事：
   *   1. 坐标动作走的是主进程的坐标通道（clickPoint / hoverPoint / drag），不是 ref 那条；
   *   2. 结果文本里必须写出落点与**谁收下了**（`canvas`）—— 坐标点击没有语义目标，
   *      这一句是模型唯一能核对的证据（ref 点击错了会报 WRONG_TARGET，坐标点击不会）；
   *   3. 拖拽把四个坐标原样交下去（起点 / 终点都不许被改写）。
   */
  it("browser_act 的坐标路径：x/y 点击、悬停与拖拽各走各的通道", async () => {
    const { automation, events } = trackingAutomation();
    const tools = createBrowserTools(automation);

    const clickText = await callText(tools, "browser_act", { action: "click", x: 120, y: 240 });
    await call(tools, "browser_act", { action: "click", x: 10, y: 20, clicks: 2 });
    await call(tools, "browser_act", { action: "click", x: 30, y: 40, button: "right" });
    await call(tools, "browser_act", { action: "hover", x: 50, y: 60 });
    const dragText = await callText(tools, "browser_act", {
      action: "drag",
      fromX: 5,
      fromY: 6,
      toX: 105,
      toY: 206,
    });

    expect(events.filter((event) => event.startsWith("enter:"))).toEqual([
      "enter:clickPoint:120,240",
      "enter:clickPoint:10,20",
      "enter:clickPoint:30,40",
      "enter:hoverPoint:50,60",
      "enter:drag:5,6->105,206",
    ]);
    expect(clickText).toContain("(120, 240)");
    expect(clickText).toContain("canvas");
    expect(dragText).toContain("(5, 6)");
    expect(dragText).toContain("(105, 206)");
  });

  it("browser_act 的坐标参数校验：ref 与 x/y 互斥、坐标要成对、拖拽四个点齐全", async () => {
    const { automation } = trackingAutomation();
    const tools = createBrowserTools(automation);

    // ref 与坐标同时给：无法判断按哪个 —— 拒绝而不是猜一个
    expect(
      await callError(tools, "browser_act", { action: "click", ref: "e1", x: 1, y: 2 }),
    ).toContain("只能给一个");
    expect(
      await callError(tools, "browser_act", { action: "hover", ref: "e1", x: 1, y: 2 }),
    ).toContain("只能给一个");
    // 只给一半：补 0 会点成页面左上角，所以必须报错
    expect(await callError(tools, "browser_act", { action: "click", x: 1 })).toContain("成对");
    expect(await callError(tools, "browser_act", { action: "hover", y: 2 })).toContain("成对");
    // 拖拽缺一个点就没有可用的落点
    const drag = await callError(tools, "browser_act", {
      action: "drag",
      fromX: 1,
      fromY: 2,
      toX: 3,
    });
    expect(drag).toContain("drag");
    expect(drag).toContain("toY");
  });

  it("browser_act 的参数校验：缺参的动作必须当场拒绝，不能把 undefined 送进主进程", async () => {
    const { automation } = trackingAutomation();
    const tools = createBrowserTools(automation);

    expect(await callError(tools, "browser_act", { action: "click" })).toContain("ref");
    expect(await callError(tools, "browser_act", { action: "type", ref: "e1" })).toContain("text");
    expect(await callError(tools, "browser_act", { action: "press" })).toContain("key");
    expect(await callError(tools, "browser_act", { action: "hover" })).toContain("ref");
    // select：value / label / index 恰好一个（0 个与 2 个都拒绝）
    const none = await callError(tools, "browser_act", { action: "select", ref: "e1" });
    expect(none).toContain("value");
    expect(none).toContain("0 个");
    const both = await callError(tools, "browser_act", {
      action: "select",
      ref: "e1",
      value: "us",
      label: "United States",
    });
    expect(both).toContain("2 个");
    // scroll：deltaY 必须是非零有限数
    expect(await callError(tools, "browser_act", { action: "scroll" })).toContain("deltaY");
    expect(await callError(tools, "browser_act", { action: "scroll", deltaY: 0 })).toContain(
      "deltaY",
    );
  });

  it("browser_act 成功文案带标签行，并说明是否导航", async () => {
    const { automation } = trackingAutomation();
    const tools = createBrowserTools(automation);

    const text = await callText(tools, "browser_act", {
      action: "click",
      ref: "e1",
      tab: "t2",
    });

    // 标签行是后续 tab 参数的唯一来源：多标签时必须给出完整列表
    expect(text).toContain("Tab: t2 (open tabs: t1, t2)");
    expect(text).toContain('Clicked e1 ("button")');
    expect(text).toContain("snapshot again");
  });

  it("browser_logs 两个视图：console 走增量读取，network 支持 failuresOnly / clear", async () => {
    const { automation, events } = trackingAutomation();
    const tools = createBrowserTools(automation);

    await call(tools, "browser_logs", { type: "console" });
    await call(tools, "browser_logs", { type: "network", failuresOnly: true, clear: true });

    const entered = events.filter((event) => event.startsWith("enter:"));
    expect(entered).toContain("enter:console");
    expect(entered).toContain("enter:network");
  });

  it("browser_screenshot 的 warning 必须进正文：模型不能把全白图当成页面本来的样子", async () => {
    const { automation } = trackingAutomation({
      screenshotWarning: "The viewport looks blank — the page may still be rendering.",
    });
    const tools = createBrowserTools(automation);

    const result = await callResult<{ warning?: string; width: number }>(
      tools,
      "browser_screenshot",
      {},
    );

    // 模型只看得到 output（details 是给渲染层的），所以告警必须出现在文本里
    const text = result.output
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("");
    expect(text).toContain("The viewport looks blank");

    // 同时保留在 details 里，让界面也能提示「这张图可能是白的」
    expect(result.details?.warning).toContain("The viewport looks blank");

    // 图片本身照常返回（告警是非致命的，不是错误）
    expect((result.output ?? []).some((block) => block.type === "image")).toBe(true);
  });

  it("没有 warning 时不加噪声行", async () => {
    const { automation } = trackingAutomation();
    const tools = createBrowserTools(automation);

    const result = await callResult<{ warning?: string }>(tools, "browser_screenshot", {});
    const text = result.output
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("");

    expect(text).not.toContain("Warning:");
    expect(result.details?.warning).toBeUndefined();
  });

  it("browser_open 的 newTab 透传（开新标签而不是把当前页面顶掉），输出带标签身份", async () => {
    const { automation } = trackingAutomation();
    const opened: Array<{ url: string; newTab?: boolean }> = [];
    const spy = {
      ...automation,
      open: async (url: string, options?: { newTab?: boolean }) => {
        opened.push({ url, ...(options?.newTab === undefined ? {} : { newTab: options.newTab }) });
        return {
          url: "https://example.com/",
          title: "Example",
          loading: false,
          canGoBack: false,
          canGoForward: false,
        };
      },
    } as unknown as BrowserAutomation;

    const tools = createBrowserTools(spy);
    await call(tools, "browser_open", { url: "example.com", newTab: true });
    expect(opened).toEqual([{ url: "example.com", newTab: true }]);

    // 打开后的输出必须带标签身份，模型才有东西可引用
    const text = await callText(tools, "browser_open", { url: "example.com" });
    expect(text).toContain("Tab: t1");
  });

  it("并发的活跃标记按标签计数：不会在还有操作在跑时被清掉", async () => {
    const { automation, events, activeByTab } = trackingAutomation();
    const tools = createBrowserTools(automation);

    await Promise.all([
      call(tools, "browser_snapshot"),
      call(tools, "browser_act", { action: "click", ref: "e1" }),
    ]);

    // 工具层是「先标记、后执行、finally 清掉」：两个并行调用之间不该互相清掉对方的标记
    expect(events).toContain("active:on:t1:正在读取页面");
    expect(events).toContain("active:on:t1:正在点击 e1");
    expect(activeByTab.get("t1")).toBe(0);
  });

  it("只读工具的 name 与 label 一致，且描述说清了「什么时候用 / 不要用」", () => {
    const { automation } = trackingAutomation();
    const tools = createBrowserTools(automation);

    for (const name of [
      BROWSER_TOOL_NAMES.snapshot,
      BROWSER_TOOL_NAMES.logs,
      BROWSER_TOOL_NAMES.screenshot,
      BROWSER_TOOL_NAMES.wait,
      BROWSER_TOOL_NAMES.open,
      BROWSER_TOOL_NAMES.act,
      BROWSER_TOOL_NAMES.dialog,
    ]) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool, `缺少工具 ${name}`).toBeTruthy();
      expect(tool?.name).toBe(name);
      expect(tool?.description).toContain("When to use it");
      expect(tool?.description).toContain("When NOT to use it");
    }
  });

  it("每个工具的参数里都有 tab（模型学会多标签的唯一入口）", () => {
    const { automation } = trackingAutomation();
    const tools = createBrowserTools(automation);

    for (const tool of tools) {
      const schema = tool.parameters as { properties?: Record<string, unknown> };
      expect(schema.properties?.tab, `${tool.name} 缺 tab 参数`).toBeTruthy();
    }
  });

  it("browser_wait 超时：文案里同时给出「超时了多久」与当前现状 detail", async () => {
    const { automation } = trackingAutomation({
      wait: { matched: false, waitedMs: 5000, detail: 'no element matches selector "#done"' },
    });
    const tools = createBrowserTools(automation);

    const text = await callText(tools, "browser_wait", { selector: "#done", timeoutMs: 5000 });

    // 超时分支是模型唯一的诊断来源：既要说明超时，也要带上现状，否则它只会盲目重试
    expect(text).toContain("Timed out");
    expect(text).toContain("5000ms");
    expect(text).toContain('no element matches selector "#done"');
    expect(text).toContain("Snapshot");
  });

  it("browser_logs network：空记录如实说「还没有记录」", async () => {
    const empty = trackingAutomation({
      network: { entries: [], total: 0, omitted: 0, bufferEmpty: true, noFailures: false },
    });
    const emptyText = await callText(createBrowserTools(empty.automation), "browser_logs", {
      type: "network",
    });
    expect(emptyText).toContain("No network requests have been recorded yet.");

    const { automation } = trackingAutomation();
    const text = await callText(createBrowserTools(automation), "browser_logs", {
      type: "network",
    });

    expect(text).toContain("POST");
    expect(text).toContain("500");
    expect(text).toContain("https://example.com/api/items");
    // status 为 0 = 没拿到响应：必须写成 failed，否则模型会把 0 当成状态码
    expect(text).toContain("failed");
    expect(text).toContain("net::ERR_CONNECTION_RESET");
  });

  it("noFailures：有记录但没有失败请求时不得说「还没有记录」，要报出条数", async () => {
    const { automation } = trackingAutomation({
      network: { entries: [], total: 23, omitted: 0, bufferEmpty: false, noFailures: true },
    });

    const text = await callText(createBrowserTools(automation), "browser_logs", {
      type: "network",
      failuresOnly: true,
    });

    expect(text).toContain("23");
    expect(text).toContain("none failed");
    expect(text).not.toContain("No network requests have been recorded yet.");
  });

  it("omitted：说明还有多少条记录没列出来（不给数字会让模型以为页面只发了这么多）", async () => {
    const { automation } = trackingAutomation({
      network: {
        entries: [
          {
            url: "https://example.com/x",
            method: "GET",
            status: 200,
            resourceType: "xhr",
            durationMs: 9,
            at: 1,
          },
        ],
        total: 93,
        omitted: 12,
        bufferEmpty: false,
        noFailures: false,
      },
    });

    const text = await callText(createBrowserTools(automation), "browser_logs", {
      type: "network",
    });

    expect(text).toContain("12 record(s) are not listed here");
    expect(text).toContain("showing the last 1 of 93");
  });

  it("dropped：说明已过滤多少条 Electron 自身噪音，增量语义不变", async () => {
    const noisy = trackingAutomation({
      console: {
        entries: [{ level: "error", text: "boom", source: "app.js", line: 3, at: 1 }],
        dropped: 5,
      },
    });
    const text = await callText(createBrowserTools(noisy.automation), "browser_logs", {
      type: "console",
    });
    expect(text).toContain("[error] boom (app.js:3)");
    expect(text).toContain("5 message(s) were filtered out");
    expect(text).toContain("Electron");

    // 一条新消息都没有、但噪音被过滤时：两条事实都要说
    const quiet = trackingAutomation({ console: { entries: [], dropped: 2 } });
    const quietText = await callText(createBrowserTools(quiet.automation), "browser_logs", {
      type: "console",
    });
    expect(quietText).toContain("No new console messages since the last read.");
    expect(quietText).toContain("2 message(s) were filtered out");
  });

  it("warnings / effect：unknown 明说「未做断言」，warnings 逐条列出，hit 不啰嗦", async () => {
    const tools = createBrowserTools(
      automationReturning("type", {
        name: "field",
        navigated: false,
        effect: "unknown",
        detail: "probe was not armed",
        warnings: ["input truncated at maxlength 10", "a page key handler also ran"],
      } satisfies BrowserActionOutcome),
    );

    const text = await callText(tools, "browser_act", { action: "type", ref: "e3", text: "hello" });

    expect(text).toContain("Effect: unknown");
    expect(text).toContain("NOT asserted to have landed");
    expect(text).toContain("probe was not armed");
    expect(text).toContain("Warning: input truncated at maxlength 10");
    expect(text).toContain("Warning: a page key handler also ran");

    // 默认的 hit 且没有告警时，成功文案保持原样（不加 Effect / Warning 行）
    const plain = createBrowserTools(trackingAutomation().automation);
    const plainText = await callText(plain, "browser_act", {
      action: "type",
      ref: "e3",
      text: "hi",
    });
    expect(plainText).not.toContain("Effect:");
    expect(plainText).not.toContain("Warning:");
  });

  it("STALE_REF：首行给出工具名与错误码，末句让模型重新 snapshot（不谎报成功）", async () => {
    const tools = createBrowserTools(
      automationThrowing(
        "click",
        browserFailure("STALE_REF", "元素 e9 已从 DOM 移除（页面重渲染）", {
          ref: "e9",
          generation: 3,
        }),
      ),
    );

    const text = await callError(tools, "browser_act", { action: "click", ref: "e9" });

    // 首行是「工具名 失败（错误码）：原因」，模型据此一眼看出这是哪一类失败
    expect(text).toContain("browser_act 失败（STALE_REF）：元素 e9 已从 DOM 移除");
    // detail 逐字段列出：ref / generation 都在
    expect(text).toContain("- ref: e9");
    expect(text).toContain("- generation: 3");
    expect(text).toContain("下一步：");
    expect(text).toContain("browser_snapshot");
  });

  it("UNAVAILABLE：说明没就绪，并给出「先 browser_open」这条路", async () => {
    const tools = createBrowserTools(
      automationThrowing(
        "click",
        browserFailure("UNAVAILABLE", "还没有打开任何浏览器标签。", { viewport: { w: 0, h: 0 } }),
      ),
    );

    const text = await callError(tools, "browser_act", { action: "click", ref: "e1" });

    expect(text).toContain("browser_act 失败（UNAVAILABLE）");
    expect(text).toContain("- viewport: 0×0");
    expect(text).toContain("browser_open");
    expect(text).toContain("browser_evaluate");
  });

  it("WRONG_TARGET：detail 渲染命中者（tag/id/class）与视口尺寸，下一步给 Escape / evaluate", async () => {
    const tools = createBrowserTools(
      automationThrowing(
        "click",
        browserFailure("WRONG_TARGET", "事件被 div.overlay 收走了，目标按钮没收到", {
          ref: "e5",
          hitRef: "e7",
          elementAtPoint: { tag: "div", id: "modal", cls: "overlay shadow" },
          viewport: { width: 1280, height: 0 },
          events: 0,
        }),
      ),
    );

    const text = await callError(tools, "browser_act", { action: "click", ref: "e5" });

    expect(text).toContain("browser_act 失败（WRONG_TARGET）");
    expect(text).toContain("- ref: e5");
    expect(text).toContain("- hitRef: e7");
    expect(text).toContain("- elementAtPoint: div#modal.overlay.shadow");
    expect(text).toContain("- viewport: 1280×0");
    expect(text).toContain("- events: 0");
    expect(text).toContain("Escape");
    expect(text).toContain("browser_evaluate");
  });

  it("标签不存在（NOT_FOUND）时的下一步：用 browser_open 打开或新建", async () => {
    const tools = createBrowserTools(
      automationThrowing("click", browserFailure("NOT_FOUND", "没有标签 t9。", { tabId: "t9" })),
    );

    const text = await callError(tools, "browser_act", { action: "click", ref: "e1", tab: "t9" });

    expect(text).toContain("NOT_FOUND");
    expect(text).toContain("browser_open");
  });
});
