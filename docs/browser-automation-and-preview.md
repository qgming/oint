# 内置浏览器：坐标级鼠标操作、可见光标、设备视口与截图

本文记录这一轮对内置浏览器（右侧栏的 `<webview>` 面板 + 9 个 `browser_*` 工具）的四项增强，
以及每项背后的判断。**改的是「模型能怎么操作页面」与「人能看到什么」两件事**，
所以每一节都先写清「不做会怎样」。

---

## 1 · 坐标点击与鼠标动作（`browser_act`）

### 起点：ref 覆盖不到的页面

原有能力是按快照里的 `ref` 操作元素（`click {ref}` / `hover {ref}`）。它定位准、
会自己滚动到位、还会校验落点（`WRONG_TARGET` / `NO_EFFECT`），但有三类页面它**根本够不到**：

| 页面形态 | 为什么 ref 不行 |
| --- | --- |
| canvas / WebGL 应用（图表、白板、游戏、地图） | 整块只有一个节点，里面的「按钮」是页面自己画出来的 |
| 图片热区、视频控件、自绘工具栏 | 没有 DOM 节点可点 |
| 页面自己合成的浮层（自绘下拉、右键菜单） | 选择器扫不到，快照里没有它 |

这些地方模型唯一的把手是**像素坐标**。而它原本也拿不到坐标 —— 快照只给 `ref role "name"`。

### 这一轮加了什么

1. **快照带上元素中心坐标**：`- e12 button "Save" @ 196,240`（视口 CSS 像素，
   与 `getBoundingClientRect` 的中心一致）。算不出中心（异常 rect）时**不写坐标**，
   而不是写 `0,0` —— 一个看起来合法的落点比没有落点更危险。
2. **`browser_act` 的 click / hover 支持 `x` / `y`**，并带上 `button`（left / right / middle）
   与 `clicks`（1 / 2，双击）。
3. **新增 `drag {fromX, fromY, toX, toY}`**：真实 `down → move×12 → up`。
   只发 down + up 会被依赖 `mousemove` 的组件当成「点了一下」（滑块、地图、画布、拖放排序全部如此），
   而工具却会报成功。
4. 坐标必须是**视口内**的有限数：越界直接拒（并回报当前视口尺寸），因为坐标动作**不滚动页面**，
   拿着过期坐标发出去只会静默点到别处。

### 诚实度的差别（必须写进工具描述）

- ref 路径**知道该是谁**收下这次点击 → 能报 `WRONG_TARGET`；
- 坐标路径没有这个知识 → 它只报「有没有事件」+「**谁收下了**」，答不了「这是不是你要点的」。

所以工具描述与结果文案都按这个口径写：能用 ref 就用 ref，坐标是逃生门；
坐标点击的结果里必须带上命中者（`… (196, 240) on <canvas#board>`）让模型自己核对。

### 已知的边界

- 坐标只对**快照那一刻**成立：页面滚动 / 重排后即过期，工具描述里明确要求重新快照。
- 坐标点击不做「该不该点这里」的判断，点错了不会失败 —— 这是它作为逃生门的代价，
  而不是可以靠更多校验消掉的缺陷（没有目标就没有可比对的东西）。

---

## 2 · 可见光标：让自动化看得见

模型操作页面时，页面会自己滚动、自己点击，用户只看到**结果变了**，
分不清「模型点了这里」与「页面自己跳了」。原有的提示条只说了一句话（「正在点击 e12」），
说得出**在做什么**，说不出**落在哪**。

现在：

- 主进程在每次真实鼠标动作前后发一条 `pointer` 事件（`BrowserEvent` 的新成员）：
  动作类型、落点（视口 CSS 像素）、按下 / 抬起相位、拖拽起点、命中者描述；
- 面板在该标签上叠加一层 `pointer-events: none` 的光标与涟漪：光标从上一个落点滑到新的落点，
  点击扩散一圈涟漪，拖拽画一条从起点到终点的虚线，右键 / 中键用琥珀色区分；
- 最后一次动作之后 2.4s 光标淡出：模型停手了还留着一个光标，会让人以为它还在动。

**事件是旁路**：渲染层的异常被 `emit` 吞掉，主进程也不等待 —— 自动化不会因为
「界面没画出来」而失败或变慢。

---

