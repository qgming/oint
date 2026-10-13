// Run the same native checks against ASAR with Electron's own Node runtime.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { probeKernel } from "./probe-kernel.mjs";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appRoot = path.join(root, "release", "win-unpacked", "resources", "app.asar");
if (!fs.existsSync(appRoot)) throw new Error("Run npm run pack before the packaged probe");
const electron = require("electron");
const parentUrl = pathToFileURL(path.join(appRoot, "package.json")).href;
const script = `
import fs from "node:fs/promises";
import path from "node:path";
const appRoot = ${JSON.stringify(appRoot)};
for (const name of ["pi-ai", "pi-durable", "pi-mcp", "chord", "pi-codemode", "pi-telemetry"]) {
  const manifest = JSON.parse(await fs.readFile(path.join(appRoot, "node_modules", "@earendil-works", name, "package.json"), "utf8"));
  if (manifest.version !== "1.2.0") throw new Error(name + " expected 1.2.0, got " + manifest.version);
}
for (const name of ["pi-client", "pi-server", "pi-protocol", "pi-coding-agent", "pi-tui"]) {
  const forbidden = path.join(appRoot, "node_modules", "@earendil-works", name, "package.json");
  await fs.access(forbidden).then(() => { throw new Error("Excluded CLI/TUI package: " + name); }, (error) => {
    if (error.code !== "ENOENT") throw error;
  });
}
const load = async (name) => {
  const url = import.meta.resolve(name, ${JSON.stringify(parentUrl)});
  if (!name.startsWith("node:") && !url.includes("/app.asar/node_modules/")) {
    throw new Error("Import escaped packaged dependencies: " + name + " -> " + url);
  }
  return import(url);
};
const results = await (${probeKernel.toString()})(load);
console.log("__RESULTS__" + JSON.stringify(results));
`;

const output = execFileSync(electron, ["--experimental-import-meta-resolve", "--input-type=module", "-e", script], {
  cwd: path.dirname(appRoot),
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
  timeout: 120_000,
});
const marker = output.split(/\r?\n/).find((line) => line.startsWith("__RESULTS__"));
if (!marker) throw new Error(`Probe returned no results: ${output}`);
const results = JSON.parse(marker.slice("__RESULTS__".length));
for (const result of results) console.log(`${result.ok ? "PASS" : "FAIL"} ${result.name}: ${result.detail}`);
process.exitCode = results.some((result) => !result.ok) ? 1 : 0;
