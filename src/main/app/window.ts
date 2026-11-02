import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, type Session, session, shell } from "electron";
import { attachBrowserGuest, recordBrowserPopup } from "@/main/browser/service";
import { isPluginSurfaceUrl } from "@/main/plugins/surface-url";
import {
  claimSurfaceBySession,
  pluginSurfacePreload,
  surfaceArgumentsForUrl,
} from "@/main/plugins/surfaces";
import { isInsidePath, normalizePath } from "@/main/security/path-guard";
import { IPC } from "@/shared/contracts/ipc";

let mainWindow: BrowserWindow | null = null;

/** 供 IPC 处理器获取当前主窗口；窗口可能已销毁 */
export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

function notifyMaximized(win: BrowserWindow): void {
  if (!win.isDestroyed()) {
    win.webContents.send(IPC.window.onMaximizedChange, win.isMaximized());
  }
}

/**
 * 内置浏览器（<webview>）的安全策略。
 *
 * webviewTag 打开后，渲染层可以嵌入任意页面 —— 那是「浏览器」面板的功能，
 * 但也意味着 guest 的能力必须被收死。这里做三件事，缺一不可：
 *
 *   1. will-attach-webview：抹掉 guest 的 preload、关掉 nodeIntegration，
 *      强制 contextIsolation + sandbox。渲染层即使想给 webview 塞 preload 也塞不进来。
 *
 *      ⚠️ **插件界面是这条规则唯一的例外**：它们的 src 走 `oint-plugin://`，
 *      必须带上宿主给的 guest preload，否则页面拿不到 `window.oint`（见下）。
 *      例外只放行**我们自己指定的那个 preload 路径**，而不是"听渲染层的" ——
 *      `webPreferences.preload` 是从渲染层传进来的，照单全收等于把这条规则作废。
 *   2. did-attach-webview：把 guest 的 window.open / target="_blank" 全部拒掉 ——
 *      内置浏览器不该能自己弹新窗口（弹出来的是无人管理的裸窗口）。
 *   3. 同一个回调里把 guest 交给浏览器自动化服务：模型操作页面（导航 / 点击 /
 *      读 DOM / 截图）全靠那份 WebContents（见 main/browser/service.ts 的说明）。
 *      插件界面**不进**这条路：它不是"用户的浏览器"，不该被模型当成一个可操作的页面。
 *
 * 刻意**不做**域名 allow-list：面板是给人用的通用浏览器，限制域名会让它失去意义。
 * 真正的边界是「guest 没有 Node 能力、不能弹窗、拿不到我们的 preload」。
 * 注意 3 是**自动化**而非权限放宽：模型能读到的仅限于用户自己打开的页面。
 */
