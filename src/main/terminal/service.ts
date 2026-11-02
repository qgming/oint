// 用户终端（PTY）主进程服务：真正的交互式 shell，给「右侧面板 · 终端」用。
//
// 与 main/pisdk/jobs.ts 的关系：两者都管理「活着的进程」，但语义相反，故并存不合并。
//   · jobs      —— 给**模型**的后台作业。stdio 的 fd0 是 "ignore"，没有写入口，
//                  只服务「跑一条命令 → drain 读输出 → 杀掉」。它的消费者是工具调用。
//   · terminals —— 给**人**的终端。真 PTY，可写入、可见提示符、可 Ctrl+C、可 resize。
//                  它的消费者是渲染层的 xterm.js。
// 把两者塞进一个抽象，只会让「有没有 stdin」这种根本差异被抹平，最后两边都用不好。
//
// 三件套按 opencode 的做法落地：**2 MB 环形缓冲 + 绝对游标回放 + 单次 ticket**。
// 这里的「单次 ticket」体现为：回放请求带 fromSeq，服务只返回该序号之后的段，
// 于是服务端**不需要**为每个视图维护游标 —— 谁要看谁自己记着，多开一个视图零成本，
// 面板重挂载（切走再切回）也只是带着旧游标再问一次。
//
// ptys 的生命周期**只在主进程内存里**：应用退出即全部消失，跨重启不存活。
// 不做假持久化（磁盘上的 scrollback 会让「重启后终端还在」变成一个需要解释的承诺）。

import { createRequire } from "node:module";
import path from "node:path";
import { BrowserWindow } from "electron";
import { IPC } from "@/shared/contracts/ipc";
import type {
  TerminalChunk,
  TerminalEvent,
  TerminalInfo,
  TerminalReplay,
} from "@/shared/contracts/terminal";
import { resolveBashPath } from "../pisdk/exec-env";
import { killProcessTreeSafe } from "../pisdk/jobs";

/**
 * 每个终端的回放缓冲上限：2 MB（opencode 同款）。
 *
 * 取这个量级的理由：终端输出是「人回头看几屏」的用途，不是日志归档；
 * 2 MB 足够放下一次完整构建的输出，而二十个终端也只占 40 MB 上限。
 */
const DEFAULT_BUFFER_BYTES = 2 * 1024 * 1024;
/** 同一时刻允许存在的终端数（面板上的标签上限）；超了拒绝新建而不是偷偷杀老的 */
const DEFAULT_MAX_TERMINALS = 12;
/** 每次 PTY 数据到达时的最大聚合字节：避免高频小包把 IPC 打爆 */
const COALESCE_BYTES = 8 * 1024;
/** 聚合时间窗：这段时间内的输出合成一段（16 ms ≈ 一帧，让 xterm 每帧最多写一次） */
const COALESCE_MS = 16;
/** 新建终端的默认尺寸；面板挂载后会用真实尺寸 resize 一次 */
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
/** 尺寸夹取范围：防止渲染层传 0 或负数把 PTY 搞坏 */
const MIN_DIMENSION = 2;
const MAX_DIMENSION = 500;

/**
 * node-pty 的加载形状。
 *
 * 用 createRequire 而不是 `await import()`：主进程是 ESM（package.json type=module），
 * 而 node-pty 是 CJS 且会把 module.exports 整个换成平台包（@lydell/node-pty 的 index.js），
 * 这类「重建导出对象」的包在个别版本下 named-export 探测会落空。
 * createRequire 走的是纯 CJS 路径，不受影响（三种写法实测都能 spawn，
 * 但这条最不依赖 Node 的互操作启发式）。
 */
const require = createRequire(import.meta.url);

/** 只取我们真正用到的那几个成员：node-pty 的类型声明随包分发，这里按结构描述避免硬依赖其类型 */
interface PtyProcess {
  pid: number;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

interface PtyModule {
  spawn(
    file: string,
    args: string[] | string,
    options: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: Record<string, string | undefined>;
    },
  ): PtyProcess;
}

