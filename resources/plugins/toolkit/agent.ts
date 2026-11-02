import { createHash, randomUUID } from "node:crypto";
import { cell, defineFacet } from "@earendil-works/chord";
// 宿主随包分发的插件 API（子进程用 resolve hook 把 `oint:plugin` 指向它）。
// 新格式为源码直载：本文件就是入口，不需要任何构建步骤（Node 类型剥离执行，
// 因此只允许可擦除的 TS 语法；相对导入必须写全扩展名）。
import { PluginAgent, pluginAgentDescriptionSchema } from "oint:plugin";

/** 支持的哈希算法。**白名单而不是透传** —— 透传的话模型可以传 `md5-sha1` 之类 */
const HASH_ALGORITHMS = ["sha256", "sha512", "sha1", "md5"];

/**
 * 每个工具的声明。
 *
 * 两条来自宿主契约、写错了就会有可读错误的约束：
 *  - `parameters.type` 必须是 `"object"`（顶层不是对象的 schema 模型没法填）；
 *  - `description` 是写给**模型**看的，不是写给人看的 —— 它决定模型什么时候会想起这个工具。
 */
const TOOLS = [
  {
    name: "hash",
    description:
      "计算一段文本的哈希值（十六进制）。默认 sha256。用于校验下载内容、比对两段文本是否相同、生成内容指纹。**注意它算的是文本，不是文件** —— 要算文件请先用 read 读出内容。",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "要计算哈希的文本" },
        algorithm: {
          type: "string",
          enum: HASH_ALGORITHMS,
          description: "哈希算法，默认 sha256",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "encode",
    description:
      "文本的编码转换：base64 / hex / url 的编码与解码。用于看清一段编码过的数据到底写了什么，或把数据编成特定格式。",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "要转换的文本" },
        format: { type: "string", enum: ["base64", "hex", "url"], description: "编码格式" },
        direction: {
          type: "string",
          enum: ["encode", "decode"],
          description: "encode = 编码，decode = 解码；默认 encode",
        },
      },
      required: ["text", "format"],
    },
  },
  {
    name: "uuid",
    description:
      "生成一个随机的 UUID v4。用于造测试数据、给临时文件起名、生成幂等键。**每次调用结果都不同** —— 需要可复现的标识时不要用它。",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "time",
    description:
      "当前时间，或把给定的时间值解析成多种表示（ISO / 本地时间 / Unix 秒 / 毫秒）。用于「今天是几号」、把时间戳翻成人话、比较两个时间点的间隔。**不传 value 就是当前时间。**",
    parameters: {
      type: "object",
      properties: {
        value: {
          type: "string",
          description:
            "要解析的时间：ISO 字符串、Unix 秒或毫秒时间戳、或任何 Date.parse 认得的写法。不传则返回当前时间。",
        },
      },
    },
  },
];

// ── 工具的实现 ────────────────────────────────────────────────────────────────

/** 一个时间点的四种表示 —— 模型经常需要其中某一种，一次给全免得它再猜 */
function describeTime(date) {
  return [
    `ISO        ${date.toISOString()}`,
    `本地时间   ${date.toLocaleString("zh-CN", { timeZoneName: "short" })}`,
    `Unix 秒    ${Math.floor(date.getTime() / 1000)}`,
    `Unix 毫秒  ${date.getTime()}`,
    `星期       ${date.toLocaleDateString("zh-CN", { weekday: "long" })}`,
  ].join("\n");
}

/** `hash` */
function runHash(args) {
  const text = String(args.text ?? "");
  const algorithm = typeof args.algorithm === "string" ? args.algorithm : "sha256";
  // 白名单而不是让 createHash 自己抛：错误信息要能告诉模型"合法的有哪些"
  if (!HASH_ALGORITHMS.includes(algorithm)) {
    return { error: `不支持的算法「${algorithm}」。可用：${HASH_ALGORITHMS.join(", ")}` };
  }
  const digest = createHash(algorithm).update(text, "utf8").digest("hex");
  return { text: `${algorithm}(${text.length} 字符) = ${digest}` };
}

