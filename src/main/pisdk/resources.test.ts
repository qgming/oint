// 资源目录解析的单测。
//
// 这些函数看着只是拼字符串，但它们决定的是**优先级**（同名技能谁生效），
// 而优先级错了是静默的：内置技能把用户技能遮住时，用户只会觉得「我改的没生效」，
// 没有任何报错。所以顺序要被断言钉住，而不是靠读代码确认。
//
// 第二组测的是**内置技能自身的完整性**：SKILL.md 里用相对链接引用的附属文件
// 必须真的存在。链接指向一个不存在的文件时不会有任何报错 ——
// 模型只会读不到那份格式说明，然后按自己的猜测写，而没人知道为什么。

import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const paths = vi.hoisted(() => ({ data: "/data-oint" }));
vi.mock("@/main/app/paths", () => ({ dataDir: () => paths.data }));

/**
 * 家目录固定成常量。
 *
 * 理由不是"为了好写"：跨工具共享技能目录住在 `~/.agents/skills`（见 `agentsSkillsDir`），
 * 拿真实的 `homedir()` 做断言等于**让测试结果取决于跑测试的那台机器上有没有那份技能** ——
 * 本机有它、CI 没有，两边断言的值就不一样，而失败信息会指向资源解析函数。
 */
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => "/home-test" };
});

import { BUILTIN_COMMANDS } from "@/shared/contracts/commands";
import { PROMPT_NAME_PATTERN } from "@/shared/contracts/prompts";
import {
  agentsSkillsDir,
  resolveBuiltinPromptDir,
  resolveBuiltinSkillDir,
  resolvePromptTemplateDirs,
  resolveSkillDirs,
  resolveSubagentDirs,
} from "./resources";

/**
 * 分隔符归一后再比。
 *
 * 本文件里几个解析函数混用了两种拼法：数据/项目目录用模板串（`${dir}/skills`，
 * 正斜杠），内置目录用 `path.join`（Windows 上是反斜杠）。这在**功能上无所谓** ——
 * 所有调用方都会先归一（runtime 的 `path.resolve`、ipc/skills 的 `sourceOfDir`、
 * 路径守卫的 `normalizePath`），但直接字符串比较会因为它红掉。
 *
 * 所以这里断言的是**语义**（有哪些目录、什么顺序），而不是分隔符风格。
 */
function normalize(value: string): string {
  return value.replace(/\\/g, "/");
}

function normalizeAll(values: string[]): string[] {
  return values.map(normalize);
}

describe("resolveSkillDirs", () => {
  it("四个来源的顺序是：数据目录 → 项目 → 跨工具共享 → 内置（顺序即优先级）", () => {
    const dirs = resolveSkillDirs("/proj", "/app");

    expect(normalizeAll(dirs)).toEqual([
      "/data-oint/skills",
      "/proj/.oint/skills",
      "/home-test/.agents/skills",
      "/app/resources/skills",
    ]);
  });

  it("内置技能排在最后：用户同名技能因此能覆盖它", () => {
    const dirs = normalizeAll(resolveSkillDirs("/proj", "/app"));

    // 这条断言锁住的是「内置永远不抢先」—— 反过来的话用户永远改不掉内置行为
    expect(dirs.indexOf("/app/resources/skills")).toBe(dirs.length - 1);
  });

  /**
   * 跨工具共享目录的位置：**在项目之后、插件之前**。
   *
   * 两边的判据不同，各钉一条：
   * - 排在项目之后 —— 项目是"这个仓库要的"，比机器级的共享目录更具体；
   * - 排在插件之前 —— 用户手上那份技能（哪怕是别的工具装的）优先于插件随包带的。
   */
  it("共享目录排在项目之后、插件与内置之前", () => {
    const dirs = normalizeAll(
      resolveSkillDirs("/proj", "/app", ["/plugin-a/skills"], ["/shared/.agents/skills"]),
    );

    expect(dirs).toEqual([
      "/data-oint/skills",
      "/proj/.oint/skills",
      "/shared/.agents/skills",
      "/plugin-a/skills",
      "/app/resources/skills",
    ]);
  });

  it("共享目录缺省是 ~/.agents/skills（家目录可注入，路径形状仍钉住）", () => {
    expect(normalize(agentsSkillsDir())).toBe("/home-test/.agents/skills");
    expect(normalize(agentsSkillsDir("/other-home"))).toBe("/other-home/.agents/skills");
    // 缺省参与扫描：不传第四个参数时它就在清单里
    expect(normalizeAll(resolveSkillDirs("/proj"))).toContain("/home-test/.agents/skills");
  });

  it("显式传空数组即完全不看共享目录（单测要纯行为时走这条）", () => {
    expect(normalizeAll(resolveSkillDirs("/proj", "/app", [], []))).toEqual([
      "/data-oint/skills",
      "/proj/.oint/skills",
      "/app/resources/skills",
    ]);
  });

  it("没有工作目录时不追加项目目录（设置面板不带会话）", () => {
    expect(normalizeAll(resolveSkillDirs(undefined, "/app"))).toEqual([
      "/data-oint/skills",
      "/home-test/.agents/skills",
      "/app/resources/skills",
    ]);
    expect(resolveSkillDirs("", "/app")).toHaveLength(3);
  });

  it("没有 appPath 时只有用户来源（单测与不关心内置技能的调用方）", () => {
    expect(normalizeAll(resolveSkillDirs("/proj"))).toEqual([
      "/data-oint/skills",
      "/proj/.oint/skills",
      "/home-test/.agents/skills",
    ]);
    expect(resolveSkillDirs("/proj", "")).toHaveLength(3);
  });
});

