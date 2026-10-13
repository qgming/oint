import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { builtinModules, createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "vite";

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "..");
const packaged = process.argv.includes("--packaged");
const archive = path.join(root, "release/win-unpacked/resources/app.asar");
const dir = await mkdtemp(path.join(tmpdir(), "oint-native-plugin-probe-"));
const deps = Object.keys(require("../package.json").dependencies);
try {
  await build({
    configFile: false, logLevel: "warn", resolve: { alias: { "@": path.join(root, "src") } },
    build: { target: "node22", outDir: path.join(dir, "compiled"), emptyOutDir: false,
      lib: { entry: { "plugin-worker": path.join(root, "src/main/plugins/worker.ts"), "plugin-api": path.join(root, "src/main/plugins/plugin-api.ts"), probe: path.join(root, "scripts/probe-native-plugins-entry.ts") }, formats: ["es"], fileName: (_format, name) => `${name}.js` },
      rolldownOptions: { external: (id) => id === "electron" || id.startsWith("node:") || builtinModules.includes(id) || deps.some((name) => id === name || id.startsWith(`${name}/`)) },
    },
  });
  // Compiled probes resolve official packages through a local node_modules junction, never global installs.
  const { symlink, writeFile } = await import("node:fs/promises");
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ type: "module" }));
  await symlink(path.join(root, "node_modules"), path.join(dir, "node_modules"), "junction");
  const env = { ...process.env, OINT_HOME: path.join(dir, "data"), OINT_PLUGIN_PROBE_ROOT: packaged ? `${archive}.unpacked` : root, ...(packaged ? { OINT_PLUGIN_PROBE_ARCHIVE: archive } : {}) };
  delete env.ELECTRON_RUN_AS_NODE;
  const code = await new Promise((resolve, reject) => {
    const child = spawn(require("electron"), [path.join(dir, "compiled/probe.js"), `--user-data-dir=${path.join(dir, "chromium")}`], { env, windowsHide: true, stdio: "inherit" });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Native plugin Electron probe timed out")); }, 30000);
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code) => { clearTimeout(timeout); resolve(code ?? 1); });
  });
  if (code !== 0) throw new Error(`Native plugin Electron probe exited ${code}`);
} finally {
  const temporaryRoot = await realpath(tmpdir());
  const cleanupTarget = await realpath(dir);
  const relativeTarget = path.relative(temporaryRoot, cleanupTarget);
  if (path.isAbsolute(relativeTarget) || path.dirname(relativeTarget) !== "." || !path.basename(cleanupTarget).startsWith("oint-native-plugin-probe-")) {
    throw new Error(`Refusing cleanup outside the native plugin probe directory: ${cleanupTarget}`);
  }
  await rm(cleanupTarget, { recursive: true, force: true });
}
