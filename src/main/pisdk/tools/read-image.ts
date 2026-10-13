import type { JsonRepresentation } from "@earendil-works/chord";
import type { ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import { requireToolEnv } from "./tool-env";
// `read_image`：把一张图片读成**模型能看的 image 块** + 给界面渲染用的 details。
//
// pi-durable 的 read 只读文本；本工具保留图片检查能力，并将尺寸、路径等元数据交给界面。
// 图片数据通过原生 image 内容块进入模型，details 只保存元数据以避免重复存储。
//
// ## 与内核 read 的分工
//
// `read_image` **只**处理图片：非图片路径直接报错并让模型改用 read（而不是自己降级成
// 文本读取）。理由是两者的结果形状不同 —— read 的文本结果是要被引用的正文，
// 而图片是给模型看的附件；混在一个工具里会让「这次到底读到什么」变得看运气。
//
// ## details 的形状（渲染层契约）
//
// `{ image: { path, mediaType, bytes, width?, height? } }`：**只有读数，没有图片字节**。
//
// 图片本体**刻意不放进 details**：details 会随 part 落盘（见 message-mapper 的
// applyToolResult），把几 MB 的图片塞进去等于每读一张图就往会话库里写一份 base64 ——
// 会话文件会被截图迅速撑爆，而那份数据在界面上只为了「点开看一眼」。
//
// 所以界面走**按需加载**：展开详情时用 `files.readImage`（IPC）按 path 现取一次
// dataUrl 来显示。这与 DSH 的 read_image 同一条思路（那边是 attachmentId + loadImage，
// 这边没有附件库，直接用路径 + 受限读取通道）。
//
// 模型侧不受影响：图片本体照常以 image 内容块返回（它必须真正看到图）。

import { getOrThrow } from "@earendil-works/pi-durable/env";
import { type Static, Type } from "typebox";
import {
  declaredUnsupportedImageExtension,
  type ImageMediaType,
  imageDimensions,
  mediaTypeForPath,
  sniffMediaType,
} from "./image-meta";

export const READ_IMAGE_TOOL_NAME = "read_image";

const readImageSchema = Type.Object({
  file_path: Type.String({
    minLength: 1,
    description:
      "Path to the image file, resolved by the filesystem backend. Relative paths are resolved against the session working directory.",
  }),
});

export type ReadImageToolParams = Static<typeof readImageSchema>;

/**
 * 单张图片的字节上限（16 MiB）。
 *
 * 这里的图片被编码为 base64 内容块，
 * 而内容块要过 IPC 结构化克隆、并在模型下一次请求里作为输入重新编码。
 * 16 MiB 足够覆盖屏幕截图与手机照片（iPhone 的 HEIC 转 PNG 后常在 3~8 MiB），
 * 再大就该让模型先缩小。
 *
 * （界面那一侧另有自己的上限：`files.readImage` 是 32 MiB —— 它只在用户展开详情时
 * 走一次、且不进会话库，见 main/files/service.ts 的 MAX_IMAGE_BYTES。）
 */
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;

const DESCRIPTION =
  "Read a PNG/JPEG/WebP/GIF file and return the image itself so you can look at it. " +
  "Use this for any image: one the user attached, one already in the project, or one produced by a screenshot.\n\n" +
  "A path without a file extension is accepted — the format is detected from the file content.\n\n" +
  "When to use: the user refers to an image and you need to see it; you need to check a screenshot, " +
  "diagram, mockup or chart; you are about to change something that is defined visually.\n" +
  "When NOT to use: for text files (use read — including SVG, which is text); " +
  "when you only need an image's path or size on disk (use glob or bash); " +
  "when a tool already returned the image to you in its result.\n\n" +
  "Do not install image libraries or write scripts to decode, resize or make thumbnails of an image " +
  "merely to inspect it — this tool is the supported route. " +
  /**
   * 这里**不要**承诺自动缩放。本工具没有任何缩放实现（只有 MAX_IMAGE_BYTES 那道拒绝），
   * 超过上限时它的实际行为是报错并让模型自己去缩小 —— 描述与行为不一致会把模型卡住：
   * 它按描述以为「大图会被自动处理」，于是既不缩小、也不换路。
   *
   * （那句「会自动缩小」是从内核 read 的描述抄来的 —— 内核**注入了 imageProcessor 时**
   * 确实会缩，而 Oint 从未注入。见 tools/read.ts 的说明。）
   */
  "Images over the size limit are rejected — the error tells you to downscale it first.\n\n" +
  "Requires the current model to accept image input. Independent files may be read in small batches.";

/** 读到的图片：给界面的结构化读数（全部是可结构化克隆的原始类型） */
export interface ReadImageDetails {
  image: {
    path: string;
    mediaType: ImageMediaType;
    bytes: number;
    /** 像素尺寸；头部解析不出来时缺省（界面据此不显示尺寸，而不是显示编的） */
    width?: number;
    height?: number;
  };
}

/**
 * 给模型的信封：DSH 的 formatImageReadOutput 同款形状。
 *
 * 写成带标签的多行而不是一句话，是为了让「路径 / 类型 / 内容读数」三段各自可被引用；
 * 模型在后续调用里回引这块内容时，标签比散文更好对上。
 *
 * 尺寸**读不出来时就不写尺寸**：DSH 那边由附件服务保证一定有尺寸，而这里是自己解析头部，
 * 解析失败是有可能的（少见格式变体）。编一个尺寸会让模型算错坐标，宁可少一行。
 */
function formatImageEnvelope(path: string, details: ReadImageDetails["image"]): string {
  const size =
    details.width === undefined || details.height === undefined
      ? "dimensions unavailable"
      : `${details.width}x${details.height} px`;
  return [
    `<path>${path}</path>`,
    "<type>image</type>",
    "<content>",
    `${details.mediaType} image, ${size}, ${details.bytes} bytes`,
    "</content>",
  ].join("\n");
}

/**
 * 组装 read_image 工具。
 *
 * 路径解析与越界判定**全部交给传入的 ExecutionEnv**（它已经带着路径守卫，
 * 见 exec-env.ts 的 createExecEnv）：这里不重复实现一遍守卫，
 * 否则两处判据迟早会漂移，而「守卫只有一份」正是那条边界可信的前提。
 */
export function createReadImageTool(): ToolRegistration<
  typeof readImageSchema,
  JsonRepresentation<ReadImageDetails>
> {
  return {
    name: READ_IMAGE_TOOL_NAME,

    description: DESCRIPTION,
    parameters: readImageSchema,
    async execute(
      rawParams,
      api,
      context,
    ): Promise<ToolExecutionResult<JsonRepresentation<ReadImageDetails>>> {
      const env = requireToolEnv(api);
      const params = rawParams as ReadImageToolParams;
      const requested = params.file_path.trim();
      if (requested === "") throw new Error("file_path must be a non-empty string");

      /**
       * 先按扩展名快速拒绝明确不支持的图片格式。
       *
       * 这一步在**读盘之前**：让模型在「这是一张 200 MB 的 PSD」这种情况下立刻拿到
       * 可操作的指引，而不是先读进来再报「内容不是图片」。
       */
      const unsupported = declaredUnsupportedImageExtension(requested);
      if (unsupported !== undefined) {
        throw new Error(
          `cannot read "${requested}" as an image: ${unsupported} is not a supported image format; ` +
            "read_image accepts PNG/JPEG/WebP/GIF — convert the file to one of those and retry",
        );
      }

      // 解析 + 越界判定都由 env 负责（它带着路径守卫）
      const absolute = getOrThrow(await env.absolutePath(requested, context));
      const bytes = getOrThrow(await env.readBinaryFile(absolute, context));

      if (bytes.byteLength === 0) {
        throw new Error(`cannot read "${absolute}": the file is empty`);
      }
      if (bytes.byteLength > MAX_IMAGE_BYTES) {
        throw new Error(
          `cannot read "${absolute}": the image is ${bytes.byteLength} bytes, over the ` +
            `${MAX_IMAGE_BYTES}-byte limit; downscale it and read the smaller copy`,
        );
      }

      /**
       * 格式：**内容优先**。
       *
       * 扩展名声明的格式只是一个期望 —— 文件被改过名是常事。以魔数为准，
       * 两者不一致时按内容走（这正是「无扩展名也能读」那条能力的同一个实现）。
       */
      const sniffed = sniffMediaType(bytes);
      if (sniffed === undefined) {
        const declared = mediaTypeForPath(requested);
        throw new Error(
          `cannot read "${absolute}": the file content is not a supported image format` +
            (declared === undefined
              ? ""
              : ` (the extension declares ${declared}, but the bytes do not decode as one)`) +
            "; read_image accepts PNG/JPEG/WebP/GIF — use read for text files",
        );
      }

      const dimensions = imageDimensions(bytes, sniffed);
      const image: ReadImageDetails["image"] = {
        path: absolute,
        mediaType: sniffed,
        bytes: bytes.byteLength,
        ...(dimensions === undefined ? {} : { width: dimensions.width, height: dimensions.height }),
      };

      return {
        output: [
          { type: "text", text: formatImageEnvelope(absolute, image) },
          /**
           * 图片本体以 image 内容块返回 —— 模型必须**真正看到**这张图，这是本工具的全部意义。
           *
           * 它只走内容块，**不进 details**：details 会随 part 落盘（见文件头），
           * 而内容块不会。界面要显示时用 `files.readImage` 按 path 现取（见 ImageDetail 组件）。
           */
          { type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: sniffed },
        ],
        details: { image },
      };
    },
  };
}