describe("resolveBuiltinSkillDir", () => {
  it("指向 <appPath>/resources/skills", () => {
    expect(normalize(resolveBuiltinSkillDir("/app"))).toBe("/app/resources/skills");
  });

  /**
   * 打包后 `app.getAppPath()` 是 asar 根，开发期是仓库根 —— 两种情况下
   * `resources/` 都在它下面。这条断言只是把「路径形状」钉住；
   * **文件真的进没进包**由 electron-builder.yml 的 `files:` 负责，测不到，只能靠打包实测。
   */
  it("开发期与打包后是同一个相对形状（resources/ 在 appPath 下）", () => {
    expect(normalize(resolveBuiltinSkillDir("D:\\dev\\oint"))).toBe("D:/dev/oint/resources/skills");
  });

  /**
   * **打包后必须返回 `app.asar.unpacked` 那一份。**
   *
   * 这条是「技能里的 scripts/ 能不能被模型执行」的命门：
   * asar 是归档文件，只有 Electron 自己的 fs 补丁认得它 —— 模型用 bash 起的
   * `node` / `python` 是独立进程，打开 asar 内路径一律 ENOENT（已实测）。
   * 所以打包时 `resources/**` 被 asarUnpack 拆出来，这里要指向那个**真实路径**，
   * 否则技能索引给出的 `<location>` 外部进程读不了，脚本等于永远跑不起来。
   *
   * 用临时目录造出 `.unpacked` 兄弟目录来验证这条分支（不依赖真的打包）。
   */
  it("存在 app.asar.unpacked 时优先返回解包后的真实路径", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "oint-asar-"));
    // 造出打包后的布局：app.asar 是文件，app.asar.unpacked/resources/skills 是目录
    const appAsar = path.join(base, "app.asar");
    await writeFile(appAsar, "", "utf8");
    const unpackedSkills = path.join(`${appAsar}.unpacked`, "resources", "skills");
    await mkdir(unpackedSkills, { recursive: true });

    expect(normalize(resolveBuiltinSkillDir(appAsar))).toBe(normalize(unpackedSkills));

    // 没有 .unpacked 时回落到普通路径（开发期就是这条分支）
    expect(normalize(resolveBuiltinSkillDir(path.join(base, "not-packed")))).toBe(
      normalize(path.join(base, "not-packed", "resources", "skills")),
    );

    await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
});

describe("其余解析函数不受影响", () => {
  it("提示模板：数据目录 → 项目 → 内置（与技能同构，内置排最后）", () => {
    // 只给 workingDir：内置层不参与（测试与不关心内置层的调用方走这条）
    expect(normalizeAll(resolvePromptTemplateDirs("/proj"))).toEqual([
      "/data-oint/prompts",
      "/proj/.oint/prompts",
    ]);
    // 给了 appPath：内置层追加在最后，用户同名模板因此能覆盖它
    const dirs = normalizeAll(resolvePromptTemplateDirs("/proj", "/app"));
    expect(dirs).toEqual(["/data-oint/prompts", "/proj/.oint/prompts", "/app/resources/prompts"]);
    expect(dirs.indexOf("/app/resources/prompts")).toBe(dirs.length - 1);
    // 没有工作目录时只跳过项目层，数据目录与内置层照常
    expect(normalizeAll(resolvePromptTemplateDirs(undefined, "/app"))).toEqual([
      "/data-oint/prompts",
      "/app/resources/prompts",
    ]);
    expect(resolvePromptTemplateDirs("/proj", "")).toHaveLength(2);
  });

  it("子智能体定义：数据目录 → 项目（内置写在代码里，不占目录）", () => {
    expect(normalizeAll(resolveSubagentDirs("/proj"))).toEqual([
      "/data-oint/subagents",
      "/proj/.oint/subagents",
    ]);
  });
});

