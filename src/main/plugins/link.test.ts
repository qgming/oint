import { describe, expect, it } from "vitest";
import { createMemoryPortPair, toIpcChannel } from "./link";

describe("toIpcChannel", () => {
  it("keeps `connected` live instead of freezing it at construction", () => {
    const [local] = createMemoryPortPair();
    const channel = toIpcChannel(local);
    expect(channel.connected).toBe(true);
    local.kill();
    expect(channel.connected).toBe(false);
  });

  it("returns an idempotent control unsubscribe", () => {
    const [local] = createMemoryPortPair();
    const channel = toIpcChannel(local);
    const received: unknown[] = [];
    const unsubscribe = channel.onControl((message) => received.push(message));
    channel.on("message", () => {});
    unsubscribe();
    unsubscribe();
    expect(received).toEqual([]);
  });
});
