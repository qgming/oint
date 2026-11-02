/**
 * 会话 IPC 只覆盖子智能体功能依赖的两条保证：
 * - `list` 把从属会话（subagent）挡在左侧栏之外，chat / 缺省 kind 照常通过 ——
 *   子智能体的转录不进会话列表，是它「隐藏会话」语义的最后一道闸门；
 * - `create` 把整个 SessionCreateOptions（kind 与归属信息）原样交给 store ——
 *   「点开子智能体组件跳到它的记录」靠的是写入时就固定下来的关联，不能在这里丢字段。
 * - `delete` **先关运行时再删库**（见下方 describe 的说明）。
 *
 * store 整体 mock：本文件验证的是 IPC 层的过滤与转发，不碰 SQLite。
 * runtime 也 mock：setModel 会热改 lane 配置，不在本文件的覆盖范围。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC } from "@/shared/contracts/ipc";
import type { SessionCreateOptions, SessionSummary } from "@/shared/contracts/session";
import { registerSessionsIpc } from "./sessions";

type IpcListener = (event: unknown, request?: unknown) => unknown;

// vi.mock 工厂先于 import 执行，用 hoisted 容器接住 handler 与 store 替身
const registered = vi.hoisted(() => ({ handlers: new Map<string, IpcListener>() }));
const store = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  remove: vi.fn(),
  setCwd: vi.fn(),
}));
/** 删除路径的调用顺序：先关运行时、再删库 */
const order = vi.hoisted(() => ({ calls: [] as string[] }));
const chatRuntime = vi.hoisted(() => ({
  closeSession: vi.fn(async (id: string) => {
    order.calls.push(`closeSession:${id}`);
  }),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: IpcListener) => {
      registered.handlers.set(channel, listener);
    },
  },
}));

vi.mock("@/main/pisdk/session-store", () => ({ getSessionStore: () => store }));
vi.mock("@/main/pisdk/runtime", () => ({ getChatRuntime: () => chatRuntime }));

/** 一条会话摘要：只填本文件会读的字段 */
function summary(patch: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "chat-1",
    title: null,
    createdAt: 1_000,
    updatedAt: 2_000,
    cwd: "C:/work",
    kind: "chat",
    archived: false,
    pinned: false,
    messageCount: 0,
    model: null,
    ...patch,
  };
}

/** 取回注册好的 handler（去掉 IPC event 参数） */
function invoke<TResponse>(channel: string, request?: unknown): Promise<TResponse> {
  const handler = registered.handlers.get(channel);
  if (handler === undefined) throw new Error(`${channel} handler 未注册`);
  return handler({}, request) as Promise<TResponse>;
}

beforeEach(() => {
  vi.clearAllMocks();
  registered.handlers.clear();
  order.calls = [];
  store.list.mockResolvedValue([]);
  store.create.mockResolvedValue(summary());
  store.remove.mockImplementation(async (id: string) => {
    order.calls.push(`store.remove:${id}`);
  });
  store.setCwd.mockResolvedValue(undefined);
  registerSessionsIpc();
});

describe("sessions:list", () => {
  it("按 kind 过滤：chat / 缺省 / 历史侧边聊天都可见；subagent 隐藏", async () => {
    const chat = summary({ id: "chat-1", kind: "chat" });
    const subagent = summary({
      id: "sub-1",
      kind: "subagent",
      parentSessionId: "chat-1",
      parentToolCallId: "call-1",
      agentName: "explorer",
    });
    const legacy = summary({ id: "legacy-1" });
    // 旧索引里没有 kind 字段：契约规定按 chat 处理，这里用一个真正没有该键的摘要
    delete legacy.kind;
    // 更早的版本还给侧边聊天写过自己的 kind 值；那种会话现在会被 store 落回 "chat"，
    // 于是它会作为普通会话出现在左侧栏里 —— 它只是一段孤立的旧对话，让用户看见并
    // 删掉它是唯一的处理方式（见 session-store 的 normalizeSessionKind）。这里按
    // store 读出来的摘要构造，钉住「不再被隐藏」这层行为。
    const oldSidePanelChat = summary({ id: "side-1", kind: "chat", parentSessionId: "chat-1" });
    store.list.mockResolvedValue([chat, subagent, legacy, oldSidePanelChat]);

    const visible = await invoke<SessionSummary[]>(IPC.sessions.list);

    expect(visible.map((item) => item.id)).toEqual(["chat-1", "legacy-1", "side-1"]);
    // 逐个 kind 点名：这条保证是「子智能体永远不进左侧栏」，不能只靠总长度暗示
    for (const item of [chat, subagent, legacy, oldSidePanelChat]) {
      const expectedVisible = item.kind === undefined || item.kind === "chat";
      expect(visible.some((candidate) => candidate.id === item.id)).toBe(expectedVisible);
    }
  });
});