/**
 * 内置技能自身的完整性。
 *
 * 这些断言跑在**真实的 `resources/skills` 目录**上（不是夹具）——
 * 这正是它们的价值：内置技能是随包分发的静态内容，
 * 没有任何类型检查或运行时校验会覆盖它们，加一个技能、改一个文件都只能靠测试拦住。
 */
describe("内置技能的完整性", () => {
  const builtinRoot = path.join(process.cwd(), "resources", "skills");

  /** 从 SKILL.md 里抽出所有相对链接的目标 */
  function relativeLinks(markdown: string): string[] {
    return [...markdown.matchAll(/\]\(\.\/([^)]+)\)/g)].map((match) => match[1] ?? "");
  }

  it("至少有三个内置技能，且每个都有 SKILL.md", async () => {
    const entries = await readdir(builtinRoot, { withFileTypes: true });
    const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);

    expect(dirs.length).toBeGreaterThanOrEqual(3);
    for (const dir of dirs) {
      const skillFile = path.join(builtinRoot, dir, "SKILL.md");
      await expect(stat(skillFile)).resolves.toBeDefined();
    }
  });

  /**
   * **SKILL.md 里引用的附属文件必须真的存在。**
   *
   * 相对链接指向不存在的文件时不会有任何报错：模型只是读不到那份格式说明，
   * 然后按自己的猜测去写。这条断言把它变成一个会红的测试。
   */
  it("SKILL.md 里 `](./xxx.md)` 引用的附属文件都存在", async () => {
    const entries = await readdir(builtinRoot, { withFileTypes: true });
    const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);

    for (const dir of dirs) {
      const skillDir = path.join(builtinRoot, dir);
      const content = await readFile(path.join(skillDir, "SKILL.md"), "utf8");
      for (const link of relativeLinks(content)) {
        await expect(stat(path.join(skillDir, link))).resolves.toBeDefined();
      }
    }
  });

  /**
   * **被引用的可执行脚本必须真的存在，且真的能跑。**
   *
   * 单独测这条是因为它与 Markdown 链接是两种引用形式（`` `scripts/x.mjs` ``），
   * 上一条的正则抓不到。而它的失败后果更重：技能正文写着「跑这个脚本校验」，
   * 脚本却不在 —— 模型会照着做、失败、然后反复重试同一个不存在的路径。
   *
   * 顺带钉住「同一份技能里 Node 版与 Python 版都在」：Node 版是首选
   *（Oint 一定有 Node），Python 版是可选的备选。
   */
  it("skill-creator 引用的校验脚本存在，且 Node 版真的能跑", async () => {
    const skillDir = path.join(builtinRoot, "skill-creator");
    const content = await readFile(path.join(skillDir, "SKILL.md"), "utf8");

    // 正文里提到的每一个 `scripts/xxx` 文件。
    //
    // 匹配不限反引号：脚本既可能写成 `code span`，也可能出现在示例命令行里
    //（`node ".../scripts/validate_skill.mjs"`）。两种写法都得抓到，
    // 否则改一下排版这条断言就静默失效了。
    // 排除含 `...` 的占位写法 —— 那是正文在讲「这个目录里放什么」，不是真的在引用。
    const mentioned = [...content.matchAll(/scripts\/[\w.-]+\.\w+/g)]
      .map((m) => m[0])
      .filter((rel) => !rel.includes("..."));
    expect(mentioned.length).toBeGreaterThan(0);
    for (const rel of mentioned) {
      await expect(stat(path.join(skillDir, rel))).resolves.toBeDefined();
    }

    // Node 版必须存在，且用 `--help` 之类不会改动文件系统的方式确认它可执行。
    // 直接对内置技能自己跑一遍是最有说服力的自检：
    // 脚本不存在、语法错误、或退出码异常都会在这里红。
    await expect(stat(path.join(skillDir, "scripts/validate_skill.mjs"))).resolves.toBeDefined();
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const { stdout } = await run(process.execPath, [
      path.join(skillDir, "scripts/validate_skill.mjs"),
      skillDir,
    ]);
    expect(stdout).toContain("PASS: 0 error(s)");
  });

  it("每个 SKILL.md 的 frontmatter 有 name 与 description（缺 description 会被内核静默丢弃）", async () => {
    const entries = await readdir(builtinRoot, { withFileTypes: true });
    const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);

    for (const dir of dirs) {
      const content = await readFile(path.join(builtinRoot, dir, "SKILL.md"), "utf8");
      expect(content.startsWith("---\n")).toBe(true);
      const frontmatter = content.slice(4, content.indexOf("\n---", 4));
      expect(frontmatter).toContain(`name: ${dir}`);
      expect(frontmatter).toMatch(/description: \S/);
    }
  });
});