let ptyModule: PtyModule | undefined;

/**
 * 惰性加载 node-pty。
 *
 * 失败时抛出的错误要能读懂：这个包的 native 二进制是按平台分发的
 * （@lydell/node-pty 的 optionalDependencies 六件套），用 `--omit=optional`
 * 安装或把 node_modules 跨系统拷贝过就会缺件，此时 `终端不可用` 比
 * "Cannot find module" 更能说明问题。
 */
function loadPty(): PtyModule {
  if (ptyModule !== undefined) return ptyModule;
  try {
    ptyModule = require("@lydell/node-pty") as PtyModule;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`PTY 运行库加载失败（终端不可用）：${detail}`);
  }
  return ptyModule;
}

/**
 * 有界环形回放缓冲。
 *
 * 与 jobs 的 DrainBuffer 的关键差异：**没有读游标**。
 * jobs 是 drain 语义（谁读谁拿走，游标属于服务），因为它的消费者只有一个（模型）。
 * 终端可以有多个视图同时看同一份输出，所以这里只存不取：写满就丢最老的、
 * 并把 seq 起点往前推，消费者带自己的 fromSeq 来要增量，
 * 服务端不记任何「谁读到哪」的状态。
 *
 * seq 自身**永远不回退**：淘汰只影响还能取出哪些段，不影响序号，
 * 所以渲染层那个「我消费到 seq=137」的记录在淘汰后依然有意义
 *（拿到的是 137 之后的内容，前面的确实没了，droppedBytes 会说清楚）。
 */
class ReplayBuffer {
  private chunks: TerminalChunk[] = [];
  private bytes = 0;
  private nextSeq = 1;
  private dropped = 0;

  constructor(private readonly limitBytes: number) {}

  get droppedBytes(): number {
    return this.dropped;
  }

  /** 追加一段输出，返回它的 seq */
  add(data: string): TerminalChunk {
    const chunk: TerminalChunk = { seq: this.nextSeq, data };
    this.nextSeq += 1;
    this.chunks.push(chunk);
    // 按 JS 字符串长度近似计费：终端输出以 ASCII 为主，
    // 用 length 而不是 Buffer.byteLength 是为了避免每次写入都编码一遍（热路径）。
    this.bytes += data.length;

    while (this.bytes > this.limitBytes && this.chunks.length > 1) {
      const evicted = this.chunks.shift();
      if (evicted === undefined) break;
      this.bytes -= evicted.data.length;
      this.dropped += evicted.data.length;
    }

    // 单段就超过上限的极端情况：留着它（总比什么都不剩好），但清掉其它段
    if (this.bytes > this.limitBytes) {
      const last = this.chunks[this.chunks.length - 1];
      for (const chunk of this.chunks.slice(0, -1)) this.dropped += chunk.data.length;
      this.chunks = last === undefined ? [] : [last];
      this.bytes = last?.data.length ?? 0;
    }

    return chunk;
  }

  /**
   * 取 fromSeq 之后的所有段。
   *
   * fromSeq 早于缓冲起点（那段已被淘汰）时**照实返回现有全部**：
   * 丢的内容回不来，但把还能给的给出去，比报错让面板空白更有用
   *（面板通过 droppedBytes > 0 知道开头缺了一段）。
   */
  since(fromSeq: number): { chunks: TerminalChunk[]; nextSeq: number } {
    const chunks =
      fromSeq <= 0 ? [...this.chunks] : this.chunks.filter((chunk) => chunk.seq >= fromSeq);
    const last = chunks[chunks.length - 1];
    return { chunks, nextSeq: last === undefined ? Math.max(fromSeq, this.nextSeq) : last.seq + 1 };
  }
}

/** 服务内部的终端记录：对外快照 + PTY 句柄 + 回放缓冲 */
interface TerminalEntry {
  info: TerminalInfo;
  pty: PtyProcess;
  buffer: ReplayBuffer;
  /** 聚合待发输出：COALESCE_MS 内的多段合成一次 IPC */
  pending: string[];
  pendingTimer: NodeJS.Timeout | undefined;
  /** 已经 dispose 过：防止 onExit 与用户关闭双触发 */
  settled: boolean;
}

