// 给 pi-durable 的文本 read 输出添加文件行号；分页与诊断保留原生结构。
// 1.2.0 起原生 read 会直接返回图片块（png/jpg/webp/gif 在模型限制内）；
// `unsupported_image` 的含义已变成「这张图无法准备/超出内联限制」，文案里给出 read_image 这条替代路。
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { createReadTool } from "@earendil-works/pi-durable/tools";

/** cat -n 风格：右对齐的绝对行号 + 制表符 + 该行原文 */
export function numberLines(content: string, firstLine: number): string {
  if (content === "") return "";
  const lines = content.split("\n");
  // 末尾换行不产生一个不存在的空行号（cat -n 对 "a\n" 也只显示第 1 行）
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  const width = String(firstLine + lines.length - 1).length;
  return lines
    .map((line, index) => `${String(firstLine + index).padStart(width)}\t${line}`)
    .join("\n");
}

/** Number only file text. Native diagnostics retain truncation, continuation and error semantics. */
export function createReadToolWithLineNumbers(): ToolRegistration {
  const inner = createReadTool();
  const execute: typeof inner.execute = async (params, api, context) => {
    const result = await inner.execute(params, api, context);
    if (result.isError && result.diagnostics?.some((item) => item.code === "unsupported_image")) {
      return {
        ...result,
        diagnostics: result.diagnostics.map((item) =>
          item.code === "unsupported_image"
            ? {
                ...item,
                message: `${item.message}. Use read_image to read this file directly (image data with dimensions, 16 MiB guard).`,
              }
            : item,
        ),
      };
    }
    // 只有「单块纯文本」才是按行组织的文件内容：图片块与多块结果原样返回
    const only = result.output?.length === 1 ? result.output[0] : undefined;
    if (only === undefined || only.type !== "text") return result;
    const firstLine = Math.max(1, Math.floor(params.offset ?? 1));
    return { ...result, output: [{ ...only, text: numberLines(only.text, firstLine) }] };
  };
  return { ...inner, execute };
}