function hardenWebviews(win: BrowserWindow): void {
  win.webContents.on("will-attach-webview", (_event, webPreferences, params) => {
    /*
      插件界面的例外（见上面第 1 条）。
      判据是 **src 的 scheme**，而不是"渲染层有没有传 preload"：
      后者是渲染层说了算的，而这是权限边界。
    */
    // `params.src` 在类型上是 `string | undefined`（Electron 允许不写 src 的 webview）。
    // 不写 src 的 guest 一律按普通页面处理 —— 它不可能是插件界面
    const isPluginSurface = isPluginSurfaceUrl(params.src ?? "");
    if (isPluginSurface) {
      // 只认我们自己那一个路径：渲染层传别的值一律覆盖回去
      webPreferences.preload = pluginSurfacePreload();
      /*
        **启动参数也要一起补**（身份 / 显示名 / 主题）。

        窗口形态在创建时就把参数交给了 preload；而这里的 guest 是渲染层建的，
        补 preload 的时机只有这一处 —— 漏了参数的后果见 surfaceArgumentsForUrl 的说明：
        桥照常工作，但 `window.oint.info` 全是空串、主题回落到浅色。
      */
      const args = surfaceArgumentsForUrl(params.src ?? "");
      if (args !== undefined) webPreferences.additionalArguments = args;
    } else {
      delete webPreferences.preload;
    }
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
  });

  win.webContents.on("did-attach-webview", (_event, contents) => {
    /*
      插件界面**只登记归属、不进浏览器自动化**。

      ## 判据用「分区」而不是 `getURL()`（踩过）

      早先这里读 `contents.getURL()` 判 scheme，**而那个时刻它往往还是空的** ——
      `did-attach-webview` 在 guest 刚挂上时就触发，导航还没提交。
      于是插件面板走进了"普通 webview"那条路：归属永远不登记，
      页面里任何一次 `window.oint.*` 都被身份闸门挡掉，报
      「这个界面没有在宿主登记」。

      **而 session 在 attach 时一定就绪**（渲染层建元素时就设了 partition），
      它也正是"这个 webview 属于哪个插件"的权威来源 —— 存储隔离用的就是它。

      分叉仍然在主进程：渲染层可以撒谎（说"我是个普通 webview"），
      而 session 是 Electron 按 partition 给的，不是它说了算。
    */
    if (claimSurfaceBySession(contents)) {
      contents.setWindowOpenHandler(() => ({ action: "deny" }));
      return;
    }

    // 拒绝但不静默：页面上「用第三方账号登录」这类按钮走的正是 window.open，
    // 被拒后页面什么都不显示，看起来和「点击没生效」一模一样。把 URL 记进控制台
    // 缓冲（见 service.ts 的 recordBrowserPopup），模型读一次 console 就能分清。
    contents.setWindowOpenHandler(({ url: target }) => {
      recordBrowserPopup(contents, target);
      return { action: "deny" };
    });
    attachBrowserGuest(contents);
  });
}

/**
 * 内置浏览器 guest 的分区名。
 *
 * 与 BrowserPanel.tsx 里 `element.setAttribute("partition", ...)` 的那个字符串必须一致 ——
 * 权限处理器要装在**同一个** session 上才生效。两处各写一份时改一处就会静默失配
 *（症状是「权限阻挡悄悄没了」，而不会有任何报错）。
 */
const BROWSER_PARTITION = "persist:oint-browser";

/**
 * 放行的设备/浏览器权限。**不在表里的一律拒绝。**
 *
 * 只放两类，判据是「页面拿不到用户的数据，只是渲染行为不同」：
 *  - `fullscreen`：视频播放器的全屏按钮。禁掉它不会更安全，只会让页面看起来坏了；
 *  - `clipboard-sanitized-write`：网页上的「复制」按钮。**注意是 write 而不是 read** ——
 *    写剪贴板是页面往用户那边放东西，读剪贴板是页面把用户的东西拿走，两者不是一个量级。
 *
 * **刻意拒绝**（它们都能拿走真实数据或设备）：`media`（摄像头/麦克风）、`geolocation`、
 * `notifications`、`clipboard-read`、`display-capture`、`midi`、`idle-detection`、
 * `pointerLock`、`openExternal` 等。
 *
 * 为什么不能只是"不装处理器"：Electron 的默认行为**不是拒绝**。README 的缺口中列过
 * 这一条 —— 全仓曾 `grep setPermissionRequestHandler` 零命中，也就是说一个网页
 * 调 `getUserMedia` 时没有任何一处代码说过"不"。
 */
const ALLOWED_GUEST_PERMISSIONS: ReadonlySet<string> = new Set([
  "fullscreen",
  "clipboard-sanitized-write",
]);

/**
 * 给内置浏览器 guest 装权限门。
 *
 * guest 走独立分区（`persist:oint-browser`）且**不套应用自己的 CSP**（那是刻意的：
 * 给它套上会把用户要访问的页面弄坏，见 installContentSecurityPolicy 的说明）。
 * 于是"这个页面能拿到什么设备能力"就只剩这一处可以表达 —— 装在这里，默认拒绝。
 *
 * 两个处理器都要装，它们管的不是一件事：
 *  - `setPermissionRequestHandler`：页面**主动请求**某权限时问一句（`getUserMedia`）；
 *  - `setPermissionCheckHandler`：Electron **同步查询**当前是否已授权（API 可用性探测）。
 *    只装前者的话，某些页面的 `navigator.permissions.query` 仍会报 granted。
 *
 * ⚠️ 将来的插件界面表面走 `persist:oint-plugin-<id>` 分区，**会另装一个全拒绝的处理器**
 *（插件界面不需要任何设备能力，连 fullscreen 都不需要）。
 */