export interface TerminalServiceDeps {
  /** 推事件给渲染进程（与 chat:event 同一套广播出口） */
  emit: (event: TerminalEvent) => void;
  /** 每个终端的回放缓冲上限（字节）；缺省 DEFAULT_BUFFER_BYTES */
  bufferBytes?: number;
  /** 终端数上限；缺省 DEFAULT_MAX_TERMINALS */
  maxTerminals?: number;
}

export interface TerminalCreateInput {
  /** 启动目录（会话工作目录；由调用方解析好绝对路径） */
  cwd: string;
  cols?: number;
  rows?: number;
}

export interface TerminalService {
  /** 新建终端：立即发 terminal-changed 并返回快照 */
  create(input: TerminalCreateInput): Promise<TerminalInfo>;
  /** 全部终端（最老在前，与面板标签顺序一致） */
  list(): TerminalInfo[];
  get(id: string): TerminalInfo | undefined;
  /** 按游标回放：返回 fromSeq 之后的新增输出 */
  replay(id: string, fromSeq: number): TerminalReplay;
  /** 写入按键（键盘输入、粘贴、Ctrl+C 的 \x03 都走这里） */
  write(id: string, data: string): void;
  /** 改尺寸（面板拖宽窄或换行时调用）；尺寸没变则什么都不做 */
  resize(id: string, cols: number, rows: number): void;
  /** 关闭一个终端（连同进程树）并移除记录，发 terminal-removed */
  close(id: string): void;
  /** 应用退出：杀掉全部终端 */
  dispose(): void;
}

/** 把尺寸夹到合法范围；非法值回落到默认 */
function clampDimension(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const rounded = Math.floor(value);
  if (rounded < MIN_DIMENSION) return MIN_DIMENSION;
  return Math.min(rounded, MAX_DIMENSION);
}

/**
 * 解析要启动的 shell。
 *
 * 与 jobs 的 resolveShell 不同：**不带 -c**。
 * 作业要的是「把这条命令跑完」，所以要 -c；终端要的是「给我一个能一直敲的交互式 shell」，
 * 加 -c 会让 shell 执行完就退出，面板上只剩一行闪过的输出。
 *
 * Windows 上优先 Git Bash（与作业一致，避免 System32 的 WSL 入口），
 * 没有才回落 cmd.exe —— 注意此时**不能**用 /d /s /c 那套，直接起 cmd.exe 才是交互式。
 */
function resolveInteractiveShell(): { file: string; args: string[] } {
  const bash = resolveBashPath();
  if (bash !== undefined) {
    // --login：Git Bash 下把 /etc/profile 读进来，PATH 与常见别名才对（用户期望的 bash 体验）。
    // -i 让 shell 进入交互模式（提示符、作业控制）。
    return { file: bash, args: ["--login", "-i"] };
  }
  if (process.platform === "win32") {
    return { file: process.env.ComSpec ?? "cmd.exe", args: [] };
  }
  return { file: process.env.SHELL ?? "/bin/sh", args: ["-i"] };
}

/** PTY 需要的环境变量：删掉明显来自「非交互上下文」的标记，否则 shell 会不等输入就退出 */
function ptyEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key === "ELECTRON_RUN_AS_NODE") continue;
    env[key] = value;
  }
  // 有这些变量时 shell（尤其是 bash）会认为自己在被脚本驱动，从而跳过提示符
  delete env.CI;
  delete env.NO_COLOR;
  env.TERM = "xterm-256color";
  return env;
}

