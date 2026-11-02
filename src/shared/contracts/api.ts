import type { AppInfo } from "./app";
import type { ApprovalDecision } from "./approval";
import type { ChatAttachment } from "./attachment";
import type { BrowserEvent, BrowserStatus } from "./browser";
import type { ChatEventEnvelope, ChatLiveSnapshot, ChatSendOptions, CompactOutcome } from "./chat";
import type { AgentMode, ModelRef, WireFormat } from "./common";
import type { DirectoryListing, FileContent, FileWriteResult, ImageContent } from "./files";
import type { AskReply, AskRequest } from "./interaction";
import type { JobInfo } from "./job";
import type { McpProbeResult, McpServerConfig, McpServerView } from "./mcp";
import type { ModelLookupResult } from "./models";
import type { PermissionRuleView } from "./permissions";
import type {
  PluginCommandView,
  PluginDiagnostic,
  PluginListResult,
  PluginMutationResult,
  PluginSurfaceClosedEvent,
  PluginSurfaceOpenResult,
  PluginView,
} from "./plugin";
import type { Project } from "./project";
import type { PromptTemplateInfo, PromptTemplateWriteRequest } from "./prompts";
import type { ReviewSummary } from "./review";
import type {
  LoadSessionMessagesOptions,
  SessionMessagesPage,
  SessionSummary,
  SetSessionModelResult,
  SetSessionModeResult,
} from "./session";
import type { Settings } from "./settings";
import type { SkillDetail, SkillImportResult, SkillInfo } from "./skills";
import type { UsageStatsReport } from "./stats";
import type {
  SubagentCatalog,
  SubagentEventEnvelope,
  SubagentInfo,
  SubagentReadResult,
  SubagentRun,
  SubagentWriteRequest,
} from "./subagent";
import type { TerminalEvent, TerminalInfo, TerminalReplay } from "./terminal";
import type { WebTestRequest, WebTestResult } from "./web";