function restrictGuestPermissions(): void {
  const guest = session.fromPartition(BROWSER_PARTITION);

  guest.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(ALLOWED_GUEST_PERMISSIONS.has(permission));
  });

  guest.setPermissionCheckHandler((_contents, permission) =>
    ALLOWED_GUEST_PERMISSIONS.has(permission),
  );
}

/**
 * 渲染进程的 Content-Security-Policy。
 *
 * 为什么必须有：消息正文是**模型可控内容**，而渲染层是特权进程（持有 preload 桥）。
 * React 会转义文本、mermaid 那处 `dangerouslySetInnerHTML` 也实测过转义（见该文件顶部），
 * 但「每一处都恰好写对了」不是可依赖的性质 —— CSP 是这些之外唯一不依赖代码正确性的那层。
 *
 * 逐条口径：
 *  - `default-src 'self'`：默认只信自己。内联脚本、外部 CDN 一概不放。
 *  - `script-src 'self'`：**不写 'unsafe-inline' / 'unsafe-eval'**。构建产物是外部 .js，
 *    调色板与 mermaid 都不需要 eval（已核对依赖：beautiful-mermaid / shiki 零 eval）。
 *  - `style-src 'self' 'unsafe-inline'`：这条**必须放宽**。React 的 style 属性、
 *    xterm.js 与 shiki 的动态主题都会写行内样式，禁掉会让终端与代码高亮无法显示。
 *    行内样式的风险远低于行内脚本（不能执行代码），是可接受的取舍。
 *  - `img-src 'self' data: blob:`：消息里的图片以 dataUrl 形态传递（见 session.ts 的 ImagePart），
 *    终端与 mermaid 也会用到 blob。**刻意不含 http(s)** —— 否则模型在回复里写一个外链图片，
 *    渲染时就会带上 IP 与 referrer 去请求那个域，成为一条静默的外带信道。
 *  - `connect-src 'self'`：渲染层不直连外部服务（模型请求全在主进程，见 ipc/services.ts）。
 *  - `object-src 'none'` / `frame-src 'none'`：插件与 iframe 一律不用。
 *  - `base-uri 'self'`：防止 <base> 被注入后改写相对路径的解析目标。
 *  - `form-action 'none'`：应用里没有表单提交，堵掉「注入一个 form 把数据 POST 出去」。
 *
 * dev 与 prod 的差别有两处（都是**为 dev server 让路**，打包后自动收紧）：
 *
 *  1. `connect-src` 放行 dev server 与它的 HMR websocket；
 *  2. **dev 的 `script-src` 必须带 `'unsafe-inline'`** —— 这一条是踩坑后补的：
 *     `@vitejs/plugin-react` 在 dev 下会往 index.html 注入一段**行内** `<script type="module">`
 *     （React Refresh 的 preamble，见 plugin-react 的 `transformIndexHtml`），
 *     它没有 src、也没有哈希/nonce 可用。禁掉它 → preamble 不执行 →
 *     每个被转换过的组件模块都抛 `can't detect preamble` → **整页白屏**。
 *
 * 为什么不用上面报错里给的那个 sha256 哈希：preamble 的正文由插件版本与 `base` 拼出来，
 * 插件一升级哈希就变，而失效的表现又是「白屏 + 一条看不懂的 CSP 报错」——
 * 用哈希换来的严格性不值得这个维护陷阱。dev 是本机 127.0.0.1 的可信来源，
 * 且**打包产物（真正会跑模型内容的那份）依然不带 'unsafe-inline'**，这一点由单测钉住。
 *
 * 这里不按 URL 猜，而是由调用方把 devServerUrl 传进来 —— 打包后它就是 undefined，
 * 策略自动收紧，不需要维护两份字符串。
 */
