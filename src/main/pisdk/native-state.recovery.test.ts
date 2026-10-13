import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { StorageWrite } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { JsonlStorage } from "@earendil-works/pi-durable/storage/jsonl";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { afterEach, describe, expect, it } from "vitest";
import type { Settings } from "@/shared/contracts/settings";
import { createApprovalService } from "./approvals";
import { createInteractionService } from "./interactions";
import {
  ApprovalDoc,
  ApprovalTask,
  InteractionDoc,
  InteractionTask,
  nativeRequestTasks,
} from "./native-state";
import { openNativeStateTest } from "./native-state-test";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function durableDirectory() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "oint-native-requests-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const env = new NodeExecutionEnv({ cwd: dir });
  return () => JsonlStorage.open(path.join(dir, "state"), env, context);
}
describe("native request restart and durability", () => {
  it("reopens pending approval task and commits user's recovered decision", async () => {
    const storage = await durableDirectory();
    const first = await openNativeStateTest(nativeRequestTasks, await storage());
    const taskId = await first.harness.commit(async (tx) => {
      const id = await tx.createTask(
        ApprovalTask,
        { id: "approval" },
        { conversationId: first.root.id, ownership: { kind: "conversation" } },
      );
      (await tx.doc(ApprovalDoc, first.root.id)).entries.approval = {
        request: {
          id: "approval",
          sessionId: "s1",
          toolName: "bash",
          argsText: "final normalized args",
          risk: "high",
          source: "ai",
        },
        taskId: id,
        ownerTaskId: id,
        signature: "persisted",
      };
      return id;
    }, context);
    await first.close();
    const reopened = await openNativeStateTest(nativeRequestTasks, await storage());
    cleanups.push(reopened.close);
    const service = createApprovalService({
      emit() {},
      getSettings: async () => ({ permissionMode: "default" }) as Settings,
    });
    await service.attach(reopened.attachment);
    expect((await service.pending())[0]).toMatchObject({ id: "approval", aiReviewed: true });
    await service.respond("approval", "allow_once");
    expect((await reopened.harness.waitForTask(taskId, context)).state.outcome).toMatchObject({
      status: "completed",
      result: "allow_once",
    });
    expect((await service.history())[0]?.decision).toBe("allow_once");
  });
  it("expired question deadline is enforced after a full storage reopen", async () => {
    const storage = await durableDirectory();
    const first = await openNativeStateTest(nativeRequestTasks, await storage());
    const taskId = await first.harness.commit(async (tx) => {
      const id = await tx.createTask(
        InteractionTask,
        { id: "question" },
        { conversationId: first.root.id, ownership: { kind: "conversation" } },
      );
      (await tx.doc(InteractionDoc, first.root.id)).entries.question = {
        request: {
          id: "question",
          sessionId: "s1",
          toolCallId: "call",
          questions: [],
          createdAt: Date.now() - 5000,
        },
        taskId: id,
        ownerTaskId: id,
        signature: "persisted",
        deadline: Date.now() - 1,
      };
      return id;
    }, context);
    await first.close();
    const reopened = await openNativeStateTest(nativeRequestTasks, await storage());
    cleanups.push(reopened.close);
    const service = createInteractionService({ emit() {} });
    await service.attach(reopened.attachment);
    // A late click must never win merely because the scheduler has not resumed.
    await service.respond("question", { outcome: "answered", answers: [] });
    expect((await reopened.harness.waitForTask(taskId, context)).state.outcome).toMatchObject({
      result: { outcome: "unanswered" },
    });
    expect(await service.pending()).toEqual([]);
  });
  it("failed decision persistence rejects the acknowledgement and leaves the card pending", async () => {
    class FailingStorage extends MemoryStorage {
      fail = false;
      /**
       * 1.2.0：存储异常让会话永久失败并**连带关闭存储**。本用例要做「尸检」
       *（确认卡片上没有落下决策），而 MemoryStorage 关闭即丢数据、没有重开语义，
       * 所以这里让 close 只保留可读视图 —— 生产上的「关闭后重开」语义不靠这个桩覆盖。
       */
      override async close(_context: Context): Promise<void> {
        // 刻意不真正关闭：断言需要读原始存储。
      }
      override commit(writes: readonly StorageWrite[], ctx: Context) {
        if (this.fail) return Promise.reject(new Error("disk write failed"));
        return super.commit(writes, ctx);
      }
    }
    const storage = new FailingStorage();
    const service = createApprovalService({
      emit() {},
      getSettings: async () => ({ permissionMode: "default" }) as Settings,
    });
    const test = await openNativeStateTest(service.taskDefinitions, storage);
    cleanups.push(test.close);
    await service.attach(test.attachment);
    await test.invoke((api, ctx) =>
      service.request({
        sessionId: "s1",
        toolCallId: api.callId,
        toolName: "bash",
        argsText: "args",
        risk: "high",
        api,
        context: ctx,
      }),
    );
    await expect.poll(async () => (await service.pending()).length).toBe(1);
    const card = (await service.pending())[0];
    if (!card) throw new Error("Missing pending request");
    storage.fail = true;
    await expect(service.respond(card.id, "allow_once")).rejects.toThrow("disk write failed");
    // 1.2.0：任何存储异常都让会话永久失败（SessionFailed），后续调用一律拒绝、不再重试；
    // 原始错误挂在这条失败错误的 cause 上。
    await expect(service.pending()).rejects.toThrow("Session failed after a storage error");
    await expect(service.pending()).rejects.toMatchObject({
      cause: expect.objectContaining({ message: "disk write failed" }),
    });
    const document = await storage.findDocument(
      {
        kind: ApprovalDoc.definition.kind,
        scope: { kind: "conversation", conversationId: test.root.id },
      },
      "current",
      context,
    );
    if (!document) throw new Error("Missing persisted approval document");
    const value = (await storage.document(document.id, "current", context))?.value;
    expect(value).toMatchObject({ entries: { [card.id]: { request: { id: card.id } } } });
    expect(JSON.stringify(value)).not.toContain('"decision"');
    storage.fail = false;
  });
});
