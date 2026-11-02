// 视觉验证：新会话页（没有选中会话 / 刚新建空会话时的那一屏）在真实 Electron 里长什么样。
//
// 为什么需要它：组件测试证明的是 DOM 结构与数据链，证明不了**排版**真的对 ——
// 「输入框居中、不再贴窗口底边、品牌水印在问候之上、起手提示在输入框之下」全是 CSS 的事，
// Tailwind 类名写错时 DOM 断言照样全绿。这里量的是真实几何与计算样式，并留一张截图。
//
// 与 probe-input-dock / probe-composer-dock 的分工：那两个量的是**对话中**的输入区
// （停靠区、状态条间距），本文件量的是**还没有消息时**的那一屏。
//
// 用法（先另开一个终端跑 `npm run dev`）：
//   node scripts/probe-welcome.mjs [devServerUrl]

import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const DEV_URL = process.argv[2] ?? "http://127.0.0.1:1420";
const PORT = 19511;
const TMP = path.join(os.tmpdir(), "oint-welcome-probe");
const OUT = path.resolve("shot-welcome.png");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 1;
    this.pending = new Map();
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (!m.id || !this.pending.has(m.id)) return;
      const { resolve, reject } = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (m.error) reject(new Error(m.error.message));
      else resolve(m.result);
    });
  }
  static connect(url) {
    return new Promise((res, rej) => {
      const ws = new WebSocket(url);
      ws.addEventListener("open", () => res(new Cdp(ws)));
      ws.addEventListener("error", () => rej(new Error("CDP failed")));
    });
  }
  send(method, params = {}) {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

async function ev(cdp, expression) {
  const r = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed");
  return r.result.value;
}

/**
 * 把输入框的值设成 text。
 *
 * 用原型上的 value setter 再派发 input 事件：库的输入框是受控 textarea，
 * 直接改 `input.value` 不会触发 React 的 onChange，composer 文本状态就永远不变
 * （斜杠菜单、发送键的可用性全都读那份状态）。
 */
async function setComposerText(cdp, text) {
  await ev(
    cdp,
    `(() => {
       const input = document.querySelector('[data-slot="composer-root"] textarea');
       if (!input) return false;
       const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
       setter.call(input, ${JSON.stringify(text)});
       input.dispatchEvent(new Event("input", { bubbles: true }));
       return true;
     })()`,
  );
}

let failed = 0;
function check(label, condition, detail) {
  if (condition) console.log(`OK   | ${label} | ${detail}`);
  else {
    failed += 1;
    console.log(`FAIL | ${label} | ${detail}`);
  }
}

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const env = { ...process.env, VITE_DEV_SERVER_URL: DEV_URL, OINT_HOME: path.join(TMP, "data") };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(
  electronPath,
  [".", `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(TMP, "ud")}`],
  { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] },
);
const appLog = [];
child.stdout.on("data", (d) => appLog.push(String(d)));
child.stderr.on("data", (d) => appLog.push(String(d)));