export function buildContentSecurityPolicy(devServerUrl: string | undefined): string {
  const dev = devServerUrl === undefined || devServerUrl === "" ? null : new URL(devServerUrl);
  /** HMR 的 websocket 与 dev server 的 http 源；prod 下为空 */
  const devConnect = dev === null ? [] : [`${dev.origin}`, `ws://${dev.host}`, `wss://${dev.host}`];
  /** dev 的脚本来源：dev server 自身 + 行内（React Refresh preamble） */
  const devScript = dev === null ? [] : [dev.origin, "'unsafe-inline'"];

  return [
    "default-src 'self'",
    `script-src 'self'${devScript.map((source) => ` ${source}`).join("")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${devConnect.map((source) => ` ${source}`).join("")}`,
    "media-src 'self' data: blob:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
  ].join("; ");
}

/**
 * 把 CSP 作为**响应头**下发（而不是 index.html 里的 meta）。
 *
 * 选响应头的理由：meta 只覆盖它自己那个文档，而响应头对同一 session 的每个文档都生效；
 * 而且它不需要改构建产物 —— dev（vite server）与 prod（file://）共用同一段代码。
 *
 * 只给**主窗口与它的 session** 下发：webview guest 走的是独立分区（persist:oint-browser），
 * 那是「浏览器」，给它套应用自己的 CSP 会把用户要访问的页面弄坏。
 */
function installContentSecurityPolicy(session: Session, devServerUrl: string | undefined): void {
  const policy = buildContentSecurityPolicy(devServerUrl);
  session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [policy],
      },
    });
  });
}

/**
 * 主窗口的导航守卫。
 *
 * 为什么必须有：渲染层是**特权进程**（持有 preload 桥），而消息正文里的 Markdown 链接
 * 是模型可控内容、`<a>` 又没有 preventDefault（见 markdown-text.tsx 的 a 组件）。
 * 模型写一个 `[点我](...)`，用户点下去就能把整个应用窗口导航走 ——
 * 关键点是**新页面仍然带着 preload 桥**（导航不重载 preload），所以这不是「界面没了」，
 * 而是「任意页面拿到了 window.oint」。实测确认过这一点，别把它当成纯 UI 故障。
 *
 * 四条边界（缺一不可）：
 *  1. **导航目标必须逐字等于应用自己的页面**（见 isSelfUrl）；
 *  2. **重定向也要管**（will-redirect）—— 只拦 will-navigate 时，一个 302 就能绕过去；
 *  3. **window.open / target="_blank" 一律拒绝**：内置浏览器该在右侧面板里开，
 *     弹出来的裸窗口没人管（webview guest 也由 hardenWebviews 单独拒掉）；
 *  4. 拒绝而不是静默：外链交给系统浏览器打开，用户的意图仍然被满足。
 */
/**
 * 判断一个 URL 是不是**主窗口该待的地方**（应用自己那个页面）。
 *
 * **必须逐字比对，不能用协议前缀。** 这里踩过一次实测确认的坑：写成
 * `target.startsWith("file://")` 时，打包环境下的守卫退化成「任何本地文件都放行」——
 * 模型写一条 `[点我](file:///C:/Users/x/evil.html)`，用户一点就导航过去，
 * 而目标页面**照样拿得到 preload 桥**（导航不重载 preload），等价于把特权窗口交给模型。
 *
 * 规则：
 * - dev：与 vite dev server **同源**；
 * - 打包后：`file://` 且落在应用自己的 `dist/` 目录内（入口 index.html 与 assets/）。
 *
 * 抽成导出的纯函数是为了能直接单测 —— 这条判断是「模型可控链接」与「特权窗口」之间
 * 唯一的边界，而它此前**没有任何测试**，错成 `startsWith` 也没人会发现。
 */
