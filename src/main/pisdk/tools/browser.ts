import type { JsonRepresentation } from "@earendil-works/chord";
import type { ToolRegistration } from "@earendil-works/pi-durable";
// 内置浏览器工具：让模型自己操作右侧栏里那些浏览器标签。
//
// 与其它自建工具的差异：它们操作的是**主进程持有的 guest WebContents**
//（见 main/browser/service.ts），而不是会话的工作目录。所以：
//   · 不进 exec-env 的路径守卫 —— 浏览器读的是网页，不是工作区文件；
//   · 状态是主进程单例（多标签），工具只按 tabId 指定目标。
//
// 依赖经参数注入（BrowserAutomation）而不是 import 具体实现：service.ts 依赖 electron，
// 而这个文件要能在 node 环境的单测里跑（假实现即可，见 browser.test.ts）。
//
// **工具只有九个**（原先十四个）。合并的口径是按「问题」分而不是按「事件」分：
// click / type / press / hover / select / scroll 六种动作的参数天然互斥，
// 合进 browser_act 的一个 action 字段；console / network 两种读取合进 browser_logs 的 type。
// 每个工具都接受可选的 `tab`（作用于哪个标签），输出里也带当前标签身份 ——
// 用户可能同时开着好几个标签，模型必须能把动作指到对的那个上。
//
// 权限分级（见 permissions.ts，名单常量在 shared/contracts/browser.ts）：
//   · snapshot / logs / screenshot / wait 是只读的 → LOW_RISK_TOOLS，模型可以自由地「先看一眼」；
//   · open / history / act / dialog / evaluate 会改变页面状态或执行代码 → high，逐次审批。
//
// 工具文案用英文，与内核四件套、todo、jobs 一致；面向维护者的注释是中文。

import { type Static, Type } from "typebox";
import {
  BROWSER_TOOL_NAMES,
  type BrowserConsoleReport,
  type BrowserDialogPolicy,
  type BrowserErrorCode,
  type BrowserNetworkReport,
  type BrowserPageState,
  type BrowserSnapshot,
  type BrowserWaitResult,
} from "@/shared/contracts/browser";
import type {
  BrowserActionOutcome,
  BrowserAutomation,
  BrowserNetworkQuery,
  BrowserOptionMatch,
  BrowserTabOperations,
  BrowserWaitOptions,
} from "../../browser/types";

/** 快照文本回填给模型的上限：与页面侧脚本的上限一致，这里只做二次兜底 */
const SNAPSHOT_TEXT_LIMIT = 6000;
/** 控制台回填条数上限 */
const CONSOLE_LIMIT = 100;

/** 网络记录回填条数上限：取最近 N 条（网络是「回头看」的读取，不增量） */
const NETWORK_LIMIT = 80;

/**
 * 已知错误码的运行时副本（冻结）。
 *
 * 类型只在编译期存在，工具层要在运行时判断「这个错误是不是带码的浏览器失败」，
 * 所以必须有一份值。这里刻意不 import 具体类（src/main/browser/errors.ts）：
 *   1. 工具层与主进程实现按**结构**识别（有 code 且在名单内）能让两侧各自独立落地，
 *      也把 electron 侧的依赖挡在 node 单测之外；
 *   2. detail 的键是开放集合（命中者 / 视口 / ref…），字段名不该固化进工具层。
 */
const BROWSER_ERROR_CODES: readonly BrowserErrorCode[] = [
  "UNKNOWN_REF",
  "STALE_REF",
  "REF_DRIFT",
  "NO_EFFECT",
  "WRONG_TARGET",
  "BLOCKED",
  "NOT_FOUND",
  "UNAVAILABLE",
  "INVALID_ARGUMENT",
  "TOOL_FAILED",
];

/** 主进程抛出的浏览器失败：code 决定「下一步怎么办」，detail 决定诊断信息 */
interface BrowserFailure {
  code: BrowserErrorCode;
  message: string;
  detail?: Record<string, unknown>;
}

/** 把任意错误识别成 BrowserFailure；不是就返回 undefined（原样上抛，行为不变） */
function asBrowserFailure(error: unknown): BrowserFailure | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as { code?: unknown; message?: unknown; detail?: unknown };
  if (typeof candidate.code !== "string") return undefined;
  if (!(BROWSER_ERROR_CODES as readonly string[]).includes(candidate.code)) return undefined;
  const detail =
    typeof candidate.detail === "object" && candidate.detail !== null
      ? (candidate.detail as Record<string, unknown>)
      : undefined;
  return {
    code: candidate.code as BrowserErrorCode,
    message: typeof candidate.message === "string" ? candidate.message : String(error),
    ...(detail === undefined ? {} : { detail }),
  };
}

/**
 * detail 的一个值 → 一行可读文本。
 *
 * 命中者与视口是诊断遮挡 / 零尺寸这两类故障的关键字段，给它们专有写法，
 * 比丢一段 JSON 更容易被模型读对（`div#modal.overlay` / `0×0`）。
 */
function formatDetailValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.tag === "string") {
      const id = typeof record.id === "string" && record.id !== "" ? `#${record.id}` : "";
      const cls = record.cls ?? record.class;
      const classes =
        typeof cls === "string" && cls.trim() !== "" ? `.${cls.trim().split(/\s+/).join(".")}` : "";
      return `${record.tag}${id}${classes}`;
    }
    const width = record.w ?? record.width;
    const height = record.h ?? record.height;
    if (typeof width === "number" && typeof height === "number") return `${width}×${height}`;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/** 每种错误码的「下一步怎么办」：模型靠这一句决定是重试、重新快照还是换一条路 */
const FAILURE_NEXT_STEP: Record<BrowserErrorCode, string> = {
  UNKNOWN_REF: "这个 ref 不在任何快照里 —— 重新 browser_snapshot，用新清单里的 ref。",
  STALE_REF: "元素已被移除（页面重渲染过）—— 重新 browser_snapshot，再对新的 ref 操作。",
  REF_DRIFT: "节点还在但语义变了（框架复用了节点）—— 重新 browser_snapshot 核对目标后再操作。",
  NO_EFFECT:
    "动作发出但页面没有任何反应 —— 重新 browser_snapshot 看现状，并用 browser_logs 查原因。",
  WRONG_TARGET:
    '该位置被别的元素占据（浮层遮挡或坐标偏移）—— 先用 browser_act 的 press 动作发 "Escape" 关掉浮层，或改用 browser_evaluate 直接操作目标。',
  BLOCKED:
    "被浏览器策略拦下（弹窗 / 权限 / 导航白名单）—— 换个入口或先处理权限，别重试同一个动作。",
  NOT_FOUND:
    "目标不存在 —— 重新 browser_snapshot 确认页面上还有什么；标签不存在时用 browser_open 打开或新建一个。",
  UNAVAILABLE:
    "浏览器还没就绪（面板未布局 / 标签未挂载）—— 先用 browser_open 打开一个网址（它会自己把面板拉出来）后重试，或改用 browser_evaluate。",
  INVALID_ARGUMENT: "参数不合法 —— 按工具的 schema 修正参数后重试。",
  TOOL_FAILED: "操作失败但原因不明 —— 可原样重试一次；仍失败就重新 browser_snapshot 后换一种做法。",
};

