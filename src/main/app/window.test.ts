// 渲染进程 CSP 与导航守卫的策略单测。
//
// **为什么值得为这两段纯字符串/纯路径判断写测试**：它们是不依赖「其余代码写得对」的
// 那类防线。失效方式又特别安静 —— 少写一条 CSP 指令不会报错，只会让某类注入重新可行；
// 导航判断写宽一条也不会报错，只会把特权窗口交出去。
//
// 这里钉住四件事：
//   1. **不放行 eval / 内联脚本**（CSP 的主要价值）；
//   2. **不放行任意外链**（img-src / connect-src）—— 否则模型写个外链图片就能静默外带；
//   3. dev 与 prod 的差别只有 HMR 那一处，打包后必须自动收紧；
//   4. **导航白名单必须逐字比对**——曾经写成 `startsWith("file://")`，
//      于是打包后任何本地 HTML 都能把特权窗口导航走（且目标仍带 preload 桥）。
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { buildContentSecurityPolicy, isSelfUrl } from "./window";

/** 把策略拆成「指令 → 源列表」，便于逐条断言 */
function parse(policy: string): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const part of policy.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name !== undefined && name !== "") directives.set(name, sources);
  }
  return directives;
}

describe("buildContentSecurityPolicy", () => {
  describe("生产构建（无 dev server）", () => {
    const directives = parse(buildContentSecurityPolicy(undefined));

    it("默认只信自己", () => {
      expect(directives.get("default-src")).toEqual(["'self'"]);
    });

    it("脚本不允许 eval 与内联：这是这条策略的主要价值", () => {
      const script = directives.get("script-src") ?? [];
      expect(script).toContain("'self'");
      expect(script).not.toContain("'unsafe-eval'");
      expect(script).not.toContain("'unsafe-inline'");
      // 连哈希/nonce 都没有：本仓的脚本全是外部文件，不需要任何内联通道
      expect(script.join(" ")).not.toMatch(/unsafe/);
    });

    it("图片只放行 self / data / blob —— 不含 http(s)", () => {
      const img = directives.get("img-src") ?? [];
      expect(img).toEqual(["'self'", "data:", "blob:"]);
      // 关键：模型在回复里写一个外链图片，渲染时不该去请求那个域
      expect(img.some((source) => source.startsWith("http"))).toBe(false);
    });

    it("连接只放行 self：模型请求全在主进程发起", () => {
      expect(directives.get("connect-src")).toEqual(["'self'"]);
    });

    it("堵掉插件 / iframe / 表单 / base 注入", () => {
      expect(directives.get("object-src")).toEqual(["'none'"]);
      expect(directives.get("frame-src")).toEqual(["'none'"]);
      expect(directives.get("base-uri")).toEqual(["'self'"]);
      expect(directives.get("form-action")).toEqual(["'none'"]);
    });

    it("样式放行 unsafe-inline（React 行内样式、xterm、shiki 都靠它）", () => {
      // 这条是**有意放宽**的：行内样式不能执行代码，风险远低于行内脚本；
      // 禁掉会让终端与代码高亮直接不显示。写成断言是为了让这个取舍在 review 里可见。
      expect(directives.get("style-src")).toEqual(["'self'", "'unsafe-inline'"]);
    });
  });

  describe("开发模式（vite dev server）", () => {
    const devUrl = "http://127.0.0.1:1420";
    const directives = parse(buildContentSecurityPolicy(devUrl));

    it("放行 dev server 自身与它的 HMR websocket", () => {
      expect(directives.get("script-src")).toContain(devUrl);
      const connect = directives.get("connect-src") ?? [];
      expect(connect).toContain(devUrl);
      expect(connect).toContain("ws://127.0.0.1:1420");
    });

    /**
     * **这条是白屏事故的回归保护，别删。**
     *
     * `@vitejs/plugin-react` 在 dev 下往 index.html 注入一段**行内** `<script type="module">`
     * （React Refresh preamble）。dev 的 script-src 若不含 `'unsafe-inline'`，
     * 它会被 CSP 拦下 → 每个组件模块抛 `can't detect preamble` → 整页白屏。
     * 实测到的报错原文：
     *   "Executing inline script violates ... 'script-src 'self' http://localhost:1420'.
     *    Either the 'unsafe-inline' keyword, a hash (...), or a nonce (...) is required"
     */
    it("dev 必须放行行内脚本，否则 React Refresh preamble 被拦、整页白屏", () => {
      expect(directives.get("script-src")).toContain("'unsafe-inline'");
    });

    it("即便在 dev 也不放行 eval —— 本仓没有需要它的依赖", () => {
      expect((directives.get("script-src") ?? []).join(" ")).not.toContain("'unsafe-eval'");
    });

    it("dev 与 prod 的差别只在 script-src / connect-src 两处", () => {
      const prod = parse(buildContentSecurityPolicy(undefined));
      const differing = [...directives.keys()].filter((name) => {
        const a = (directives.get(name) ?? []).join(" ");
        const b = (prod.get(name) ?? []).join(" ");
        return a !== b;
      });
      expect(differing.sort()).toEqual(["connect-src", "script-src"]);
    });

    it("空串与 undefined 等价（打包后 VITE_DEV_SERVER_URL 可能被置为空串）", () => {
      expect(buildContentSecurityPolicy("")).toBe(buildContentSecurityPolicy(undefined));
    });
  });
});

