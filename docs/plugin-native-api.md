# Native plugin implementation (chord 1.2)

2026-10-14. 本次升级把插件子系统整体迁到 chord 1.2 的 host 运行时；旧的 facet bundle / pi-client / pi-server 协议栈全部移除。面向插件作者的使用说明见内置技能 plugin-authoring；现成例子在 `resources/plugins/toolkit`。

## 模型

- **插件子进程 = 一台 Chord host**（`createHost({ name: "plugin:<uuid>", loader: nodeLoader, upstream: ipcLink(...) })`），父进程把它 `accept` 进共享的插件 host（`oint-plugins`），再以 `at: "plugin:<uuid>"` 拿 `PluginAgent` 句柄。
- **契约**：`plugin-api.ts` 用 `remote("oint.plugin.agent", …)` 定义宿主与插件共用的对象——`description` 状态 + `execute/command/beforeTool/afterTool` 四个方法（单对象入参，取消走 Chord 的 `ctx.signal`）。
- **源码直载**：插件以 `.ts` 源码分发，子进程用 `nodeLoader` 直接导入（Node 类型剥离）。没有 bundler、没有 `dist/chord-facets.json`；旧格式包会被 `artifact.ts` 以明确错误拒绝。
- **依赖供给**：插件目录没有 node_modules。worker 入口在注册 resolve hook **之前**预解析白名单说明符（`oint:plugin` → dist-electron/plugin-api.js；`@earendil-works/chord`(+node/context/delta)；`typebox`(+value)），运行期由 hook 短路映射；其余裸导入由 Node 原生解析（对插件目录通常失败）。
- **握手**：链路是 Electron utilityProcess 的 MessagePort，经 `link.ts` 适配成 chord 的 IpcChannel（消息在监听者出现前缓冲，避免把 hello 吃掉）。子进程 `host.load([entry])` 成功后发 `{ ointControl: "ready" }`；致命错误发 `{ ointControl: "fatal" }` 后退出。
- **生命周期**：`retire()` 等在飞调用结束再停；`stop()` 释放句柄、关链路、杀进程。死链由 `onExit` 上报，`process-host` 把该插件的发布降级为「策略不可用」扩展（beforeTool 阻塞而不是静默消失）。

## 宿主侧装配（process-host.ts）

- 每个 source 目录一个子进程，签名 = 入口文件内容哈希 + manifest；内容变则替换新一代。
- `description` 是远端状态：订阅带 `undefined` 守卫（远端快照到达前可能先给 undefined），首发值用 `firstDescription` 等待；校验（`validateAgentDescription`）失败保留上一代已发布定义。
- 每个插件发布一个独立 Durable Extension：直接公开每个工具的 schema、静态 sections、beforeTool/afterTool 钩子。钩子/工具调用分别限时 5s / 120s。

## 兼容与安全

- **旧产物**：含 `dist/chord-facets.json` 的包在安装/加载时得到 `LegacyPluginArtifactError`，附迁移说明（删掉 dist、给 package.json 加 `"type": "module"`、入口保持 `.ts`）。
- **写入 principal**：插件更新自己的 `description` 需要 Chord 根（`Ctx`）且 principal 与记录一致（父侧取走的记录 principal 为 `{ host: <父host名> }`，即 `oint-plugins`）。在方法里用收到的 `ctx` 写入即可。
- 权限面不变：宿主仍按 `oint.permissions` 装配工具/钩子/section；进程隔离仍只是崩溃隔离，不宣称 OS 沙箱。

## 验证

```text
npx vitest run src/main/plugins
node scripts/probe-native-plugins.mjs
node scripts/probe-native-plugins.mjs --packaged   （需先 npm run pack）
```

打包探针从 app.asar 启动真实 worker、解析打包后的官方依赖、加载 app.asar.unpacked 里的 toolkit 源码、调用原生 hash 工具并验证 utilityProcess 退出。