/** 失败 → 给模型看的完整文本：错误码 / 详情 / 下一步 */
function formatBrowserFailure(tool: string, failure: BrowserFailure): string {
  const lines = [`${tool} 失败（${failure.code}）：${failure.message}`];
  if (failure.detail !== undefined && Object.keys(failure.detail).length > 0) {
    lines.push("详情：");
    for (const [key, value] of Object.entries(failure.detail)) {
      lines.push(`- ${key}: ${formatDetailValue(value)}`);
    }
  }
  lines.push(`下一步：${FAILURE_NEXT_STEP[failure.code]}`);
  return lines.join("\n");
}

/**
 * 失败渲染的唯一出口（在 withinTab 里统一调用）。
 *
 * 带 code 的失败换成可读文本再抛 —— 内核把抛出的文案作为工具结果回给模型；
 * 没有 code 的错误原样上抛，保持「参数校验错误 / 非浏览器错误」的既有形态。
 */
function decorateBrowserFailure(tool: string, error: unknown): unknown {
  const failure = asBrowserFailure(error);
  return failure === undefined ? error : new Error(formatBrowserFailure(tool, failure));
}

/**
 * 目标标签参数：每个浏览器工具都有它。
 *
 * 为什么值得做成一个共享常量而不是各写一遍：这句话就是模型学会「多标签怎么用」的
 * 唯一入口 —— 每个工具各讲一遍，迟早会讲岔；而漏讲的那个工具会让模型以为
 * 「这个工具只能作用于当前标签」。
 */
const tabParam = Type.Optional(
  Type.String({
    minLength: 1,
    description:
      'Which browser tab to act on, e.g. "t2". Take the id from the "Tab:" line of any previous browser result. ' +
      "Omit it to keep working in the tab you used last (the tool says which one that was).",
  }),
);

const openSchema = Type.Object({
  url: Type.String({
    minLength: 1,
    description:
      'The web address to open, e.g. "example.com" or "https://example.com/path?q=1". ' +
      "A missing scheme is completed to https. Only http and https are accepted.",
  }),
  newTab: Type.Optional(
    Type.Boolean({
      description:
        "true opens a new tab for this page instead of navigating the current one — use it to keep the " +
        "current page open (comparing two pages, following a link without losing your place).",
    }),
  ),
  tab: tabParam,
});

const historySchema = Type.Object({
  action: Type.Union([Type.Literal("back"), Type.Literal("forward"), Type.Literal("reload")], {
    description: '"back" / "forward" move through this tab\'s own history; "reload" refetches it.',
  }),
  tab: tabParam,
});

const snapshotSchema = Type.Object({ tab: tabParam });

/** browser_act 的七种动作：参数互斥，所以一个 action 字段就能讲清 */
const ACT_ACTIONS = ["click", "type", "press", "hover", "select", "scroll", "drag"] as const;
type ActAction = (typeof ACT_ACTIONS)[number];

const actSchema = Type.Object({
  action: Type.Union(
    [
      Type.Literal("click"),
      Type.Literal("type"),
      Type.Literal("press"),
      Type.Literal("hover"),
      Type.Literal("select"),
      Type.Literal("scroll"),
      Type.Literal("drag"),
    ],
    {
      description:
        "click {ref} or {x, y, button?, clicks?} | type {ref, text, submit?} | press {key, ref?} | " +
        "hover {ref} or {x, y} | select {ref, value|label|index} | scroll {deltaY, deltaX?} | " +
        "drag {fromX, fromY, toX, toY}",
    },
  ),
  ref: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        'Element ref from the most recent browser_snapshot, e.g. "e12". Required for type / select, and for ' +
        "click / hover unless x and y are given instead; optional for press (given, the element is clicked " +
        "first to move focus onto it). Prefer the ref: it locates the element, scrolls it into view and " +
        "verifies that the event reached it. Use x / y only where a ref cannot work (canvas, image maps, " +
        "page-drawn overlays).",
    }),
  ),
  x: Type.Optional(
    Type.Number({
      description:
        "For click / hover without a ref: x in viewport pixels (the x of an element in the latest snapshot, " +
        "or a position measured on a screenshot). Must be inside the current viewport — coordinate actions " +
        "do not scroll, so scroll and snapshot again first when the target is off-screen.",
    }),
  ),
  y: Type.Optional(
    Type.Number({
      description: "For click / hover without a ref: y in viewport pixels, same rules as x.",
    }),
  ),
  button: Type.Optional(
    Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")], {
      description: 'For a coordinate click: which mouse button. Default "left".',
    }),
  ),
  clicks: Type.Optional(
    Type.Union([Type.Literal(1), Type.Literal(2)], {
      description:
        "For a coordinate click: 1 = single click, 2 = double click (for zoom, text selection, map " +
        "double-tap zoom). Default 1.",
    }),
  ),
  fromX: Type.Optional(
    Type.Number({ description: "For drag: x of the start point, in viewport pixels." }),
  ),
  fromY: Type.Optional(
    Type.Number({ description: "For drag: y of the start point, in viewport pixels." }),
  ),
  toX: Type.Optional(
    Type.Number({ description: "For drag: x of the end point, in viewport pixels." }),
  ),
  toY: Type.Optional(
    Type.Number({ description: "For drag: y of the end point, in viewport pixels." }),
  ),
  text: Type.Optional(
    Type.String({
      description:
        "For type: the text to put into the field. Any existing content in it is replaced.",
    }),
  ),
  submit: Type.Optional(
    Type.Boolean({
      description:
        "For type: true presses Enter after typing (search boxes, login forms). Default false.",
    }),
  ),
  key: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        'For press: the key, e.g. "Enter", "Escape", "Tab", "ArrowDown", "PageDown", "Control+A", "Shift+Tab". ' +
        'Names follow KeyboardEvent.key; a modifier combination is written with "+".',
    }),
  ),
  value: Type.Optional(
    Type.String({
      description: 'For select: program value of the option, e.g. "us" (what the form submits).',
    }),
  ),

  label: Type.Optional(
    Type.String({
      description: 'For select: the option text as the user sees it, e.g. "United States".',
    }),
  ),
  index: Type.Optional(
    Type.Number({
      minimum: 1,
      description: "For select: 1-based position of the option in the list (1 = the first option).",
    }),
  ),
  deltaY: Type.Optional(
    Type.Number({
      description:
        "For scroll: pixels to scroll down (negative scrolls up), e.g. 600 for about one screen.",
    }),
  ),
  deltaX: Type.Optional(
    Type.Number({
      description: "For scroll: pixels to scroll right (negative scrolls left). Default 0.",
    }),
  ),
  tab: tabParam,
});

