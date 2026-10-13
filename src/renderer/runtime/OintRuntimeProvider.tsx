import {
  type AppendMessage,
  type AssistantRuntime,
  AssistantRuntimeProvider,
  type Attachment,
  type ExternalStoreThreadListAdapter,
  MessageNotSentError,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import type * as React from "react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { commandSpec, runCommand, unavailableReason } from "@/renderer/features/chat/commands";
import { dispatchSlashInput } from "@/renderer/features/chat/slash-commands";
import { JobToolUIs, SubagentToolUIs } from "@/renderer/features/chat/ToolParts";
import { loadSlashCommands, resolveWorkingDir } from "@/renderer/features/chat/use-slash-commands";
import { selectSessionTitles } from "@/renderer/lib/session-title";
import { useChatStore } from "@/renderer/stores/chat-store";
import { SUBAGENT_TOOL_NAMES, useSubagentStore } from "@/renderer/stores/subagent-store";
import { useUiStore } from "@/renderer/stores/ui-store";
import type { ChatMessage } from "@/shared/contracts";
import { OintAttachmentAdapter } from "./attachment-adapter";
import { appendMessageToAttachments } from "./attachment-payload";
import { startEventBridge } from "./event-bridge";
import {
  appendMessageToText,
  childSessionIdFromDetails,
  toThreadMessage,
} from "./message-converter";

/**
 * 发送前的**唯一收口**：认出指令、展开斜杠命令、放行普通消息。
 *
 * 为什么落在这里而不是 Composer：库的发送主路径是 ComposerPrimitive.Send → 本 provider 的
 * onNew，Composer 想拦它就得放弃 Send primitive 自己重写一遍发送；而 onNew 是**唯一的**
 * 收口，两条发送路径（发送键、键盘回车）都会经过它。
 *
 * 清单与菜单同源（同一个 loadSlashCommands），否则会出现「菜单里看得见、发送时认不出来」
 * —— 对指令来说那意味着一条 `/compact` 会被当成普通消息发给模型。
 *
 * 读不到清单时不展开、也不吞输入：`loadSlashCommands` 会把内置指令补上，
 * 因此 `/compact` 在任何情况下都还认得出来。
 */
async function resolveSlashMessage(
  text: string,
  workingDir: string | undefined,
): Promise<
  | { kind: "message"; text: string }
  | { kind: "command"; name: string; rest: string; source: string }
> {
  if (!text.startsWith("/")) return { kind: "message", text };
  const commands = await loadSlashCommands(workingDir, (key) => key);
  const dispatch = dispatchSlashInput(text, commands);
  if (dispatch.kind === "message") return dispatch;
  return {
    kind: "command",
    name: dispatch.command.name,
    rest: dispatch.rest,
    // 原文留着：万一指令名查不到规格（代码与菜单不同步），宁可当普通消息发出去，也不能吞掉
    source: text,
  };
}

/** 稳定的空数组常量：zustand v5 基于 useSyncExternalStore，
 *  选择器每次返回新引用会被判定为快照变化，从而触发无限重渲染（React #185）。 */
const EMPTY_MESSAGES: ChatMessage[] = [];

/** 渲染层运行时桥：把 chat-store 接入 assistant-ui 的 ExternalStoreRuntime */
export function OintRuntimeProvider({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const runtimeRef = useRef<AssistantRuntime | null>(null);
  const composerDrafts = useRef(
    new Map<string, { text: string; attachments: readonly Attachment[] }>(),
  ).current;
  const messages = useChatStore((state) =>
    state.activeSessionId
      ? (state.messagesBySession[state.activeSessionId] ?? EMPTY_MESSAGES)
      : EMPTY_MESSAGES,
  );
  const isRunning = useChatStore((state) =>
    state.activeSessionId ? state.runningBySession[state.activeSessionId] === true : false,
  );
  const sessionTitles = useChatStore(useShallow(selectSessionTitles));
  const sessions = useChatStore((state) => state.sessions);
  const activeSessionId = useChatStore((state) => state.activeSessionId);
  /**
   * 当前会话的工作目录。只订阅 cwd 这一个值（不是整个 sessions 数组）：选择器返回字符串，
   * zustand 的 Object.is 比较才稳，切会话不会连带重渲染整棵 runtime 树。
   */
  const sessionCwd = useChatStore(
    (state) => state.sessions.find((session) => session.id === state.activeSessionId)?.cwd,
  );
  const workingDir = resolveWorkingDir(sessionCwd);

  // 主进程事件 → store reducer（卸载时取消订阅）
  useEffect(() => {
    const unsubscribe = startEventBridge((sessionId, event) => {
      useChatStore.getState().applyEvent(sessionId, event);
    });
    return unsubscribe;
  }, []);
  const onNew = useCallback(
    async (message: AppendMessage) => {
      let targetSessionId = activeSessionId;
      const resolved = await resolveSlashMessage(appendMessageToText(message), workingDir);
      /**
       * 指令**不产生模型消息**：整条命令在这里被消费掉。
       *
       * 不可用（正在跑一轮 / 已经在压缩）时不执行、也不发送 —— 给一行提示。
       * Composer 的按键路径已经拦过一道（那里能保住草稿），这里是发送键那条路的兜底。
       */
      if (resolved.kind === "command") {
        const spec = commandSpec(resolved.name);
        if (spec !== undefined) {
          if (useChatStore.getState().activeSessionId !== targetSessionId) {
            const key = targetSessionId ?? "__new__";
            if (!composerDrafts.has(key))
              composerDrafts.set(key, {
                text: appendMessageToText(message),
                attachments: message.attachments ?? [],
              });
            throw new MessageNotSentError("The conversation changed before the command could run.");
          }
          const state = useChatStore.getState();
          const sessionId = state.activeSessionId;
          const reason = unavailableReason(spec, {
            running: sessionId !== null && state.runningBySession[sessionId] === true,
            compacting: sessionId !== null && state.compactions[sessionId]?.phase === "running",
          });
          const notify = useUiStore.getState().notifyComposer;
          if (reason !== null) {
            notify(reason);
            throw new MessageNotSentError("The command is not available right now.");
          }
          const feedback = await runCommand(spec, resolved.rest, {
            compact: (instructions) => useChatStore.getState().compact(instructions),
          });
          if (feedback.notice !== undefined) notify(feedback.notice);
          return;
        }
        // 规格查不到（菜单与代码不同步）：按普通消息发出去，绝不静默吞掉用户输入
      }
      const text = resolved.kind === "command" ? resolved.source : resolved.text;
      /**
       * 附件从 `message.attachments` 取，**不是** `message.content`（见 attachment-payload）。
       *
       * 这一步曾经写成只扫 content，于是图片从来没离开过渲染进程：界面上不显示、
       * 模型也收不到。测试直接钉在这个函数上。
       */
      const attachments = appendMessageToAttachments(message);
      try {
        if (targetSessionId === null) {
          await useChatStore.getState().createSession();
          targetSessionId = useChatStore.getState().activeSessionId;
        }
        await useChatStore.getState().send(text, attachments, targetSessionId);
      } catch (error) {
        const draft = {
          text: appendMessageToText(message),
          attachments: message.attachments ?? [],
        };
        const key = targetSessionId ?? "__new__";
        if (!composerDrafts.has(key)) composerDrafts.set(key, draft);
        if (useChatStore.getState().activeSessionId === targetSessionId) {
          const composer = runtimeRef.current?.thread.composer;
          if (composer && !composer.getState().text && !composer.getState().attachments.length) {
            composer.setText(draft.text);
            for (const attachment of draft.attachments) {
              void composer.addAttachment({ ...attachment, content: attachment.content ?? [] });
            }
          }
          useUiStore.getState().notifyComposer({ messageKey: "chat.sendFailed", level: "error" });
        }
        // assistant-ui restores rejected sends, including attachment payloads.
        throw new MessageNotSentError(error instanceof Error ? error.message : String(error));
      }
    },
    [workingDir, composerDrafts, activeSessionId],
  );

  const onCancel = useCallback(async () => {
    await useChatStore.getState().stop();
  }, []);

  // 重新生成最后一条回复：删除其后消息并重发最后一条用户消息
  const onReload = useCallback(async () => {
    await useChatStore.getState().reload();
  }, []);

  // 附件：自绘适配器，接受任意文件（图片 / 视频 / 文本 / 其他），加入时就探测好
  const attachments = useMemo(() => new OintAttachmentAdapter(), []);

  /**
   * 会话列表适配器：把 chat-store 的 sessions 接到官方的 thread-list primitives。
   * threads 的顺序即渲染顺序，store 已按 updatedAt 降序维护，这里不再排序。
   *
   * 侧栏的「置顶 / 项目 / 最近」分组不在这里切：分组要用到项目列表与会话的绑定目录，
   * 由 thread-list 部件直接读 chat-store 与 projects-store 计算（见 buildSidebarSections）——
   * 走商店的订阅比把数据塞进 custom 再读回来更直接，也保证置顶后立刻重新分组。
   *
   * 一处取舍：官方 thread list 只为「主线程」保留 runtime，非当前会话读不到运行状态，
   * 因此运行中指示只在当前会话上有效（原实现每个会话各自显示）。
   *
   * 已归档会话仍放进 threads（官方列表不渲染 archivedThreads，放进去会彻底找不到），
   * 归档项在菜单里以同一个 Archive 入口切换，行为与原实现一致。
   */
  const threadList = useMemo<ExternalStoreThreadListAdapter>(
    () => ({
      threadId: activeSessionId ?? undefined,
      threads: sessions.map((session) => ({
        id: session.id,
        status: "regular",
        title: sessionTitles[session.id] || undefined,
        custom: { archived: session.archived, updatedAt: session.updatedAt },
      })),
      onSwitchToNewThread: () => useChatStore.getState().createSession(),
      onSwitchToThread: (threadId) => useChatStore.getState().setActiveSession(threadId),
      onRename: (threadId, title) => useChatStore.getState().renameSession(threadId, title),
      onArchive: (threadId) => {
        const session = useChatStore.getState().sessions.find((item) => item.id === threadId);
        return useChatStore.getState().archiveSession(threadId, !(session?.archived ?? false));
      },
      // 官方 Delete 会立刻执行，而删会话是不可撤销的磁盘操作：先经确认框，确认后才真删
      onDelete: async (threadId) => {
        const confirmed = await useUiStore.getState().requestDeleteSession(threadId);
        if (confirmed) await useChatStore.getState().removeSession(threadId);
      },
    }),
    [sessions, activeSessionId, sessionTitles],
  );

  const adapters = useMemo(() => ({ attachments, threadList }), [attachments, threadList]);

  /**
   * 子转录修订号：已加载的子会话转录份数（只增不减，天然单调）。
   *
   * 为什么非得有这么个东西：assistant-ui 只在 convertMessage 的**函数引用**变化时才丢弃
   * 自己那份转换缓存（ExternalStoreThreadRuntimeCore 的 _converter），而 loadChild 只写
   * childMessages、**不动**父会话的 messages 数组 —— 只依赖 messages 的话，子转录到了
   * 也不会重算，嵌套消息永远不出现。把份数接进 convertMessage 的依赖，每多读到一份子转录
   * 就换一次引用，缓存随之失效并带着嵌套把整棵树重算一遍。
   * 取「份数」而不是 childMessages 对象本身：zustand v5 用 Object.is 比较快照，数字最稳，
   * 且这个数只增不减，正好当修订号（store 里已有的字段，不另造第二个真相来源）。
   */
  const childTranscriptRevision = useSubagentStore(
    (state) => Object.keys(state.childMessages).length,
  );

  /**
   * ChatMessage → assistant-ui 线程消息。
   *
   * 子会话转录在**转换发生的那一刻**用 getState() 取，而不是渲染时捕获快照 —— 解析函数
   * 因此永远读到最新一份；转换器自己仍是纯函数，只有这一层接触 store。
   * 依赖里的修订号不是转换的输入，只是让库丢掉缓存的失效信号（见上）。
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: 修订号是缓存失效信号，不是转换的输入
  const convertMessage = useCallback(
    (message: ChatMessage) =>
      toThreadMessage(message, (childSessionId) => {
        return useSubagentStore.getState().childMessages[childSessionId];
      }),
    [childTranscriptRevision],
  );

  /**
   * 主线程里的 Task 调用一出现就把子会话转录拉进来：嵌套消息要有内容可挂。
   *
   * 触发放在 provider 而不是 Task 卡片里：卡片只在当前视口挂载，而嵌套渲染取决于转换结果，
   * 用户不打开右侧面板、卡片没滚到可见处时这一步也得发生。store 动作只能在 effect 里调，
   * 不能在渲染期调。
   *
   * 依赖用**结构签名**而不是 messages 数组：流式期间数组每个 flush 都换引用，直接依赖会
   * 让整表扫描跟着每个 token 跑。扫描本身的语义是「转录里有没有新的 Task 调用」，
   * 那只在形状变化（新消息、新 part）时才可能变。loadChild 自身幂等，重复路过不会重复发 IPC。
   */
  const structureKey = `${messages.length}:${messages.at(-1)?.id ?? ""}:${messages.at(-1)?.parts.length ?? -1}`;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  // biome-ignore lint/correctness/useExhaustiveDependencies: 结构签名才是触发条件，messages 从 ref 读最新值
  useEffect(() => {
    const childSessionIds = new Set<string>();
    for (const message of messagesRef.current) {
      for (const part of message.parts) {
        if (part.type !== "tool-call") continue;
        if (!SUBAGENT_TOOL_NAMES.includes(part.toolName)) continue;
        const childSessionId = childSessionIdFromDetails(part.details);
        if (childSessionId !== undefined) childSessionIds.add(childSessionId);
      }
    }
    for (const childSessionId of childSessionIds) {
      const store = useSubagentStore.getState();
      if (store.requestedChildren[childSessionId] === true) continue;
      void store.loadChild(childSessionId);
    }
  }, [structureKey]);

  // ChatMessage 是自定义类型，必须显式提供 convertMessage
  const runtime = useExternalStoreRuntime<ChatMessage>({
    messages,
    isRunning,
    onNew,
    onCancel,
    onReload,
    convertMessage,
    adapters,
  });

  runtimeRef.current = runtime;

  useEffect(() => {
    const key = activeSessionId ?? "__new__";
    const composer = runtime.thread.composer;
    const draft = composerDrafts.get(key);
    if (draft) {
      composer.setText(draft.text);
      for (const attachment of draft.attachments) {
        const input = attachment.content?.length
          ? {
              ...attachment,
              id: attachment.id,
              type: attachment.type,
              name: attachment.name,
              contentType: attachment.contentType,
              content: attachment.content,
            }
          : attachment.file;
        if (input)
          void composer.addAttachment(input).catch(() => {
            if ((useChatStore.getState().activeSessionId ?? "__new__") === key)
              useUiStore
                .getState()
                .notifyComposer({ messageKey: "chat.sendFailed", level: "error" });
          });
      }
    }
    return composer.subscribe(() => {
      if ((useChatStore.getState().activeSessionId ?? "__new__") !== key) return;
      const state = composer.getState();
      if (!state.text && state.attachments.length === 0) composerDrafts.delete(key);
      else composerDrafts.set(key, { text: state.text, attachments: state.attachments });
    });
  }, [activeSessionId, runtime, composerDrafts]);

  useEffect(() => {
    for (const key of composerDrafts.keys()) {
      if (key !== "__new__" && !sessions.some((session) => session.id === key))
        composerDrafts.delete(key);
    }
  }, [sessions, composerDrafts]);

  /**
   * Task 系列注册成独立显示的工具 UI（见 ToolParts 的说明）。
   *
   * 挂在 provider 内部而不是 Thread 里：注册表是**运行时**的一部分，而 provider 就是
   * 创建那个运行时的地方；Thread 只是它的一个消费者，卸载换页时不该把注册一起带走。
   */
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <SubagentToolUIs />
      <JobToolUIs />
      {children}
    </AssistantRuntimeProvider>
  );
}
