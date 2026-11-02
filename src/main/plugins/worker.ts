// 插件子进程入口（chord 1.2 新 host 运行时）。
//
// 执行流程：
//   1. 安装 resolve hooks：`oint:plugin` → 应用随包分发的契约模块；`@earendil-works/chord*`
//      与 `typebox*` → 从应用自身解析（插件目录没有 node_modules，必须由宿主供给）；
//   2. createHost({ name, loader: nodeLoader, upstream: ipcLink(port) }) 连上父进程；
//   3. host.load([插件 agent 入口])（源码直载：.ts 由 Node 类型剥离执行）；
//   4. 向父进程发就绪控制消息；链路关闭即收摊。

import { mkdirSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHost, ipcLink } from "@earendil-works/chord";
import { nodeLoader } from "@earendil-works/chord/node";
import { parentPortPort, toIpcChannel } from "./link";

/** 供插件代码使用的裸模块说明符白名单：在注册 hook 之前全部预解析（见 installResolveHooks）。 */
const HOSTED_SPECIFIERS = [
  "@earendil-works/chord",
  "@earendil-works/chord/node",
  "@earendil-works/chord/context",
  "@earendil-works/chord/delta",
  "typebox",
  "typebox/value",
] as const;

function installResolveHooks(): void {
  // 文件名走变量：`new URL("./plugin-api.js", import.meta.url)` 会被 Vite 当资产内联
  //（.js 不在时它会落到同名 .ts 源文件，塞成 data:video/mp2t —— 运行时直接报未知模块格式）。
  const pluginApiFile = "plugin-api.js";
  const pluginApiUrl = new URL(pluginApiFile, import.meta.url).href;
  // 必须在 registerHooks 之前解析：hook 里再调 import.meta.resolve 会重新走 hooks，自递归爆栈。
  const hostedUrls = new Map<string, string>();
  for (const specifier of HOSTED_SPECIFIERS) {
    try {
      hostedUrls.set(specifier, import.meta.resolve(specifier));
    } catch {
      // 解析不了就不映射；插件 import 它时会拿到 Node 的原生报错。
    }
  }
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "oint:plugin") return { url: pluginApiUrl, shortCircuit: true };
      const url = hostedUrls.get(specifier);
      if (url !== undefined) return { url, shortCircuit: true };
      return nextResolve(specifier, context);
    },
  });
}

function fatal(
  parent: { postMessage(message: unknown): void },
  stage: string,
  error: unknown,
): void {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  try {
    parent.postMessage({ ointControl: "fatal", stage, message });
  } catch {
    // 端口已断：消息发不出去，交给进程退出码。
  }
  console.error(`[plugin-worker] ${stage} 失败:`, error);
  process.exit(1);
}

async function main(): Promise<void> {
  const parentPort = process.parentPort;
  const entry = process.env.OINT_PLUGIN_ENTRY;
  const hostName = process.env.OINT_PLUGIN_HOST_NAME;
  if (parentPort === undefined || entry === undefined || hostName === undefined) {
    throw new Error(
      "插件进程缺少启动参数（OINT_PLUGIN_ENTRY / OINT_PLUGIN_HOST_NAME / parentPort）",
    );
  }
  // 数据目录作为插件代码的 cwd（与旧版一致，插件可用它放自己的临时文件）。
  // 目录可能还不存在（首次装插件）：先创建；失败也不致命 —— 别让 chdir 拖垮整个插件进程。
  const dataDir = process.env.OINT_PLUGIN_DATA_DIR;
  if (dataDir !== undefined) {
    try {
      mkdirSync(dataDir, { recursive: true });
      process.chdir(dataDir);
    } catch (error) {
      console.error(`[plugin-worker] 无法进入插件数据目录：${String(error)}`);
    }
  }

  installResolveHooks();

  const channel = toIpcChannel(parentPortPort(parentPort));
  let closing = false;
  const shutdown = async (code: number): Promise<void> => {
    if (closing) return;
    closing = true;
    await host.close().catch(() => undefined);
    process.exit(code);
  };

  const host = createHost({
    name: hostName,
    loader: nodeLoader,
    upstream: ipcLink(channel),
    onError: (error) => {
      console.error("[plugin-worker] host 后台错误:", error);
    },
  });
  channel.on("disconnect", () => {
    void shutdown(0);
  });
  // 父进程的强制结束在 POSIX 上是 SIGTERM；给 dispose 一次收尾机会，
  // 未决的 durable 写入不会被硬杀截断。Windows 由父进程的延迟 kill 兜底。
  process.once("SIGTERM", () => {
    void shutdown(0);
  });
  process.once("SIGINT", () => {
    void shutdown(0);
  });

  try {
    await host.load([pathToFileURL(path.isAbsolute(entry) ? entry : path.resolve(entry)).href]);
  } catch (error) {
    fatal(parentPort, "load", error);
  }
  parentPort.postMessage({ ointControl: "ready" });
}

void main().catch((error: unknown) => {
  const parentPort = process.parentPort;
  if (parentPort !== undefined) fatal(parentPort, "bootstrap", error);
  else {
    console.error("[plugin-worker] bootstrap 失败:", error);
    process.exit(1);
  }
});
