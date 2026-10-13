// title-generator 单测：素材挑选、输出去噪、失败一律返回 null；通过注入假 models 完全避免网络请求。
import type { MutableModels } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { ChatMessage, ModelServiceConfig, Settings } from "@/shared/contracts";
import { DEFAULT_WEB_SEARCH_SETTINGS } from "@/shared/contracts/web";
import {
  autoTitleSession,
  collectTitleSource,
  createSessionTitleGenerator,
  normalizeSessionTitle,
  type SessionTitleHooks,
  type SessionTitleInput,
} from "./title-generator";

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    theme: "system",
    language: "zh-CN",
    density: "comfortable",
    chatFont: "",
    chatFontSize: 14,
    services: [],
    defaultModel: null,
    thinkingLevel: "medium",
    permissionMode: "default",
    agentMode: "standard",
    disabledSubagentNames: [],
    mcpServers: [],
    systemMcpServerEnabled: {},
    webSearch: DEFAULT_WEB_SEARCH_SETTINGS,
    disabledSkillNames: [],
    ...overrides,
  };
}

const service: ModelServiceConfig = {
  id: "svc-a",
  name: "服务 A",
  baseUrl: "https://api.test/v1",
  apiKey: "sk-test",
  wireFormat: "openai-completions",
  models: [{ id: "m1" }],
};

function configuredSettings(overrides: Partial<Settings> = {}): Settings {
  return makeSettings({
    services: [service],
    defaultModel: { serviceId: "svc-a", modelId: "m1" },
    ...overrides,
  });
}

/** 假 completeSimple：记录入参并返回固定文本或抛指定异常，不触碰网络 */
function fakeModels(options: {
  text?: string;
  error?: unknown;
  seen?: { system?: string; content?: string };
}) {
  return {
    completeSimple: async (
      _model: unknown,
      params: { systemPrompt?: string; messages?: { content?: unknown }[] },
    ) => {
      if (options.seen) {
        options.seen.system = params.systemPrompt;
        const content = params.messages?.[0]?.content;
        options.seen.content = typeof content === "string" ? content : undefined;
      }
      if (options.error !== undefined) throw options.error;
      return {
        role: "assistant",
        content: [{ type: "text", text: options.text ?? "" }],
        api: "openai-completions",
        provider: "svc-a",
        model: "m1",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      };
    },
  } as unknown as MutableModels;
}

function message(role: "user" | "assistant", text: string): ChatMessage {
  return {
    id: `${role}-${text}`,
    role,
    createdAt: Date.now(),
    parts: [{ type: "text", text }],
    status: "complete",
  };
}

describe("collectTitleSource", () => {
  it("取第一条有文字的用户消息与它之后的助手回复", () => {
    const source = collectTitleSource([
      message("user", "帮我修一下登录超时"),
      message("assistant", "问题在超时时间配置…"),
      message("user", "再顺手加个日志"),
      message("assistant", "已加日志"),
    ]);
    expect(source).toEqual({
      userText: "帮我修一下登录超时",
      assistantText: "问题在超时时间配置…",
    });
  });

  it("跳过只有工具调用 / 图片的消息", () => {
    const withToolOnlyAssistant: ChatMessage = {
      id: "a-tool",
      role: "assistant",
      createdAt: Date.now(),
      parts: [
        { type: "tool-call", toolCallId: "t1", toolName: "read", argsText: "{}", status: "done" },
      ],
      status: "complete",
    };
    const source = collectTitleSource([
      message("user", "看看这个文件"),
      withToolOnlyAssistant,
      message("assistant", "这个文件负责鉴权"),
    ]);
    expect(source?.assistantText).toBe("这个文件负责鉴权");
  });

  it("缺用户或助手文本时返回 null", () => {
    expect(collectTitleSource([])).toBeNull();
    expect(collectTitleSource([message("assistant", "你好")])).toBeNull();
    expect(collectTitleSource([message("user", "帮我看下")])).toEqual({
      userText: "帮我看下",
      assistantText: "",
    });
  });
});