export function isSelfUrl(
  target: string,
  options: { devServerUrl?: string; distDir: string },
): boolean {
  const { devServerUrl, distDir } = options;
  if (devServerUrl !== undefined && devServerUrl !== "") {
    try {
      return new URL(target).origin === new URL(devServerUrl).origin;
    } catch {
      return false;
    }
  }
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return false;
  }
  if (parsed.protocol !== "file:") return false;
  /**
   * **必须用 `fileURLToPath`，不能拿 `pathname` 直接 resolve。**
   *
   * Windows 上 `new URL("file:///D:/app/x").pathname` 是 `/D:/app/x`（多一个前导斜杠），
   * 而 `path.resolve("/D:/app/x")` 会得到 `D:\D:\app\x` —— 于是应用自己的 index.html
   * 反而匹配不上 dist/，守卫会把正常页面也拦掉。`fileURLToPath` 处理了盘符与百分号编码，
   * 正是为这个转换存在的。
   */
  let targetPath: string;
  try {
    targetPath = normalizePath(fileURLToPath(parsed));
  } catch {
    // 非法百分号编码 / 非本地文件 URL：当作不可信
    return false;
  }
  return isInsidePath(targetPath, normalizePath(distDir));
}

function guardMainWindowNavigation(win: BrowserWindow): void {
  const distDir = path.join(import.meta.dirname, "../dist");
  const selfUrl = (target: string): boolean =>
    isSelfUrl(target, {
      ...(process.env.VITE_DEV_SERVER_URL ? { devServerUrl: process.env.VITE_DEV_SERVER_URL } : {}),
      distDir,
    });

  /** 拦下一次导航：交系统浏览器打开，不在这里跳 */
  const blockNavigation = (event: Electron.Event, url: string): void => {
    event.preventDefault();
    // 只把 http(s) 交给系统浏览器：file:// 之类交给系统没有意义，还会变成另一个入口
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url).catch(() => undefined);
    }
  };

  win.webContents.on("will-navigate", (event, url) => {
    if (selfUrl(url)) return;
    blockNavigation(event, url);
  });

  /**
   * `will-redirect` 必须单独订阅：服务端 302 不经过 will-navigate，
   * 对它 `preventDefault()` 拦不住重定向本身。实测过：只挂 will-navigate 时，
   * 一个同源地址只要回 302 到外部域，窗口就会落在那上面。
   */
  win.webContents.on("will-redirect", (event, url) => {
    if (selfUrl(url)) return;
    blockNavigation(event, url);
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url).catch(() => undefined);
    }
    return { action: "deny" };
  });
}

export function createMainWindow(): BrowserWindow {
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;

  const win = new BrowserWindow({
    icon: path.join(import.meta.dirname, devServerUrl ? "../public/oint.png" : "../dist/oint.png"),
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    frame: false, // 自绘标题栏
    show: false,
    // 主题令牌落地前先给深色底，避免首帧白闪；checkpoint-2 接设置项
    backgroundColor: "#121212",
    webPreferences: {
      // 构建产物为 dist-electron/preload.cjs；sandbox 不支持 ESM preload
      preload: path.join(import.meta.dirname, "preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      /*
        内置浏览器面板需要 <webview>。实测 sandbox: true 与 webviewTag 可以共存
        （guest 页面照常加载、did-attach 钩子照常触发），所以主窗口的 sandbox 不放松。
        光开这个开关等于给了渲染层任意嵌页面的能力，配套的收紧见 hardenWebviews()。
      */
      webviewTag: true,
    },
  });

  // CSP 必须在首次加载**之前**装上：onHeadersReceived 只对之后发生的请求生效
  installContentSecurityPolicy(win.webContents.session, devServerUrl);
  // 权限门只需装一次（分区级），放在这里是因为主窗口是唯一会创建 guest 的地方
  restrictGuestPermissions();
  hardenWebviews(win);
  guardMainWindowNavigation(win);

  win.once("ready-to-show", () => win.show());
  win.on("maximize", () => notifyMaximized(win));
  win.on("unmaximize", () => notifyMaximized(win));
  win.on("closed", () => {
    mainWindow = null;
  });

  if (devServerUrl) {
    void win.loadURL(devServerUrl);
  } else {
    void win.loadFile(path.join(import.meta.dirname, "../dist/index.html"));
  }

  mainWindow = win;
  return win;
}
