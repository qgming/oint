import type { Message } from "@earendil-works/pi-ai";
import { type EntryId, MemoryStorage, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import type { AppEntry } from "./durable-session";

const ids = await Promise.all(
  Array.from({ length: 100 }, () => new MemoryStorage().mintId<EntryId>()),
);

import { describe, expect, it, vi } from "vitest";
import type { ToolCallPart } from "@/shared/contracts/session";
import { mapEntriesToMessages, mapUserParts } from "./message-mapper";

type UserMessage = Extract<Message, { role: "user" }>;
type AssistantMessage = Extract<Message, { role: "assistant" }>;
type ToolResultMessage = Extract<Message, { role: "toolResult" }>;

const USAGE: AssistantMessage["usage"] = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 3,
  totalTokens: 15,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function messageEntry(id: string, seq: number, message: Message): AppEntry {
  const native = ids[seq];
  if (native === undefined) throw new Error("Missing test id");
  return {
    record: {
      id: native,
      conversationId: ROOT_CONVERSATION_ID,
      kind: message.role === "toolResult" ? "pi.tool-result" : `pi.${message.role}`,
      model: [message],
    },
    entryId: id,
    parentId: null,
    sequence: seq,
    createdAt: 1_000 + seq,
  };
}

function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "test",
    model: "test-model",
    usage: USAGE,
    stopReason: "stop",
    timestamp: 1_000,
  };
}

function toolResultMessage(
  overrides: Partial<ToolResultMessage> & { toolCallId: string },
): ToolResultMessage {
  return {
    role: "toolResult",
    toolName: "read",
    content: [],
    isError: false,
    timestamp: 2_000,
    ...overrides,
  };
}