describe("normalizeSessionTitle", () => {
  it("rejects invalid JSON-shaped output instead of storing it as a title", () => {
    for (const raw of [
      '{"title":null}',
      '{"title":""}',
      '{"other":"value"}',
      '{"title":',
      '```json\n{"title":null}\n```',
      "[]",
    ])
      expect(normalizeSessionTitle(raw)).toBeNull();
    expect(normalizeSessionTitle("Login timeout investigation")).toBe(
      "Login timeout investigation",
    );
  });
  it("去掉换行、引号、Markdown 记号与「标题：」前缀", () => {
    expect(normalizeSessionTitle("标题：修复登录超时。")).toBe("修复登录超时");
    expect(normalizeSessionTitle('"Fix login timeout."')).toBe("Fix login timeout");
    expect(normalizeSessionTitle("## 修复登录超时")).toBe("修复登录超时");
    expect(normalizeSessionTitle("修复登录超时\n（这是一句解释）")).toBe("修复登录超时");
  });

  it("超长标题按上限截断（按字符数）", () => {
    const long = "很".repeat(60);
    expect(normalizeSessionTitle(long)?.length).toBe(40);
  });

  it("JSON 输出含转义引号时也能完整取到标题", () => {
    expect(normalizeSessionTitle('{"title": "Fix \\"login\\" timeout"}')).toBe(
      'Fix "login" timeout',
    );
  });

  it("非 JSON 输出仍走文本启发式（旧行为不退步）", () => {
    expect(normalizeSessionTitle("标题：修复登录超时。")).toBe("修复登录超时");
    expect(normalizeSessionTitle('```json\n{"title":"登录超时排查"}\n```')).toBe("登录超时排查");
  });

  it("空内容返回 null（调用方保留默认会话名）", () => {
    expect(normalizeSessionTitle("")).toBeNull();
    expect(normalizeSessionTitle("   \n  ")).toBeNull();
    expect(normalizeSessionTitle('""')).toBeNull();
  });
});

describe("createSessionTitleGenerator", () => {
  it("未选择默认路由模型时放弃命名", async () => {
    const generate = createSessionTitleGenerator({ getSettings: async () => makeSettings() });
    await expect(generate({ userText: "你好", assistantText: "你好呀" })).resolves.toBeNull();
  });

  it("读取设置失败时放弃命名", async () => {
    const generate = createSessionTitleGenerator({
      getSettings: async () => {
        throw new Error("磁盘错误");
      },
    });
    await expect(generate({ userText: "你好", assistantText: "你好呀" })).resolves.toBeNull();
  });

  it("把素材填进内置英文提示词（不再有自定义入口）", async () => {
    const seen: { system?: string; content?: string } = {};
    const generate = createSessionTitleGenerator({
      getSettings: async () => configuredSettings(),
      buildModels: () => fakeModels({ text: "标题：登录超时排查\n", seen }),
    });
    await expect(
      generate({ userText: "登录总是超时", assistantText: "看下超时配置" }),
    ).resolves.toBe("登录超时排查");
    expect(seen.system).toContain("You name conversation threads in Oint");
    expect(seen.content).toContain("登录总是超时");
    expect(seen.content).toContain("看下超时配置");
    expect(seen.content).toContain("same language as the user's message");
  });

  it("模型输出为空或调用失败时返回 null，不抛错", async () => {
    const empty = createSessionTitleGenerator({
      getSettings: async () => configuredSettings(),
      buildModels: () => fakeModels({ text: "   " }),
    });
    await expect(empty({ userText: "你好", assistantText: "在的" })).resolves.toBeNull();

    const failing = createSessionTitleGenerator({
      getSettings: async () => configuredSettings(),
      buildModels: () => fakeModels({ error: new Error("网络中断") }),
    });
    await expect(failing({ userText: "你好", assistantText: "在的" })).resolves.toBeNull();
  });
});