/** preload 暴露给渲染进程的全部能力面；渲染进程除此外无特权通道 */
export interface OintApi {
  app: {
    getInfo(): Promise<AppInfo>;
    /** 用系统默认程序打开一个绝对路径（目录或文件）；失败时返回原因，不抛异常 */
    openPath(path: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  };
  window: {
    minimize(): Promise<void>;
    toggleMaximize(): Promise<void>;
    close(): Promise<void>;
    /** 订阅最大化状态变化，返回取消订阅函数 */
    onMaximizedChange(callback: (maximized: boolean) => void): () => void;
  };
  settings: {
    read(): Promise<Settings>;
    write(next: Settings): Promise<void>;
  };
  sessions: {
    list(): Promise<SessionSummary[]>;
    create(options?: { cwd?: string; title?: string }): Promise<SessionSummary>;
    rename(id: string, title: string): Promise<void>;
    setArchived(id: string, archived: boolean): Promise<void>;
    /** 置顶/取消置顶 */
    setPinned(id: string, pinned: boolean): Promise<void>;
    /**
     * 切换该会话使用的模型（null = 跟随设置里的默认模型）。
     *
     * 立即生效：下一次发送就用新模型，会话上下文完整保留。运行中会被拒绝（reason: "running"）。
     */
    setModel(id: string, model: ModelRef | null): Promise<SetSessionModelResult>;
    /**
     * 切换该会话使用的智能体模式（null = 跟随设置里的默认模式）。
     *
     * 立即生效：下一次发送就用新模式的系统提示。运行中会被拒绝（reason: "running"）——
     * 与切模型同一条理由：中途换提示会让同一段对话的前后指令不一致。
     */
    setMode(id: string, mode: AgentMode | null): Promise<SetSessionModeResult>;
    /**
     * 重新绑定会话的工作目录（新会话页上「选择项目」走这条路）。
     *
     * 只对**还没产生消息**的会话开放：工作目录决定相对路径怎么解析，一段已经存在的
     * 对话换根之后，历史里那些相对路径会指到别的地方去。空会话没有这个包袱，
     * 而它正是用户会想改绑定的那一刻。
     */
    setCwd(id: string, cwd: string): Promise<void>;
    remove(id: string): Promise<void>;
    fork(id: string, entryId: string): Promise<SessionSummary>;
    loadMessages(id: string, options?: LoadSessionMessagesOptions): Promise<SessionMessagesPage>;
  };
  projects: {
    list(): Promise<Project[]>;
    /** 绑定一个文件夹；该路径已绑定时返回已有项目（不重复添加） */
    add(path: string): Promise<Project>;
    /** 解绑项目：只删项目本身，会话与其工作目录都不动 */
    remove(id: string): Promise<void>;
  };
  chat: {
    controlGoal(
      sessionId: string,
      action: import("./workflow").GoalControl,
    ): Promise<import("./workflow").WorkflowResult>;
    startPlan(
      sessionId: string,
      ref: import("./workflow").PlanExecutionRequest,
    ): Promise<import("./workflow").WorkflowResult>;
    readPlan(
      sessionId: string,
      ref?: import("./workflow").PlanRef,
    ): Promise<import("./workflow").PlanState | null>;
    planHistory(sessionId: string): Promise<import("./workflow").PlanState[]>;
    archivePlan(
      sessionId: string,
      ref: import("./workflow").PlanRef,
    ): Promise<import("./workflow").WorkflowResult>;
    send(
      sessionId: string,
      text: string,
      /**
       * 附件（图片 / 视频 / 文本 / 其他文件）。
       *
       * **必须读 `AppendMessage.attachments` 才拿得到**：assistant-ui 把附件放在与
       * `content` 并列的独立字段里，`content` 只有文本 —— 早先只扫 `content`，
       * 于是图片从来没离开过渲染进程（见 renderer/runtime/attachment-payload.ts）。
       */
      attachments?: ChatAttachment[],
      messageId?: string,
      /** 重新生成 / 编辑：先回退到指定条目再运行 */
      options?: ChatSendOptions,
    ): Promise<void>;
    stop(sessionId: string): Promise<void>;
    queue(sessionId: string, text: string, mode: "steer" | "followUp"): Promise<void>;
    /**
     * 撤销一条还没被消费的排队消息。
     *
     * `entryId` 就是 `QueuedMessage.id`，映射自原生 InboxDoc 的 submission id。
     * 已经开跑（被消费）或已经不存在的条目是**无操作**，不抛错 —— 用户点「移除」时那条
     * 恰好被取走是正常竞态，为它弹一个错误只会让人以为操作失败。
     */
    cancelQueued(sessionId: string, entryId: string): Promise<void>;
    /** Promote queued input to steering; the native view immediately shows it in the conversation. */
    sendQueued(sessionId: string, entryId: string): Promise<boolean>;
    /** Edit in place; false means the input has already left the queue. */
    editQueued(sessionId: string, entryId: string, text: string): Promise<boolean>;
    /**
     * 手动压缩上下文（`/compact` 指令的后端）。
     *
     * **用结果对象而不是抛异常**：`busy` / `nothing` 都是正常结局（lane 上压着别的操作、
     * 对话还短得没什么可压），不是故障；把它们的 code 交给渲染层，界面才能用自己的语言
     * 给出稳定文案（主进程的中文 message 只作未知 code 的兜底）。
     *
     * 压缩过程与结果通过已提交的原生会话视图汇报，
     * 此调用等待原生压缩 receipt，返回可展示的完成或失败结果。
     */
    compact(sessionId: string, instructions?: string): Promise<CompactOutcome>;
    /**
     * 当前会话的原生视图快照（运行时尚未挂载时为 null）。
     *
     * 原生视图操作按 revision 应用，渲染层发现缺口（revision 不连续、
     * 下标对不上）就用它整条补齐。窗口重载、订阅晚于运行开始等场景靠这条兜底。
     */
    snapshot(sessionId: string): Promise<ChatLiveSnapshot | null>;
    /** 订阅主进程推送的聊天事件（含所属会话 id），返回取消订阅函数 */
    onEvent(callback: (payload: ChatEventEnvelope) => void): () => void;
  };
  approvals: {
    respond(id: string, decision: ApprovalDecision, note?: string): Promise<void>;
  };
  interaction: {
    /** 回填一次提问的答案；未知 id 或已处理时主进程只记日志，不打断渲染层 */
    respond(id: string, reply: AskReply): Promise<void>;
    /** 未决提问列表（会话切换时恢复卡片）；sessionId 缺省返回全部 */
    pending(sessionId?: string): Promise<AskRequest[]>;
  };
  jobs: {
    /** 该会话的后台作业（会话切换时恢复面板用） */
    list(sessionId: string): Promise<JobInfo[]>;
    /** 杀掉一个后台作业（界面上「停止」按钮用） */
    kill(sessionId: string, id: string): Promise<JobInfo>;
  };
  skills: {
    /** 扫描技能目录并列出；workingDir 缺省表示只扫数据目录里的全局技能 */
    list(workingDir?: string): Promise<SkillInfo[]>;
    /** 弹出文件选择框，把 zip 技能包导入数据目录的 skills/；用户取消时返回 canceled: true */
    import(): Promise<SkillImportResult>;
    /** 读一个全局技能的 SKILL.md 原文，喂给详情弹窗 */
    read(name: string): Promise<SkillDetail>;
    /** 删除一个全局技能（连同它的技能目录一起删） */
    remove(name: string): Promise<void>;
  };
  prompts: {
    /** 扫描提示模板目录并列出；workingDir 缺省表示只扫数据目录里的全局模板 */
    list(workingDir?: string): Promise<PromptTemplateInfo[]>;
    /** 新建或更新一份全局模板（落盘为 `<名称>.md`）；返回落盘后的那一行 */
    write(request: PromptTemplateWriteRequest): Promise<PromptTemplateInfo>;
    /** 删除一份全局模板 */
    remove(name: string): Promise<void>;
  };
  /**
   * 子智能体：定义目录 + 运行记录。
   *
   * 分成两组：「定义」是用户可以编辑的（list/read/write/remove/reveal），
   * 「运行」是主 AI 委派后产生的（runs/stop/onEvent，按父会话取）。
   */
  subagents: {
    /** 读取目录（内置预设 + 用户定义），enabled 由设置决定 */
    list(workingDir?: string): Promise<SubagentCatalog>;
    /** 读一个用户定义的原文（含 frontmatter），喂给编辑框 */
    read(name: string): Promise<SubagentReadResult>;
    /** 新建或更新一个用户定义；返回落盘后的那一行 */
    write(request: SubagentWriteRequest): Promise<SubagentInfo>;
    /** 删除一个用户定义（内置的删不掉，会抛错） */
    remove(name: string): Promise<void>;
    /** 在系统文件管理器里定位该定义的 .md 文件 */
    reveal(name: string): Promise<{ ok: boolean }>;
    /** 某个父会话派出去的全部子智能体运行（按开始时间升序） */
    runs(sessionId: string): Promise<SubagentRun[]>;
    /** 停止一次运行（等价于 TaskStop）；不在本进程运行中的记录（例如意外终止的历史运行）返回 undefined */
    stop(sessionId: string, delegationId: string): Promise<SubagentRun | undefined>;
    /** 订阅运行事件（信封里的 sessionId 是**父**会话），返回取消订阅函数 */
    onEvent(callback: (payload: SubagentEventEnvelope) => void): () => void;
  };
  permissions: {
    listRules(): Promise<PermissionRuleView[]>;
    addRule(rule: PermissionRuleView): Promise<void>;
    removeRule(toolName: string, pattern?: string): Promise<void>;
  };
  agents: {
    /** 读取 AGENTS.md；不存在时返回空串 */
    read(): Promise<string>;
    write(content: string): Promise<void>;
  };
  dialog: {
    /** 打开系统目录选择框；取消返回 null */
    pickDirectory(defaultPath?: string): Promise<string | null>;
  };
  mcp: {
    /** 读取 MCP server 配置与连接状态（状态来自主进程的连接池） */
    list(): Promise<McpServerView[]>;
    /** 按当前设置重新连接（连上该连的、断开该断的），返回最新状态 */
    reload(): Promise<McpServerView[]>;
    /**
     * 只重连一台 server，返回全部 server 的最新状态。
     *
     * 与 reload 的差别是「不打扰别人」：reload 会按设置对账整张连接表，
     * 而这一条只针对某台 server 断线重连 —— 面板上每张卡片右上角那个按钮用它。
     */
    reconnect(serverId: string): Promise<McpServerView[]>;
    /** 用草稿配置试连一次：不写设置、不影响已有连接 */
    probe(config: McpServerConfig): Promise<McpProbeResult>;
  };
  services: {
    /** 从 OpenAI 兼容端点拉取可用模型 id 列表 */
    fetchModels(request: {
      baseUrl: string;
      apiKey: string;
      wireFormat: WireFormat;
    }): Promise<{ ok: true; modelIds: string[] } | { ok: false; reason: string }>;
  };
  models: {
    /** 按模型 id 从 models.dev 元数据目录匹配（带本地缓存） */
    lookup(id: string): Promise<ModelLookupResult>;
  };
  /**
   * 用户终端（真 PTY）。
   *
   * 与 jobs 分开：jobs 是模型的后台作业（无 stdin），这里是给人敲的交互式 shell。
   * 输出走 onEvent 推送（带 seq，供按游标回放），replay 用于面板重新挂载时补齐。
   */
  terminal: {
    /** 当前全部终端（面板挂载时拉一次） */
    list(): Promise<TerminalInfo[]>;
    /** 新建一个终端；cwd 由调用方给（会话工作目录） */
    create(options: { cwd: string; cols?: number; rows?: number }): Promise<TerminalInfo>;
    /** 按游标回放：fromSeq 之后的新增输出；面板重新挂载时用它补齐断档 */
    replay(id: string, fromSeq: number): Promise<TerminalReplay>;
    /** 写入按键（键盘输入、粘贴、Ctrl+C 的 \x03） */
    write(id: string, data: string): Promise<void>;
    /** 改尺寸（面板换行或拖宽窄时调用） */
    resize(id: string, cols: number, rows: number): Promise<void>;
    /** 关闭终端（连同进程树） */
    close(id: string): Promise<void>;
    /** 订阅终端事件（输出 / 元信息变化 / 移除），返回取消订阅函数 */
    onEvent(callback: (event: TerminalEvent) => void): () => void;
  };
  /**
   * 右侧面板「文件」：列目录与读文件。
   *
   * 只传 sessionId，**不传 root** —— 根由主进程从会话索引解析。
   * 让渲染层指定根等于把「能读哪个目录」的决定权交给渲染层，那是提权面。
   */
  files: {
    /** 列一层目录；path 缺省用会话工作目录 */
    listDirectory(request: { sessionId: string; path?: string }): Promise<DirectoryListing>;
    /** 读一个文件（等宽预览用，超出上限会截断） */
    readFile(request: { sessionId: string; path: string }): Promise<FileContent>;
    /**
     * 读一张图片，返回可直接用于 `<img src>` 的 dataUrl。
     *
     * 与 readFile 分开是因为结果形态完全不同（一个是给等宽预览的文本，一个是给 <img> 的
     * 数据 URL），而这条通道**只在用户展开 read_image 的详情时**走 —— 模型那次调用的
     * details 里刻意不带图片字节（它会落盘，见 main/pisdk/tools/read-image.ts）。
     */
    readImage(request: { sessionId: string; path: string }): Promise<ImageContent>;
    /**
     * 把编辑后的文本写回文件（原子写：先写同目录的临时文件，再 rename 覆盖）。
     *
     * **失败是抛异常**（message 为人类可读的中文，不含绝对路径与内部错误码），
     * 与 readFile 同款 —— 渲染层 catch 后直接显示 message 即可。
     *
     * `text` 原样落盘：**不做行尾符转换**（CRLF 的文件读出来带 \r，写回去还是 CRLF）、
     * 不补也不去 BOM。上限 512 KiB —— 与 readFile 的截断阈值同一个数：比它大的文件
     * 读侧只会给出开头一段，因此两侧都直接拒绝，避免一次保存把没显示过的部分抹掉。
     */
    writeFile(request: { sessionId: string; path: string; text: string }): Promise<FileWriteResult>;
    /**
     * 一个 `<input type="file">` / 拖拽给出的 `File` 在磁盘上的真实路径。
     *
     * 为什么需要它：附件要落盘，而把整个文件先读成 base64 再走 IPC 会把一份 200 MB 的
     * 视频在内存里复制两遍。有路径就让主进程自己读 —— 这也顺带让「同一个文件重发」
     * 在磁盘上命中同一份（内容寻址，见 main/pisdk/attachments.ts）。
     *
     * 只有**用户真的从磁盘选/拖**来的 File 才有路径：剪贴板粘贴、以及用 Blob 造的 File
     * 会返回空串，那条路必须走 `data`（base64）。返回值不抛错 —— 拿不到路径不是异常，
     * 是「换一条路」的信号。
     *
     * 这个能力由 preload 用 Electron 的 `webUtils.getPathForFile` 提供；它**不暴露任意
     * 路径查询**，只回答「你手里这个 File 来自哪里」，所以不构成提权面。
     */
    pathForFile(file: File): string;
  };
  /** 右侧面板「审查」：本次会话改动过的文件与补丁 */
  review: {
    /** 从会话消息里的 write / edit 记录汇总改动 */
    summary(sessionId: string): Promise<ReviewSummary>;
  };
  /**
   * 内置浏览器：标签注册 + 状态 + 事件订阅。
   *
   * **没有导航 / 点击之类的通道**，那是刻意的：页面由主进程直接驱动
   * （见 main/browser/service.ts 顶部对攻击面的说明）。渲染层这一侧负责
   * 「把 webview 建出来」「把 tabId ↔ guest 的绑定登记回来」「把状态显示给人看」。
   */
  browser: {
    /** 当前状态：打开了哪些标签、模型是否正在操作 */
    status(): Promise<BrowserStatus>;
    /**
     * 登记一个浏览器标签：建好 webview 之后调用，把它的 guest 交给主进程。
     * requestId 由主进程的 open-request 事件给出（见 BrowserEvent），
     * 带回它表示「模型要的那个标签已经就绪」。
     */
    registerTab(tabId: string, webContentsId: number, requestId?: string): Promise<void>;
    /** 注销一个标签（标签关闭时）：主进程释放该 guest 的引用与缓冲 */
    unregisterTab(tabId: string): Promise<void>;
    /** 告诉主进程用户切到了哪个标签（决定 status 里的 active） */
    activateTab(tabId: string): Promise<void>;
    /** 订阅浏览器事件（状态变化 / 开标签请求 / 模型操作中），返回取消订阅函数 */
    onEvent(callback: (event: BrowserEvent) => void): () => void;
  };
  /**
   * 用量统计：数据统计模态窗的数据通路。
   *
   * 一条只读通道返回整份报告 —— 时间范围的切换（近 7 日 / 近 30 日）在渲染层切片，
   * 不为此再走一次 IPC：那条路会让每次切范围都闪一下，而数据本来就在手里。
   */
  stats: {
    /** 全部用量统计（总量 / 每日 / 分模型 / 连续天数 / 历史折叠进度） */
    report(): Promise<UsageStatsReport>;
  };
  /**
   * 网络搜索：只需要一个「测试连接」通道。
   *
   * 配置本身走 settings 的读写（webSearch 字段），provider 清单是编译期常量 ——
   * 都不需要额外的 IPC。
   */
  web: {
    /** 用**草稿**配置发一次真实检索，验证 provider 是否可用（与是否已保存无关） */
    test(request: WebTestRequest): Promise<WebTestResult>;
  };
  /**
   * 插件：设置里那个插件管理模态窗的数据通路。
   *
   * 两处刻意的形状选择：
   *  - **改状态的通道一律返回 PluginListResult（变更后的完整列表）**，而不是 void ——
   *    与 mcp 那组同款。一次操作可能连带影响别的行（同 id 覆盖、升级时的权限变化），
   *    只回一行会让界面漏刷新，而「再拉一次」会多一次往返和一个闪烁的中间态。
   *  - **`list` 在运行时未接入时返回空数组而不是抛错** —— 模态窗因此可以先于插件
   *    运行时上线。真正的失败（IPC 通道不存在）由 plugins-store 兜住并降级为空态。
   */
  plugins: {
    /** 列出全部插件（内置 + 用户 + 开发），已按来源与安装顺序排好 */
    list(): Promise<PluginView[]>;
    /** 启用一个插件；加载失败时那一行的 state 是 load_error，而不是抛错 */
    enable(id: string): Promise<PluginListResult>;
    /** 停用一个插件：卸载运行时的全部贡献物并关闭它的界面 */
    disable(id: string): Promise<PluginListResult>;
    /** 重载：先卸载再加载，用于「改完包 / 崩过之后再来一次」 */
    reload(id: string): Promise<PluginListResult>;
    /** 安装原生插件 ZIP 包；取消时 canceled 为真 */
    install(): Promise<PluginMutationResult>;
    /** 卸载；keepData 为真时保留私有数据目录（默认由界面问用户） */
    uninstall(id: string, keepData: boolean): Promise<PluginListResult>;
    /** 引用本地目录作为开发插件（不拷贝文件，带文件监视） */
    loadDev(): Promise<PluginMutationResult>;
    /** 打开插件的一个界面；面板切右侧面板、模态窗开对话框、窗口建独立窗口 */
    openSurface(id: string, surfaceId: string): Promise<PluginSurfaceOpenResult>;
    /**
     * 订阅「插件界面自己请求关闭」（见 IPC.plugins.surfaceClosed）。
     *
     * 与 chat / terminal / subagents 的 onEvent 同款：返回取消订阅函数。
     * **只针对宿主在渲染层的两类界面**（面板与模态窗）—— 独立窗口由主进程关，
     * 渲染层不需要知道。
     */
    onSurfaceClosed(callback: (event: PluginSurfaceClosedEvent) => void): () => void;
    /** 插件注册的命令（只有进程在跑的插件才有） */
    commands(): Promise<PluginCommandView[]>;
    /**
     * 执行一个插件命令。
     *
     * `workspaceDir` **由调用方给**：主进程不知道"当前会话在看哪个目录"，
     * 而插件命令多半要针对那个目录做事。传空串表示没有特定工作目录。
     */
    runCommand(
      id: string,
      args: string,
      workspaceDir: string,
    ): Promise<{ ok: boolean; text?: string; error?: string }>;
    /**
     * 把当前主题推给全部插件界面；返回送达了几个（诊断用）。
     *
     * 接受 `"system"`：**解析留给主进程**（`nativeTheme` 只有它拿得到），
     * 渲染层不该自己猜操作系统现在是深色还是浅色。
     */
    broadcastTheme(theme: "light" | "dark" | "system"): Promise<number>;
    /**
     * 把一个插件打成 zip 分享出去。
     *
     * `canceled` 表示用户在保存框上按了取消 —— **不是错误**（与安装那边同款）。
     * `skipped` 里是被排除的东西（node_modules、超大文件等），要显示给用户，
     * 否则他会以为分享包里有那些东西。
     */
    export(
      id: string,
    ): Promise<{ canceled: boolean; path?: string; files?: number; skipped?: string[] }>;
    /** 在系统文件管理器里定位插件的私有数据目录 */
    revealData(id: string): Promise<{ ok: boolean }>;
    /** 最近的诊断记录（加载错误、崩溃、被拒的权限请求），按时间降序 */
    diagnostics(): Promise<PluginDiagnostic[]>;
    /**
     * 告诉宿主当前会话的工作目录。
     *
     * 它决定**项目级插件目录**（`<工作目录>/.oint/plugins/`）扫不扫 ——
     * 模型写插件只能写在会话工作目录里（那是它被允许写的范围），
     * 所以"对话创建插件"能不能被看见，取决于这一条。
     *
     * 传 `undefined` 表示没有会话：那时**跳过**项目那一层，而不是猜一个。
     */
    setWorkspace(dir: string | undefined): Promise<void>;
  };
}