let cdp = null;
try {
  try {
    await fetch(DEV_URL);
  } catch {
    throw new Error(`${DEV_URL} 不可达 —— 请先在另一个终端跑 npm run dev`);
  }

  let target = null;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline && target === null) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((i) => i.type === "page" && i.webSocketDebuggerUrl) ?? null;
    } catch {
      /* 端口未就绪 */
    }
    if (target === null) await sleep(400);
  }
  if (target === null) throw new Error("等待调试目标超时");

  cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");

  let mounted = false;
  const md = Date.now() + 30000;
  while (Date.now() < md && !mounted) {
    mounted = await ev(cdp, '!!document.querySelector("aside")');
    if (!mounted) await sleep(300);
  }
  check("应用已挂载", mounted, "aside 存在");
  if (!mounted) throw new Error("应用没有挂载");

  // 固定窗口尺寸：几何断言要有一致的参照，否则「居中」会随窗口大小漂移
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await sleep(300);

  /**
   * 灌入「一个绑定了项目的空会话」。
   *
   * 用 store 而不是走 IPC 建会话：探针要的是**这一屏**的形态，不是「建会话」这条链
   * （那条由 session-store 与 chat-store 的测试覆盖）。项目列表同样直接塞进 store ——
   * 它平时由启动时的一次 `projects:list` 填上，这里省掉那次往返。
   */
  await ev(
    cdp,
    `(async () => {
       const chat = await import("/src/renderer/stores/chat-store.ts");
       const projects = await import("/src/renderer/stores/projects-store.ts");
       const settings = await import("/src/renderer/stores/settings-store.ts");
       projects.useProjectsStore.setState({
         projects: [
           { id: "p1", name: "oint", path: "D:\\\\dev\\\\oint", createdAt: 0 },
           { id: "p2", name: "polartv", path: "D:\\\\dev\\\\polartv", createdAt: 0 },
         ],
         loading: false,
       });
       settings.useSettingsStore.setState({
         settings: {
           permissionMode: "full",
           agentMode: "standard",
           thinkingLevel: "medium",
           defaultModel: null,
           services: [],
           theme: "light",
         },
         loaded: true,
       });
       chat.useChatStore.setState({
         activeSessionId: "s-welcome",
         sessions: [{
           id: "s-welcome", title: null, createdAt: Date.now(), updatedAt: Date.now(),
           cwd: "D:\\\\dev\\\\oint", archived: false, pinned: false,
           messageCount: 0, model: null,
         }],
         messagesBySession: {},
         loadedSessions: {},
         runningBySession: {},
         queueBySession: {},
       });
       return true;
     })()`,
  );
  await sleep(900);

  const m = await ev(
    cdp,
    `(() => {
       const box = (el) => {
         if (!el) return null;
         const r = el.getBoundingClientRect();
         return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width),
                  h: Math.round(r.height), cx: Math.round(r.left + r.width / 2),
                  cy: Math.round(r.top + r.height / 2) };
       };
       const q = (s) => document.querySelector(s);
       const mark = q('[data-slot="welcome-mark"]');
       const card = q('[data-slot="composer-root"]');
       const context = q('[data-slot="composer-context"]');
       const input = q('[data-slot="composer-root"] textarea');
       const chips = q('[data-slot="empty-state-suggestions"]');
       return {
         window: { w: innerWidth, h: innerHeight },
         // 对话区（输入框所在的那一列）：它右侧还有 240px 的侧栏，所以居中要对着它量
         viewport: box(q('[data-slot="aui_thread-viewport"]')),
         greeting: (q('[data-slot="empty-state-greeting"]')?.textContent ?? "").trim(),
         mark: box(mark),
         markStyle: mark
           ? {
               opacity: getComputedStyle(mark).opacity,
               filter: getComputedStyle(mark).filter,
               src: mark.getAttribute("src"),
             }
           : null,
         markLoaded: mark ? (mark.complete && mark.naturalWidth > 0) : false,
         // 侧栏那枚小标记：暗色下靠 invert 才看得见（字形是墨色、侧栏是深色）
         brand: (() => {
           const img = document.querySelector("aside img");
           if (!img) return null;
           const r = img.getBoundingClientRect();
           return {
             src: img.getAttribute("src"),
             w: Math.round(r.width),
             h: Math.round(r.height),
             filter: getComputedStyle(img).filter,
             loaded: img.complete && img.naturalWidth > 0,
           };
         })(),
         card: box(card),
         context: box(context),
         contextLabel: (context?.textContent ?? "").trim(),
         input: box(input),
         chips: box(chips),
         chipLabels: [...(q('[data-slot="empty-state-suggestions"]')?.querySelectorAll("button") ?? [])]
           .map((b) => b.textContent.trim()),
         footer: box(q('[data-slot="aui_thread-viewport-footer"]')),
         cardRadius: card ? getComputedStyle(card).borderRadius : null,
         innerRadius: input ? getComputedStyle(input.closest('[data-slot="composer-root"] > div')).borderRadius : null,
       };
     })()`,
  );

  console.log("几何:", JSON.stringify(m, null, 2));

  const vp = m.viewport;
  check("问候语在", m.greeting.includes("今天想做点什么"), m.greeting);
  check("对话区已量到", vp !== null, JSON.stringify(vp));
  check("品牌水印渲染出来了（图真的解码成功）", m.markLoaded === true, JSON.stringify(m.markStyle));
  check(
    "水印用的是新 logo（透明底那份）且压成了低不透明度的装饰",
    Number(m.markStyle?.opacity ?? 1) <= 0.3 && (m.markStyle?.src ?? "").includes("oint-logo"),
    JSON.stringify(m.markStyle),
  );
  check(
    "侧栏品牌标记也换成了新 logo，且真的解码成功",
    m.brand !== null && (m.brand?.src ?? "").includes("oint-logo") && m.brand?.loaded === true,
    JSON.stringify(m.brand),
  );
  check(
    "输入框在对话区里水平居中（卡片中心 ≈ 对话区中心）",
    m.card !== null && vp !== null && Math.abs(m.card.cx - vp.cx) <= 8,
    `card.cx=${m.card?.cx} 对话区中心=${vp?.cx}`,
  );
  check(
    "输入框不再贴窗口底边（底部留白 > 150px）",
    m.card !== null && vp !== null && vp.y + vp.h - (m.card.y + m.card.h) > 150,
    `底部留白=${m.card && vp ? vp.y + vp.h - (m.card.y + m.card.h) : "n/a"}px`,
  );
  check(
    "输入框在垂直方向的居中档（不是贴底、也不是贴着顶）",
    m.card !== null && vp !== null && m.card.cy > vp.y + vp.h * 0.3 && m.card.cy < vp.y + vp.h * 0.8,
    `card.cy=${m.card?.cy} 对话区=${vp?.y}..${vp ? vp.y + vp.h : "?"}`,
  );
  check(
    "水印在问候之上、输入框之上",
    m.mark !== null && m.card !== null && m.mark.y + m.mark.h <= m.card.y,
    `mark.bottom=${m.mark ? m.mark.y + m.mark.h : "n/a"} card.y=${m.card?.y}`,
  );
  check(
    "上下文行在卡片内、且排在输入框之前",
    m.context !== null &&
      m.card !== null &&
      m.context.y >= m.card.y &&
      m.context.y + m.context.h <= m.input.y,
    `context=${JSON.stringify(m.context)} input.y=${m.input?.y}`,
  );
  check(
    "上下文行显示的是会话工作目录所属的项目",
    m.contextLabel.includes("oint"),
    m.contextLabel,
  );
  check(
    "起手提示在输入框之下（这一排属于「输入框之后」的下一步）",
    m.chips !== null && m.card !== null && m.chips.y >= m.card.y + m.card.h,
    `chips.y=${m.chips?.y} card.bottom=${m.card ? m.card.y + m.card.h : "n/a"}`,
  );
  check("起手提示至少有 3 条", m.chipLabels.length >= 3, JSON.stringify(m.chipLabels));
  check("空会话页没有底栏（输入框不在脚注里）", m.footer === null, JSON.stringify(m.footer));

  /**
   * 点一条起手提示：正文进输入框，**不发出去**。
   *
   * 用真实受信任的点击（CDP 投递鼠标事件），与 probe-input-dock 同一个口径 ——
   * 页面内 dispatchEvent 出来的事件 isTrusted 为 false，Radix / React 的路径不完全一样。
   */
  const chipBox = await ev(
    cdp,
    `(() => {
       const btn = document.querySelector('[data-slot="empty-state-suggestions"] button');
       if (!btn) return null;
       const r = btn.getBoundingClientRect();
       return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), label: btn.textContent.trim() };
     })()`,
  );
  if (chipBox !== null) {
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: chipBox.x,
      y: chipBox.y,
      buttons: 0,
    });
    for (const type of ["mousePressed", "mouseReleased"]) {
      await cdp.send("Input.dispatchMouseEvent", {
        type,
        x: chipBox.x,
        y: chipBox.y,
        button: "left",
        buttons: type === "mousePressed" ? 1 : 0,
        clickCount: 1,
      });
    }
    await sleep(600);
  }
  const afterChip = await ev(
    cdp,
    `(() => {
       const input = document.querySelector('[data-slot="composer-root"] textarea');
       return { text: input ? input.value : null };
     })()`,
  );
  check(
    "点起手提示把模板正文填进输入框（只填不发）",
    (afterChip?.text ?? "").length > 20,
    JSON.stringify(afterChip?.text?.slice(0, 60)),
  );

  /**
   * —— 斜杠菜单在 hero 摆法下的落点 ——
   *
   * 菜单是 `absolute bottom-full`：在对话里它贴着输入框上沿往上弹，而空会话页把输入框
   * 挪到了画面中间、外壳还多了一层内层输入面 —— 锚点一旦变了，菜单可能弹到卡片里侧、
   * 或者被视口裁掉。这里量的是它真的落在**卡片之上**。
   */
  await setComposerText(cdp, "/");
  await sleep(600);
  const slash = await ev(
    cdp,
    `(() => {
       const box = (el) => {
         if (!el) return null;
         const r = el.getBoundingClientRect();
         return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
       };
       const list = document.querySelector('[role="listbox"]');
       return { list: box(list), card: box(document.querySelector('[data-slot="composer-root"]')) };
     })()`,
  );
  check("斜杠菜单在 hero 摆法下也能打开", slash.list !== null, JSON.stringify(slash.list));
  check(
    "菜单落在卡片**之上**（不是压在输入面上）",
    slash.list !== null && slash.card !== null && slash.list.y + slash.list.h <= slash.card.y + 2,
    `list.bottom=${slash.list ? slash.list.y + slash.list.h : "?"} card.y=${slash.card?.y}`,
  );
  check(
    "菜单没有被视口顶边裁掉",
    slash.list !== null && slash.list.y >= 0,
    JSON.stringify(slash.list),
  );

  /**
   * —— 输入框的高度上限与内部滚动 ——
   *
   * 这件事只有真实布局能验：jsdom 没有排版引擎，scrollHeight 恒为 0，
   * 「长到 10 行封顶、再往上自己滚」在组件测试里量不出来。
   *
   * 三档一起量：1 行（不高过下限）、5 行（跟着内容长）、15 行（封顶且内部滚动）。
   */
  const measureInput = () =>
    ev(
      cdp,
      `(() => {
         const el = document.querySelector('[data-slot="composer-root"] textarea');
         const cs = getComputedStyle(el);
         return {
           clientHeight: el.clientHeight,
           scrollHeight: el.scrollHeight,
           lineHeight: Number.parseFloat(cs.lineHeight),
           overflowY: cs.overflowY,
         };
       })()`,
    );

  const oneLine = await measureInput();
  await setComposerText(
    cdp,
    Array.from({ length: 5 }, (_, i) => `第 ${i + 1} 行`).join("\n"),
  );
  await sleep(400);
  const fiveLines = await measureInput();
  await setComposerText(
    cdp,
    Array.from({ length: 15 }, (_, i) => `第 ${i + 1} 行`).join("\n"),
  );
  await sleep(400);
  const manyLines = await measureInput();
  console.log("输入框高度:", JSON.stringify({ oneLine, fiveLines, manyLines }));

  check(
    "内容变多时输入框跟着长高",
    fiveLines.clientHeight > oneLine.clientHeight,
    `1 行=${oneLine.clientHeight}px → 5 行=${fiveLines.clientHeight}px`,
  );
  check(
    "封顶在 10 行（不再随内容长高）",
    manyLines.clientHeight <= Math.round(manyLines.lineHeight * 10) + 12,
    `15 行时高=${manyLines.clientHeight}px，行高=${manyLines.lineHeight}px，10 行上限≈${Math.round(manyLines.lineHeight * 10)}px`,
  );
  check(
    "超出的内容在输入框内部滚动（不是被裁掉）",
    manyLines.scrollHeight > manyLines.clientHeight && manyLines.overflowY !== "hidden",
    `scrollHeight=${manyLines.scrollHeight} clientHeight=${manyLines.clientHeight} overflowY=${manyLines.overflowY}`,
  );
  const shotTall = await cdp.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.resolve("shot-welcome-tall-input.png"), Buffer.from(shotTall.data, "base64"));
  console.log("截图: shot-welcome-tall-input.png");

  // 清掉再截一张干净的图（否则图上输入框里会留着斜杠或一大段模板正文）
  await setComposerText(cdp, "");
  await sleep(400);

  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(OUT, Buffer.from(shot.data, "base64"));
  console.log(`截图: ${OUT}`);

  /**
   * —— 项目 chip 的弹层 ——
   *
   * 它挂在输入框**上沿之上**（Popover 默认从触发键往上/往下找位置），要确认它没有被
   * 卡片或视口裁掉。用真实点击打开，量的是弹层自己的位置与可见性。
   */
  const chipTrigger = await ev(
    cdp,
    `(() => {
       const btn = document.querySelector('[data-slot="composer-context"] button');
       if (!btn) return null;
       const r = btn.getBoundingClientRect();
       return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
     })()`,
  );
  if (chipTrigger !== null) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...chipTrigger, buttons: 0 });
    for (const type of ["mousePressed", "mouseReleased"]) {
      await cdp.send("Input.dispatchMouseEvent", {
        type,
        ...chipTrigger,
        button: "left",
        buttons: type === "mousePressed" ? 1 : 0,
        clickCount: 1,
      });
    }
    await sleep(600);
  }
  const menu = await ev(
    cdp,
    `(() => {
       const panel = document.querySelector('[data-radix-popper-content-wrapper]');
       const items = [...document.querySelectorAll('[data-radix-popper-content-wrapper] button')]
         .map((b) => b.textContent.trim());
       const r = panel?.getBoundingClientRect();
       return {
         open: panel !== null,
         box: r ? { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } : null,
         items,
       };
     })()`,
  );
  check("项目 chip 的弹层能打开", menu.open === true, JSON.stringify(menu.box));
  check(
    "弹层里列出项目与「添加项目」入口",
    (menu.items ?? []).some((t) => t.includes("polartv")) &&
      (menu.items ?? []).some((t) => t.includes("添加项目")),
    JSON.stringify(menu.items),
  );
  check(
    "弹层没有被视口裁掉（整块都在窗口内）",
    menu.box !== null && menu.box.y >= 0 && menu.box.y + menu.box.h <= 900,
    JSON.stringify(menu.box),
  );
  const shotMenu = await cdp.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.resolve("shot-welcome-project.png"), Buffer.from(shotMenu.data, "base64"));
  console.log("截图: shot-welcome-project.png");

  // 关掉弹层（Esc），再换暗色看一眼：水印与内层输入面在暗色下都要还成立
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });
  await sleep(300);
  await ev(
    cdp,
    `(async () => {
       const settings = await import("/src/renderer/stores/settings-store.ts");
       settings.useSettingsStore.getState().applyTheme?.("dark");
       document.documentElement.classList.add("dark");
       return true;
     })()`,
  );
  await sleep(500);
  const darkTokens = await ev(
    cdp,
    `(() => {
       const root = document.documentElement;
       const aside = document.querySelector("aside");
       return {
         hasClass: root.classList.contains("dark"),
         sidebarToken: getComputedStyle(root).getPropertyValue("--sidebar").trim(),
         asideBg: aside ? getComputedStyle(aside).backgroundColor : null,
         cardBg: getComputedStyle(document.querySelector('[data-slot="composer-root"]')).backgroundColor,
       };
     })()`,
  );
  console.log("暗色令牌:", JSON.stringify(darkTokens));
  check(
    "暗色下外壳与侧栏都换了面（令牌真的生效）",
    darkTokens.hasClass === true &&
      darkTokens.asideBg !== darkTokens.cardBg &&
      darkTokens.sidebarToken.startsWith("oklch(0.19"),
    JSON.stringify(darkTokens),
  );
  const darkBrand = await ev(
    cdp,
    `(() => {
       const img = document.querySelector("aside img");
       return img ? { filter: getComputedStyle(img).filter } : null;
     })()`,
  );
  check(
    "暗色侧栏上的墨色标记被反相（否则深底黑字等于看不见）",
    (darkBrand?.filter ?? "").includes("invert"),
    JSON.stringify(darkBrand),
  );
  const shotDark = await cdp.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.resolve("shot-welcome-dark.png"), Buffer.from(shotDark.data, "base64"));
  console.log("截图: shot-welcome-dark.png");
  await ev(cdp, "document.documentElement.classList.remove('dark'), true");

  /**
   * —— 发出第一条消息之后：这一屏必须回到「对话中」的摆法 ——
   *
   * 这是最容易出事的回归：空态那一屏是**另一棵树**，如果分支条件写错，
   * 有消息之后输入框会留在中间、或者整片对话区空白。这里灌一条消息进去，量的是
   * 「输入框回到贴底的脚注里、空态那一屏消失」。
   */
  await ev(
    cdp,
    `(async () => {
       const chat = await import("/src/renderer/stores/chat-store.ts");
       const now = Date.now();
       chat.useChatStore.setState({
         messagesBySession: {
           "s-welcome": [
             { id: "m1", role: "user", createdAt: now, status: "complete",
               parts: [{ type: "text", text: "你好" }] },
           ],
         },
         loadedSessions: { "s-welcome": true },
       });
       return true;
     })()`,
  );
  await sleep(900);
  const afterSend = await ev(
    cdp,
    `(() => {
       const box = (el) => {
         if (!el) return null;
         const r = el.getBoundingClientRect();
         return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
       };
       const q = (s) => document.querySelector(s);
       return {
         welcome: q('[data-slot="welcome"]') !== null,
         footer: box(q('[data-slot="aui_thread-viewport-footer"]')),
         composer: box(q('[data-slot="composer-root"]')),
         context: q('[data-slot="composer-context"]') !== null,
         messages: document.querySelectorAll('[data-message-id]').length,
       };
     })()`,
  );
  check("有消息之后空态那一屏消失", afterSend.welcome === false, JSON.stringify(afterSend.welcome));
  check("输入框回到贴底的脚注里", afterSend.footer !== null, JSON.stringify(afterSend.footer));
  check(
    "对话中的输入框贴着窗口底部（与空态相反）",
    afterSend.composer !== null && afterSend.composer.y + afterSend.composer.h > 900 - 60,
    JSON.stringify(afterSend.composer),
  );
  check("上下文行只在空会话页出现", afterSend.context === false, JSON.stringify(afterSend.context));
  check("消息渲染出来了", afterSend.messages >= 1, String(afterSend.messages));

  /**
   * 斜杠菜单在**对话中**的落点：锚点从「脚注容器（sticky）」改成了卡片自己（relative），
   * 菜单因此比原先低十几像素。这条断言钉住它仍然贴着卡片上沿、且没有被裁掉。
   */
  await setComposerText(cdp, "/");
  await sleep(600);
  const dockedSlash = await ev(
    cdp,
    `(() => {
       const box = (el) => {
         if (!el) return null;
         const r = el.getBoundingClientRect();
         return { y: Math.round(r.top), h: Math.round(r.height), bottom: Math.round(r.bottom) };
       };
       const list = document.querySelector('[role="listbox"]');
       return { list: box(list), card: box(document.querySelector('[data-slot="composer-root"]')) };
     })()`,
  );
  check("斜杠菜单在对话中也贴着卡片上沿", 
    dockedSlash.list !== null && dockedSlash.card !== null &&
      dockedSlash.list.bottom <= dockedSlash.card.y && dockedSlash.list.bottom >= dockedSlash.card.y - 40,
    JSON.stringify(dockedSlash));
  check("对话中的菜单没有被视口裁掉", dockedSlash.list !== null && dockedSlash.list.y >= 0, JSON.stringify(dockedSlash.list));
  await setComposerText(cdp, "");
  await sleep(300);
  const shotChat = await cdp.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.resolve("shot-welcome-after-send.png"), Buffer.from(shotChat.data, "base64"));
  console.log("截图: shot-welcome-after-send.png");
} catch (error) {
  failed += 1;
  console.log(`FAIL | 探针异常 | ${error instanceof Error ? error.message : String(error)}`);
  if (appLog.length > 0) console.log(`--- 应用日志 ---\n${appLog.slice(-12).join("")}`);
} finally {
  cdp?.ws.close();
  child.kill();
  await sleep(600);
  if (child.exitCode === null) child.kill("SIGKILL");
}

console.log(failed === 0 ? "\n结论：全部通过" : `\n结论：${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);
