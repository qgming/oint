/**
 * 新会话页的测试（ui project / jsdom）。
 *
 * 这一屏是「没有选中会话 / 刚新建了一个空会话」时的**全部**内容：品牌标记、问候、
 * 居中的输入框、起手提示。挂的是真的 WelcomeView + 真的 Composer + 真的 store，
 * 只把 window.oint 这个进程边界换掉。
 *
 * 三件事必须钉住，因为它们的失败都不会报错、只会让人困惑：
 *
 * 1. **项目 chip 写的是会话，不是设置**（`sessions:set-cwd`）。写错地方的症状是
 *    「换个会话，项目跟着变了」。
 * 2. **没有活动会话时选项目是「带着 cwd 建一个」**，不是「先建再改」——后者会先留下
 *    一个临时工作区再把它清掉，多一次往返也多一个可能失败的点。
 * 3. **起手提示只填不发**：模板正文常常还要用户补一句上下文，替用户按发送键是错的。
 */

import { AssistantRuntimeProvider, useExternalStoreRuntime } from "@assistant-ui/react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/renderer/i18n";
import { toThreadMessage } from "@/renderer/runtime/message-converter";
import { useChatStore } from "@/renderer/stores/chat-store";
import { useProjectsStore } from "@/renderer/stores/projects-store";
import { useSettingsStore } from "@/renderer/stores/settings-store";
import type { Project } from "@/shared/contracts/project";
import type { PromptTemplateInfo } from "@/shared/contracts/prompts";
import type { ChatMessage, SessionSummary } from "@/shared/contracts/session";
import type { Settings } from "@/shared/contracts/settings";
import { WelcomeView } from "./WelcomeView";

afterEach(cleanup);

beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});

const PROJECT: Project = {
  id: "p1",
  name: "oint",
  path: "D:\\dev\\oint",
  createdAt: 0,
};
const OTHER_PROJECT: Project = {
  id: "p2",
  name: "polartv",
  path: "D:\\dev\\polartv",
  createdAt: 0,
};

/** 会话的工作目录落在项目里 → 它归这个项目（判定见 lib/projects 的 findProjectForCwd） */
function session(cwd: string): SessionSummary {
  return {
    id: "s1",
    title: null,
    createdAt: 0,
    updatedAt: 0,
    cwd,
    archived: false,
    pinned: false,
    messageCount: 0,
    model: null,
  };
}

const TEMPLATES: PromptTemplateInfo[] = [
  {
    name: "plan",
    description: "只读探索后给出实现计划",
    content: "先把方案想清楚，不要写任何代码。",
    source: "builtin",
    dir: "D:\\app\\resources\\prompts",
  },
  {
    name: "debug",
    description: "系统化根因排查",
    content: "排查下面这个 bug。",
    source: "builtin",
    dir: "D:\\app\\resources\\prompts",
  },
];

const EMPTY_MESSAGES: ChatMessage[] = [];

/** 只补这一条链真的会调到的 IPC；调用记下来供断言 */
function stubBridge() {
  const listSkills = vi.fn(async () => []);
  const listPrompts = vi.fn(async () => TEMPLATES);
  const setCwd = vi.fn(async () => undefined);
  const create = vi.fn(async (options?: { cwd?: string }) => session(options?.cwd ?? ""));
  vi.stubGlobal("oint", {
    skills: { list: listSkills },
    prompts: { list: listPrompts },
    sessions: { setCwd, create },
  });
  return { listSkills, listPrompts, setCwd, create };
}

function seedStores(options: { cwd?: string; noSession?: boolean } = {}) {
  const cwd = options.cwd ?? "";
  useChatStore.setState({
    sessions: options.noSession === true ? [] : [session(cwd)],
    activeSessionId: options.noSession === true ? null : "s1",
    messagesBySession: {},
    loadedSessions: {},
    runningBySession: {},
    queueBySession: {},
  });
  useProjectsStore.setState({ projects: [PROJECT, OTHER_PROJECT], loading: false });
  useSettingsStore.setState({
    settings: {
      permissionMode: "default",
      agentMode: "standard",
      thinkingLevel: "medium",
      defaultModel: null,
      services: [],
      theme: "light",
    } as unknown as Settings,
    loaded: true,
  });
}

