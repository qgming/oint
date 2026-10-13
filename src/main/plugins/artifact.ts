// 插件产物体检：源码直载时代没有预构建 bundle 可校验，这里做的是：
//   1. 旧格式明确报错（chord 1.0 的 dist/chord-facets.json 包在新运行时装不起来）；
//   2. agent 入口存在且经真实路径校验（不许指向包外）；
//   3. 返回入口的真实路径，交给子进程 nodeLoader 加载。

import { stat } from "node:fs/promises";
import path from "node:path";
import { validateRealPathAccess } from "@/main/security/path-guard";
import type { PluginPackage } from "@/shared/contracts/plugin";

export class LegacyPluginArtifactError extends Error {
  constructor() {
    super(
      "这是 chord 1.0 时代的旧格式插件包（含 dist/chord-facets.json 预构建产物）。" +
        '新版本改为源码直载：请用新版格式重新打包（package.json 的 chord.facets.agent 指向 .ts 源码，并声明 "type": "module"）。',
    );
    this.name = "LegacyPluginArtifactError";
  }
}

async function isFile(target: string): Promise<boolean> {
  return (await stat(target).catch(() => undefined))?.isFile() === true;
}

/**
 * 解析并校验插件的 agent 入口，返回其真实路径。`dir` 是插件的根目录。
 * 无 agent facet 的插件（纯界面插件）返回 undefined。
 */
export async function resolvePluginEntry(
  dir: string,
  metadata: PluginPackage,
): Promise<string | undefined> {
  if (!metadata.agentFacet) return undefined;
  if (await isFile(path.join(dir, "dist", "chord-facets.json")))
    throw new LegacyPluginArtifactError();
  const entry = path.join(dir, metadata.agentFacet);
  const access = await validateRealPathAccess(entry, [dir]);
  if (!access.ok) throw new Error(access.reason);
  if (!(await isFile(access.resolved)))
    throw new Error(`插件 agent 入口不存在：${metadata.agentFacet}（chord.facets.agent）`);
  return access.resolved;
}

/** Verify the entry before installing; no plugin code runs here. */
export async function verifyPluginArtifact(dir: string, metadata: PluginPackage): Promise<void> {
  await resolvePluginEntry(dir, metadata);
}
