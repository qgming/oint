// 插件进程链路契约（chord 1.2 新运行时）：
//   - 父进程 attach（accept + ready 握手 + 句柄）后可以 invoke 方法、订阅描述状态；
//   - 调用方取消/超时经 Chord 根的信号传到子侧执行的 ctx.signal；
//   - retire 保留在飞调用、拒绝新调用、结束即停；
//   - 断开让未决调用兑现（拒绝）。
// 子侧用内存端口 + 内存 facet（不落盘、不起进程），语义与 worker.ts 的子 host 相同。
import {
  type Ctx,
  cell,
  createHost,
  type Draft,
  defineFacet,
  ipcLink,
} from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryPortPair, toIpcChannel } from "./link";
import {
  PluginAgent,
  type PluginAgentDescription,
  pluginAgentDescriptionSchema,
} from "./plugin-api";
import { attachPluginProcess } from "./plugin-process";

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const description: PluginAgentDescription = {
  tools: [{ name: "echo", description: "Echo", parameters: { type: "object" } }],
  commands: [],
  sections: [],
};

async function setup(execute: (ctx: Ctx) => Promise<string> = async () => "ok") {
  let updateImpl: ((name: string) => void) | undefined;
  const update = (name: string): void => updateImpl?.(name);
  const [parentRaw, childRaw] = createMemoryPortPair();
  const childHost = createHost({
    name: "plugin:test",
    upstream: ipcLink(toIpcChannel(childRaw)),
  });
  cleanups.push(() => childHost.close());
  const facet = defineFacet((childApi) => {
    childApi.serve(PluginAgent, (_input, _principal, self) => {
      const state = self.state({
        description: cell(pluginAgentDescriptionSchema, structuredClone(description)),
      });
      updateImpl = (name) => {
        // cell 的写入需要一个 Chord 根（Ctx），且 principal 必须与该记录一致：
        // 父 host 取走的这份记录以 `{host: 父host名}` 为 principal（上游链路的规则）。
        void childHost
          .root(
            (ctx) => {
              state.description.change(ctx, (draft: Draft<PluginAgentDescription>) => {
                if (draft.tools[0]) draft.tools[0].description = name;
              });
            },
            { principal: { host: "oint-plugins" } },
          )
          .catch(() => undefined);
      };
      return {
        kind: "default",
        description: state.description,
        async execute(_args, ctx) {
          const text = await execute(ctx);
          return {
            output: [{ type: "text", text }],
            // F4：structuredOutput 也要原样过桥（1.2.0 的程序化调用通道）
            structuredOutput: { text },
          };
        },
        async command() {
          return "command";
        },
        async beforeTool() {
          return {};
        },
        async afterTool({ result }) {
          return result;
        },
      };
    });
  });
  const host = createHost({ name: "oint-plugins" });
  cleanups.push(() => host.close());
  const processPromise = attachPluginProcess({
    host,
    port: parentRaw,
    hostName: "plugin:test",
    onExit: () => {},
    kill: () => {
      void childHost.close();
    },
  });
  await childHost.load([{ ...facet, name: "test" }]);
  childRaw.post({ ointControl: "ready" });
  const process = await processPromise;
  cleanups.push(() => process.stop());
  return { process, update };
}

const invoke = (
  process: Awaited<ReturnType<typeof setup>>["process"],
  parent = BACKGROUND_CONTEXT,
  timeout?: number,
) =>
  process.invoke(
    (service, ctx) =>
      service.execute(
        {
          name: "echo",
          args: {},
          invocation: { callId: "c", taskId: "t", conversationId: "s", cwd: "" },
        },
        ctx,
      ),
    parent,
    timeout,
  );

describe("plugin host link (chord 1.2)", () => {
  it("invokes PluginAgent.execute and hydrates/updates the description state", async () => {
    const { process, update } = await setup();
    expect(await invoke(process)).toMatchObject({
      output: [{ text: "ok" }],
      // 结构化输出随结果原样过桥（codemode/嵌套调用的通道）
      structuredOutput: { text: "ok" },
    });
    // 远端状态成员需要订阅才会持续推送增量（process-host 同样是订阅方）。
    const stop = process.description.subscribe(() => {});
    cleanups.push(stop);
    update("New description");
    await expect
      .poll(() => process.description.value?.tools[0]?.description)
      .toBe("New description");
  });

  it("delivers caller cancellation to the plugin execution context", async () => {
    let started = false;
    let cancelled = false;
    const { process } = await setup(
      (ctx) =>
        new Promise((_resolve, reject) => {
          started = true;
          ctx.signal.addEventListener(
            "abort",
            () => {
              cancelled = true;
              reject(ctx.signal.reason);
            },
            { once: true },
          );
        }),
    );
    const controller = new AbortController();
    const call = invoke(process, withAbortSignal(controller.signal, BACKGROUND_CONTEXT));
    const rejected = expect(call).rejects.toBeDefined();
    await expect.poll(() => started).toBe(true);
    controller.abort();
    await rejected;
    await expect.poll(() => cancelled).toBe(true);
  });

  it("keeps a started invocation alive while retiring its generation", async () => {
    let finish!: (value: string) => void;
    const { process } = await setup(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const call = invoke(process);
    await expect.poll(() => typeof finish).toBe("function");
    process.retire();
    expect(process.alive).toBe(true);
    await expect(invoke(process)).rejects.toThrow("卸载");
    finish("old generation finished");
    expect(await call).toMatchObject({ output: [{ text: "old generation finished" }] });
    expect(process.alive).toBe(false);
  });

  it("deadline cancels remote execution and disconnected calls settle", async () => {
    let cancelled = false;
    const { process } = await setup(
      (ctx) =>
        new Promise((_resolve, reject) => {
          ctx.signal.addEventListener(
            "abort",
            () => {
              cancelled = true;
              reject(new Error("cancelled"));
            },
            { once: true },
          );
        }),
    );
    await expect(invoke(process, BACKGROUND_CONTEXT, 30)).rejects.toBeDefined();
    await expect.poll(() => cancelled).toBe(true);
    const pending = invoke(process);
    const rejected = expect(pending).rejects.toBeDefined();
    process.stop();
    await rejected;
  });
});