describe("resolveBuiltinPromptDir", () => {
  it("指向 <appPath>/resources/prompts（与内置技能同构）", () => {
    expect(normalize(resolveBuiltinPromptDir("/app"))).toBe("/app/resources/prompts");
    expect(normalize(resolveBuiltinPromptDir("D:\\dev\\oint"))).toBe(
      "D:/dev/oint/resources/prompts",
    );
  });

  /**
   * 打包后必须返回 `app.asar.unpacked` 那一份 —— 理由与内置技能**逐字相同**
   *（见 resolveBuiltinSkillDir 的测试注释）：asar 是归档，非 Electron 进程读不了，
   * 而 `resources/**` 在 electron-builder.yml 里被整个 asarUnpack 出来了。
   * 这里用临时目录造出 `.unpacked` 兄弟目录来验证分支，不依赖真的打包。
   */
  it("存在 app.asar.unpacked 时优先返回解包后的真实路径", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "oint-asar-prompt-"));
    const appAsar = path.join(base, "app.asar");
    await writeFile(appAsar, "", "utf8");
    const unpackedPrompts = path.join(`${appAsar}.unpacked`, "resources", "prompts");
    await mkdir(unpackedPrompts, { recursive: true });

    expect(normalize(resolveBuiltinPromptDir(appAsar))).toBe(normalize(unpackedPrompts));
    expect(normalize(resolveBuiltinPromptDir(path.join(base, "not-packed")))).toBe(
      normalize(path.join(base, "not-packed", "resources", "prompts")),
    );

    await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
});

/**
 * 内置魔法提示自身的完整性。
 *
 * 跑在**真实的 `resources/prompts` 目录**上（不是夹具），理由与内置技能那组相同：
 * 这些 .md 是随包分发的静态内容，没有任何类型检查覆盖它们 ——
 * 文件名不符合命名规则（斜杠菜单认不出来）、frontmatter 写坏（描述退化成正文首行）、
 * 或正文被清空，都只能靠这里的断言拦住。
 */
describe("内置魔法提示的完整性", () => {
  const builtinRoot = path.join(process.cwd(), "resources", "prompts");

  async function promptFiles(): Promise<string[]> {
    const entries = await readdir(builtinRoot, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((e) => e.name);
  }

  /** frontmatter 里的描述（没有 frontmatter 时返回空串） */
  function frontmatterDescription(content: string): string {
    if (!content.startsWith("---\n")) return "";
    const end = content.indexOf("\n---", 4);
    if (end === -1) return "";
    const match = /^description:[ \t]*(.+)$/m.exec(content.slice(4, end));
    return match?.[1]?.trim() ?? "";
  }

  it("内置提示至少有 12 个，文件名都符合命名规则", async () => {
    const files = await promptFiles();

    // 第一批是「工作流型」提示（14 条）：门槛取 12 是为了拦住"文件被误删/漏进包"，
    // 而不是把数量钉死 —— 增删条目是正常维护，改这个数字比让人猜要诚实。
    expect(files.length).toBeGreaterThanOrEqual(12);
    for (const file of files) {
      // 文件名去掉 .md 就是斜杠命令名：不符合规则的会被 normalizePromptName 判非法，
      // 而内置文件不是用户敲进去的，没有机会被规范化 —— 只能在这里拦住
      expect(PROMPT_NAME_PATTERN.test(file.replace(/\.md$/, ""))).toBe(true);
    }
  });

  it("每个内置提示都有非空的 frontmatter 描述与像样的正文", async () => {
    for (const file of await promptFiles()) {
      const content = await readFile(path.join(builtinRoot, file), "utf8");
      expect(frontmatterDescription(content).length).toBeGreaterThan(4);
      // 正文 = frontmatter 之后的部分。门槛比"非空"高得多：内置提示的定位是
      // **多步工作流**（有产出物、有检查点、有红线），一句话的小提示不该占这个位置。
      const body = content.slice(content.indexOf("\n---", 4) + 4).trim();
      expect(body.length).toBeGreaterThan(400);
    }
  });

  it("内置提示不与内置指令同名（同名会让 /名字 出现歧义）", async () => {
    const commandNames = new Set(BUILTIN_COMMANDS.map((spec) => spec.name.toLowerCase()));
    for (const file of await promptFiles()) {
      expect(commandNames.has(file.replace(/\.md$/, "").toLowerCase())).toBe(false);
    }
  });
});
