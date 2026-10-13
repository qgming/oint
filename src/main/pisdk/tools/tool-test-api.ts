// Native durable invocation fixture; storage operations must be configured explicitly.
import { createRegistry, type ToolExecutionApi } from "@earendil-works/pi-durable";

export function createToolTestApi(overrides: Partial<ToolExecutionApi> = {}): ToolExecutionApi {
  const unavailable = async (): Promise<never> => {
    throw new Error("This test did not configure durable storage");
  };
  const models = new Proxy(
    {},
    {
      get() {
        throw new Error("This test did not configure models");
      },
    },
  ) as ToolExecutionApi["models"];
  // 1.2.0 起 outputWindow / retainedOutput / executeTool 是必需成员：
  // 默认把 output() 记在内存里供 retainedOutput() 读取，工具要「已保留输出」时有真东西可拿。
  let retained = "";
  return {
    taskId: 1 as ToolExecutionApi["taskId"],
    conversationId: 1 as ToolExecutionApi["conversationId"],
    callId: "call-1",
    registry: createRegistry().snapshot(),
    models,
    env: undefined,
    agent: unavailable,
    outputWindow: undefined,
    output(chunk) {
      retained += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    },
    retainedOutput: () => ({ text: retained, truncated: false }),
    diagnostic() {},
    details: async () => {},
    commit: unavailable,
    memo: unavailable,
    createTask: unavailable,
    getTask: unavailable,
    waitForTask: unavailable,
    conversation: unavailable,
    snapshot: unavailable,
    snapshotAsOf: unavailable,
    watchDoc: unavailable,
    executeTool: unavailable,
    ...overrides,
  };
}