describe("mapEntriesToMessages", () => {
  it("映射 user/assistant 内容块并把 toolResult 回填到对应调用", () => {
    const entries: AppEntry[] = [
      messageEntry("u1", 1, { role: "user", content: "你好", timestamp: 1 } satisfies UserMessage),
      messageEntry(
        "a1",
        2,
        assistantMessage([
          { type: "thinking", thinking: "先读文件" },
          { type: "text", text: "我来看看" },
          { type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.txt" } },
        ]),
      ),
      messageEntry(
        "t1",
        3,
        toolResultMessage({
          toolCallId: "call-1",
          content: [{ type: "text", text: "文件内容" }],
        }),
      ),
    ];

    const { messages, compactionSummaries } = mapEntriesToMessages(entries);

    expect(compactionSummaries).toEqual([]);
    expect(messages).toHaveLength(2);

    expect(messages[0]).toMatchObject({
      id: "u1",
      entryId: "u1",
      role: "user",
      createdAt: 1_001,
      status: "complete",
    });
    expect(messages[0]?.parts).toEqual([{ type: "text", text: "你好" }]);

    const assistant = messages[1];
    expect(assistant).toMatchObject({ id: "a1", entryId: "a1", role: "assistant" });
    expect(assistant?.parts).toEqual([
      { type: "reasoning", text: "先读文件" },
      { type: "text", text: "我来看看" },
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "read",
        argsText: '{"path":"a.txt"}',
        args: { path: "a.txt" },
        result: "文件内容",
        isError: false,
        status: "done",
      },
    ]);
    expect(assistant?.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      reasoningTokens: 3,
      totalTokens: 15,
      uncachedInputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it("durationMs 透传：助手回复与工具结果的耗时都带上（内核 1.2.0 测量）", () => {
    const entries: AppEntry[] = [
      messageEntry("a1", 1, {
        ...assistantMessage([
          { type: "toolCall", id: "call-x", name: "read", arguments: { path: "a.txt" } },
        ]),
        durationMs: 4_200,
      }),
      messageEntry(
        "t1",
        2,
        toolResultMessage({
          toolCallId: "call-x",
          content: [{ type: "text", text: "ok" }],
          durationMs: 350,
        }),
      ),
    ];

    const { messages } = mapEntriesToMessages(entries);
    expect(messages[0]?.durationMs).toBe(4_200);
    const part = messages[0]?.parts.find((candidate) => candidate.type === "tool-call");
    expect(part).toMatchObject({ durationMs: 350, status: "done" });
  });

  it("user 图片内容映射为 dataUrl", () => {
    const entries: AppEntry[] = [
      messageEntry("u1", 1, {
        role: "user",
        content: [
          { type: "text", text: "看图" },
          { type: "image", data: "QUJD", mimeType: "image/png" },
        ],
        timestamp: 1,
      }),
    ];

    const { messages } = mapEntriesToMessages(entries);
    expect(messages[0]?.parts).toEqual([
      { type: "text", text: "看图" },
      { type: "image", mimeType: "image/png", dataUrl: "data:image/png;base64,QUJD" },
    ]);
  });

  /**
   * 截图的历史回读：图片本体从 pi 的 toolResult 条目里重新取出。
   *
   * 这条路径就是「刷新窗口 / 重开应用之后，会话里的截图还在」的全部实现 ——
   * part 上的 images 只在内存里（流式那份由 runtime 的 applyToolEnd 写），磁盘上的那份
   * 是这条 toolResult 消息的 image 内容块。两条路径共用同一个 toolPartImages 判断，
   * 所以这里同时钉住「截图带图」与「read_image 不带图」这一对相反的口径。
   */
  it("截图的 toolResult 回读时带上图片；read_image 刻意不带（它给 path，界面现取）", () => {
    const entries: AppEntry[] = [
      messageEntry(
        "a1",
        1,
        assistantMessage([
          { type: "toolCall", id: "call-1", name: "browser_screenshot", arguments: {} },
          { type: "toolCall", id: "call-2", name: "read_image", arguments: { file_path: "a.png" } },
        ]),
      ),
      messageEntry(
        "t1",
        2,
        toolResultMessage({
          toolCallId: "call-1",
          toolName: "browser_screenshot",
          content: [
            { type: "text", text: "Screenshot of the visible viewport (380×639)." },
            { type: "image", data: "QUJD", mimeType: "image/png" },
          ],
        }),
      ),
      messageEntry(
        "t2",
        3,
        toolResultMessage({
          toolCallId: "call-2",
          toolName: "read_image",
          content: [{ type: "image", data: "QUJD", mimeType: "image/png" }],
        }),
      ),
    ];

    const { messages } = mapEntriesToMessages(entries);
    const parts = messages[0]?.parts ?? [];
    const screenshot = parts.find(
      (part): part is ToolCallPart =>
        part.type === "tool-call" && part.toolName === "browser_screenshot",
    );
    const readImage = parts.find(
      (part): part is ToolCallPart => part.type === "tool-call" && part.toolName === "read_image",
    );

    expect(screenshot?.images).toEqual([
      { mimeType: "image/png", dataUrl: "data:image/png;base64,QUJD" },
    ]);
    expect(readImage?.images).toBeUndefined();
  });

  it("无结果的调用保持 running，出错结果标记 error", () => {
    const entries: AppEntry[] = [
      messageEntry(
        "a1",
        1,
        assistantMessage([
          { type: "toolCall", id: "call-1", name: "read", arguments: {} },
          { type: "toolCall", id: "call-2", name: "bash", arguments: {} },
        ]),
      ),
      messageEntry(
        "t1",
        2,
        toolResultMessage({
          toolCallId: "call-2",
          toolName: "bash",
          content: [{ type: "text", text: "命令失败" }],
          isError: true,
        }),
      ),
    ];

    const { messages } = mapEntriesToMessages(entries);
    const parts = messages[0]?.parts as ToolCallPart[];
    expect(parts[0]).toMatchObject({ toolCallId: "call-1", status: "running" });
    expect(parts[0]?.result).toBeUndefined();
    expect(parts[1]).toMatchObject({
      toolCallId: "call-2",
      status: "error",
      isError: true,
      result: "命令失败",
    });
  });

  it("工具的结构化 details 与文本结果并存透传", () => {
    const details = {
      diff: "@@ -1 +1 @@\n-旧\n+新\n",
      patch: "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-旧\n+新\n",
      firstChangedLine: 1,
    };
    const entries: AppEntry[] = [
      messageEntry(
        "a1",
        1,
        assistantMessage([
          { type: "toolCall", id: "call-1", name: "edit", arguments: { path: "a.txt" } },
        ]),
      ),
      messageEntry(
        "t1",
        2,
        toolResultMessage({
          toolCallId: "call-1",
          toolName: "edit",
          content: [{ type: "text", text: "Successfully replaced 1 block(s) in a.txt." }],
          details,
        }),
      ),
    ];

    const { messages } = mapEntriesToMessages(entries);
    const part = messages[0]?.parts[0] as ToolCallPart | undefined;
    // 文本照旧进 result；details 不因为文本存在而丢失
    expect(part?.result).toBe("Successfully replaced 1 block(s) in a.txt.");
    expect(part?.details).toEqual(details);
  });

  it("工具未给 details 时不写入该字段", () => {
    const entries: AppEntry[] = [
      messageEntry(
        "a1",
        1,
        assistantMessage([{ type: "toolCall", id: "call-1", name: "read", arguments: {} }]),
      ),
      messageEntry(
        "t1",
        2,
        toolResultMessage({ toolCallId: "call-1", content: [{ type: "text", text: "内容" }] }),
      ),
    ];

    const { messages } = mapEntriesToMessages(entries);
    const part = messages[0]?.parts[0] as ToolCallPart | undefined;
    expect(part).toBeDefined();
    expect(Object.hasOwn(part ?? {}, "details")).toBe(false);
  });

  it("找不到对应调用的 toolResult 被忽略", () => {
    const entries: AppEntry[] = [
      messageEntry(
        "t1",
        1,
        toolResultMessage({ toolCallId: "missing", content: [{ type: "text", text: "x" }] }),
      ),
    ];
    expect(mapEntriesToMessages(entries).messages).toEqual([]);
  });

  it("native compaction collects its model summary while bookkeeping stays invisible", () => {
    const compact = messageEntry("c1", 1, { role: "user", content: "旧对话摘要", timestamp: 1 });
    compact.record = { ...compact.record, kind: "pi.compaction" };
    const note = messageEntry("n1", 2, { role: "user", content: "hidden", timestamp: 2 });
    note.record = { ...note.record, kind: "todo", model: undefined };
    const entries = [
      compact,
      note,
      messageEntry("u1", 4, { role: "user", content: "继续", timestamp: 4 }),
    ];
    const result = mapEntriesToMessages(entries);
    expect(result.compactionSummaries).toEqual(["旧对话摘要"]);
    expect(result.messages.map((message) => message.id)).toEqual(["u1"]);
  });

  it("未知内容块跳过且不抛错", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const weird = {
      ...assistantMessage([{ type: "text", text: "正常文本" }]),
      content: [
        { type: "text", text: "正常文本" },
        { type: "unknown-block", foo: 1 },
      ],
    } as unknown as Message;

    const entries: AppEntry[] = [messageEntry("a1", 1, weird)];
    expect(() => mapEntriesToMessages(entries)).not.toThrow();
    expect(mapEntriesToMessages(entries).messages[0]?.parts).toEqual([
      { type: "text", text: "正常文本" },
    ]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("assistant 出错状态带 error 文案", () => {
    const failed: AssistantMessage = {
      ...assistantMessage([{ type: "text", text: "出错了" }]),
      stopReason: "error",
      errorMessage: "网络异常",
    };
    const { messages } = mapEntriesToMessages([messageEntry("a1", 1, failed)]);
    expect(messages[0]).toMatchObject({ status: "error", error: "网络异常" });
  });
});

/**
 * 附件在消息里的往返：信封 + 图片块 → 附件 part。
 *
 * 这里钉住的是**界面能不能把附件卡片还原出来**。实时回显与历史回读共用同一个
 * `mapUserParts`（见该函数的说明），所以这一组用例同时覆盖「刚发出去」与
 * 「刷新之后」两种情形 —— 它们必须长得一模一样。
 */
describe("mapUserParts 的附件还原", () => {
  // 路径用正斜杠写：这些用例验的是**信封的解析**，不是 Windows 路径的转义
  //（转义那一组在 attachments.test.ts 里，用真实的双反斜杠路径钉住）
  const ENVELOPE_IMAGE =
    '<attachment index="1" kind="image" name="shot.png" mime="image/png" bytes="68" ' +
    'path="D:/proj/attachments/s1/abc.png" frames="1" width="2" height="2" />\n' +
    "<content>\nThe image below is this file, sent so you can look at it.\n</content>";

  const ENVELOPE_VIDEO =
    '<attachment index="1" kind="video" name="demo.mp4" mime="video/mp4" bytes="1024" ' +
    'path="D:/proj/demo.mp4" frames="2" duration="6.20" frame-times="1.55,4.65" />\n' +
    "<content>\nThe 2 images below are frames sampled evenly from this video (6.2s).\n</content>";

  const ENVELOPE_TEXT =
    '<attachment index="1" kind="text" name="notes.md" mime="text/markdown" bytes="9" ' +
    'path="D:/proj/notes.md" frames="0" lines="2" />\n' +
    "<content>\n第一行\n第二行\n</content>";

  it("信封 + 图片块 → 一条附件 part，帧留在 part 上", () => {
    const parts = mapUserParts({
      role: "user",
      content: [
        { type: "text", text: "看这张图" },
        { type: "text", text: ENVELOPE_IMAGE },
        { type: "image", data: "QUJD", mimeType: "image/png" },
      ],
      timestamp: 1,
    });

    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ type: "text", text: "看这张图" });
    expect(parts[1]).toEqual({
      type: "attachment",
      index: 1,
      kind: "image",
      name: "shot.png",
      mimeType: "image/png",
      size: 68,
      path: "D:/proj/attachments/s1/abc.png",
      frames: [{ mimeType: "image/png", dataUrl: "data:image/png;base64,QUJD" }],
      width: 2,
      height: 2,
    });
  });

  it("视频：帧数与时长进 part（界面要显示「模型只看到这几帧」）", () => {
    const parts = mapUserParts({
      role: "user",
      content: [
        { type: "text", text: ENVELOPE_VIDEO },
        { type: "image", data: "QQ==", mimeType: "image/jpeg" },
        { type: "image", data: "Qg==", mimeType: "image/jpeg" },
      ],
      timestamp: 1,
    });
    expect(parts[0]).toMatchObject({
      type: "attachment",
      kind: "video",
      frameCount: 2,
      durationSeconds: 6.2,
    });
    expect((parts[0] as { frames: unknown[] }).frames).toHaveLength(2);
  });

  it("文本附件没有帧，行数照常带出", () => {
    const parts = mapUserParts({
      role: "user",
      content: [{ type: "text", text: ENVELOPE_TEXT }],
      timestamp: 1,
    });
    expect(parts[0]).toMatchObject({ type: "attachment", kind: "text", totalLines: 2 });
    expect((parts[0] as { frames?: unknown }).frames).toBeUndefined();
  });

  it("多条附件各自配自己的帧（交错顺序不能串）", () => {
    const parts = mapUserParts({
      role: "user",
      content: [
        { type: "text", text: ENVELOPE_IMAGE },
        { type: "image", data: "QUJD", mimeType: "image/png" },
        { type: "text", text: ENVELOPE_VIDEO },
        { type: "image", data: "QQ==", mimeType: "image/jpeg" },
        { type: "image", data: "Qg==", mimeType: "image/jpeg" },
      ],
      timestamp: 1,
    });
    expect(parts.map((part) => (part.type === "attachment" ? part.name : part.type))).toEqual([
      "shot.png",
      "demo.mp4",
    ]);
    expect((parts[0] as { frames: unknown[] }).frames).toHaveLength(1);
    expect((parts[1] as { frames: unknown[] }).frames).toHaveLength(2);
  });

  it("旧会话（没有信封的裸图片块）继续显示成图片", () => {
    const parts = mapUserParts({
      role: "user",
      content: [{ type: "image", data: "QUJD", mimeType: "image/png" }],
      timestamp: 1,
    });
    expect(parts).toEqual([
      { type: "image", mimeType: "image/png", dataUrl: "data:image/png;base64,QUJD" },
    ]);
  });

  it("帧数对不上时按实际块数收（信封只是提示，解析以块为准）", () => {
    const parts = mapUserParts({
      role: "user",
      content: [
        { type: "text", text: ENVELOPE_VIDEO },
        { type: "image", data: "QQ==", mimeType: "image/jpeg" },
        { type: "text", text: "信封说 2 帧，实际只有 1 帧" },
      ],
      timestamp: 1,
    });
    expect(parts).toHaveLength(2);
    expect((parts[0] as { frames: unknown[] }).frames).toHaveLength(1);
    expect(parts[1]).toEqual({ type: "text", text: "信封说 2 帧，实际只有 1 帧" });
  });
});