/**
 * 导航白名单：**模型可控链接**与**特权窗口**之间唯一的边界。
 *
 * 这组用例直接对应一次实测确认的事故：原实现是 `target.startsWith("file://")`，
 * 打包环境下等价于「任何本地文件都放行」。模型写一条
 * `[点我](file:///C:/Users/x/evil.html)`，用户一点就导航过去 ——
 * 而**目标页面照样拿得到 preload 桥**（导航不重载 preload），
 * 于是任意本地 HTML 都能拿到 window.oint。
 */
describe("isSelfUrl（主窗口导航白名单）", () => {
  // 用当前平台的绝对路径构造 dist：`path.join("D:", ...)` 在 POSIX 上仍是相对路径，
  // 会让「放行自己的页面」这条正向用例错误地失败。
  const DIST = path.resolve("app", "resources", "app", "dist");
  const DIST_URL = pathToFileURL(DIST).href;
  const prod = { distDir: DIST };

  describe("打包环境", () => {
    it("放行应用自己的入口页面与 dist 内的资源", () => {
      const index = `${DIST_URL}/index.html`;
      const asset = `${DIST_URL}/assets/index-abc123.js`;
      expect(isSelfUrl(index, prod)).toBe(true);
      expect(isSelfUrl(asset, prod)).toBe(true);
    });

    it("**拒绝 dist 之外的任意本地文件**（这正是原来出错的形态）", () => {
      // 攻击形态：模型写一条指向本地 HTML 的链接
      expect(isSelfUrl("file:///C:/Users/victim/evil.html", prod)).toBe(false);
      expect(isSelfUrl("file:///C:/Users/victim/AppData/Roaming/x.html", prod)).toBe(false);
      // dist 的兄弟目录也不行（前缀相似但不是它内部）
      expect(isSelfUrl(`${pathToFileURL(`${DIST}-evil`).href}/x.html`, prod)).toBe(false);
      // 用 .. 爬出去
      expect(isSelfUrl(`${DIST_URL}/../secret.html`, prod)).toBe(false);
    });

    it("拒绝所有远程地址（外链该走系统浏览器）", () => {
      expect(isSelfUrl("https://example.com/", prod)).toBe(false);
      expect(isSelfUrl("http://127.0.0.1:9469/attacker", prod)).toBe(false);
    });

    it("拒绝其他危险协议", () => {
      expect(isSelfUrl("javascript:alert(1)", prod)).toBe(false);
      expect(isSelfUrl("data:text/html,<script>1</script>", prod)).toBe(false);
      expect(isSelfUrl("about:blank", prod)).toBe(false);
    });

    it("非法 URL 与非法百分号编码都拒绝（不可信输入）", () => {
      expect(isSelfUrl("not a url", prod)).toBe(false);
      expect(isSelfUrl("", prod)).toBe(false);
      expect(isSelfUrl("file:///%E0%A4%A", prod)).toBe(false);
    });
  });

  describe("开发环境", () => {
    const dev = { devServerUrl: "http://127.0.0.1:1420", distDir: DIST };

    it("放行 dev server 同源地址", () => {
      expect(isSelfUrl("http://127.0.0.1:1420/", dev)).toBe(true);
      expect(isSelfUrl("http://127.0.0.1:1420/index.html", dev)).toBe(true);
    });

    it("不同源一律拒绝（包括同主机的别的端口）", () => {
      expect(isSelfUrl("http://127.0.0.1:9469/attacker", dev)).toBe(false);
      expect(isSelfUrl("http://localhost:1420/", dev)).toBe(false);
      expect(isSelfUrl("https://example.com/", dev)).toBe(false);
    });
  });
});
