// 插件作者 API（chord 1.2 新 host 运行时）。
//
// 这是 `oint:plugin` 解析到的模块：插件子进程的 worker 入口会给这个说明符装 resolve hook，
// 指向本文件编译产物，插件 `import { PluginAgent, ... } from "oint:plugin"` 即可拿到
// 与宿主完全一致的契约对象（同一个对象 → 不存在跨进程指纹漂移）。
//
// 契约里的复杂载荷（工具调用、工具结果）用 Type.Unsafe 承载 TS 类型、运行时校验保持宽松
// （additionalProperties: true）—— 它们来自 pi-durable / pi-ai，字段会随内核版本演进，
// 契约只负责「形状大致如此、能过线」，精确语义由宿主的 validateAgentDescription 兜底。
import { type JsonValue, method, remote } from "@earendil-works/chord";
import Type from "typebox";
import { Value } from "typebox/value";

/** 工具、命令与 section 的声明，和旧版一致（宿主按它装配 Extension）。 */
export type PluginToolDescriptor = {
  name: string;
  description: string;
  parameters: { [key: string]: JsonValue };
  replay?: "safe" | "unsafe";
  executionMode?: "parallel" | "sequential";
  outputLimits?: { maxBytes?: number; maxLines?: number; retain?: "head" | "tail" };
};
export type PluginAgentDescription = {
  tools: PluginToolDescriptor[];
  commands: { name: string; description: string }[];
  sections: { key: string; text: string }[];
};
export type PluginInvocation = {
  callId: string;
  taskId: string;
  conversationId: string;
  cwd: string;
};
export type PluginHookInvocation = { taskId: string; conversationId: string };
export type BeforeToolResult = { arguments?: { [key: string]: JsonValue }; block?: string };

/** 给模型看的内容块：文本与图片（与 pi-ai 的同名字段结构一致）。 */
export type PluginTextBlock = { type: "text"; text: string };
export type PluginImageBlock = { type: "image"; data: string; mimeType: string };
export type PluginContentBlock = PluginTextBlock | PluginImageBlock;
export type PluginDiagnostic = {
  severity: "info" | "warn" | "error";
  message: string;
  code?: string;
};

/**
 * 插件工具/钩子的返回值；与 pi-durable 1.2 的 `ToolExecutionResult` 结构一致
 * （`content` 已更名为 `output`，并新增 `structuredOutput`）。
 */
export type PluginToolResult = {
  readonly output?: readonly PluginContentBlock[];
  readonly isError?: boolean;
  readonly details?: JsonValue;
  readonly diagnostics?: readonly PluginDiagnostic[];
  readonly structuredOutput?: JsonValue;
};

/** 结构化的工具调用（beforeTool / afterTool 的入参），字段跟随 pi-ai 演进。 */
export type PluginToolCall = {
  id?: string;
  name: string;
  args?: unknown;
  arguments?: unknown;
};

