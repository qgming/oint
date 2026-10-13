---
name: plugin-authoring
description: 创建或修改 Oint 插件，包括 Chord agent facet、工具、原生工具钩子、技能、提示、MCP 和桌面面板。产出可加载的 package.json 插件目录。
---

# Oint 插件

插件是一个目录：`package.json` + 可选的 `agent.ts`（Chord facet 源码）+ 资源文件。宿主示例看仓库的 `src/main/plugins/plugin-api.ts`、`src/main/plugins/manifest.ts` 与 `resources/plugins/toolkit/agent.ts`。

在当前项目的 `.oint/plugins/<name>/` 创建源码。项目插件、全局安装包和开发挂载默认停用，由用户在插件管理中启用。

## 包结构

```text
package.json
agent.ts                    # 可选的 Chord agent facet 源码（直接运行，无需构建）
skills/<name>/SKILL.md
prompts/<name>.md
subagents/<name>.md
mcp.json
ui/index.html
```

```json
{
  "name": "@example/helper",
  "version": "1.0.0",
  "description": "Describe the feature",
  "type": "module",
  "peerDependencies": { "@earendil-works/chord": "1.2.0" },
  "chord": { "facets": { "agent": "./agent.ts" } },
  "oint": {
    "displayName": "Helper",
    "permissions": ["agent.tool.register", "skills.contribute"]
  }
}
```

只贡献界面或文件时省略 `chord` 和 `agent.ts`。包名是身份，宿主据此分配私有数据、面板分区与工具名称。安装的 ZIP 直接放源码（不需要 `dist/`）；宿主在子进程里用 Node 类型剥离直接加载 `.ts`，因此：**只允许可擦除的 TS 语法**（不要 enum / namespace / 参数属性），**相对导入必须带 `.ts` 扩展名**（`import { x } from "./util.ts"`），且 `"type": "module"` 必须声明。**不引入第三方 npm 依赖**（插件目录没有 node_modules；宿主只提供下述坐标）。

## Agent facet（`agent.ts`）

```ts
import { cell, defineFacet } from "@earendil-works/chord";
import { PluginAgent, pluginAgentDescriptionSchema } from "oint:plugin";

export default defineFacet((host) => {
  host.serve(
    PluginAgent,
    (_input, _principal, self) => {
      const state = self.state({
        description: cell(pluginAgentDescriptionSchema, { tools: [], commands: [], sections: [] }),
      });
      return {
        kind: "default",
        description: state.description,
        async execute({ name, args, invocation }, ctx) {
          ctx.signal.throwIfAborted();          // 取消走 ctx.signal
          return { output: [{ type: "text", text: `${name} 收到 ${JSON.stringify(args)}` }] };
        },
        async command({ name, args, cwd }) { return `${cwd}: ${name} ${args}`; },
        async beforeTool({ call, invocation }) { return {}; },     // 或 { block } / { arguments }
        async afterTool({ call, result, invocation }) { return result; },
      };
    },
    { eager: true },
  );
});
```

可 import 的裸模块只有：`oint:plugin`（宿主契约与类型）、`@earendil-works/chord`（含 `/node`、`/context`、`/delta`）、`typebox`（含 `/value`），以及 Node 内置模块（`node:crypto` 等）。`import type` 只在类型检查期存在，运行时被剥离。

### 契约细节

- `description`：`{ tools, commands, sections }`。至多 64 个工具、64 个命令、32 个 section；工具名最长 40 字符、字母开头；工具参数必须是 JSON object schema。要更新描述就在**收到 ctx 的方法里**用 `state.description.change(ctx, draft => {...})` 或 `replace(ctx, value)` 写入 —— Chord 的写入需要根上下文与匹配的 principal。
- `execute` 的返回值：`{ output?, isError?, details?, diagnostics?, structuredOutput? }`。`output` 是给模型的内容块数组（`{type:"text",text}` / `{type:"image",data,mimeType}`）；`details` 是给界面的结构化数据。旧版的 `content` 字段已更名 `output`。
- `beforeTool` 返回 `{ arguments?, block? }`：改写参数或直接拦截（拦截后宿主不再执行原工具）。需要 `oint.hooks: ["beforeTool"]` 与 `hostHooks.register`。
- `afterTool` 返回新的工具结果（通常是改过 details 的同一份）。需要 `oint.hooks: ["afterTool"]`。
- 未使用的方法给空实现：`beforeTool` 返回 `{}`；`afterTool` 返回收到的 result；`command` 对不存在的命令抛错。

工具调用默认 120 秒、钩子 5 秒；超时与取消经 `ctx.signal` 到达插件。工具可配置 `replay`（默认 unsafe）、`executionMode`、`outputLimits`；随机数、时钟与外部写操作保持 unsafe。宿主自己的权限审批在插件钩子之后按最终参数检查 —— 不要尝试代替宿主批准工具。原生 Durable 的 task 函数、commit 回调与 ToolExecutionApi 不能穿过进程边界。

## 界面和资源

`oint.surfaces` 声明 `{id, kind, title, entry}`，kind 为 panel/modal/window，分别需要 ui.panel/ui.modal/ui.window。entry 是包内 `./` 相对路径。window 可用 width/height、shape:widget、alwaysOnTop、resizable、skipTaskbar；modal 只接受尺寸。

`window.oint` 提供 info、ready()、close()、workspace()、storage.get/set、notify、writeText、fetch、exec、on("theme", listener)。每项能力按真实权限检查：storage、notify、clipboard.write、net.fetch（配 oint.net.domains）、shell.exec（配 oint.shell.exec 裸命令白名单）。页面遵循宿主 CSP，不启用 Node。

skills、prompts、subagents 分别需要 skills.contribute、prompts.contribute、subagents.contribute。mcp.json 使用 `{mcpServers:{name:{command,args}|{url}}}`；本地需要 mcp.server.local，远端需要 mcp.server.remote。

插件跑在 utilityProcess 里（崩溃隔离，不是 OS 沙箱）。私有持久文件写到 `process.env.OINT_PLUGIN_DATA_DIR`（宿主会创建该目录并把子进程 cwd 切到那里）。

## 旧格式迁移

chord 1.0 的预构建包（含 `dist/chord-facets.json`）会被明确拒绝。迁移：删除 `dist/` 与 package.json 里的 `chord.external` / `chord.sourceMap`；补 `"type": "module"`；把 `agent.ts` 改成上面的新 facet 写法（`defineService`/`env.provide` 已不存在）；给相对导入补 `.ts` 扩展名。

交付前验证：包元数据、实际工具调用、取消（ctx.signal）、启停/更新与私有数据保留。验证完成后给出插件目录、功能和使用入口。
