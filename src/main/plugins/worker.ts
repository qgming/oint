// 插件子进程入口（chord 1.2 新 host 运行时）。
//
// 执行流程：
//   1. 安装 resolve hooks：`oint:plugin` → 应用随包分发的契约模块；`@earendil-works/chord*`
//      与 `typebox*` → 从应用自身解析（插件目录没有 node_modules，必须由宿主供给）；
//   2. createHost({ name, loader: nodeLoader, upstream: ipcLink(port) }) 连上父进程；
//   3. host.load([插件 agent 入口])（源码直载：.ts 由 Node 类型剥离执行）；
//   4. 向父进程发就绪控制消息；链路关闭即收摊。
import path from "node:path";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { createHost, ipcLink } from "@earendil-works/chord";
import { nodeLoader } from "@earendil-works/chord/node";
import { parentPortPort, toIpcChannel } from "./link";

/** 供插件代码使用的裸模块说明符白名单：其余一律走宿主自己的解析（对插件目录多半会失败）。 */
const HOSTED_SPECIFIERS = ["@earendil-works/chord", "typebox"];

function hosted(specifier: string): boolean {
  return HOSTED_SPECIFIERS.some(
    (name) => specifier === name || specifier.startsWith(`${name}/`),
  );
}

function installResolveHooks(): void {
  const pluginApiUrl = new URL("./plugin-api.js", import.meta.url).href;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "oint:plugin") return { url: pluginApiUrl, shortCircuit: true };
      if (hosted(specifier)) return { url: import.meta.resolve(specifier), shortCircuit: true };
      return nextResolve(specifier, context);
    },
  });
}

function fatal(parent: { postMessage(message: unknown): void }, stage: string, error: unknown): void {
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
  // 数据目录作为插件代码的 cwd 提示（与旧版一致，插件可用它放自己的临时文件）。
  const dataDir = process.env.OINT_PLUGIN_DATA_DIR;
  if (dataDir !== undefined) process.chdir(dataDir);

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
