# 更新日志

本文件记录 Oint 的重要变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.1.0] - 2026-11-02

首个公开版本。项目从 PolarAgent 重构并重命名为 **Oint**，基于 Pi 1.2.0 原生生态重新实现。

### Added

- **桌面 Agent 工作台**：Electron 44 + React 19 + assistant-ui，主进程独占 Agent 运行时，渲染进程零特权。
- **Pi 1.2.0 原生生态**：精确固定 pi-ai / pi-durable / pi-mcp / Chord / pi-codemode，包含 `tool_search` 延迟工具网关与 QuickJS `codemode` 沙箱。
- **原生工具集**：`bash` / `read` / `write` / `edit` / `grep` / `glob` / `todo` / `read_image`，以及只读免审批的 `web_search` / `web_fetch`。
- **内置浏览器**：右侧 `<webview>` 面板与九个 `browser_*` 工具，支持导航、页面读取、真实点击与输入、截图、控制台和网络记录。
- **技能与魔法提示**：SKILL.md 四层来源、14 条内置工作流提示、项目级 `.oint/` 覆盖、zip 导入与中英双语设置面板。
- **MCP 系统预设**：34 个零配置远端服务默认开启；每个 server 聚合为单个延迟工具，`mcp_tools` 按需读取完整 schema。
- **子智能体**：七个内置预设、自定义定义、并发与重复调用保护、报告自动投递、重启后进度恢复。
- **会话能力**：SQLite 持久化、项目分组、置顶 / 归档、任意消息分支、分页历史、Ctrl+K 全局搜索与 Ctrl+F 会话内查找。
- **权限与安全**：默认权限 / 帮我审批 / 完全访问三档模式、审批卡与「始终允许」规则、路径守卫、命令黑名单、`safeStorage` 凭据加密。
- **数据统计**：用量总览、年度热力图、日期趋势与模型用量，压缩、失败和工具支出均计入账本。
- **chord 1.2 插件系统**：宿主运行时、源码直载、utilityProcess 隔离、插件权限表与内置 `toolkit` 示例。
- **工程化**：GitHub Actions CI 与跨平台打包、完整 Vitest 测试、Biome lint/format、打包探针与端到端冒烟脚本。

### Changed

- 项目名称、包名、应用 ID、数据目录、仓库地址与文档全面迁移到 **Oint** / `oint`。
- 会话与配置改用 Pi 原生文档与 SQLite 存储，移除旧版 JSON / 兼容层。
- 版本号重置为 `0.1.0`，开始新的发布线。

### Fixed

- **打包后 codemode 不可用**：`@earendil-works/pi-codemode` 改为直接依赖并 externalize；worker 随包解到 `app.asar.unpacked`，运行时显式指定 `workerUrl`（worker_threads 无法从 asar 加载入口）。
- **插件热重载漏更新**：源码签名现在覆盖插件目录内所有文件（含入口 import 的 helper），不再只哈希入口文件。
- **插件退出被硬杀**：父进程先关链路并留 1.5s 收尾窗口，worker 同时处理 SIGTERM / SIGINT，避免 durable 写入被截断。
- **上下文工具估算重复计数**：内置扩展不再重复追加，刷新路径改用实际选中的工具表。
- **压缩失败时间戳**：未解决的压缩失败不再沿用上一次成功压缩的时间，优先使用失败任务的记录时间。
- **历史工具耗时缺失**：`durationMs` 经 `providerMetadata` 透出，作为 live run 起止缺失时的回退。
- **插件控制监听泄漏**：`waitReady` 结束时退订 control 监听；`toIpcChannel` 的 `connected` 保持实时 getter。
- **toolkit 原型链查找**：工具名改为无原型表查找，`toString` / `__proto__` 不再命中继承属性。

### Removed

- 清理早期 PolarAgent 时代的设计稿、实施计划与调研记录；需要回溯时见 Git 历史。
- 移除不再使用的旧插件传输协议、旧构建脚本与遗留资源。

### Notes

- 安装包由 `Package` workflow 生成：Windows NSIS、macOS zip、Linux AppImage / deb / rpm / tar.gz。
- 首个版本不提供旧版本数据迁移，更换数据目录即视为全新开始。