## 3 · 设备视口：适配不同的屏幕

### 问题

右侧栏固定宽度（`--layout-right-sidebar-width`，默认 380px），
于是页面**永远**按桌面断点渲染 —— 手机版长什么样，用户看不到，
模型也没法在窄视口里截图验证「手机上这个按钮会不会被挤掉」。

### 做法：改布局视口，而不是缩放页面

工具条上多了一个设备菜单：自适应面板 / 手机 390×844 / 平板 834×1112 /
笔记本 1280×800 / 桌面 1440×900。选中某一档时：

- webview 元素的 CSS 尺寸 = 该设备尺寸 → **页面自己的** `window.innerWidth`、
  media query、懒加载断点全部跟着变（这才是「适配」的实质）；
- 装不下时整台设备用 CSS `transform: scale()` **只在视觉上**缩小
  （纯合成层变换，不参与布局），菜单里报出缩放比（`缩放 42%`），
  免得看起来像「页面自己变小了」。

### 为什么不用 `setZoomFactor`

`webview.setZoomFactor()` 同样能改布局视口（Chromium 的页面缩放就是这么工作的），
但它会让**输入坐标的换算多出一层缩放**：CDP `Input.dispatchMouseEvent` 收的是控件坐标，
而快照与 `getBoundingClientRect` 给的是 CSS 坐标，两者之间差一个 zoom 因子。
一旦这个换算写错（或在某个 Electron 版本上语义不同），表现是**所有点击静默落到别处** ——
比「预览画得不对」严重得多。用 transform 则 guest 的 zoom 恒为 1，
主进程那条「页面上量的坐标直接投递」的链路完全不变。

代价写在注释里：transform 只影响显示，不影响布局 —— 这正是我们要的；
若哪天需要模拟移动端 UA / 触摸，那属于另一件事（CDP `Emulation.setDeviceMetricsOverride`），
不该顺手塞进这个菜单。

### 真机验证（`node scripts/probe-browser-viewport.mjs`）

「transform 到底有没有作用到 guest 画面上」这件事**只能由像素回答**：
若 Electron 不对 guest 应用祖先的 transform，DOM 上一切正常（元素尺寸与 transform 都在），
但画面会被裁成设备中间的一条。探针因此这样验（`Electron 不把 webview guest 列进 /json/list`，
探针进不去 guest 求值，判据只能落在屏幕上）：

1. 探针页面按**自己的布局视口宽度**换底色（≤420 品红 / 421–999 蓝 / ≥1000 绿）：
   底色变了 = guest 的布局视口真的变了，而这是页面自己的 media query 做出的判断；
2. 页面两个角各放一个 20×20 的红方块：缩放生效时整台设备都在画面里、两个方块都看得见，
   被裁切时它们都不在可见范围内；
3. 底色包围盒的像素尺寸要等于 `设备尺寸 × scale × dpr`。

实测结果（本机 Electron，窗口 100% 缩放、dpr=2）：自适应档底色为品红（面板 379px 宽）、
平板档为蓝（834×1112）、桌面档为绿（1440×900，`scale=0.241`），底色包围盒实测 692×432
（期望 694×434），两个红方块都在（边长 9.6px = 20 × 0.241 × 2，正方块应为 ~93 像素，
实测 69/78 —— 圆角与边框吃掉了边缘）。**缩放确实作用于 guest 画面，且布局视口就是设备尺寸。**

顺带一条对模型有用的结论：guest 的渲染不受祖先 transform 影响，
所以设备档位下面板的预览是缩小的，而 `browser_screenshot` 给模型的图仍是**设备原始分辨率**
（1440×900）—— 模型看细节不会被面板宽度限制。

---

## 4 · 会话里的图片：截图要看得到，点得开

### 问题

`browser_screenshot` 的结果是 `[文本, image 块]`，而两条落盘 / 推送路径
（`runtime.ts` 的 `applyToolEnd`、`message-mapper.ts` 的 `applyToolResult`）
都只取**文本块**：文本非空就直接返回文本，图片字节被丢掉。
于是「模型看到了什么」在界面上完全不存在，只剩一行 `viewport 380×639`。

### 做法

- 工具结果里的 image 块，对**该带图的工具**转成 dataUrl 挂到 `ToolCallPart.images`
  （判断收口在 `main/pisdk/tool-images.ts`，两条路径共用同一个函数）；
