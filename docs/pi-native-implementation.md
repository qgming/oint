# Pi 1.0.0 原生生态重构实施记录

> **历史记录（1.0.0 时代的实施快照）**：包集合、插件加载方式（bundle 预构建）与本文所述的部分细节已被 [Pi 1.0.0 → 1.2.0 升级记录](pi-upgrade-1.2.md) 取代；保留用于回溯当时的实施决策。

本次按已确认方案实施，排除 `pi-coding-agent`、`pi-tui` 和无关 CLI/TUI 依赖，不保留旧插件格式、旧 RPC 或旧事件协议兼容层。优化依据见 [调研报告](pi-native-optimization-report.md)，插件作者接口见 [原生插件 API](plugin-native-api.md)。

## 依赖和构建

直接使用的七个生态包均精确固定为 1.0.0：`chord`、`pi-ai`、`pi-durable`、`pi-mcp`、`pi-client`、`pi-server`、`pi-protocol`。原生环境要求 Node ≥22.19.0。

`npm run check:pi` 校验整个 lockfile 的 Pi 版本，并拒绝直接或间接引入 coding-agent/TUI。`build`、`dev` 和测试前使用官方 `bundleFacetPackage` 构建内置插件。构建产物不作为另一份源码维护。

## 插件

- 包身份使用 `package.json`，桌面显示、资源和权限元信息放在 `oint`，代码入口使用 Chord facets 与官方构建清单。
- 代码仍运行在 Electron utilityProcess。Chord 负责 bundle 完整性、加载、服务和释放；Pi Client/Server/Protocol 负责握手、帧、请求、取消与订阅。
- 每插件产生原生 Durable Extension，直接注册工具、提示段及 native hooks。移除旧 init/ready/call/hook 协议、独立 hook chain、插件工具目录网关与手写工具 generation。
- `toolkit` 注册四个工具；Git 面板与速记界面保留。ZIP 安装、开发目录、启停、重载、卸载和私有数据仍可用。
- 候选 extension 先通过原生 Registry 校验再发布；失败不替换正在工作的版本。已经开始的服务调用持有旧进程直至结束，尚未开始的旧调用在版本退役后明确失败。
- 项目来源、分区、协议资源和界面权限绑定工作区。切换项目前撤销旧项目界面；全局 Git 面板仍可跟随当前目录。停用插件后旧 guest 不能继续访问能力。
- MCP 配置按来源和 cwd 隔离，调用入口也检查范围；对原始来源和成员名称计算 ID，避免归一化覆盖。

跨进程接口只传可序列化服务数据，不伪装成能远程传递 `commit(callback)` 的完整 ToolExecutionApi。进程故障隔离与宿主能力检查保留，未将它们称为 OS 沙箱。

## 任务与持久状态

- 主聊天及其子代理共享一个家族 Harness/storage。子视图只引用原生 Conversation，不单独创建 SQLite、不拥有关闭家族存储的权限。
- 子代理用 background anchor、原生任务和 task-owned Conversation 实现。并发准入、子会话和报告引用同事务建立；稳定 requestId 防止恢复时重复发输入。
- 删除子代理运行/spec/名额 Map 和 JSON 运行记录。Task 系列从原生文档/任务查询状态，报告更新原工具卡与后续工具结果投影，不自动提交父 follow-up。
- Todo 使用 rewindable/asOf document 和任务级结果，实现原子修改、分支截止点恢复和幂等重放。
- 审批与提问使用原生 owned tasks、待决 documents 和 memo。决定先提交再反馈；memo 与最终工具及参数绑定。取消、超时、重启和重复答复不依赖旧 resolver 表。
- 后台作业的状态、输出游标、保留窗口和报告进入原生 document/task。只有实际 OS 进程句柄留在内存；启动尝试先落盘，崩溃后不会自动重复执行任意命令。

独立主聊天保持文件级删除；独立新聊天分支仍保留必要的快照与附件复制。官方 1.0.0 没有单 Conversation 物理删除 API，未通过修改其内部 SQL 伪造这项能力。

## 界面、元数据和统计

- 删除旧 `runtime-events.ts` 以及重复的流式内容、工具输出、队列折叠。
- `Conversation.watch()` 是实时状态来源；纯展示投影经过 Chord ops 到 renderer，带 mount generation/revision。完整历史继续独立分页，报告可以覆盖已离开 active context 的历史工具卡。
- `watchEvents` 仅作为性能计时观察，不再重建聊天状态。Token 总量来自原生 UsageDoc；上下文估算与耗时属于单独派生指标。
- 会话元数据和性能存入 native documents。JSON 索引只是可删除缓存；离线修改使用串行、短生命周期的官方 Session，不占用后续 Harness 的配置。
- 日期用量根据已提交的模型和工具账本记录，包含失败及压缩支出。保留 400 个日期桶；没有可靠日期的差额仍计入原生总量，并明确标注，日期图表不冒充这部分已有日期。
- 统计不再维护 `usage-stats.json` 第二份账本，不通过扫描 assistant 历史来推测全部花费。未打开的家族只短暂读取，已有 owner 则复用。

## 验证命令

```sh
npm run check:pi
npm run typecheck
npm run lint
npm test -- --maxWorkers=4 --reporter=dot
npm run check:i18n
npm run check:unwired
npm run probe:kernel
npm run probe:plugins
npm run pack
npm run probe:packaged
npm run probe:plugins:packaged
npm run probe:stats
```

统计探针生成隔离的原生 SQLite 合成样本：725 总量、650 有日期、75 无日期，不读取或复制用户数据库。插件探针使用真实 Electron utilityProcess，打包模式使用实际 ASAR worker 和已解包的 Chord 资源。

真实模型端到端脚本已改用 committed snapshot，但没有在本次工作中发起付费模型请求或 OAuth 登录。启动后的手动测试提示词见 [手动验收提示词](manual-acceptance-prompt.md)。

## 最终验证结果

| 检查 | 结果 |
| --- | --- |
| `check:pi` | 全部相关包为 1.0.0；依赖树无 coding-agent/TUI |
| TypeScript / Biome | 通过；573 个文件无 lint 错误或警告 |
| 整仓测试 | **2436 通过，18 跳过**；188 个测试文件通过，1 个跳过 |
| i18n / 未接线检查 | 724 个中英文键一致；无新增未接线组件 |
| `npm run pack` | 通过，生成 `release/win-unpacked/Oint.exe` |
| 打包内核探针 | **5/5**，严格从 ASAR 解析实际依赖，无开发目录回退 |
| 插件进程探针 | 开发版与实际 ASAR worker 均通过；验证 Chord bundle、Pi RPC 与四个工具 |
| 真实 Electron 统计 UI | **40/40**，验证 725/650/75 分账、图表、重载与无渲染错误 |
| 真实 Electron 插件模态界面 | **18/18**，验证发现、权限、webview、桥、私有存储与关闭 |
| 独立代码复核 | 各阶段阻断问题均已修复并通过针对性回归 |

最终回归还覆盖了项目切换后旧界面权限失效、停用插件后 guest 能力被拒绝、原始 MCP 名称不碰撞、重试账本/性能隔离、日期日志故障不阻断聊天列表、重新挂载不丢历史、旧首页响应丢弃、快照缺口期间再次补拉，以及停止后的延迟附件不会启动新运行。

测试使用真实原生 Harness/存储、可控模型流、真实本地进程和 Electron。18 项跳过包含外部 MCP 联网验证；未发起真实模型付费调用或 OAuth 交互登录，留给配置模型后的手动验收。
