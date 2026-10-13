# Pi 1.0.0 → 1.2.0 升级记录

2026-10-14。本文记录本次生态升级的范围、设计决策与验证证据；面向插件作者的用法说明见 [插件作者 API](./plugin-native-api.md)，1.0.0 迁移的历史记录见 [pi-1.0.md](./pi-1.0.md)（历史）。

## 范围

- **升级**：`@earendil-works/chord` / `pi-ai` / `pi-durable` / `pi-mcp` 1.0.0 → **1.2.0**（精确固定）；新增传递依赖 `pi-codemode@1.2.0`、`pi-telemetry@1.2.0`（由 `check-pi-deps.mjs` 白名单精确校验）。
- **移除**：`@earendil-works/pi-client` / `pi-server` / `pi-protocol` —— chord 1.2.0 删除了它们服务的旧运行时，"no longer released"。
- **插件子系统重写**：旧 facet bundle + 字节协议栈整体替换为 chord 1.2 的 host 运行时（详见 plugin-native-api.md）。
- **采纳的新能力**：read 原生读图、压缩失败可见性、`durationMs` 展示、`structuredOutput` 透传、`tool_search` 延迟工具网关、`codemode` QuickJS 沙箱。

## 关键设计决策

| 决策 | 结论 | 理由 |
| --- | --- | --- |
| 插件加载 | **源码直载**（`.ts` + Node 类型剥离），删除全部打包环节 | chord 1.2.0 删除了 `./bundler`；Electron 44 / Node 24 与开发 Node 22.19 的剥离均实测可用 |
| 旧插件产物 | 不兼容，明确报错 + 迁移文档 | 旧 bundle 无法在新运行时加载；`LegacyPluginArtifactError` 给出逐条迁移步骤 |
| 进程模型 | 保留 Electron utilityProcess + `ipcLink` 适配 | 不引入 `forkDriver`/ELECTRON_RUN_AS_NODE 的额外面；生命周期语义与旧版一致 |
| 契约供给 | worker 入口预解析白名单说明符后注册 resolve hook | 插件目录没有 node_modules；`oint:plugin` 保证两端拿到同一份契约对象 |
| MCP 网关 | 聚合工具标记 `deferred`，`tool_search` 按需装载 | 34 台 server 的 schema 不再进每轮请求体；`mcp_tools` 目录仍常驻作为免搜索索引 |
| codemode | 常驻工具、**本体按高风险审批**、`models: false`、时限 10 分钟、堆限 256 MiB | README 的安全承诺不降级：脚本只有工具调用能力，逐次审批；不给脚本隐藏的模型花费通道 |

## Breaking changes 的落地

- **`ToolExecutionResult.content` → `output`**：生产与测试全部改名；另修 3 处类型检查漏报点（mcp-gateway 简写属性、subagent map、search/todo/web/workflow helper）。
- **bash 非零退出不再抛出**：改为 error result + `exit_code` 诊断（`Command exited with code N`）。应用删除了整个 `[exited with code N]` 文本包装器与相应描述，文案改为「看诊断」。
- **Storage 异常让 Session 永久失败**：审批落盘失败的用例改为断言 `SessionFailed`（含 cause 链），并用只读检查桩做「决策未写入」的尸检。
- **查询 `order` 字段**：官方 SQLite storage 已支持，应用无自定义实现。
- **pi-ai 每 token 字符数 4 → 3.5**：应用本就委托内核 `estimateTextTokens`，只更新了测试与注释口径。
- **`read` 原生读图**：`read` 在模型限制内直接返回图片块；超限时的 `unsupported_image` 诊断追加 `read_image` 提示（语义已从「类型不支持」变成「无法准备/超限」，替换文案不再撒谎）。
- **pi-mcp `structuredContent` 放宽为 `unknown`、pi-ai azure 改名、手写 stream 类型收紧**：应用均无使用，零改动。

## 验证证据

- 升级前基线：全量 2549/2558 通过（唯一失败为负载敏感钩子超时，隔离重跑通过）。
- 升级后全量：**196 文件通过 / 1 skipped；2553 用例通过 / 8 skipped**（`pi-upgrade-1.2-tests-*.log`）。
- `npm run typecheck` 全绿；`check:i18n` 751 词条两侧对齐。
- `npm run probe:kernel` 5/5（含新的 chord host 往返检查）；`npm run probe:plugins` 通过（真实 utilityProcess → 新链路 → 源码直载 toolkit → 4 工具 + hash 校验 + 进程退出）；打包探针见下。
- 新增/改写的测试：插件链路（内存端口握手/取消传播/retire/断开）、tool_search 装载与消费、codemode 沙箱内调用 `read`、**codemode 嵌套调用走审批（本体与嵌套各一次，写操作真落盘）**、durationMs 透传、compactionFailure 投影。

## 已知限制与后续

- **lint 已清零**：升级收尾追加一次机械修复提交 —— 新增 `.gitattributes`（`* text=auto eol=lf`，与 Biome 的 LF 口径一致，Windows 检出不再变 CRLF）+ 全仓 biome 格式/import 修复 + 测试文件豁免 `style/noNonNullAssertion`（`foo!` 是测试的「必须存在」断言，改成可选链只会让断言静默通过）；生产代码里的 `!` 改成了显式守卫。`npm run lint` 现为 **0 errors / 0 warnings**。
- **发布产物**：打包探针（`npm run probe:packaged` / `probe:plugins --packaged`）在 `npm run pack` 后运行，覆盖 asar 内 worker/plugin-api、wasm 资源与 unpacked 插件源码。
- **codemode 的嵌套审批**：脚本里的嵌套调用各自走审批链（已由自动化测试钉住：本体 + 嵌套 `write` 各一张卡、放行后真实落盘）；手动验收提示词仍保留对应的界面检查项。
- **tool_search 的 defer 集合**：v1 只延迟 MCP 聚合工具；浏览器/插件工具保持常驻，后续可按同一机制扩展。
- 插件描述状态的异步更新：需要在 Chord 根内写入且 principal 与记录一致（在方法里用 ctx 写入最自然），已写入作者文档。
