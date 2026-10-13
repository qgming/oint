// 内核依赖：读取实际安装的 pi 生态版本，供「关于」面板展示。
//
// 取值顺序：node_modules/<name>/package.json 的 version（真实安装版本）
// → 应用 package.json 里声明的范围（去掉 ^ / ~ 等前缀）
// → null（界面留空，绝不编造版本号）。
//
// 这里刻意不 import electron：调用方传入 appPath，单测可以直接喂临时目录。

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { KernelDependency } from "@/shared/contracts/app";

/** 需要展示的内核包；数组顺序即面板中的排列顺序 */
export const KERNEL_PACKAGES = [
  "@earendil-works/pi-durable",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-mcp",
  "@earendil-works/chord",
] as const;

/** 文件读取注入点（默认 node:fs/promises 的 readFile） */
export type KernelFileReader = (file: string) => Promise<string>;

async function readJsonObject(
  file: string,
  read: KernelFileReader,
): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await read(file));
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function asVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** 实际安装版本 */
async function readInstalledVersion(
  appPath: string,
  name: string,
  read: KernelFileReader,
): Promise<string | null> {
  const manifest = await readJsonObject(
    path.join(appPath, "node_modules", name, "package.json"),
    read,
  );
  return manifest ? asVersion(manifest.version) : null;
}

/** 应用 package.json 中声明的版本范围，去掉 ^ / ~ / >= 等前缀只留数字部分 */
async function readDeclaredVersions(
  appPath: string,
  read: KernelFileReader,
): Promise<Map<string, string>> {
  const declared = new Map<string, string>();
  const manifest = await readJsonObject(path.join(appPath, "package.json"), read);
  const dependencies = manifest?.dependencies;
  if (typeof dependencies !== "object" || dependencies === null) return declared;
  for (const [name, range] of Object.entries(dependencies as Record<string, unknown>)) {
    const version = asVersion(range);
    if (version) declared.set(name, version.replace(/^[\^~>=<\s]+/, ""));
  }
  return declared;
}

/** 读取全部内核依赖（含版本），保持 KERNEL_PACKAGES 的顺序 */
export async function readKernelDependencies(
  appPath: string,
  read: KernelFileReader = (file) => readFile(file, "utf8"),
): Promise<KernelDependency[]> {
  const declared = await readDeclaredVersions(appPath, read);
  return Promise.all(
    KERNEL_PACKAGES.map(async (name) => ({
      name,
      version: (await readInstalledVersion(appPath, name, read)) ?? declared.get(name) ?? null,
    })),
  );
}
