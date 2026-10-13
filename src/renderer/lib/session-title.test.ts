import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/shared/contracts";
import { sessionDisplayTitle } from "./session-title";

const messages: ChatMessage[] = [
  {
    id: "u1",
    role: "user",
    createdAt: 0,
    status: "complete",
    parts: [{ type: "text", text: "  修复登录页面\n按钮错误  " }],
  },
];
describe("sessionDisplayTitle", () => {
  it("shows first-request context until a stored title arrives", () => {
    expect(sessionDisplayTitle({ title: null }, messages, "新对话")).toBe("修复登录页面 按钮错误");
    expect(sessionDisplayTitle({ title: "自定名称" }, messages, "新对话")).toBe("自定名称");
  });
  it("uses a fallback for attachment-only and empty conversations", () => {
    expect(sessionDisplayTitle({ title: null }, [], "新对话")).toBe("新对话");
    expect(sessionDisplayTitle({ title: null }, [{ ...messages[0]!, parts: [] }], "新对话")).toBe(
      "新对话",
    );
  });
  it("truncates Unicode characters without splitting emoji", () => {
    expect(
      sessionDisplayTitle(
        { title: null },
        [{ ...messages[0]!, parts: [{ type: "text", text: "😀".repeat(41) }] }],
        "",
      ),
    ).toBe(`${"😀".repeat(40)}…`);
  });
});
