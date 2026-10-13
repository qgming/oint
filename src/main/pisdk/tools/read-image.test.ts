import { createToolTestApi } from "@/main/pisdk/tools/tool-test-api";
// read_image 工具的契约：把一张图读成「模型能看的 image 块 + 给界面的 details」。
//
// 全部在真实临时文件上跑（与 read.test.ts 同一套）：路径守卫、魔数嗅探与尺寸解析
// 都走真实逻辑，替身会把要验的东西验成空的。
//
// 最要紧的两条断言：
//   1. **图片本体在 content 里**（模型必须真正看到图，那是本工具的全部意义）；
//   2. **图片本体不在 details 里** —— details 会随 part 落盘（见 message-mapper 的
//      applyToolResult），几百 KB 的图每读一张就往会话库里写一份 base64，会话文件会被
//      截图撑爆。界面要显示走 files.readImage 按需取（见 ImageDetail 组件）。

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createExecEnv } from "../exec-env";
import { buildTools } from "../tools";
import type { ReadImageDetails } from "./read-image";

let root: string;
let env: ExecutionEnv;

/**
 * 最小的合法 PNG：签名 + IHDR（带宽高）+ 一个空的 IDAT + IEND。
 * 手工拼而不是塞一个 base64 常量，是为了让「宽高是哪几个字节」在测试里一眼可读。
 */
function png(width: number, height: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "ascii");
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  // 位深 8 / 颜色类型 2（truecolor）/ 压缩 0 / 滤波 0 / 隔行 0，末 4 字节是 CRC 占位
  ihdr.writeUInt8(8, 16);
  ihdr.writeUInt8(2, 17);
  const iend = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  return Buffer.concat([signature, ihdr, iend]);
}

/** 走装配后的 read_image（而不是单独构造）：tools.ts 里接错工具时这里必须变红 */
async function runReadImage(filePath: string) {
  const tool = buildTools().find((candidate) => candidate.name === "read_image");
  if (tool === undefined) throw new Error("缺少 read_image 工具");
  const result = await tool.execute(
    { file_path: filePath },
    createToolTestApi({ env, callId: "call-read-image" }),
    BACKGROUND_CONTEXT,
  );
  /**
   * `buildTools()` 的返回类型把 details 擦成了 `unknown`（它要容纳 MCP 等外部工具，
   * 见 tools.ts 的 AppToolContext 说明），所以这里断言一次真实形状。
   * 用断言而不是 `as any`：形状真的变了（例如又有人把 dataUrl 加回来）时，
   * 下面那条「details 里没有字节」的用例仍会红。
   */
  return result as typeof result & { details: ReadImageDetails };
}

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "oint-read-image-"));
  env = await createExecEnv({ cwd: root });
  await writeFile(path.join(root, "shot.png"), png(800, 600));
  await writeFile(path.join(root, "photo.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));
  // 扩展名撒谎：内容是 PNG
  await writeFile(path.join(root, "actually-png.jpg"), png(64, 32));
  // 无扩展名：只能靠内容嗅探
  await writeFile(path.join(root, "noext"), png(10, 20));
  await writeFile(path.join(root, "notes.txt"), "这不是图片");
  await writeFile(path.join(root, "vector.svg"), "<svg></svg>");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("read_image 的输出契约", () => {
  it("图片本体进 output（模型必须真正看到图）", async () => {
    const result = await runReadImage("shot.png");

    const image = (result.output ?? []).find((block) => block.type === "image");
    expect(image).toBeDefined();
    // image 块是 base64 的字节本体，不是路径
    expect(image?.type === "image" ? image.mimeType : "").toBe("image/png");
    expect(image?.type === "image" ? image.data.length : 0).toBeGreaterThan(0);
  });

  /**
   * 这一条是**设计决定**，不是实现细节：details 随 part 落盘，
   * 图片字节进去就等于往会话库里写 base64。界面显示走 files.readImage 按需取。
   */
  it("图片本体不进 details（details 会落盘，几 MB 的 base64 会撑爆会话库）", async () => {
    const result = await runReadImage("shot.png");

    expect(result.details?.image.path).toContain("shot.png");
    expect(result.details?.image.mediaType).toBe("image/png");
    expect(result.details?.image.bytes).toBeGreaterThan(0);
    // 尺寸读出来了（界面据此显示读数）
    expect(result.details?.image.width).toBe(800);
    expect(result.details?.image.height).toBe(600);
    // 但没有任何字节形态的字段
    expect(JSON.stringify(result.details)).not.toContain("base64");
    expect(Object.keys(result.details?.image ?? {})).not.toContain("dataUrl");
  });

  it("给模型的信封带路径 / 类型 / 尺寸 / 体积（DSH 同款形状）", async () => {
    const result = await runReadImage("shot.png");
    const text = (result.output ?? [])
      .filter((block) => block.type === "text")
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n");

    expect(text).toContain("<type>image</type>");
    expect(text).toContain("shot.png");
    expect(text).toContain("800x600 px");
    expect(text).toContain("image/png");
  });

  it("扩展名撒谎时按**内容**判格式，而不是按扩展名", async () => {
    const result = await runReadImage("actually-png.jpg");
    expect(result.details?.image.mediaType).toBe("image/png");
    expect(result.details?.image.width).toBe(64);
  });

  it("没有扩展名也能读（靠内容嗅探）", async () => {
    const result = await runReadImage("noext");
    expect(result.details?.image.mediaType).toBe("image/png");
    expect(result.details?.image.width).toBe(10);
    expect(result.details?.image.height).toBe(20);
  });

  it("尺寸读不出来时就不给尺寸，不编一个", async () => {
    // JPEG 头只有 SOI + 一个不完整的 APP0：嗅得出格式，但读不出尺寸
    const result = await runReadImage("photo.jpg");
    expect(result.details?.image.mediaType).toBe("image/jpeg");
    expect(result.details?.image.width).toBeUndefined();
  });

  it("非图片内容报错，并把「改用 read」指出来", async () => {
    await expect(runReadImage("notes.txt")).rejects.toThrow(/not a supported image format/);
    // 措辞里要有出路，否则模型只知道失败、不知道下一步
    await expect(runReadImage("notes.txt")).rejects.toThrow(/use read for text files/);
  });

  /**
   * SVG 是**文本**不是图片：它走 read，不该被 read_image 当成图。
   * 给它一条专门的指引（换成 PNG/JPEG/WebP/GIF），比笼统的「不是图片」有用。
   */
  it("SVG 按「不支持的图片扩展名」拒绝，并给出可操作的指引", async () => {
    await expect(runReadImage("vector.svg")).rejects.toThrow(/\.svg is not a supported/);
    await expect(runReadImage("vector.svg")).rejects.toThrow(/convert the file/);
  });

  it("文件不存在时报错而不是静默成功", async () => {
    await expect(runReadImage("missing.png")).rejects.toThrow();
  });

  it("空 file_path 被拒绝", async () => {
    const tool = buildTools().find((candidate) => candidate.name === "read_image");
    if (tool === undefined) throw new Error("缺少 read_image 工具");
    await expect(
      tool.execute(
        { file_path: "   " },
        createToolTestApi({ env, callId: "call-x" }),
        BACKGROUND_CONTEXT,
      ),
    ).rejects.toThrow(/non-empty/);
  });
});