describe("autoTitleSession", () => {
  /** 有状态的假会话：rename 会真的改掉标题，readTitle 因此能反映「写后回读」的结果 */
  function fakeSession(options: {
    title?: string | null;
    messages?: ChatMessage[];
    generated?: string | null;
    /** 模拟「没有可用模型」：不算一次尝试 */
    noModel?: boolean;
    /** 模拟写入失败（索引里没写进去） */
    renameLands?: boolean;
    onRename?: (sessionId: string, title: string) => void;
    /** 生成期间发生的改动（例如用户在侧栏手动改名） */
    duringGenerate?: (session: { title: string | null }) => void;
  }) {
    const session = { title: options.title ?? null };
    const renamed: Array<[string, string]> = [];
    const attempts: string[] = [];
    return {
      session,
      renamed,
      attempts,
      deps: {
        generate: async (_input: SessionTitleInput, hooks?: SessionTitleHooks) => {
          options.duringGenerate?.(session);
          // 真生成器在「没有模型」时直接放弃，且不记尝试（用户配好模型后还能补标题）
          if (options.noModel === true) return null;
          hooks?.onAttempt?.();
          return options.generated ?? null;
        },
        readTitle: async () => session.title,
        loadMessages: async () => options.messages ?? [],
        rename: async (sessionId: string, title: string) => {
          renamed.push([sessionId, title]);
          options.onRename?.(sessionId, title);
          if (options.renameLands !== false) session.title = title;
        },
        onAttempt: () => {
          attempts.push("attempt");
        },
      },
    };
  }

  it("没有名字时生成标题并落盘", async () => {
    const fake = fakeSession({
      messages: [message("user", "登录总是超时"), message("assistant", "看下超时配置")],
      generated: "登录超时排查",
    });
    await expect(autoTitleSession("s1", fake.deps)).resolves.toBe("登录超时排查");
    expect(fake.renamed).toEqual([["s1", "登录超时排查"]]);
    expect(fake.session.title).toBe("登录超时排查");
  });

  it("用户消息即可命名，暂时失败最多重试三次并保留用户需求兜底", async () => {
    const fake = fakeSession({ messages: [message("user", "修复登录超时")], generated: null });
    await expect(
      autoTitleSession("s1", { ...fake.deps, maxAttempts: 3, fallback: true }),
    ).resolves.toBe("修复登录超时");
    expect(fake.attempts).toHaveLength(3);
    expect(fake.renamed).toEqual([["s1", "修复登录超时"]]);
  });

  it("structured user requests remain usable fallback titles", async () => {
    for (const text of ["[Bug] 修复登录超时", '{"task":"修复登录"}']) {
      const fake = fakeSession({ messages: [message("user", text)], generated: null });
      await expect(
        autoTitleSession("s1", { ...fake.deps, maxAttempts: 3, fallback: true }),
      ).resolves.toBe(text);
    }
    const fake = fakeSession({ messages: [message("user", "🙂".repeat(45))], generated: null });
    await expect(autoTitleSession("s1", { ...fake.deps, fallback: true })).resolves.toBe(
      "🙂".repeat(40),
    );
  });

  it("重试成功后立即停止，原子保存拒绝时不覆盖人工标题", async () => {
    const fake = fakeSession({ messages: [message("user", "登录超时")] });
    let calls = 0;
    await expect(
      autoTitleSession("s1", {
        ...fake.deps,
        maxAttempts: 3,
        generate: async () => (++calls === 1 ? null : "登录超时排查"),
        renameIfUntitled: async () => {
          fake.session.title = "人工标题";
          return false;
        },
      }),
    ).resolves.toBeNull();
    expect(calls).toBe(2);
    expect(fake.renamed).toEqual([]);
    expect(fake.session.title).toBe("人工标题");
  });

  it("已有标题（含用户手改 / 分支名）时不覆盖、也不再请求模型", async () => {
    let called = false;
    const title = await autoTitleSession("s1", {
      generate: async () => {
        called = true;
        return "新标题";
      },
      readTitle: async () => "源会话 · 分支",
      loadMessages: async () => [message("user", "你好"), message("assistant", "在的")],
      rename: async () => {
        called = true;
      },
    });
    expect(title).toBeNull();
    expect(called).toBe(false);
  });

  it("生成期间用户手动改名：不覆盖用户输入", async () => {
    const fake = fakeSession({
      messages: [message("user", "你好"), message("assistant", "在的")],
      generated: "自动标题",
      duringGenerate: (session) => {
        session.title = "我自己的名字";
      },
    });
    await expect(autoTitleSession("s1", fake.deps)).resolves.toBeNull();
    expect(fake.renamed).toEqual([]);
    expect(fake.session.title).toBe("我自己的名字");
  });

  it("落盘失败时不广播标题（回读不一致即视为未命名）", async () => {
    const fake = fakeSession({
      messages: [message("user", "你好"), message("assistant", "在的")],
      generated: "自动标题",
      renameLands: false,
    });
    await expect(autoTitleSession("s1", fake.deps)).resolves.toBeNull();
    expect(fake.renamed).toEqual([["s1", "自动标题"]]);
  });

  it("素材不足或模型放弃时不落盘", async () => {
    const noAssistant = fakeSession({ messages: [message("user", "只有我问")] });
    await expect(autoTitleSession("s1", noAssistant.deps)).resolves.toBeNull();

    const modelGaveUp = fakeSession({
      messages: [message("user", "你好"), message("assistant", "在的")],
      generated: null,
    });
    await expect(autoTitleSession("s1", modelGaveUp.deps)).resolves.toBeNull();
    expect(modelGaveUp.renamed).toEqual([]);
  });

  it("onAttempt 只在真要调模型时触发：素材不足不记账，下一轮可补上", async () => {
    const empty = fakeSession({ messages: [] });
    await expect(autoTitleSession("s1", empty.deps)).resolves.toBeNull();
    expect(empty.attempts).toEqual([]);

    const ready = fakeSession({
      messages: [message("user", "你好"), message("assistant", "在的")],
      generated: "标题",
    });
    await expect(autoTitleSession("s1", ready.deps)).resolves.toBe("标题");
    expect(ready.attempts).toEqual(["attempt"]);
    expect(ready.renamed).toEqual([["s1", "标题"]]);
  });

  it("没有可用模型时记账回调不触发，配好模型后下一轮仍能补标题", async () => {
    const noModel = fakeSession({
      messages: [message("user", "你好"), message("assistant", "在的")],
      noModel: true,
    });
    await expect(autoTitleSession("s1", noModel.deps)).resolves.toBeNull();
    expect(noModel.attempts).toEqual([]);
    expect(noModel.renamed).toEqual([]);
  });
});