describe("sessions:create", () => {
  it("完整的 SessionCreateOptions（kind 与归属信息）原样转发给 store", async () => {
    const options: SessionCreateOptions = {
      cwd: "C:/work/project",
      title: "子智能体转录",
      kind: "subagent",
      parentSessionId: "chat-1",
      parentToolCallId: "call-1",
      agentName: "explorer",
      delegationId: "call-1",
    };
    const created = summary({
      id: "sub-1",
      kind: "subagent",
      parentSessionId: "chat-1",
      parentToolCallId: "call-1",
      agentName: "explorer",
    });
    store.create.mockResolvedValue(created);

    const result = await invoke<SessionSummary>(IPC.sessions.create, options);

    // 一个字段都不能少：kind / 归属信息是子智能体转录能被关联回父会话的唯一依据
    expect(store.create).toHaveBeenCalledWith(options);
    expect(result).toEqual(created);
  });
});

/**
 * 删除会话的收尾（P1-3）。
 *
 * `closeSession` 曾经**生产从不调用**：`sessions:delete` 直接删 SQLite 文件，
 * 而 `Harness` / `Conversation` / `ExecutionEnv` 与事件订阅全都还活着 ——
 * 每删一个会话就漏一整套运行时资源（实测表现为 50 个会话留下 120 MB 的 `-wal`）。
 */
/**
 * 新会话页「选择项目」的落点。
 *
 * 这一条只验转发（改绑定的判定在 store 里，见 session-store.test.ts 的 setCwd 一节）：
 * IPC 层多写一层校验，就会出现「界面能选、store 也接受，但中间那道闸门把它拦了」——
 * 而那种失败在界面上只表现为「点了没反应」。
 */
describe("sessions:set-cwd", () => {
  it("把 {id, cwd} 原样交给 store", async () => {
    store.setCwd.mockResolvedValue(undefined);

    await invoke(IPC.sessions.setCwd, { id: "s1", cwd: "D:\\dev\\oint" });

    expect(store.setCwd).toHaveBeenCalledWith("s1", "D:\\dev\\oint");
  });

  it("store 拒绝时错误照常抛给渲染层（那里要把它显示出来）", async () => {
    store.setCwd.mockRejectedValue(new Error("目录不存在：D:\\nope"));

    await expect(invoke(IPC.sessions.setCwd, { id: "s1", cwd: "D:\\nope" })).rejects.toThrow(
      "目录不存在",
    );
  });
});

describe("sessions:delete", () => {
  it("先关运行时、再删库（顺序反了，收尾就打在已删除的存储上）", async () => {
    await invoke(IPC.sessions.delete, { id: "s1" });

    expect(order.calls).toEqual(["closeSession:s1", "store.remove:s1"]);
    expect(chatRuntime.closeSession).toHaveBeenCalledWith("s1");
    expect(store.remove).toHaveBeenCalledWith("s1");
  });

  it("删除不存在的会话也照常走完（closeSession 对未知 id 是空操作）", async () => {
    await expect(invoke(IPC.sessions.delete, { id: "missing" })).resolves.toBeUndefined();
    expect(order.calls).toEqual(["closeSession:missing", "store.remove:missing"]);
  });
});
