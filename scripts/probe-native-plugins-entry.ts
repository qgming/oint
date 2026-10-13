import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { app } from "electron";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createPluginProcessHost } from "../src/main/plugins/process-host";
import { validatePluginManifest } from "../src/main/plugins/manifest";
import { startPluginProcess } from "../src/main/plugins/plugin-process";

async function main(): Promise<void> {
await app.whenReady();
const archive = process.env.OINT_PLUGIN_PROBE_ARCHIVE;
const workerEntry = archive ? ["plugin-worker.js", "plugin-worker.mjs"].map((name) => path.join(archive, "dist-electron", name)).find(existsSync) : undefined;
if (archive && !workerEntry) { console.error("Packaged plugin worker missing; run npm run pack first"); app.exit(1); return; }
const host = createPluginProcessHost({ start: (options) => startPluginProcess({ ...options, workerEntry }) });
try {
  const dir = path.join(process.env.OINT_PLUGIN_PROBE_ROOT!, "resources/plugins/toolkit");
  const parsed = validatePluginManifest(JSON.parse(await readFile(path.join(dir, "package.json"), "utf8")));
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  await host.sync([{ id: parsed.manifest.id, manifest: parsed.manifest, dir }]);
  if (host.issues().length) throw new Error(JSON.stringify(host.issues()));
  const tools = host.extensions()[0]?.extension.tools ?? [];
  const hash = tools.find((tool) => tool.name.endsWith("_hash"));
  if (tools.length !== 4 || !hash) throw new Error("Toolkit did not publish four native tools");
  const result = await hash.execute({ text: "abc" }, { callId: "probe", taskId: "probe", conversationId: "probe", env: { cwd: dir } } as never, BACKGROUND_CONTEXT);
  if (!JSON.stringify(result).includes("ba7816bf8f01cfea414140de5dae2223")) throw new Error(`Unexpected toolkit hash: ${JSON.stringify(result)}`);
  const uuid = tools.find((tool) => tool.name.endsWith("_uuid"));
  if (uuid?.replay !== "unsafe") throw new Error("UUID replay policy is unsafe");
  const pluginPid = app.getAppMetrics().find((metric) => `${metric.name ?? ""} ${metric.serviceName ?? ""}`.includes("dev.oint.toolkit"))?.pid;
  if (!pluginPid) throw new Error("Plugin utilityProcess was not present in Electron process metrics");
  console.log(`PASS ${archive ? "packaged ASAR worker/dependencies + unpacked artifact" : "development worker"}: Electron utilityProcess → Chord 1.2 host link (source-loaded facet) → native Durable toolkit (4 tools)`);
  host.stopAll();
  for (let i = 0; i < 30 && pluginPid && app.getAppMetrics().some((metric) => metric.pid === pluginPid); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  if (pluginPid && app.getAppMetrics().some((metric) => metric.pid === pluginPid)) throw new Error("Plugin utilityProcess did not exit after disposal");
  app.exit(0);
} catch (error) { console.error(error); host.stopAll(); app.exit(1); }

}
void main();