/** `encode` */
function runEncode(args) {
  const text = String(args.text ?? "");
  const format = String(args.format ?? "");
  const direction = args.direction === "decode" ? "decode" : "encode";
  if (!["base64", "hex", "url"].includes(format)) {
    return { error: `不支持的格式「${format}」。可用：base64, hex, url` };
  }

  if (direction === "encode") {
    if (format === "base64") return { text: Buffer.from(text, "utf8").toString("base64") };
    if (format === "hex") return { text: Buffer.from(text, "utf8").toString("hex") };
    return { text: encodeURIComponent(text) };
  }

  try {
    if (format === "base64") return { text: Buffer.from(text, "base64").toString("utf8") };
    if (format === "hex") return { text: Buffer.from(text, "hex").toString("utf8") };
    return { text: decodeURIComponent(text) };
  } catch {
    /*
      解码失败**必须给出可读原因**：一段不是 base64 的文本解出来会是乱码而不是报错
      （`Buffer.from` 不校验），所以这里只兜 URL 解码那种真的会抛的情况。
      乱码那条由技能提醒模型"解出来是乱码说明输入不是这个格式"。
    */
    return { error: `不是合法的 ${format} 编码，解不开` };
  }
}

/** `uuid` */
function runUuid() {
  return { text: randomUUID() };
}

/** `time` */
function runTime(args) {
  const raw = args.value;
  if (raw === undefined || raw === null || raw === "") {
    return { text: describeTime(new Date()) };
  }

  const value = String(raw).trim();
  let date;
  /*
    纯数字先按时间戳解：`Date.parse("1700000000")` 在多数引擎里会把它当成
    **年份** 1700000000 而不是 Unix 秒 —— 那是个静默的错误答案。
    先按 10 位/13 位判一次，剩下的才交给 Date.parse。
  */
  if (/^\d{10}$/.test(value)) {
    date = new Date(Number(value) * 1000);
  } else if (/^\d{13}$/.test(value)) {
    date = new Date(Number(value));
  } else {
    date = new Date(value);
  }

  if (Number.isNaN(date.getTime())) {
    return { error: `解析不出时间：「${value}」。可以给 ISO 字符串、Unix 秒/毫秒，或 "2024-01-01 10:00" 这类写法` };
  }
  return { text: describeTime(date) };
}

// 无原型表：工具名来自模型输入，`toString` / `__proto__` 这类名字不能命中原型链。
const HANDLERS = Object.assign(Object.create(null), {
  hash: runHash,
  encode: runEncode,
  uuid: runUuid,
  time: runTime,
});

/** 声明里的 replay 档位：只读工具可重放，依赖外部状态的不可。 */
function replayOf(name) {
  return ["hash", "encode"].includes(name) ? "safe" : "unsafe";
}

export default defineFacet((host) => {
  host.serve(
    PluginAgent,
    (_input, _principal, self) => {
      const state = self.state({
        description: cell(pluginAgentDescriptionSchema, {
          tools: TOOLS.map((tool) => ({ ...tool, replay: replayOf(tool.name) })),
          commands: [],
          sections: [],
        }),
      });
      return {
        kind: "default",
        description: state.description,
        async execute({ name, args }, ctx) {
          // 取消走 Chord 的根上下文：宿主调用被中止时这里会抛，脚本/模型立刻收手。
          ctx.signal.throwIfAborted();
          const handler = HANDLERS[name];
          if (!handler) throw new Error(`Unknown toolkit tool: ${name}`);
          const result = handler(args);
          return {
            output: [{ type: "text", text: result.error ?? result.text }],
            isError: result.error !== undefined,
          };
        },
        async command() {
          throw new Error("Toolkit has no commands");
        },
        async beforeTool() {
          return {};
        },
        async afterTool({ result }) {
          return result;
        },
      };
    },
    { eager: true },
  );
});
