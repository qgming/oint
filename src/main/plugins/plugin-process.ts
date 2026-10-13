// 插件进程（父侧）：utilityProcess + chord 链接 + PluginAgent 句柄。
//
// 与 1.0 时代的区别：不再有 pi-client/pi-server 的字节协议与远程服务绑定 —— 子进程如今是一台
// chord host（name=plugin:<uuid>），父进程把它 accept 进共享的插件 host，然后以 `at` 拿句柄：
//   - 描述（description）是句柄上的状态，订阅方式与旧 ReplicatedState 相同（snapshot + delta）；
//   - 四个方法（execute/command/beforeTool/afterTool）直接调句柄，取消走 ctx.signal；
//   - 就绪/致命通过链路上的控制消息（{ ointControl: "ready" | "fatal" }）握手。
import { fileURLToPath } from "node:url";
import {
  type Context,
  type Ctx,
  type Handle,
  type Host,
  ipcLink,
  type Link,
} from "@earendil-works/chord";
import { buildChildEnv } from "@/main/security/child-env";
import {
  type RawLinkPort,
  toIpcChannel,
  utilityProcessPort,
} from "./link";
import { PLUGIN_HOST_PREFIX, PluginAgent } from "./plugin-api";

export type PluginAgentHandle = Handle<typeof PluginAgent>;
export type PluginAgentChannel = ReturnType<typeof toIpcChannel>;

export interface PluginProcess {
  readonly description: PluginAgentHandle["description"];
  readonly alive: boolean;
  invoke<T>(
    operation: (service: PluginAgentHandle, ctx: Ctx) => Promise<T>,
    parent: Context,
    timeoutMs?: number,
  ): Promise<T>;
  /** Retire after existing invocations finish; new registry publication points to a new process. */
  retire(): void;
  stop(): void;
}

export interface PluginProcessOptions {
  pluginId: string;
  pluginDir: string;
  /** 插件 agent 入口的绝对路径（chord.facets.agent 解析后的真实文件）。 */
  entryPath: string;
  dataDir: string;
  /** 覆盖 worker 入口（探针/测试用；默认 dist-electron 的 plugin-worker.js）。 */
  workerEntry?: string;
  onExit: (message: string) => void;
}

export type PluginProcessFactory = (
  options: PluginProcessOptions & { host: Host },
) => Promise<PluginProcess>;

const READY_TIMEOUT_MS = 20000;

interface ControlMessage {
  ointControl?: "ready" | "fatal";
  stage?: string;
  message?: string;
}

/** 等子进程的 ready / fatal / 断开。 */
function waitReady(channel: PluginAgentChannel): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      channel.off("disconnect", onDisconnect);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(
      () => finish(new Error(`插件进程在 ${READY_TIMEOUT_MS}ms 内没有就绪`)),
      READY_TIMEOUT_MS,
    );
    const onDisconnect = (): void => finish(new Error("插件进程连接已断开"));
    channel.onControl((raw) => {
      const message = raw as ControlMessage;
      if (message?.ointControl === "ready") finish();
      else if (message?.ointControl === "fatal")
        finish(new Error(`插件启动失败（${message.stage ?? "unknown"}）：${message.message ?? ""}`));
    });
    channel.on("disconnect", onDisconnect);
  });
}

/**
 * 把一个已经建立的链路接入宿主：accept 子 host、等就绪、拿句柄。
 * 生产路径由 startPluginProcess 调用；测试可以用内存端口直接调它。
 *
 * 端口→channel→link 三步在这里**同步**完成：端口在监听者出现前可能已经攒了消息
 *（真实 Electron 端口会排队，内存端口也会），中间隔出别的同步步骤就会把 hello 丢掉。
 */
export async function attachPluginProcess(options: {
  host: Host;
  port: RawLinkPort;
  hostName: string;
  onExit: (message: string) => void;
  kill: () => void;
}): Promise<PluginProcess> {
  const { host, hostName, onExit, kill } = options;
  const channel = toIpcChannel(options.port);
  const link: Link = ipcLink(channel);
  let stopping = false;
  let retired = false;
  let calls = 0;
  let handle: PluginAgentHandle | undefined;

  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    handle?.release();
    handle = undefined;
    if (!link.closed) link.close("plugin stopped");
    kill();
  };

  link.onClose((reason) => {
    if (!stopping) onExit(`插件进程连接已断开：${reason}`);
  });

  try {
    host.accept(link, { principal: { host: "oint" }, kind: "host", name: hostName });
    await waitReady(channel);
    handle = host.get(PluginAgent, {}, { at: hostName });
  } catch (error) {
    stop();
    throw error;
  }

  const service = handle;
  return {
    description: service.description,
    get alive() {
      return !stopping && !link.closed;
    },
    async invoke(operation, parent, timeoutMs = 120000) {
      if (stopping || retired) throw new Error("插件版本已卸载，请重试调用");
      calls += 1;
      // 取消桥接：pi-durable 的调用上下文（AbortSignal）→ Chord 根（RootOptions.signal）。
      const signals = [AbortSignal.timeout(timeoutMs)];
      const parentSignal = (parent as { abortSignal?: AbortSignal }).abortSignal;
      if (parentSignal !== undefined) signals.push(parentSignal);
      const signal = AbortSignal.any(signals);
      try {
        return await host.root((ctx) => operation(service, ctx), { signal });
      } finally {
        calls -= 1;
        if (retired && calls === 0) stop();
      }
    },
    retire() {
      retired = true;
      if (calls === 0) stop();
    },
    stop,
  };
}

export const startPluginProcess: PluginProcessFactory = async (options) => {
  const { utilityProcess } = await import("electron");
  const hostName = `${PLUGIN_HOST_PREFIX}${crypto.randomUUID()}`;
  const env = {
    ...buildChildEnv(),
    OINT_PLUGIN_ENTRY: options.entryPath,
    OINT_PLUGIN_HOST_NAME: hostName,
    OINT_PLUGIN_DATA_DIR: options.dataDir,
  };
  const workerEntry =
    options.workerEntry ?? fileURLToPath(new URL("./plugin-worker.js", import.meta.url));
  const child = utilityProcess.fork(workerEntry, [], {
    cwd: options.pluginDir,
    env,
    stdio: "pipe",
    serviceName: `Oint plugin: ${options.pluginId}`,
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-4096);
  });
  child.stdout?.resume();
  const port: RawLinkPort = utilityProcessPort(child);
  try {
    return await attachPluginProcess({
      host: options.host,
      port,
      hostName,
      onExit: (message) => options.onExit(`${message}${stderr ? `: ${stderr}` : ""}`),
      kill: () => port.kill(),
    });
  } catch (error) {
    port.kill();
    throw new Error(
      `插件启动失败：${error instanceof Error ? error.message : String(error)}${stderr ? `: ${stderr}` : ""}`,
      { cause: error },
    );
  }
};
