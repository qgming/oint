// Keep the desktop dependency graph on the approved native ecosystem, fail closed.
//
// 1.2.0 起 pi-client / pi-protocol / pi-server 不再发布（chord 1.2.0 已删除旧运行时）；
// pi-telemetry 是 pi-durable / pi-ai 的传递依赖，只出现在 lock 里；pi-codemode 被主进程
// 直接 import（codemode worker 的打包布局要求它作为直接依赖被 externalize）。
import { readFile } from "node:fs/promises";

/** 核准的全家桶与精确版本；任何不在表内的 @earendil-works/* 都视为错误。 */
const APPROVED = {
  "@earendil-works/chord": "1.2.0",
  "@earendil-works/pi-ai": "1.2.0",
  "@earendil-works/pi-durable": "1.2.0",
  "@earendil-works/pi-mcp": "1.2.0",
  "@earendil-works/pi-codemode": "1.2.0",
  "@earendil-works/pi-telemetry": "1.2.0",
};

/** 应用直接声明的依赖，必须精确到版本号字符串。 */
const DIRECT = [
  "@earendil-works/chord",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-codemode",
  "@earendil-works/pi-durable",
  "@earendil-works/pi-mcp",
];

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
const errors = [];
const dependencies = manifest.dependencies ?? {};
for (const name of DIRECT) {
  const version = dependencies[name];
  if (version !== APPROVED[name])
    errors.push(`${name} must be exactly ${APPROVED[name]}, found ${version ?? "missing"}`);
}
for (const name of Object.keys(dependencies)) {
  if (name.startsWith("@earendil-works/") && !(name in APPROVED))
    errors.push(`unapproved direct dependency: ${name}`);
}
const native = [];
for (const [location, pkg] of Object.entries(lock.packages ?? {})) {
  if (!location) continue;
  const name = location.split("node_modules/").at(-1);
  if (!name?.startsWith("@earendil-works/")) continue;
  const expected = APPROVED[name];
  if (expected === undefined) errors.push(`unapproved package in lock: ${location}`);
  else if (pkg.version !== expected)
    errors.push(`${location} resolved to ${pkg.version}, expected ${expected}`);
  native.push(`${name}@${pkg.version}`);
}
if (errors.length) throw new Error(errors.join("\n"));
console.log(
  `Pi dependency graph verified: ${[...new Set(native)].sort().join(", ")}; approved ecosystem only`,
);