function Harness() {
  const runtime = useExternalStoreRuntime<ChatMessage>({
    messages: EMPTY_MESSAGES,
    isRunning: false,
    convertMessage: toThreadMessage,
    onNew: async () => {},
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <WelcomeView />
    </AssistantRuntimeProvider>
  );
}

/** 输入框本体（库渲染成 textarea，且带 combobox 角色） */
function composerInput(): HTMLTextAreaElement {
  const input = screen.getByRole("combobox");
  if (!(input instanceof HTMLTextAreaElement)) throw new Error("输入框不是 textarea");
  return input;
}

beforeEach(() => {
  stubBridge();
});

describe("新会话页的版面", () => {
  it("问候与输入框都在，输入框是这一屏的输入面", async () => {
    seedStores({ cwd: PROJECT.path });
    render(<Harness />);

    expect(await screen.findByText("今天想做点什么？")).toBeTruthy();
    expect(composerInput()).toBeTruthy();
  });

  it("输入框上方是上下文行（项目 chip 在输入框之前）", async () => {
    seedStores({ cwd: PROJECT.path });
    render(<Harness />);

    const chip = await screen.findByRole("button", { name: "工作目录所属项目" });
    // compareDocumentPosition 的 DOCUMENT_POSITION_FOLLOWING (4) 表示输入框在 chip 之后
    expect(chip.compareDocumentPosition(composerInput()) & 4).toBeTruthy();
  });
});

describe("项目 chip", () => {
  it("显示会话工作目录所属的项目名", async () => {
    seedStores({ cwd: `${PROJECT.path}\\src` });
    render(<Harness />);

    const chip = await screen.findByRole("button", { name: "工作目录所属项目" });
    expect(chip.textContent).toContain("oint");
  });

  it("工作目录不在任何项目里时显示「未绑定项目」", async () => {
    // 新建对话给的是本会话的临时工作区：它落在数据目录下，不属于任何项目
    seedStores({ cwd: "C:\\Users\\me\\AppData\\Roaming\\oint\\workspaces\\s1" });
    render(<Harness />);

    const chip = await screen.findByRole("button", { name: "工作目录所属项目" });
    expect(chip.textContent).toContain("未绑定项目");
  });

  it("选中另一个项目 → 走 sessions:set-cwd 改这个会话的绑定", async () => {
    const { setCwd, create } = stubBridge();
    seedStores({ cwd: PROJECT.path });
    render(<Harness />);

    fireEvent.click(await screen.findByRole("button", { name: "工作目录所属项目" }));
    fireEvent.click(await screen.findByRole("button", { name: /polartv/ }));

    await waitFor(() => expect(setCwd).toHaveBeenCalledWith("s1", OTHER_PROJECT.path));
    // 已经有会话在：不该再建一个
    expect(create).not.toHaveBeenCalled();
  });

  it("连会话都没有时选项目 → 带着 cwd 直接建（不是先建再改）", async () => {
    const { setCwd, create } = stubBridge();
    seedStores({ noSession: true });
    render(<Harness />);

    fireEvent.click(await screen.findByRole("button", { name: "工作目录所属项目" }));
    fireEvent.click(await screen.findByRole("button", { name: /oint/ }));

    await waitFor(() => expect(create).toHaveBeenCalledWith({ cwd: PROJECT.path }));
    expect(setCwd).not.toHaveBeenCalled();
  });

  it("运行中禁用：换根要落在下一轮之前，跑着的时候不给点", async () => {
    seedStores({ cwd: PROJECT.path });
    useChatStore.setState({ runningBySession: { s1: true } });
    render(<Harness />);

    const chip = await screen.findByRole("button", { name: "工作目录所属项目" });
    expect((chip as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("起手提示", () => {
  it("按模板清单渲染，标签是短标签而不是模板名", async () => {
    seedStores({ cwd: PROJECT.path });
    render(<Harness />);

    expect(await screen.findByRole("button", { name: /实现计划/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /排查 Bug/ })).toBeTruthy();
    // 名单之外的模板不进这一排
    expect(screen.queryByRole("button", { name: /translate/ })).toBeNull();
  });

  it("点一条只把正文填进输入框，**不发送**", async () => {
    seedStores({ cwd: PROJECT.path });
    render(<Harness />);

    fireEvent.click(await screen.findByRole("button", { name: /实现计划/ }));

    await waitFor(() => expect(composerInput().value).toBe("先把方案想清楚，不要写任何代码。"));
  });

  it("取清单用的是当前会话的工作目录（与斜杠菜单同一口径）", async () => {
    const { listPrompts } = stubBridge();
    seedStores({ cwd: PROJECT.path });
    render(<Harness />);

    await screen.findByRole("button", { name: /实现计划/ });
    expect(listPrompts).toHaveBeenCalledWith(PROJECT.path);
  });

  it("一条模板都读不到时整排不渲染，不留空行", async () => {
    vi.stubGlobal("oint", {
      skills: { list: vi.fn(async () => []) },
      prompts: { list: vi.fn(async () => []) },
      sessions: { setCwd: vi.fn(), create: vi.fn() },
    });
    seedStores({ cwd: PROJECT.path });
    render(<Harness />);

    // 等模板清单这一趟 IPC 落地：它一回来这一排就该是空的
    await waitFor(() => expect(screen.queryByRole("group", { name: "起手提示" })).toBeNull());
    expect(screen.getByText("今天想做点什么？")).toBeTruthy();
  });
});

describe("welcome execution styles", () => {
  it.each(["standard", "orchestrate"] as const)("keeps one welcome for %s", (mode) => {
    seedStores();
    useChatStore.setState({ sessions: [{ ...session(""), agentMode: mode }] });
    render(<Harness />);
    expect(screen.getByText("把任务交给 Oint，它会读写代码、运行命令。")).toBeDefined();
  });
});