const waitSchema = Type.Object({
  text: Type.Optional(
    Type.String({
      description:
        "Wait until this text appears on the page (case-insensitive substring match). Use it when the page " +
        "has no stable selector to wait for.",
    }),
  ),
  selector: Type.Optional(
    Type.String({
      description: 'Wait until this CSS selector matches a visible element, e.g. "#results .row".',
    }),
  ),
  ms: Type.Optional(
    Type.Number({
      minimum: 0,
      description:
        "Wait this many milliseconds instead of waiting for something to appear (max 30000).",
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Number({
      minimum: 0,
      description:
        "How long to wait for text / selector before giving up, in milliseconds. Default 5000, max 30000. " +
        "Ignored when ms is given.",
    }),
  ),
  tab: tabParam,
});

const screenshotSchema = Type.Object({ tab: tabParam });

/** browser_logs：两种读取视图（原先的 browser_console / browser_network） */
const logsSchema = Type.Object({
  type: Type.Union([Type.Literal("console"), Type.Literal("network")], {
    description:
      '"console" for script output and uncaught errors (incremental read); ' +
      '"network" for the requests the page made (full buffered list).',
  }),
  failuresOnly: Type.Optional(
    Type.Boolean({
      description:
        "network only: true returns just failed requests and 4xx/5xx responses. Default false.",
    }),
  ),
  clear: Type.Optional(
    Type.Boolean({
      description:
        "network only: true empties the buffer before returning, so the list measures only what happens " +
        "from now on. Default false.",
    }),
  ),
  tab: tabParam,
});

const dialogSchema = Type.Object({
  action: Type.Union([Type.Literal("accept"), Type.Literal("dismiss")], {
    description:
      '"accept" clicks OK, "dismiss" clicks Cancel / closes. Stays in effect for every later dialog of this ' +
      "tab until changed.",
  }),
  tab: tabParam,
});

const evaluateSchema = Type.Object({
  code: Type.String({
    minLength: 1,
    description:
      "JavaScript to run in the page. The last expression's value is returned as JSON. " +
      "Use it only when the snapshot cannot answer the question (e.g. a page variable or a computed style).",
  }),
  tab: tabParam,
});

const OPEN_DESCRIPTION =
  "Open a web address in the built-in browser in the right sidebar. The panel opens by itself — do not ask the user to open it.\n\n" +
  "When to use it: to reach a page before reading or interacting with it (sites the user asked about, docs, dashboards).\n" +
  "When NOT to use it: when a page is already open and you only need its content (use browser_snapshot); " +
  "to fetch a URL whose text is just data — this drives a real browser window the user is watching.\n\n" +
  "Notes: only http/https addresses work. With newTab: true a new tab opens (use it to keep the current page " +
  "and compare); without it the current tab navigates away. The result names the tab and the open-tab list — " +
  "pass that id as `tab` to the other browser tools whenever more than one is open.\n" +
  "Output: the tab, its url and title. A load error may be reported for the url while the page still shows content.";

const HISTORY_DESCRIPTION =
  "Move a browser tab through its own history: back, forward, or reload.\n\n" +
  "When to use it: after following a link you want to come back from; to retry a page that failed to load; " +
  "to refresh data after the user changed something outside the page.\n" +
  "When NOT to use it: to reach a known url (use browser_open); to change what the page shows " +
  "(use browser_act).\n\n" +
  "Output: the tab, its url and title; a failure message when there is nothing to go back or forward to.";

const SNAPSHOT_DESCRIPTION =
  "Read a page: its visible text plus the list of interactive elements (buttons, links, inputs) with a `ref` for each.\n\n" +
  "When to use it: first thing after browser_open, and again after every action that can change the page — " +
  "it is the only reliable way to know what is currently on screen.\n" +
  "When NOT to use it: when you only need to know whether the page finished loading " +
  "(browser_open already reports that).\n\n" +
  `Output: the tab, url, title, the visible text (truncated at ${SNAPSHOT_TEXT_LIMIT} characters), and elements as ` +
  'lines of `ref role "name" … @ x,y` in document order, where x,y is the element centre in viewport pixels at ' +
  "the moment of this snapshot (use it for coordinate clicks on targets a ref cannot reach; it expires as soon as " +
  "the page scrolls). Refs are valid only for this snapshot: after the page changes, snapshot again before acting.\n" +
  "The text is what the user sees: it does not include hidden menus, collapsed sections, or content behind a click.";

const ACT_DESCRIPTION =
  "Act on a page: click, type, press, hover, select, scroll, or drag.\n\n" +
  "When to use it: to change what the page shows — follow a link, fill and submit a form, open a menu, pick a " +
  "dropdown option, or scroll to content that is below the fold.\n" +
  "Pick the action and give its arguments:\n" +
  "  · click {ref} — follow a link, press a button, tick a box, open a menu, submit a filled-in form.\n" +
  "  · click {x, y, button?, clicks?} — click a position instead of an element: canvas / WebGL apps, image maps, " +
  "maps and charts, or anything the page draws itself. clicks: 2 is a double click; button right/middle opens " +
  "context menus and middle-click behaviour.\n" +
  "  · type {ref, text, submit?} — replace the content of a field; submit: true presses Enter right after " +
  "(search boxes, login forms).\n" +
  '  · press {key, ref?} — a key or combination ("Enter", "Escape", "Tab", "PageDown", "Control+A"); with a ref ' +
  "the element is clicked first to put focus on it.\n" +
  "  · hover {ref} or {x, y} — move the mouse over a target to open a hover menu / tooltip; snapshot again to see " +
  "what appeared.\n" +
  "  · select {ref, exactly one of value / label / index} — choose an option of a real <select> dropdown.\n" +
  "  · scroll {deltaY, deltaX?} — wheel-scroll the page at the viewport centre (positive = down); use it to reach " +
  "content that is below the fold.\n" +
  "  · drag {fromX, fromY, toX, toY} — press at one point, move through the path and release at another: sliders, " +
  "map panning, canvas drawing, drag-and-drop reordering.\n\n" +
  "Coordinates are viewport pixels — take the `@ x,y` at the end of a snapshot element line, or measure on a " +
  "browser_screenshot. They are only valid for the moment they were taken: after the page scrolls or reflows, " +
  "snapshot again. Coordinate actions do not scroll for you, and a point outside the current viewport is rejected.\n\n" +
  "Prefer a ref whenever one exists: a ref locates the element, scrolls it into view and verifies the event " +
  "reached it (WRONG_TARGET when an overlay swallowed the click). A coordinate click has no such knowledge — it " +
  "only reports which element received it, so read that back and check it is the one you meant.\n\n" +
  "When NOT to use it: on an element you have not just seen in a snapshot (the page may have re-rendered and the " +
  "ref gone stale); to read what a field holds (the snapshot reports it).\n\n" +
  "Notes: every action is a real input event followed by a page-side check — when the page shows no reaction the " +
  "call fails with NO_EFFECT instead of pretending success, and a ref click whose coordinates land on a different " +
  'element fails with WRONG_TARGET rather than clicking the wrong thing. Press "Escape" to close an overlay that ' +
  "is blocking a target.\n" +
  "Output: what was acted on (for a coordinate action: which element received it) and whether the interaction " +
  "caused a navigation. Snapshot again to see the result.";

const WAIT_DESCRIPTION =
  "Wait until the page shows a piece of text or an element, or for a fixed number of milliseconds.\n\n" +
  "When to use it: the number one problem with single-page apps is that an action returns before its content is " +
  "rendered, so a snapshot taken right after it shows an empty shell. Wait for the outcome instead — a text that " +
  "only appears once data arrives, or a container selector. text matches case-insensitively as a substring, " +
  "which is what you need when the page has no stable selector (class names are build hashes).\n" +
  "When NOT to use it: as a substitute for looking — snapshot first to see whether the page is loading at all, " +
  "and re-check with browser_logs type network when you want to know whether a request finished.\n\n" +
  "Notes: give exactly one of text / selector / ms. timeoutMs (default 5000) applies only to text and selector; " +
  "both it and ms are capped at 30000.\n" +
  "Output: whether the condition was met and how long it took. On timeout the message also says what the page " +
  "looked like at that moment — read it before retrying.";

const SCREENSHOT_DESCRIPTION =
  "Take a picture of the visible part of a browser tab and look at it.\n\n" +
  "When to use it: when the answer depends on how the page looks rather than on its text — a chart, a captcha, " +
  "a layout problem, whether something is visually hidden or overlapped.\n" +
  "When NOT to use it: as a substitute for browser_snapshot — the screenshot shows only the visible viewport, " +
  "contains no element refs, and costs far more tokens than the text.\n\n" +
  "Output: a PNG image of the current viewport.";

const LOGS_DESCRIPTION =
  "Read what a page reported: its console messages (type: console) or its network requests (type: network).\n\n" +
  "When to use it: a page is blank or a button did nothing and you need to tell a script error apart from " +
  "nothing happening at all (console), or an API returning 500 apart from a request that was never sent (network); " +
  "after browser_evaluate to see whether the code you ran logged anything; after browser_dialog to read what a " +
  "dialog said.\n" +
  "When NOT to use it: to read the page content (use browser_snapshot).\n\n" +
  "Notes: console is an incremental read — each call returns only the messages added since the previous call " +
  "(and says so when there are none), so it is the right tool for watching a flow step by step. network is the " +
  "opposite: every call returns the whole buffered list, so calling it twice shows the same requests twice; pass " +
  "clear: true to measure only what happens from now on, or failuresOnly: true to narrow it to failures and 4xx/5xx.\n" +
  'Output: one line per message as "[level] text (source:line)" / per request as "METHOD status url (type, Nms)".';

const DIALOG_DESCRIPTION =
  "Set how a browser tab answers JavaScript dialogs (alert / confirm).\n\n" +
  "When to use it: a flow shows a confirmation dialog you need to accept; set accept before triggering it.\n" +
  "When NOT to use it: as a one-off answer — this sets a policy for that tab, not for the dialog that is about " +
  "to appear, and it stays in effect until you change it again. The content of each dialog is logged to the " +
  "console (level=warning); read it with browser_logs type console.\n\n" +
  "Notes: a JS dialog blocks the page's renderer — while nobody answers it the page is completely stuck and " +
  "every later operation times out. The built-in browser therefore dismisses dialogs automatically by default, " +
  'so a page is never stuck; use accept for the flows that need "OK". `prompt()` is not supported by the ' +
  "built-in browser at all: a page calling it throws immediately (visible in the console), and there is no way " +
  "to type into it.\n" +
  "Output: the policy now in effect, and how many dialogs have been answered automatically since this tool was " +
  "last called.";

const EVALUATE_DESCRIPTION =
  "Run a piece of JavaScript in the page and get its value back as JSON.\n\n" +
  "When to use it: the escape hatch for questions the snapshot cannot answer — reading a page variable, " +
  "a computed style, a data attribute, or a small calculation over the DOM.\n" +
  "When NOT to use it: for anything browser_snapshot already reports (text, links, form values) — " +
  "those are cheaper and cannot break the page. Do not use it to fetch other URLs.\n\n" +
  "Notes: the code runs in the page's own context, so it can see the page's globals and the DOM; " +
  "it cannot reach Node or this app. Promise results are awaited. The value must be JSON-serialisable.\n" +
  "Output: the JSON value, or the error message if the code threw.";

/**
 * 标签身份那一行：每个结果的第一个信息。
 *
 * 多标签下「我刚操作的是哪一个」是后续所有 `tab` 参数的唯一来源，
 * 所以哪怕只有一个标签也照给 —— 模型不必去记「什么时候会有这一行」。
 */
function tabLine(automation: BrowserAutomation, tabId: string): string {
  const tabs = automation.listTabs();
  if (tabs.length <= 1) return `Tab: ${tabId}`;
  return `Tab: ${tabId} (open tabs: ${tabs.map((tab) => tab.tabId).join(", ")})`;
}

/** 快照 → 给模型看的文本：文本在前、元素清单在后（元素才是下一步要用的） */
function formatSnapshot(snapshot: BrowserSnapshot): string {
  const lines: string[] = [`Page: ${snapshot.title === "" ? "(untitled)" : snapshot.title}`];
  lines.push(`URL: ${snapshot.url === "" ? "(none)" : snapshot.url}`);
  if (typeof snapshot.generation === "number") {
    lines.push(`Snapshot generation: ${snapshot.generation} — refs are only valid for this one.`);
  }
  if (
    snapshot.viewport !== undefined &&
    (snapshot.viewport.width === 0 || snapshot.viewport.height === 0)
  ) {
    lines.push(
      `Viewport: ${snapshot.viewport.width}×${snapshot.viewport.height} — the panel is not laid out, ` +
        "so coordinate input (the click / type / press / hover / select / scroll actions) cannot be delivered. " +
        "Ask the user to expand the browser panel, or use browser_evaluate.",
    );
  }

  const text =
    snapshot.text.length > SNAPSHOT_TEXT_LIMIT
      ? `${snapshot.text.slice(0, SNAPSHOT_TEXT_LIMIT)}…`
      : snapshot.text;
  lines.push("", "Visible text:", text === "" ? "(the page shows no text)" : text);

  lines.push("", `Interactive elements (${snapshot.elements.length}):`);
  if (snapshot.elements.length === 0) {
    lines.push("(none — the page may still be loading, or everything on it is plain text)");
  } else {
    /**
     * 元素行末尾的 `@ x,y` 是**中心点的视口坐标**（本次快照那一刻的值）。
     *
     * 为什么要印出来：canvas、图片热区、页面自绘的浮层在快照里没有可点的 ref，
     * 模型唯一能做的是按坐标点 —— 而坐标它自己量不出来（截图与视口未必同尺度）。
     * 成本是每行十来个字符，换来的是「这一类页面终于有把手」。
     *
     * 视口外的元素照样有坐标（快照不限定视口），所以同一个 x,y 可能是负数或超过视口 ——
     * 那正是「先滚动再点」的信号，工具描述里写着这条纪律。
     */
    for (const element of snapshot.elements) {
      const parts = [`- ${element.ref}`, element.role, `"${element.name}"`];
      if (element.type !== undefined) parts.push(`type=${element.type}`);
      if (element.value !== undefined) parts.push(`value="${element.value}"`);
      if (element.checked !== undefined) parts.push(element.checked ? "checked" : "unchecked");
      if (element.disabled === true) parts.push("disabled");
      if (element.href !== undefined) parts.push(`-> ${element.href}`);
      if (element.x !== undefined && element.y !== undefined) {
        parts.push(`@ ${element.x},${element.y}`);
      }
      lines.push(parts.join(" "));
    }
  }

  if (
    snapshot.omitted !== undefined &&
    (snapshot.omitted.elements > 0 || snapshot.omitted.textChars > 0)
  ) {
    const omitted: string[] = [];
    if (snapshot.omitted.elements > 0) omitted.push(`${snapshot.omitted.elements} element(s)`);
    if (snapshot.omitted.textChars > 0) {
      omitted.push(`${snapshot.omitted.textChars} text character(s)`);
    }
    lines.push(
      "",
      `(Omitted by the page limits: ${omitted.join(" and ")} — there is more on the page than listed above.)`,
    );
  }
  if (snapshot.truncated) {
    lines.push("", "(The page was longer than the limits above; this is a partial view.)");
  }
  return lines.join("\n");
}

/**
 * 控制台消息 → 给模型看的文本。
 *
 * dropped 是被过滤掉的来源（Electron 自身的安全警告等）：过滤该做，
 * 但必须让模型知道「少了的那几条不是页面没产生」。读取语义仍是增量 ——
 * 只报上次读取之后的新消息。
 */
function formatConsole(report: BrowserConsoleReport): string {
  const notes =
    report.dropped > 0
      ? [
          `(${report.dropped} message(s) were filtered out as noise from Electron itself, not the page.)`,
        ]
      : [];
  if (report.entries.length === 0) {
    return ["No new console messages since the last read.", ...notes].join("\n");
  }
  const shown = report.entries.slice(-CONSOLE_LIMIT);
  const lines = shown.map((entry) => {
    const where = entry.source === "" ? "" : ` (${entry.source}:${entry.line})`;
    return `[${entry.level}] ${entry.text}${where}`;
  });
  const header =
    report.entries.length > shown.length
      ? `Console messages (showing the last ${shown.length} of ${report.entries.length}):`
      : `Console messages (${report.entries.length}):`;
  return [header, ...notes, ...lines].join("\n");
}

/** 导航结果文案：open 与 history 都只回「到哪了」 */
function formatPageState(action: string, state: BrowserPageState): string {
  const notes = [`${action}: now at ${state.url === "" ? "(no page)" : state.url}`];
  if (state.title !== "") notes.push(`Title: ${state.title}`);
  if (state.loading) {
    notes.push("The page is still loading; snapshot again if it looks incomplete.");
  }
  if (state.error !== undefined) notes.push(`Load problem: ${state.error}`);
  return notes.join("\n");
}

/**
 * 网络记录 → 给模型看的文本。
 *
 * 三种事实必须分开说，否则模型没法据此决策：
 *   1. bufferEmpty —— 缓冲里一条记录都没有；
 *   2. noFailures —— 有记录但全都成功了。旧实现在这里回「还没有记录」，与事实相反，
 *      而模型正是靠这句话决定要不要继续等接口；
 *   3. omitted —— 有记录没列出来（展示上限），不给出数字会让模型以为「页面就发了这么多」。
 */
function formatNetwork(report: BrowserNetworkReport): string {
  if (report.bufferEmpty) return "No network requests have been recorded yet.";

  const shown = report.entries.slice(-Math.min(report.entries.length, NETWORK_LIMIT));
  const omitted = Math.max(0, report.omitted) + (report.entries.length - shown.length);
  const lines: string[] = [];

  if (report.noFailures) {
    lines.push(
      `Network requests: ${report.total} record(s), none failed — no request errored and none returned a 4xx/5xx status.`,
    );
  }

  if (shown.length === 0) {
    lines.push("Nothing to list for this read.");
  } else {
    lines.push(
      omitted > 0
        ? `Network requests (showing the last ${shown.length} of ${report.total}):`
        : `Network requests (${report.total}):`,
      'Each line is "METHOD status url (type, Nms)"; a failed line is a request that got no response.',
    );
    for (const entry of shown) {
      const status = entry.status === 0 ? "failed" : String(entry.status);
      const reason = entry.error === undefined || entry.error === "" ? "" : ` - ${entry.error}`;
      lines.push(
        `${entry.method} ${status} ${entry.url} (${entry.resourceType}, ${entry.durationMs}ms)${reason}`,
      );
    }
  }

  if (omitted > 0) {
    lines.push(
      `${omitted} record(s) are not listed here (only the most recent ${NETWORK_LIMIT} are shown).`,
    );
  }
  return lines.join("\n");
}

/**
 * 等待结果 → 给模型看的文本。
 *
 * 超时分支是重点：这是模型唯一能拿到「等的是什么、等了多久、现在页面什么样」的地方，
 * 少了它模型只会拿着同一个条件盲目重试。
 */
function formatWait(result: BrowserWaitResult): string {
  if (result.matched) return `Waited ${result.waitedMs}ms: ${result.detail}`;
  return (
    `Timed out after ${result.waitedMs}ms: ${result.detail}\n` +
    "The page may be slower than the timeout, or the text you are waiting for never renders. " +
    "Snapshot to see what is on the page now."
  );
}

/**
 * 动作成功 → outcome 里必须交代的两件事。
 *
 * effect 三态要区别对待：
 *   hit —— 探针确认事件落到了目标上，这是常态，不再多说（默认形态不变，不啰嗦）；
 *   unknown —— 探针不可用（注入失败等），**没有做任何断言**，绝不能读成「已验证命中」；
 *   no-effect —— 服务侧通常已把它转成 NO_EFFECT 抛错，真走到这里也要说清。
 * warnings 非空必须逐条列出（例如输入被 maxlength 截断），否则模型会把「部分生效」当成完全生效。
 */
function withActionNotes(text: string, outcome: BrowserActionOutcome): string {
  const notes: string[] = [];
  if (outcome.effect === "unknown") {
    notes.push(
      "Effect: unknown — the page-side check was not available, so this only says the action was dispatched; it is NOT asserted to have landed.",
    );
  } else if (outcome.effect === "no-effect") {
    notes.push("Effect: the page showed no reaction to this action.");
  }
  if (outcome.detail !== undefined && outcome.detail !== "") notes.push(outcome.detail);
  for (const warning of outcome.warnings ?? []) notes.push(`Warning: ${warning}`);
  return notes.length === 0 ? text : [text, ...notes].join("\n");
}

/**
 * 统一入口：解析目标标签 → 标记「模型正在操作这个标签」→ 跑动作 → 收口错误。
 *
 * 串行化在**服务侧按标签**做（同一标签上的「移鼠标 → 按下 → 抬起」不会被别的调用插进来；
 * 不同标签上的操作互不阻塞）。工具层不再自己排队 —— 那会让两个标签互相等，
 * 而模型一次点两个不同页面本来是完全安全的。
 *
 * 失败也在这里收口：主进程抛的 BrowserToolError 带 code/detail，统一渲染成
 * 「错误码 + 详情 + 下一步」；tool 参数就是首行要写的工具名（browser_act 等）。
 */
function withinTab<T>(
  automation: BrowserAutomation,
  tabId: string | undefined,
  note: string,
  tool: string,
  run: (ops: BrowserTabOperations) => Promise<T>,
): Promise<T> {
  let ops: BrowserTabOperations;
  try {
    ops = automation.tab(tabId);
  } catch (error) {
    return Promise.reject(decorateBrowserFailure(tool, error));
  }
  ops.setAgentActive(true, note);
  return run(ops)
    .catch((error: unknown) => {
      throw decorateBrowserFailure(tool, error);
    })
    .finally(() => {
      ops.setAgentActive(false);
    });
}

/** browser_act 的 select 动作：value / label / index 恰有一个 */
function pickOptionMatch(input: {
  value?: string;
  label?: string;
  index?: number;
}): BrowserOptionMatch {
  const given: string[] = [];
  if (input.value !== undefined) given.push("value");
  if (input.label !== undefined) given.push("label");
  if (input.index !== undefined) given.push("index");
  if (given.length !== 1) {
    throw new Error(
      `select 需要且只需要 value / label / index 中的一个（收到 ${given.length} 个：${given.join(", ") || "无"}）——` +
        "选中错误的项会把整张表单改坏，所以这里不做猜测。",
    );
  }
  if (input.value !== undefined) return { kind: "value", value: input.value };
  if (input.label !== undefined) return { kind: "label", label: input.label };
  if (input.index !== undefined) return { kind: "index", index: input.index };
  // 上面的计数已经保证三者恰有一个；这一行只是让类型收敛（TS 无法从计数推断解构结果）
  throw new Error("select 缺少选项参数");
}

/** browser_wait 的 text / selector / ms → BrowserWaitOptions（个数不对直接抛错） */
function pickWaitOptions(input: {
  text?: string;
  selector?: string;
  ms?: number;
  timeoutMs?: number;
}): BrowserWaitOptions {
  const given: string[] = [];
  if (input.text !== undefined) given.push("text");
  if (input.selector !== undefined) given.push("selector");
  if (input.ms !== undefined) given.push("ms");
  if (given.length !== 1) {
    throw new Error(
      `browser_wait 需要且只需要 text / selector / ms 中的一个（收到 ${given.length} 个：${given.join(", ") || "无"}）。`,
    );
  }

  const options: BrowserWaitOptions = {};
  if (input.text !== undefined) options.text = input.text;
  else if (input.selector !== undefined) options.selector = input.selector;
  else if (input.ms !== undefined) options.ms = input.ms;
  if (input.timeoutMs !== undefined) options.timeoutMs = input.timeoutMs;
  return options;
}

/** 面板提示条文案：wait 的三类目标互斥，说清这次在等什么 */
function waitNote(options: BrowserWaitOptions): string {
  if (options.text !== undefined) return "正在等待文字出现";
  if (options.selector !== undefined) return "正在等待元素出现";
  return "正在等待页面";
}

/** browser_act 面板提示条文案：一句话说清这次在做什么 */
function actNote(input: {
  action: ActAction;
  ref?: string;
  key?: string;
  x?: number;
  y?: number;
  clicks?: number;
  button?: string;
}): string {
  const at =
    input.x === undefined || input.y === undefined
      ? ""
      : `(${Math.round(input.x)}, ${Math.round(input.y)})`;
  switch (input.action) {
    case "click":
      if (input.ref === undefined) {
        if (input.clicks === 2) return `正在双击 ${at}`;
        if (input.button === "right") return `正在右键点击 ${at}`;
        if (input.button === "middle") return `正在中键点击 ${at}`;
        return `正在点击 ${at}`;
      }
      return `正在点击 ${input.ref}`;
    case "type":
      return `正在输入到 ${input.ref ?? ""}`;
    case "press":
      return `正在按键 ${input.key ?? ""}`;
    case "hover":
      return `正在悬停到 ${input.ref ?? at}`;
    case "select":
      return "正在选择下拉项";
    case "scroll":
      return "正在滚动页面";
    case "drag":
      return "正在拖拽";
  }
}

/**
 * click / hover 的坐标参数：**必须成对给出**。
 *
 * 只给一个就报错（而不是拿 0 补另一个）：补出来的落点是页面左上角 ——
 * 那上面通常是 logo 或「返回首页」，是最容易被误点的地方，
 * 而一次静默的错误点击比一次明确的参数错误贵得多。
 */
function pickPoint(
  input: { x?: number; y?: number },
  action: string,
): { x: number; y: number } | null {
  if (input.x === undefined && input.y === undefined) return null;
  if (input.x === undefined || input.y === undefined) {
    const missing = input.x === undefined ? "x" : "y";
    throw new Error(
      `${action} 的坐标要成对给出：x 与 y 缺一不可（现在缺 ${missing}）。` +
        "坐标只给一半时无法判断你想点哪里，补 0 会点成页面左上角。",
    );
  }
  if (!Number.isFinite(input.x) || !Number.isFinite(input.y)) {
    throw new Error(`${action} 的 x / y 必须是数字。`);
  }
  return { x: input.x, y: input.y };
}

/** drag 的起点 / 终点：四个参数必须齐全（缺一个就没有可用的落点） */
function pickDragPoint(
  input: { fromX?: number; fromY?: number; toX?: number; toY?: number },
  which: "from" | "to",
): { x: number; y: number } {
  const x = which === "from" ? input.fromX : input.toX;
  const y = which === "from" ? input.fromY : input.toY;
  if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(
      `drag 需要完整的 fromX / fromY / toX / toY（视口像素坐标），现在缺 ${which}X 或 ${which}Y。`,
    );
  }
  return { x, y };
}

/**
 * 坐标点击结果里的目标描述：**必须带上「谁收下了这次点击」**。
 *
 * ref 点击不需要这一句 —— 它本来就知道目标是谁，错了会报 WRONG_TARGET。
 * 坐标点击没有这个知识，所以「落点上报的是谁」是模型唯一能核对的东西：
 * 它给出的是 canvas 而模型以为点的是按钮，那就该换落点重来。
 */
function describePointClick(
  point: { x: number; y: number },
  input: { button?: string; clicks?: number },
  outcome: BrowserActionOutcome,
): string {
  const verb =
    input.clicks === 2
      ? "double-click at"
      : input.button === "right"
        ? "right-click at"
        : input.button === "middle"
          ? "middle-click at"
          : "at";
  const hit = outcome.name === "" ? "(no element reported receiving it)" : `on ${outcome.name}`;
  return `${verb} (${Math.round(point.x)}, ${Math.round(point.y)}) ${hit}`;
}

/**
 * 构造整套浏览器工具。
 *
 * automation 由调用方注入：生产是 getBrowserAutomation() 单例（工具与 IPC 共用一份状态），
 * 测试传假实现 —— 与 jobs / ask 的注入方式一致，工具自己不认识 Electron。
 */
export function createBrowserTools(automation: BrowserAutomation): ToolRegistration[] {
  const open: ToolRegistration<
    typeof openSchema,
    JsonRepresentation<{ state: BrowserPageState; tabId: string }>
  > = {
    name: BROWSER_TOOL_NAMES.open,

    description: OPEN_DESCRIPTION,
    parameters: openSchema,
    async execute(params: Static<typeof openSchema>) {
      try {
        const state = await automation.open(params.url, {
          ...(params.tab === undefined ? {} : { tabId: params.tab }),
          ...(params.newTab === true ? { newTab: true } : {}),
        });
        // open 会把目标设成「工作标签」，这里问一次它的身份，好让后续调用能指名道姓
        const tabId = automation.tab().tabId;
        return {
          output: [
            {
              type: "text",
              text: `${tabLine(automation, tabId)}\n${formatPageState("Opened", state)}`,
            },
          ],
          details: { state, tabId },
        };
      } catch (error) {
        throw decorateBrowserFailure(BROWSER_TOOL_NAMES.open, error);
      }
    },
  };

  const history: ToolRegistration<
    typeof historySchema,
    JsonRepresentation<{ state: BrowserPageState; tabId: string }>
  > = {
    name: BROWSER_TOOL_NAMES.history,

    description: HISTORY_DESCRIPTION,
    parameters: historySchema,
    async execute(params: Static<typeof historySchema>) {
      const label =
        params.action === "back" ? "后退" : params.action === "forward" ? "前进" : "刷新";
      return withinTab(
        automation,
        params.tab,
        `正在${label}`,
        BROWSER_TOOL_NAMES.history,
        async (ops) => {
          const state = await ops.history(params.action);
          return {
            output: [
              {
                type: "text",
                text: `${tabLine(automation, ops.tabId)}\n${formatPageState(params.action, state)}`,
              },
            ],
            details: { state, tabId: ops.tabId },
          };
        },
      );
    },
  };

  const snapshot: ToolRegistration<typeof snapshotSchema, JsonRepresentation<BrowserSnapshot>> = {
    name: BROWSER_TOOL_NAMES.snapshot,

    description: SNAPSHOT_DESCRIPTION,
    parameters: snapshotSchema,
    async execute(params: Static<typeof snapshotSchema>) {
      return withinTab(
        automation,
        params.tab,
        "正在读取页面",
        BROWSER_TOOL_NAMES.snapshot,
        async (ops) => {
          const result = await ops.snapshot();
          return {
            output: [
              {
                type: "text",
                text: `${tabLine(automation, ops.tabId)}\n${formatSnapshot(result)}`,
              },
            ],
            details: result,
          };
        },
      );
    },
  };

  const act: ToolRegistration<typeof actSchema, JsonRepresentation<BrowserActionOutcome>> = {
    name: BROWSER_TOOL_NAMES.act,

    description: ACT_DESCRIPTION,
    parameters: actSchema,
    async execute(params: Static<typeof actSchema>) {
      return withinTab(
        automation,
        params.tab,
        actNote(params),
        BROWSER_TOOL_NAMES.act,
        async (ops) => {
          const header = tabLine(automation, ops.tabId);
          switch (params.action) {
            case "click": {
              const point = pickPoint(params, "click");
              if (params.ref === undefined && point === null) {
                throw new Error(
                  "click 需要 ref（来自最近一次快照），或者 x 与 y 坐标（canvas / 图片热区这类没有 ref 的目标）。",
                );
              }
              if (params.ref !== undefined && point !== null) {
                throw new Error(
                  "click 的 ref 与 x/y 只能给一个：ref 会自己定位并滚动到位，坐标不会 —— " +
                    "同时给两个时无法判断你想按哪一个。",
                );
              }
              const outcome =
                point === null
                  ? await ops.click(params.ref as string)
                  : await ops.clickPoint(point.x, point.y, {
                      ...(params.button === undefined ? {} : { button: params.button }),
                      ...(params.clicks === undefined ? {} : { clicks: params.clicks }),
                    });
              const target =
                point === null
                  ? outcome.name === ""
                    ? (params.ref as string)
                    : `${params.ref} ("${outcome.name}")`
                  : describePointClick(point, params, outcome);
              const suffix = outcome.navigated
                ? "The page navigated; snapshot again to see the new content."
                : "The page did not navigate; snapshot again to see what changed.";
              const text = withActionNotes(`Clicked ${target}. ${suffix}`, outcome);
              return { output: [{ type: "text", text: `${header}\n${text}` }], details: outcome };
            }
            case "type": {
              if (params.ref === undefined) throw new Error("type 需要 ref（来自最近一次快照）。");
              if (params.text === undefined) throw new Error("type 需要 text。");
              const outcome = await ops.type(params.ref, params.text, params.submit === true);
              const target = outcome.name === "" ? params.ref : `${params.ref} ("${outcome.name}")`;
              const suffix = params.submit === true ? " and pressed Enter" : "";
              const text = withActionNotes(
                outcome.navigated
                  ? `Typed into ${target}${suffix}. The page navigated; snapshot again to see the result.`
                  : `Typed into ${target}${suffix}. The page did not navigate; snapshot again to confirm the field now holds the text.`,
                outcome,
              );
              return { output: [{ type: "text", text: `${header}\n${text}` }], details: outcome };
            }
            case "press": {
              if (params.key === undefined)
                throw new Error("press 需要 key（如 Enter / Escape / Control+A）。");
              const outcome = await ops.press(params.key, params.ref);
              const where =
                outcome.name === ""
                  ? ""
                  : ` on ${params.ref ?? "(the focused element)"} ("${outcome.name}")`;
              const text = withActionNotes(
                outcome.navigated
                  ? `Pressed ${outcome.keys}${where}. The page navigated; snapshot again to see the new content.`
                  : `Pressed ${outcome.keys}${where}. The page did not navigate; snapshot again to see what changed.`,
                outcome,
              );
              return { output: [{ type: "text", text: `${header}\n${text}` }], details: outcome };
            }
            case "hover": {
              const point = pickPoint(params, "hover");
              if (params.ref === undefined && point === null) {
                throw new Error(
                  "hover 需要 ref（来自最近一次快照），或者 x 与 y 坐标（canvas 这类没有 ref 的目标）。",
                );
              }
              if (params.ref !== undefined && point !== null) {
                throw new Error("hover 的 ref 与 x/y 只能给一个（同 click 的口径）。");
              }
              const outcome =
                point === null
                  ? await ops.hover(params.ref as string)
                  : await ops.hoverPoint(point.x, point.y);
              const target =
                point === null
                  ? outcome.name === ""
                    ? (params.ref as string)
                    : `${params.ref} ("${outcome.name}")`
                  : describePointClick(point, params, outcome);
              const suffix = outcome.navigated
                ? "The page navigated; snapshot again to see the new content."
                : "The page did not navigate; snapshot again to see what appeared.";
              const text = withActionNotes(`Hovered ${target}. ${suffix}`, outcome);
              return { output: [{ type: "text", text: `${header}\n${text}` }], details: outcome };
            }
            case "select": {
              if (params.ref === undefined)
                throw new Error("select 需要 ref（来自最近一次快照）。");
              const match = pickOptionMatch(params);
              const outcome = await ops.select(params.ref, match);
              const target = outcome.name === "" ? params.ref : `${params.ref} ("${outcome.name}")`;
              const suffix = outcome.navigated
                ? "The page navigated; snapshot again to see the new content."
                : "The page did not navigate; snapshot again to confirm the field now holds the selection.";
              const text = withActionNotes(
                `Selected "${outcome.label}" (value="${outcome.value}") in ${target}. ${suffix}`,
                outcome,
              );
              return { output: [{ type: "text", text: `${header}\n${text}` }], details: outcome };
            }
            case "scroll": {
              const deltaY = params.deltaY;
              if (typeof deltaY !== "number" || !Number.isFinite(deltaY) || deltaY === 0) {
                throw new Error("scroll 需要非零的 deltaY（正数向下、负数向上，600 约一屏）。");
              }
              const outcome = await ops.scroll(deltaY, params.deltaX ?? 0);
              const text = withActionNotes(
                `Scrolled ${deltaY > 0 ? "down" : "up"} ${Math.abs(deltaY)}px.`,
                outcome,
              );
              return { output: [{ type: "text", text: `${header}\n${text}` }], details: outcome };
            }
            case "drag": {
              const start = pickDragPoint(params, "from");
              const end = pickDragPoint(params, "to");
              const outcome = await ops.drag(start, end);
              const text = withActionNotes(
                `Dragged from (${Math.round(start.x)}, ${Math.round(start.y)}) to ` +
                  `(${Math.round(end.x)}, ${Math.round(end.y)})` +
                  `${outcome.name === "" ? "" : ` onto ${outcome.name}`}.` +
                  (outcome.navigated
                    ? " The page navigated; snapshot again to see the new content."
                    : " The page did not navigate; snapshot again (or browser_evaluate) to see whether the drag actually moved anything."),
                outcome,
              );
              return { output: [{ type: "text", text: `${header}\n${text}` }], details: outcome };
            }
          }
        },
      );
    },
  };

  const wait: ToolRegistration<typeof waitSchema, JsonRepresentation<BrowserWaitResult>> = {
    name: BROWSER_TOOL_NAMES.wait,

    description: WAIT_DESCRIPTION,
    parameters: waitSchema,
    async execute(params: Static<typeof waitSchema>) {
      const options = pickWaitOptions(params);
      return withinTab(
        automation,
        params.tab,
        waitNote(options),
        BROWSER_TOOL_NAMES.wait,
        async (ops) => {
          const result = await ops.wait(options);
          return {
            output: [
              { type: "text", text: `${tabLine(automation, ops.tabId)}\n${formatWait(result)}` },
            ],
            details: result,
          };
        },
      );
    },
  };

  const screenshot: ToolRegistration<typeof screenshotSchema> = {
    name: BROWSER_TOOL_NAMES.screenshot,

    description: SCREENSHOT_DESCRIPTION,
    parameters: screenshotSchema,
    async execute(params: Static<typeof screenshotSchema>) {
      return withinTab(
        automation,
        params.tab,
        "正在截图",
        BROWSER_TOOL_NAMES.screenshot,
        async (ops) => {
          const shot = await ops.screenshot();
          return {
            output: [
              {
                type: "text",
                text:
                  `${tabLine(automation, ops.tabId)}\n` +
                  `Screenshot of the visible viewport (${shot.width}×${shot.height}).` +
                  /**
                   * `warning` 必须进正文，不能只放进 details。
                   *
                   * 它是**非致命**的如实告警（见 BrowserScreenshot 的类型注释）：截图拿到了、
                   * 但内容可疑 —— 最典型的是刚挂载时那张全白图。模型只看得到 content，
                   * 而 details 只给渲染层用；漏掉这一句，模型就只能把纯白当成页面本来的样子。
                   */
                  (shot.warning === undefined ? "" : `\nWarning: ${shot.warning}`),
              },
              { type: "image", data: shot.data, mimeType: shot.mimeType },
            ],
            details: {
              width: shot.width,
              height: shot.height,
              tabId: ops.tabId,
              ...(shot.warning === undefined ? {} : { warning: shot.warning }),
            },
          };
        },
      );
    },
  };

  const logs: ToolRegistration<
    typeof logsSchema,
    JsonRepresentation<BrowserConsoleReport | BrowserNetworkReport>
  > = {
    name: BROWSER_TOOL_NAMES.logs,

    description: LOGS_DESCRIPTION,
    parameters: logsSchema,
    async execute(params: Static<typeof logsSchema>) {
      // 读缓冲本身不碰页面，但它也要走这条链：提示条与错误收口的口径必须一致
      return withinTab(
        automation,
        params.tab,
        params.type === "console" ? "正在读取控制台" : "正在读取网络记录",
        BROWSER_TOOL_NAMES.logs,
        async (ops) => {
          const header = tabLine(automation, ops.tabId);
          if (params.type === "console") {
            const report = await ops.console();
            return {
              output: [{ type: "text", text: `${header}\n${formatConsole(report)}` }],
              details: report,
            };
          }
          const query: BrowserNetworkQuery = {
            ...(params.failuresOnly === undefined ? {} : { failuresOnly: params.failuresOnly }),
            ...(params.clear === undefined ? {} : { clear: params.clear }),
          };
          const report = await ops.network(query);
          return {
            output: [{ type: "text", text: `${header}\n${formatNetwork(report)}` }],
            details: report,
          };
        },
      );
    },
  };

  const dialog: ToolRegistration<
    typeof dialogSchema,
    JsonRepresentation<Awaited<ReturnType<BrowserTabOperations["dialog"]>>>
  > = {
    name: BROWSER_TOOL_NAMES.dialog,

    description: DIALOG_DESCRIPTION,
    parameters: dialogSchema,
    async execute(params: Static<typeof dialogSchema>) {
      const policy: BrowserDialogPolicy = { action: params.action };
      return withinTab(
        automation,
        params.tab,
        "正在设置弹窗策略",
        BROWSER_TOOL_NAMES.dialog,
        async (ops) => {
          const outcome = await ops.dialog(policy);
          const text =
            `Dialogs in this tab are now answered automatically with "${outcome.policy.action}".\n` +
            `${outcome.handledSinceLastRead} dialog(s) were answered since the last time this tool was called. ` +
            "Their content is in the console (browser_logs type console).";
          return {
            output: [{ type: "text", text: `${tabLine(automation, ops.tabId)}\n${text}` }],
            details: outcome,
          };
        },
      );
    },
  };

  const evaluate: ToolRegistration<typeof evaluateSchema> = {
    name: BROWSER_TOOL_NAMES.evaluate,

    description: EVALUATE_DESCRIPTION,
    parameters: evaluateSchema,
    async execute(params: Static<typeof evaluateSchema>) {
      return withinTab(
        automation,
        params.tab,
        "正在页面内求值",
        BROWSER_TOOL_NAMES.evaluate,
        async (ops) => {
          const result = await ops.evaluate(params.code);
          const header = tabLine(automation, ops.tabId);
          const text = result.ok
            ? `${header}\n${result.value === "" ? "(the code returned nothing)" : result.value}`
            : `${header}\nThe code threw: ${result.error}`;
          return { output: [{ type: "text", text }], details: result };
        },
      );
    },
  };

  return [open, history, snapshot, act, wait, screenshot, logs, dialog, evaluate];
}