- 渲染层经 assistant-ui 的 `providerMetadata.oint.images` 槽位拿到它
  （自造字段会被归一化丢掉，而 `artifact` 已被工具 details 占用）；
- 截图的详情因此是**读数 + 那张图**：缩略图点开就是一个大模态窗（见下）。

**谁该带图**是有边界的一条判断，写在那个文件的文件头：

- `browser_screenshot` **必须**带 —— 它的图只存在于这次结果里，没有可回读的路径；
- `read_image` **刻意不带** —— 它给 `path`，界面展开时用 `files.readImage` 现取一次。
  几 MB 的 base64 不该常驻在渲染层的会话状态里。

**不落盘**：`images` 只活在内存中的 part 上；磁盘上的那份是 pi 的 toolResult 条目本身
（含 image 内容块），刷新窗口 / 重开应用时由 `message-mapper` 重新取出 ——
所以「历史会话里的截图」照样看得见。单个工具的图片总量超过 12MB 时**放弃这张图**
（界面只显示读数，并留一条告警），不让一条消息把 IPC 与内存撑爆。

### 图片查看器

`read_image` 与 `browser_screenshot` 两处详情点开的都是同一个组件
（`renderer/components/ui/image-viewer.tsx`）：外壳与设置模态同族（同一个 Dialog、
同样的 Esc / 点遮罩关闭），尺寸取**比设置模态大一档**（1280×860 上限 vs 880×640）——
设置是表单、字要大，这里是一张图、像素越多越好。

刻意**只有大图 + 关闭**：缩放条、旋转、下载、复制都属于「图片编辑器」，
而这里的动作只有一个 —— 看清楚。缩略图右上角那枚「查看大图」徽标常驻可见
（不是 hover 才出现）：触屏与触控板上没有 hover 这个状态。

---

## 5 · 从哪里开始读代码

| 关注点 | 位置 |
| --- | --- |
| 坐标动作的派发 / 校验 / 探针判定 | `src/main/browser/service.ts`（`clickAt` / `dragAt` / `clickPoint` / `drag` / `hoverPoint`） |
| 快照的元素中心坐标 | `src/main/browser/script.ts`（`buildSnapshotExpression`） |
| 工具参数与文案（七种动作、坐标纪律） | `src/main/pisdk/tools/browser.ts` |
| 光标事件契约 | `src/shared/contracts/browser.ts`（`BrowserPointerEvent`） |
| 设备视口 + 光标层 | `src/renderer/features/right-panel/BrowserPanel.tsx` |
| 截图 / 读图在会话里的呈现 | `src/renderer/features/chat/ToolParts.tsx`、`tool-presentation.ts` |
| 图片本体随 part 走的收口 | `src/main/pisdk/tool-images.ts` |
| 大图查看器 | `src/renderer/components/ui/image-viewer.tsx` |

### 自动化验证到哪一层

- 纯逻辑与 DOM 脚本：`browser.test.ts`、`dom-scripts.test.ts`（坐标是否算对）、
  `tool-presentation.test.ts`、`tool-images.test.ts`、`message-mapper.test.ts`；
- 组件层（jsdom）：`BrowserPanel.test.tsx`（设备视口改的是元素尺寸 / 光标只画在自己的标签上）、
  `tool-image-viewer.test.tsx`（缩略图可点、点开是大图、Esc 关闭）；
- 真机（Electron + CDP）：
  - `node scripts/probe-browser-guest.mjs` —— guest 附着、导航、弹窗自动应答的既有回归；
  - `node scripts/probe-browser-viewport.mjs` —— 设备视口的布局视口与「缩放是否作用于 guest」
    （判据是像素，见 §3 末）。注意它读的是**构建产物**：改完渲染层要先
    `npx vite build --config vite.renderer.config.ts`，否则探针跑的是旧界面
    （实测踩过一次：菜单按钮根本不在按钮清单里）。
- **仍然只能目视的部分**：光标的动画观感；以及 `pointer` 事件本身 ——
  它只在模型真的点击时才产生，而探针没有模型，无法在不跑一轮对话的情况下驱动它
  （渲染层那一半由 `BrowserPanel.test.tsx` 覆盖，主进程那一半靠代码审查）。
