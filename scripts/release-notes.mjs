// 从 CHANGELOG.md 提取指定 tag 对应的版本章节，作为 GitHub Release 正文。
//
// 为什么不在 workflow 里写 sed/awk：章节结束条件（下一个 `## [`）和版本号归一（去掉 v）
// 都是逻辑，单独成脚本才能本地跑一遍再发布 —— Release 正文发错了只能手改。
import { readFileSync } from "node:fs";

const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
if (!tag) {
  console.error("用法：node scripts/release-notes.mjs <tag>（或设置 GITHUB_REF_NAME）");
  process.exit(1);
}

const version = tag.replace(/^v/, "");
const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const lines = changelog.split(/\r?\n/);
const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
if (start === -1) {
  console.error(`CHANGELOG.md 中找不到 ${version} 的章节`);
  process.exit(1);
}

let end = lines.length;
for (let index = start + 1; index < lines.length; index += 1) {
  if (lines[index]?.startsWith("## [")) {
    end = index;
    break;
  }
}

process.stdout.write(`${lines.slice(start, end).join("\n").trimEnd()}\n`);