const NAME_PATTERN = "^[a-zA-Z][a-zA-Z0-9_-]{0,39}$";
const name = Type.String({ pattern: NAME_PATTERN });
const descriptionSchema = Type.Object(
  {
    tools: Type.Array(
      Type.Object(
        {
          name,
          description: Type.String({ maxLength: 12000 }),
          parameters: Type.Record(Type.String(), Type.Unknown()),
          replay: Type.Optional(Type.Union([Type.Literal("safe"), Type.Literal("unsafe")])),
          executionMode: Type.Optional(
            Type.Union([Type.Literal("parallel"), Type.Literal("sequential")]),
          ),
          outputLimits: Type.Optional(
            Type.Object(
              {
                maxBytes: Type.Optional(Type.Integer({ minimum: 1 })),
                maxLines: Type.Optional(Type.Integer({ minimum: 1 })),
                retain: Type.Optional(Type.Union([Type.Literal("head"), Type.Literal("tail")])),
              },
              { additionalProperties: false },
            ),
          ),
        },
        { additionalProperties: false },
      ),
      { maxItems: 64 },
    ),
    commands: Type.Array(
      Type.Object(
        { name, description: Type.String({ maxLength: 12000 }) },
        { additionalProperties: false },
      ),
      { maxItems: 64 },
    ),
    sections: Type.Array(
      Type.Object(
        {
          key: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,39}$" }),
          text: Type.String({ maxLength: 32000 }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 32 },
    ),
  },
  { additionalProperties: false },
);

/** description 的 schema 本体：插件建 cell 用它，宿主校验订阅值用它。 */
export const pluginAgentDescriptionSchema = Type.Unsafe<PluginAgentDescription>(descriptionSchema);

export function validateAgentDescription(value: unknown): asserts value is PluginAgentDescription {
  if (!Value.Check(descriptionSchema, value)) throw new Error("插件 agent service 的描述不合法");
  const items = [
    value.tools,
    value.commands,
    value.sections.map((section) => ({ name: section.key })),
  ] as { name: string }[][];
  for (const group of items) {
    if (new Set(group.map((item) => item.name)).size !== group.length)
      throw new Error("插件的工具、命令或 section 名称重复");
  }
  for (const tool of value.tools)
    if ((tool.parameters as { type?: unknown }).type !== "object")
      throw new Error(`工具 ${tool.name} 的参数必须是 object schema`);
}

const invocationSchema = Type.Unsafe<PluginInvocation>(
  Type.Object(
    {
      callId: Type.String(),
      taskId: Type.String(),
      conversationId: Type.String(),
      cwd: Type.String(),
    },
    { additionalProperties: false },
  ),
);
const hookInvocationSchema = Type.Unsafe<PluginHookInvocation>(
  Type.Object(
    { taskId: Type.String(), conversationId: Type.String() },
    { additionalProperties: false },
  ),
);
const jsonObjectSchema = Type.Record(Type.String(), Type.Unknown());
const toolCallSchema = Type.Unsafe<PluginToolCall>(
  Type.Object({ name: Type.String() }, { additionalProperties: true }),
);
const toolResultSchema = Type.Unsafe<PluginToolResult>(
  Type.Object(
    {
      output: Type.Optional(Type.Array(Type.Unknown())),
      isError: Type.Optional(Type.Boolean()),
      details: Type.Optional(Type.Unknown()),
      diagnostics: Type.Optional(Type.Array(Type.Unknown())),
      structuredOutput: Type.Optional(Type.Unknown()),
    },
    { additionalProperties: true },
  ),
);
const beforeToolResultSchema = Type.Unsafe<BeforeToolResult>(
  Type.Object(
    {
      arguments: Type.Optional(jsonObjectSchema),
      block: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
);

/**
 * 插件 agent 契约：每台插件 host 上以 `default` 变体提供。
 *
 * - `description` 是状态（工具/命令/section 声明），宿主订阅它并materialize成原生 Extension；
 * - `execute` / `command` / `beforeTool` / `afterTool` 是四个方法，全部单对象入参；
 * - 取消通过 Chord 的 ctx.signal 传递（实现方用 `ctx.signal.throwIfAborted()` 检查）。
 */
export const PluginAgent = remote("oint.plugin.agent", {
  version: 1,
  input: Type.Object({}),
  variants: {
    default: {
      state: { description: pluginAgentDescriptionSchema },
      methods: {
        execute: method(
          Type.Object({
            name: Type.String(),
            args: jsonObjectSchema,
            invocation: invocationSchema,
          }),
          toolResultSchema,
        ),
        command: method(
          Type.Object({ name: Type.String(), args: Type.String(), cwd: Type.String() }),
          Type.String(),
        ),
        beforeTool: method(
          Type.Object({ call: toolCallSchema, invocation: hookInvocationSchema }),
          beforeToolResultSchema,
        ),
        afterTool: method(
          Type.Object({
            call: toolCallSchema,
            result: toolResultSchema,
            invocation: hookInvocationSchema,
          }),
          toolResultSchema,
        ),
      },
    },
  },
});

/** 插件 host 的名字前缀：主进程以 `at: "plugin:<key>"` 访问。 */
export const PLUGIN_HOST_PREFIX = "plugin:";
