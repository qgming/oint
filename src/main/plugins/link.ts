// Electron 消息端口 ↔ Chord IpcChannel 适配。
//
// 旧实现（1.0 时代）在字节帧上自己跑了一套 pi-client/pi-server 协议；1.2 起
// chord 自带 `ipcLink`（JSON 帧、`{ chord2: frame }` 包装、消息与关闭语义齐全），
// 这里只做两件薄事：
//  1. 把 Electron 的 postMessage/on("message")/on(exit|close) 适配成 IpcChannel；
//  2. 留住控制消息通道（worker 的就绪/致命消息），供握手使用。

import type { IpcChannel } from "@earendil-works/chord";
import type { ParentPort, UtilityProcess } from "electron";

/** 运行时无关的链路端口：两个平台适配都实现它。 */
export interface RawLinkPort {
  post(message: unknown): void;
  onMessage(listener: (message: unknown) => void): () => void;
  onClose(listener: () => void): () => void;
  kill(): void;
  readonly closed: boolean;
}

export function utilityProcessPort(child: UtilityProcess): RawLinkPort {
  let closed = false;
  return {
    get closed() {
      return closed;
    },
    post: (message) => child.postMessage(message),
    onMessage(listener) {
      const wrapped = (message: unknown): void => listener(message);
      child.on("message", wrapped);
      return () => child.off("message", wrapped);
    },
    onClose(listener) {
      const wrapped = (): void => {
        closed = true;
        listener();
      };
      child.on("exit", wrapped);
      return () => child.off("exit", wrapped);
    },
    kill: () => {
      closed = true;
      child.kill();
    },
  };
}

export function parentPortPort(
  port: ParentPort,
  disconnectSource: NodeJS.EventEmitter = process,
): RawLinkPort {
  let closed = false;
  const closers = new Set<() => void>();
  const fire = (): void => {
    if (closed) return;
    closed = true;
    for (const listener of [...closers]) listener();
  };
  // Electron 的 ParentPort 类型只有 'message' 事件；父进程断开由 process 的 'disconnect' 兜底
  //（旧 worker 同样用它），chord 链接自己的 ping 超时是第三道保险。
  disconnectSource.on("disconnect", fire);
  return {
    get closed() {
      return closed;
    },
    post: (message) => port.postMessage(message),
    onMessage(listener) {
      const wrapped = (event: Electron.MessageEvent): void => listener(event.data);
      port.on("message", wrapped);
      return () => port.off("message", wrapped);
    },
    onClose(listener) {
      closers.add(listener);
      return () => closers.delete(listener);
    },
    kill: fire,
  };
}

/** 测试用：两条互相连通的内存端口（闭合是双向的；送达前无监听者时排队，与真实 Electron 端口一致）。 */
export function createMemoryPortPair(): [RawLinkPort, RawLinkPort] {
  interface Side {
    listeners: Set<(message: unknown) => void>;
    closers: Set<() => void>;
    pending: unknown[];
    closed: boolean;
  }
  const a: Side = { listeners: new Set(), closers: new Set(), pending: [], closed: false };
  const b: Side = { listeners: new Set(), closers: new Set(), pending: [], closed: false };
  const flush = (side: Side): void => {
    if (side.listeners.size === 0 || side.pending.length === 0) return;
    const queued = side.pending.splice(0);
    for (const message of queued) for (const listener of [...side.listeners]) listener(message);
  };
  const make = (self: Side, peer: Side): RawLinkPort => ({
    get closed() {
      return self.closed;
    },
    post: (message) => {
      if (self.closed || peer.closed) return;
      if (peer.listeners.size === 0) {
        peer.pending.push(message);
        return;
      }
      for (const listener of [...peer.listeners]) listener(message);
    },
    onMessage: (listener) => {
      self.listeners.add(listener);
      flush(self);
      return () => self.listeners.delete(listener);
    },
    onClose: (listener) => {
      self.closers.add(listener);
      return () => self.closers.delete(listener);
    },
    kill: () => {
      if (self.closed) return;
      self.closed = true;
      for (const listener of [...self.closers]) listener();
      if (!peer.closed) {
        peer.closed = true;
        for (const listener of [...peer.closers]) listener();
      }
    },
  });
  return [make(a, b), make(b, a)];
}

/**
 * RawLinkPort → Chord 的 IpcChannel。
 *
 * `send` 返回 false 表示对端已关闭（IpcChannel 契约），不抛 —— chord 依此收敛。
 * 控制消息监听器收到**所有**消息；IpcLink 只会认 `{ chord2: ... }`，其余原样流过。
 *
 * 投递缓冲：端口在第一个监听者出现前就可能有消息（真实 Electron 端口会排队攒着，
 * 内存端口也一样）—— 这时先攒在 `pending` 里，等有监听者再按序补投，避免
 * 「channel 建好、link 还没建」的一瞬间把 hello 吃掉。
 */
export function toIpcChannel(port: RawLinkPort): IpcChannel & {
  onControl(listener: (message: unknown) => void): () => void;
} {
  const control = new Set<(message: unknown) => void>();
  const messageListeners = new Set<(message: unknown) => void>();
  const closeListeners = new Set<() => void>();
  const pending: unknown[] = [];
  let closed = false;

  const dispatch = (message: unknown): void => {
    for (const listener of [...control]) listener(message);
    for (const listener of [...messageListeners]) listener(message);
  };
  const flush = (): void => {
    if (pending.length === 0 || (messageListeners.size === 0 && control.size === 0)) return;
    for (const message of pending.splice(0)) dispatch(message);
  };
  port.onMessage((message) => {
    if (messageListeners.size === 0 && control.size === 0) {
      pending.push(message);
      return;
    }
    flush();
    dispatch(message);
  });
  port.onClose(() => {
    closed = true;
    for (const listener of [...closeListeners]) listener();
  });
  const channel = {
    get connected() {
      return !port.closed && !closed;
    },
    send(message: unknown): boolean {
      if (port.closed || closed) return false;
      port.post(message);
      return true;
    },
    on(event: "message" | "disconnect", listener: (() => void) | ((message: unknown) => void)) {
      if (event === "message") messageListeners.add(listener as (message: unknown) => void);
      else closeListeners.add(listener as () => void);
      flush();
      return channel;
    },
    off(event: "message" | "disconnect", listener: (() => void) | ((message: unknown) => void)) {
      if (event === "message") messageListeners.delete(listener as (message: unknown) => void);
      else closeListeners.delete(listener as () => void);
      return channel;
    },
  };
  return {
    ...channel,
    onControl(listener) {
      control.add(listener);
      flush();
      return () => control.delete(listener);
    },
  };
}
