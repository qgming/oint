import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pluginDataDir, pluginDirName, pluginsDir } from "@/main/app/paths";
import { extractZipFile, readZipEntry, zipPrefixFor } from "@/main/storage/zip";
import { verifyPluginArtifact } from "./artifact";
import { PLUGIN_MANIFEST_FILE } from "./discovery";
import { validatePluginManifest } from "./manifest";

export interface PluginInstallResult {
  pluginId: string;

  dir: string;

  warnings: string[];

  replaced: boolean;
}

export class PluginInstallError extends Error {
  readonly issues: string[];
  constructor(message: string, issues: string[] = []) {
    super(message);
    this.name = "PluginInstallError";
    this.issues = issues;
  }
}

export async function installPluginFromZip(
  zipPath: string,
  dataDir: string,
): Promise<PluginInstallResult> {
  const rawManifest = await readZipEntry(zipPath, PLUGIN_MANIFEST_FILE);
  if (rawManifest === undefined) {
    throw new PluginInstallError(`这个包里没有 ${PLUGIN_MANIFEST_FILE}（或有多层嵌套目录）`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawManifest) as unknown;
  } catch (error) {
    throw new PluginInstallError(
      `${PLUGIN_MANIFEST_FILE} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const result = validatePluginManifest(parsed);
  if (!result.ok) {
    throw new PluginInstallError(
      `插件清单不合法（${result.issues.filter((issue) => issue.severity === "error").length} 处）`,
      result.issues
        .filter((issue) => issue.severity === "error")
        .map((issue) => `${issue.path}：${issue.message}`),
    );
  }
  const manifest = result.manifest;

  const installedRoot = path.join(pluginsDir(dataDir), "installed");
  const dirName = pluginDirName(manifest.id);
  const target = path.join(installedRoot, dirName);

  await mkdir(installedRoot, { recursive: true });
  const staging = path.join(pluginsDir(dataDir), `.staging-${dirName}-${Date.now()}`);
  const prefix = await zipPrefixFor(zipPath, PLUGIN_MANIFEST_FILE);

  try {
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });

    const extracted = await extractZipFile(zipPath, staging);

    if (extracted.files === 0) {
      throw new PluginInstallError("压缩包里没有可安装的文件");
    }
    const landed = await readFile(path.join(staging, prefix, PLUGIN_MANIFEST_FILE), "utf8").catch(
      () => undefined,
    );
    if (landed === undefined) {
      throw new PluginInstallError(
        `解压后没有找到 ${PLUGIN_MANIFEST_FILE}（压缩包可能过大或已损坏）`,
      );
    }
    const source = prefix === "" ? staging : path.join(staging, prefix);
    await verifyPluginArtifact(source, manifest);
    const replaced = await pathExists(target);
    if (replaced) {
      await rm(target, { recursive: true, force: true });
    }
    await rename(source, target);

    return {
      pluginId: manifest.id,
      dir: target,
      replaced,
      warnings: [
        ...result.warnings.map((issue) => `${issue.path}：${issue.message}`),
        ...extracted.diagnostics,
      ],
    };
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function uninstallPlugin(
  source: { id: string; dir: string },
  dataDir: string,
  keepData: boolean,
): Promise<void> {
  await rm(source.dir, { recursive: true, force: true });
  if (keepData) return;
  await rm(pluginDataDir(source.id, dataDir), { recursive: true, force: true }).catch(
    () => undefined,
  );
}

const DEV_FILE = "dev.json";

export async function addDevPlugin(pluginDir: string, dataDir: string): Promise<string> {
  const raw = await readFile(path.join(pluginDir, PLUGIN_MANIFEST_FILE), "utf8").catch(
    () => undefined,
  );
  if (raw === undefined) {
    throw new PluginInstallError(`选中的目录里没有 ${PLUGIN_MANIFEST_FILE}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new PluginInstallError(
      `${PLUGIN_MANIFEST_FILE} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const result = validatePluginManifest(parsed);
  if (!result.ok) {
    throw new PluginInstallError(
      "插件清单不合法",
      result.issues
        .filter((issue) => issue.severity === "error")
        .map((issue) => `${issue.path}：${issue.message}`),
    );
  }

  const absolute = path.resolve(pluginDir);
  if (result.manifest.agentFacet) {
    // 源码直载：不再预构建，只做入口体检（存在性、真实路径、旧格式明确报错）。
    await verifyPluginArtifact(absolute, result.manifest);
  }
  const list = await readDevList(dataDir);
  if (!list.includes(absolute)) list.push(absolute);
  await writeDevList(dataDir, list);
  return result.manifest.id;
}

export async function removeDevPlugin(pluginDir: string, dataDir: string): Promise<void> {
  const absolute = path.resolve(pluginDir);
  const list = await readDevList(dataDir);
  await writeDevList(
    dataDir,
    list.filter((entry) => entry !== absolute),
  );
}

async function readDevList(dataDir: string): Promise<string[]> {
  const raw = await readFile(path.join(pluginsDir(dataDir), DEV_FILE), "utf8").catch(
    () => undefined,
  );
  if (raw === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string" && entry !== "")
      : [];
  } catch {
    return [];
  }
}

async function writeDevList(dataDir: string, list: string[]): Promise<void> {
  const dir = pluginsDir(dataDir);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, DEV_FILE), `${JSON.stringify(list, null, 2)}\n`, "utf8");
}

async function pathExists(target: string): Promise<boolean> {
  return (await stat(target).catch(() => undefined)) !== undefined;
}
