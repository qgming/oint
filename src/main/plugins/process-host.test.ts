import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { type Ctx, type MutableReplicatedState, replicatedState } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, type ToolExecutionApi, type ToolHooks } from "@earendil-works/pi-durable";
import { describe, expect, it, vi } from "vitest";
import { validatePluginManifest } from "./manifest";
import type { PluginAgentDescription } from "./plugin-api";
import type { PluginProcess } from "./plugin-process";
import { createPluginProcessHost, type PluginProcessSource } from "./process-host";

async function source(): Promise<PluginProcessSource> {
  const dir = path.resolve(import.meta.dirname, "../../../resources/plugins/toolkit");
  const result = validatePluginManifest(
    JSON.parse(await readFile(path.join(dir, "package.json"), "utf8")),
  );
  if (!result.ok) throw new Error("fixture");
  return { id: result.manifest.id, dir, manifest: result.manifest };
}

/**
 * 内存替身：形状对齐新 PluginProcess（description 状态 + invoke(operation)）。
 * `service` 是子侧 PluginAgent 实现（单对象入参），测试可以直接改写它的方法。
 */
function process(
  version: string,
  sections: PluginAgentDescription["sections"] = [],
): PluginProcess & { service: Record<string, unknown> } {
  const description = replicatedState<PluginAgentDescription>({
    tools: [{ name: "test", description: version, parameters: { type: "object" } }],
    commands: [],
    sections,
  });
  const service = {
    description,
    execute: async () => ({ output: [{ type: "text" as const, text: version }] }),
    command: async () => version,
    beforeTool: async () => ({}),
    afterTool: async ({ result }: { result: unknown }) => result,
  };
  const fake = {
    description: description as unknown as PluginProcess["description"],
    alive: true,
    invoke: <T>(operation: (service: never, ctx: Ctx) => Promise<T>) =>
      operation(service as never, {} as Ctx),
    retire: vi.fn(),
    stop: vi.fn(),
  } satisfies PluginProcess;
  // validateAgentDescription 在宿主里会对订阅值做校验；替身明确引用它，防止它成为死代码。
  return Object.assign(fake, { service });
}
describe("native plugin extension publication", () => {
  it("registers real native sections when the source hash begins with a digit", async () => {
    const initial = await source();
    expect(createHash("sha256").update(initial.id).digest("hex")).toMatch(/^[0-9]/);
    const active = process("one", [{ key: "policy", text: "policy text" }]);
    const host = createPluginProcessHost({ start: async () => active });
    const native = createRegistry();
    host.subscribe(() => {
      for (const { extension } of host.extensions()) native.install(extension);
    });
    await host.sync([initial]);
    const extension = host.extensions()[0]?.extension;
    expect(extension?.sections?.[0]?.key).toMatch(/^p_[0-9][a-f0-9]+_policy$/);
    if (!extension) throw new Error("Missing native extension");
    expect(native.snapshot().extension(extension.name)).toBe(extension);
    expect(host.issues()).toEqual([]);
    host.stopAll();
  });
  it.each(["Policy", "1policy", "bad.key", "a b"])(
    "rejects section %s before publication while the previous invocation finishes",
    async (invalidKey) => {
      const initial = await source();
      const active = process("one", [{ key: "policy", text: "working" }]);
      let finish!: () => void;
      active.service.execute = async () => {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return { output: [{ type: "text" as const, text: "old completed" }] };
      };
      const candidate = process("two", [{ key: invalidKey, text: "bad" }]);
      const host = createPluginProcessHost({
        start: vi.fn().mockResolvedValueOnce(active).mockResolvedValueOnce(candidate),
      });
      await host.sync([initial]);
      const previous = host.extensions()[0]?.extension;
      const tool = previous?.tools?.[0];
      if (!previous || !tool) throw new Error("Missing prior native tool");
      const pending = tool.execute(
        {},
        { callId: "c", taskId: "t", conversationId: "s" } as unknown as ToolExecutionApi,
        BACKGROUND_CONTEXT,
      );
      await expect.poll(() => typeof finish).toBe("function");
      await host.sync([
        { ...initial, manifest: { ...initial.manifest, description: "candidate" } },
      ]);
      expect(host.extensions()[0]?.extension).toBe(previous);
      expect(active.retire).not.toHaveBeenCalled();
      expect(active.stop).not.toHaveBeenCalled();
      expect(candidate.stop).toHaveBeenCalledOnce();
      expect(host.issues()).toHaveLength(1);
      finish();
      expect(await pending).toMatchObject({ output: [{ text: "old completed" }] });
      host.stopAll();
    },
  );
  it("retains the previous native definition on invalid descriptor updates without normalizing collisions", async () => {
    const initial = await source();
    const active = process("one", [{ key: "policy", text: "working" }]);
    const host = createPluginProcessHost({ start: async () => active });
    await host.sync([initial]);
    const previous = host.extensions()[0]?.extension;
    if (!previous) throw new Error("Missing prior native extension");
    const state = active.service.description as MutableReplicatedState<PluginAgentDescription>;
    state.change(BACKGROUND_CONTEXT, (draft) => {
      draft.sections = [
        { key: "policy", text: "a" },
        { key: "Policy", text: "b" },
      ];
    });
    await expect.poll(() => host.issues().length).toBe(1);
    expect(host.extensions()[0]?.extension).toBe(previous);
    expect(active.retire).not.toHaveBeenCalled();
    host.stopAll();
  });
  it("shares global process across workspaces and publishes the replacement before retiring its predecessor", async () => {
    const initial = await source();
    const one = process("one");
    const two = process("two");
    const start = vi.fn().mockResolvedValueOnce(one).mockResolvedValueOnce(two);
    const host = createPluginProcessHost({ start });
    one.retire = vi.fn(() => {
      expect(host.extensions("/a")[0]?.extension.tools?.[0]?.description).toBe("two");
    });
    await host.sync([initial], "/a");
    await host.sync([initial], "/b");
    expect(start).toHaveBeenCalledTimes(1);
    expect(host.extensions("/a")[0]?.extension).toBe(host.extensions("/b")[0]?.extension);
    const updated = { ...initial, manifest: { ...initial.manifest, description: "updated" } };
    await host.sync([updated], "/a");
    // The other workspace has the same source identity; source publication updates both views.
    await host.sync([updated], "/b");
    expect(host.extensions("/a")[0]?.extension.tools?.[0]?.description).toBe("two");
    expect(one.retire).toHaveBeenCalledOnce();
    await host.sync([], "/a");
    expect(host.runningCount()).toBe(1);
    await host.sync([], "/b");
    expect(host.runningCount()).toBe(0);
    expect(two.retire).toHaveBeenCalledOnce();
  });
  it("keeps the last working generation if replacement startup fails", async () => {
    const initial = await source();
    const active = process("one");
    const host = createPluginProcessHost({
      start: vi
        .fn()
        .mockResolvedValueOnce(active)
        .mockRejectedValueOnce(new Error("bad candidate")),
    });
    await host.sync([initial]);
    const extension = host.extensions()[0]?.extension;
    await host.sync([{ ...initial, manifest: { ...initial.manifest, description: "changed" } }]);
    expect(host.extensions()[0]?.extension).toBe(extension);
    expect(active.retire).not.toHaveBeenCalled();
    expect(host.issues()[0]?.message).toContain("bad candidate");
    host.stopAll();
  });
  it("keeps a required native policy blocking when its worker cannot start", async () => {
    const initial = await source();
    initial.manifest.hooks = ["beforeTool"];
    initial.manifest.permissions.push("hostHooks.register");
    const host = createPluginProcessHost({
      start: async () => {
        throw new Error("offline");
      },
    });
    await host.sync([initial]);
    const handlers = host.extensions()[0]?.extension.hooks?.[0]?.handlers as ToolHooks;
    expect(
      await handlers.beforeTool(
        { name: "bash", id: "call", type: "toolCall", arguments: {} },
        {} as never,
        BACKGROUND_CONTEXT,
      ),
    ).toMatchObject({ block: expect.stringContaining("offline") });
    host.stopAll();
  });
});