export function createTerminalService(deps: TerminalServiceDeps): TerminalService {
  const bufferBytes = deps.bufferBytes ?? DEFAULT_BUFFER_BYTES;
  const maxTerminals = deps.maxTerminals ?? DEFAULT_MAX_TERMINALS;

  const terminals = new Map<string, TerminalEntry>();
  /** 全局自增序号：term-1、term-2 …… 与作业的 job-N 同一个习惯（可预测、跨会话不重复） */
  let nextNumber = 0;
  let disposed = false;

  function emitSafe(event: TerminalEvent): void {
    try {
      deps.emit(event);
    } catch (error) {
      console.warn(`发送终端事件失败：${String(error)}`);
    }
  }

  function snapshot(entry: TerminalEntry): TerminalInfo {
    return { ...entry.info, droppedBytes: entry.buffer.droppedBytes };
  }

  /** 元信息变化（起 / 停 / resize）统一从这里发，避免漏发或发两份 */
  function publish(entry: TerminalEntry): void {
    emitSafe({ type: "terminal-changed", terminal: snapshot(entry) });
  }

  /**
   * 把聚合窗口里攒下的输出冲出去。
   *
   * 合并是必需的：`npm install` 这类命令每秒能产出几百个数据块，
   * 一块一次 IPC 会把渲染进程的 IPC 队列打满，xterm 反而更卡。
   */
  function flush(entry: TerminalEntry): void {
    if (entry.pendingTimer !== undefined) {
      clearTimeout(entry.pendingTimer);
      entry.pendingTimer = undefined;
    }
    if (entry.pending.length === 0) return;
    const data = entry.pending.join("");
    entry.pending = [];
    const chunk = entry.buffer.add(data);
    entry.info.totalBytes += data.length;
    emitSafe({ type: "terminal-data", id: entry.info.id, seq: chunk.seq, data });
  }

  function scheduleFlush(entry: TerminalEntry): void {
    if (entry.pendingTimer !== undefined) return;
    entry.pendingTimer = setTimeout(() => {
      entry.pendingTimer = undefined;
      flush(entry);
    }, COALESCE_MS);
    // 定时器不该拖住进程退出
    entry.pendingTimer.unref?.();
  }

  /** 进程退出后的收尾：flush 残余、标终态、发事件。幂等（settled 守卫） */
  function settle(entry: TerminalEntry, exitCode: number | undefined): void {
    if (entry.settled) return;
    entry.settled = true;
    // 最后的输出必须先冲出去再报终态：否则面板会先显示「已退出」再补上一行提示符，顺序是反的
    flush(entry);
    entry.info.status = "exited";
    entry.info.endedAt = Date.now();
    if (exitCode !== undefined) entry.info.exitCode = exitCode;
    publish(entry);
  }

  function requireEntry(id: string): TerminalEntry {
    const entry = terminals.get(id);
    if (entry === undefined) throw new Error(`终端不存在：${id}`);
    return entry;
  }

  return {
    async create(input: TerminalCreateInput): Promise<TerminalInfo> {
      if (disposed) throw new Error("应用正在退出，无法新建终端");
      if (terminals.size >= maxTerminals) {
        throw new Error(`终端数量已达上限（${maxTerminals}），请先关闭一个`);
      }

      const pty = loadPty();
      const shell = resolveInteractiveShell();
      const cols = clampDimension(input.cols, DEFAULT_COLS);
      const rows = clampDimension(input.rows, DEFAULT_ROWS);

      nextNumber += 1;
      const id = `term-${nextNumber}`;

      let child: PtyProcess;
      try {
        child = pty.spawn(shell.file, shell.args, {
          name: "xterm-256color",
          cols,
          rows,
          cwd: input.cwd,
          env: ptyEnv(),
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`终端启动失败（${shell.file}）：${detail}`);
      }

      const info: TerminalInfo = {
        id,
        // 标题用 shell 的可执行文件名：面板上一眼能认出是 bash 还是 cmd
        title: path.basename(shell.file),
        cwd: input.cwd,
        shell: shell.file,
        pid: child.pid,
        cols,
        rows,
        status: "running",
        startedAt: Date.now(),
        totalBytes: 0,
        droppedBytes: 0,
      };

      const entry: TerminalEntry = {
        info,
        pty: child,
        buffer: new ReplayBuffer(bufferBytes),
        pending: [],
        pendingTimer: undefined,
        settled: false,
      };
      terminals.set(id, entry);

      child.onData((data) => {
        entry.pending.push(data);
        // 攒够一整批就直接发，不必等时间窗（大输出时让延迟不叠加）
        if (entry.pending.join("").length >= COALESCE_BYTES) flush(entry);
        else scheduleFlush(entry);
      });

      child.onExit(({ exitCode }) => {
        settle(entry, exitCode);
      });

      publish(entry);
      return snapshot(entry);
    },

    list(): TerminalInfo[] {
      return [...terminals.values()].map(snapshot);
    },

    get(id: string): TerminalInfo | undefined {
      const entry = terminals.get(id);
      return entry === undefined ? undefined : snapshot(entry);
    },

    replay(id: string, fromSeq: number): TerminalReplay {
      const entry = requireEntry(id);
      const safeFrom = Number.isFinite(fromSeq) && fromSeq > 0 ? Math.floor(fromSeq) : 0;
      const { chunks, nextSeq } = entry.buffer.since(safeFrom);
      return { terminal: snapshot(entry), chunks, nextSeq };
    },

    write(id: string, data: string): void {
      const entry = requireEntry(id);
      if (entry.settled) return;
      try {
        entry.pty.write(data);
      } catch (error) {
        // 进程刚好在这瞬间退出：不是错误，面板不需要弹提示
        console.warn(`写入终端失败：${String(error)}`);
      }
    },

    resize(id: string, cols: number, rows: number): void {
      const entry = requireEntry(id);
      const nextCols = clampDimension(cols, entry.info.cols);
      const nextRows = clampDimension(rows, entry.info.rows);
      // 尺寸没变就不做任何事：ResizeObserver 会连续触发，每次都 resize 会把 shell 刷屏
      if (nextCols === entry.info.cols && nextRows === entry.info.rows) return;
      entry.info.cols = nextCols;
      entry.info.rows = nextRows;
      if (!entry.settled) {
        try {
          entry.pty.resize(nextCols, nextRows);
        } catch (error) {
          console.warn(`调整终端尺寸失败：${String(error)}`);
        }
      }
      publish(entry);
    },

    close(id: string): void {
      const entry = terminals.get(id);
      if (entry === undefined) return;
      terminals.delete(id);
      if (entry.pendingTimer !== undefined) {
        clearTimeout(entry.pendingTimer);
        entry.pendingTimer = undefined;
      }
      entry.settled = true;
      // 杀进程树而不是只杀 shell：交互式 shell 里常常还挂着前台子进程
      // （跑着 vim / npm run dev），只杀父进程会留下占着端口的孤儿
      // 用 *Safe 版本：node-pty 在 Windows 上可能暴露 pid 0（conpty 代理未连上），
      // 而 taskkill /pid 0 /T /F 会尝试动整棵系统进程树 —— 必须挡住
      killProcessTreeSafe(entry.info.pid);
      emitSafe({ type: "terminal-removed", id });
    },

    dispose(): void {
      disposed = true;
      for (const [id, entry] of terminals) {
        if (entry.pendingTimer !== undefined) clearTimeout(entry.pendingTimer);
        entry.settled = true;
        killProcessTreeSafe(entry.info.pid);
        terminals.delete(id);
      }
    },
  };
}

let defaultService: TerminalService | null = null;

/**
 * 默认单例：终端服务由 IPC 域与退出清理共用一份实例。
 *
 * 事件出口在创建时注入，而 `app.whenReady` 之前不该有窗口 —— 所以这里
 * 用「惰性取窗口广播」而不是在模块加载时就绑死某个 webContents。
 */
export function getTerminalService(): TerminalService {
  defaultService ??= createTerminalService({
    emit: (event) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(IPC.terminal.event, event);
      }
    },
  });
  return defaultService;
}

/** 应用退出时释放（幂等） */
export function disposeTerminalService(): void {
  defaultService?.dispose();
  defaultService = null;
}
