import path from "node:path";
import Type from "typebox";
import { Value } from "typebox/value";
import {
  PLUGIN_PERMISSIONS,
  type PluginManifestResult,
  type PluginPackage,
  type PluginPermission,
} from "@/shared/contracts/plugin";

const relativeEntry = Type.String({ pattern: "^\\./[^\\\\]+$", minLength: 3 });
const surfaceSchema = Type.Object(
  {
    id: Type.String({ pattern: "^[a-zA-Z][a-zA-Z0-9_-]{0,63}$" }),
    kind: Type.Union([Type.Literal("panel"), Type.Literal("modal"), Type.Literal("window")]),
    title: Type.Union([
      Type.String({ minLength: 1 }),
      Type.Object({ en: Type.String({ minLength: 1 }), "zh-CN": Type.String({ minLength: 1 }) }),
    ]),
    entry: relativeEntry,
    icon: Type.Optional(Type.String()),
    order: Type.Optional(Type.Number()),
    shape: Type.Optional(Type.Union([Type.Literal("panel"), Type.Literal("widget")])),
    width: Type.Optional(Type.Integer({ minimum: 1, maximum: 10000 })),
    height: Type.Optional(Type.Integer({ minimum: 1, maximum: 10000 })),
    alwaysOnTop: Type.Optional(Type.Boolean()),
    resizable: Type.Optional(Type.Boolean()),
    skipTaskbar: Type.Optional(Type.Boolean()),
    openAt: Type.Optional(Type.Union([Type.Literal("enable"), Type.Literal("command")])),
  },
  { additionalProperties: false },
);

const packageSchema = Type.Object({
  name: Type.String({
    pattern: "^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$",
    maxLength: 160,
  }),
  version: Type.String({ pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+(?:[-+][a-zA-Z0-9.+-]+)?$" }),
  description: Type.Optional(Type.String()),
  chord: Type.Optional(
    Type.Object(
      {
        facets: Type.Object(
          { agent: Type.Optional(Type.Union([relativeEntry, Type.Literal(false)])) },
          { additionalProperties: false },
        ),
        external: Type.Optional(Type.Array(Type.String())),
        sourceMap: Type.Optional(Type.Boolean()),
      },
      { additionalProperties: false },
    ),
  ),
  oint: Type.Object(
    {
      displayName: Type.Optional(Type.String({ minLength: 1 })),
      permissions: Type.Array(
        Type.Union(PLUGIN_PERMISSIONS.map((permission) => Type.Literal(permission))),
        { uniqueItems: true },
      ),
      hooks: Type.Optional(
        Type.Array(Type.Union([Type.Literal("beforeTool"), Type.Literal("afterTool")]), {
          uniqueItems: true,
        }),
      ),
      surfaces: Type.Optional(Type.Array(surfaceSchema)),
      net: Type.Optional(
        Type.Object(
          { domains: Type.Array(Type.String({ minLength: 1 })) },
          { additionalProperties: false },
        ),
      ),
      shell: Type.Optional(
        Type.Object(
          { exec: Type.Array(Type.String({ pattern: "^[A-Za-z0-9._+-]+$" }), { minItems: 1 }) },
          { additionalProperties: false },
        ),
      ),
    },
    { additionalProperties: false },
  ),
});

/**
 * Application metadata only. Chord 1.0 时代的 bundle 字段（`external` / `sourceMap`）保留在 schema 里
 * 只为让旧包通过清单校验、在 artifact 体检处拿到「旧格式需重新打包」的明确报错（见 artifact.ts）。
 */
export function validatePluginManifest(raw: unknown): PluginManifestResult {
  if (!Value.Check(packageSchema, raw))
    return {
      ok: false,
      issues: [...Value.Errors(packageSchema, raw)].map((issue) => ({
        path: issue.instancePath,
        message: issue.message,
        severity: "error",
      })),
    };
  const issues: { path: string; message: string; severity: "error" }[] = [];
  const fail = (field: string, message: string): void => {
    issues.push({ path: field, message, severity: "error" });
  };
  const { oint } = raw;
  const permissions = oint.permissions as PluginPermission[];
  const hooks = oint.hooks ?? [];
  const agentFacet =
    typeof raw.chord?.facets.agent === "string" ? raw.chord.facets.agent : undefined;
  const entries = [
    ...(agentFacet ? [agentFacet] : []),
    ...(oint.surfaces ?? []).map((surface) => surface.entry),
  ];
  for (const entry of entries)
    if (entry.split(/[\\/]/).includes("..") || path.isAbsolute(entry))
      fail("entry", `路径必须位于插件包内：${entry}`);
  if (hooks.length > 0 && (!agentFacet || !permissions.includes("hostHooks.register")))
    fail("oint.hooks", "钩子需要 chord.facets.agent 和 hostHooks.register 权限");
  if (permissions.includes("shell.exec") !== !!oint.shell?.exec.length)
    fail("oint.shell", "shell.exec 权限和命令白名单必须同时声明");
  if (permissions.includes("net.fetch") && !oint.net?.domains.length)
    fail("oint.net", "net.fetch 需要域名白名单");
  for (const domain of oint.net?.domains ?? [])
    if (domain === "*" || /[:/?#]/.test(domain)) fail("oint.net.domains", `无效域名：${domain}`);
  if (oint.net && !permissions.includes("net.fetch"))
    fail("oint.net", "域名白名单需要 net.fetch 权限");
  const seen = new Set<string>();
  for (const surface of oint.surfaces ?? []) {
    if (seen.has(surface.id)) fail("oint.surfaces", `界面 id 重复：${surface.id}`);
    seen.add(surface.id);
    if (!permissions.includes(`ui.${surface.kind}`))
      fail("oint.surfaces", `界面需要 ui.${surface.kind} 权限`);
    if (
      surface.kind !== "window" &&
      (surface.shape === "widget" ||
        surface.alwaysOnTop !== undefined ||
        surface.skipTaskbar !== undefined ||
        surface.resizable !== undefined)
    )
      fail("oint.surfaces", "widget 和窗口选项只适用于 window");
  }
  if (issues.length) return { ok: false, issues };
  const manifest: PluginPackage = {
    id: raw.name,
    name: oint.displayName ?? raw.name,
    version: raw.version,
    description: raw.description ?? "",
    permissions,
    hooks,
    surfaces: oint.surfaces ?? [],
    ...(agentFacet ? { agentFacet } : {}),
    ...(oint.net ? { net: oint.net } : {}),
    ...(oint.shell ? { shell: oint.shell } : {}),
  };
  return { ok: true, manifest, warnings: [] };
}
