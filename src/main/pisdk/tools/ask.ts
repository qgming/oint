import type { JsonRepresentation } from "@earendil-works/chord";
import type { ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
// 提问工具（ask_user）：让模型在关键分叉点上停下来问用户，而不是自己猜。
//
// **只允许主 lane 使用**：Oint 目前只有根 lane（见 runtime.ts 的 LANE_NAME），所以这条约束
// 现在等价于「所有 lane」。将来子智能体（子 lane / dsh）上线时**不要**把这个工具注入子 lane：
// 子智能体不允许自己卡住等人 —— 它要把待决问题写进最终结果，由主 lane 统一提问。
// 装配处的同一句提醒见 tools.ts 的 buildTools（那里才是注入点）。
//
// 与审批的关系：ask_user 是低风险工具（permissions.ts 的 LOW_RISK_TOOLS），
// 提问本身不该再先弹一张「批准提问」的审批卡 —— 否则用户要连点两次才能回答一个问题。

import { type Static, Type } from "typebox";
import type {
  AskAnswerItem,
  AskOutcome,
  AskQuestion,
  AskResponse,
} from "@/shared/contracts/interaction";
import type { InteractionService } from "../interactions";

/** 工具名：权限层、UI 图标表与测试都按它登记 */
export const ASK_TOOL_NAME = "ask_user";

/** 一次提问最多带几道题；再多用户就不想答了，模型应该拆成多轮 */
const MAX_QUESTIONS = 4;

const questionSchema = Type.Object({
  id: Type.String({
    minLength: 1,
    description:
      'Stable id for this question inside the call (e.g. "q1"), used to match the answer back.',
  }),
  header: Type.String({
    minLength: 1,
    description:
      'Short label of one or two words shown above the question (e.g. "Database", "UI style").',
  }),
  question: Type.String({
    minLength: 1,
    description:
      "The question itself, phrased so it can be answered directly. Ask one thing per question.",
  }),
  options: Type.Optional(
    Type.Array(Type.String({ minLength: 1 }), {
      description:
        'Ready-made answers the user can click (2-4 short ones). Do NOT add an "other" entry: the UI always offers a free-text box.',
    }),
  ),
  multiSelect: Type.Optional(
    Type.Boolean({
      description:
        "true when several options may be picked together; omit or false for a single choice.",
    }),
  ),
});

/** 工具参数 schema：1~4 道题，超范围由内核在校验阶段挡下 */
export const askSchema = Type.Object({
  questions: Type.Array(questionSchema, {
    minItems: 1,
    maxItems: MAX_QUESTIONS,
    description:
      "The questions to ask, in display order. One call should cover one decision point; do not split a single question into several entries.",
  }),
});

export type AskToolParams = Static<typeof askSchema>;

/** details：给 UI 与日志回填用，字段都是原始类型（要能过 IPC 的结构化克隆） */
export interface AskToolDetails {
  outcome: AskOutcome;
  questions: AskQuestion[];
  answers: AskAnswerItem[];
}

export interface AskToolDeps {
  /** 会话 id：提问请求要落到产生它的那个会话上（后台会话的卡片也只画在它自己那里） */
  sessionId: string;
  /** 提问服务：挂起本轮运行并等渲染层回填（见 pisdk/interactions.ts） */
  interactions: InteractionService;
}

/** 工具说明：本仓库的既定标准 —— 文案要教「什么时候该用、什么时候不要用」 */
function buildAskDescription(timeoutSeconds: number): string {
  return (
    "向用户提问并等待回答：一次调用可以带 1~4 道题，每题可以给现成选项（用户也能自由输入）。" +
    `这是唯一会阻塞运行的等待型工具：用户长时间（默认 ${timeoutSeconds} 秒）不回应会按超时收尾。\n\n` +
    "什么时候用：\n" +
    "- 需求有歧义，且猜错的代价高（改错方向要重写一大片、动错数据、改错对外接口）—— 先问清再动手；\n" +
    "- 要继续就必须由人来定：用哪套方案、保留还是删除、走哪条分支、用哪个环境或账号；\n" +
    "- 用户的偏好类信息无法从仓库或环境推断：命名口味、文案语气、界面取舍、要不要新增一个依赖。\n" +
    "什么时候不要用：\n" +
    "- 自己读代码、查文件、跑命令就能知道的，一律不要问 —— 答案就在仓库里，问了只会拖慢任务；\n" +
    "- 能靠最保守的假设继续、且事后改起来便宜的，不要问：先做，并在最终答复里写明你的假设；\n" +
    "- 不要为了确认「我理解得对不对」而问，也不要连着问第二次：用户答过一轮就按答案做完再汇报。\n" +
    "提问要求：\n" +
    "- header 是一两个词的短标签，question 是具体到能直接回答的一句问话；不要把两件事塞进一题。\n" +
    "- options 给 2~4 个短选项；**不要**写「其他」「以上都不是」这类兜底项 —— 界面自带自由输入框。\n" +
    "- 一次调用只覆盖一个决策点；要连着问好几轮才能推进的任务，说明该先做能做的部分。\n\n" +
    "输出：每题一行「问题 → 用户选了什么 / 自由输入的内容」；用户没回应或运行被停止时给出对应说明，" +
    "此时按最保守的假设继续。"
  );
}

/** 单题答复文本：选项与自由输入各自成句，都没有就是「未作答」 */
function formatAnswer(question: AskQuestion, answer: AskAnswerItem | undefined): string {
  const label = `${question.header}：${question.question}`;
  const parts: string[] = [];
  if (answer !== undefined && answer.selected.length > 0) {
    parts.push(`选定 ${answer.selected.join(" / ")}`);
  }
  const text = answer?.text?.trim();
  if (text !== undefined && text !== "") parts.push(`自由输入：${text}`);
  return `- ${label} → ${parts.length === 0 ? "未作答" : parts.join("；")}`;
}

/** 按题序拼出给模型看的答复文本（顺序跟问题一致，模型不用去比对 id） */
function formatAnswers(questions: readonly AskQuestion[], response: AskResponse): string {
  const byQuestion = new Map(response.answers.map((answer) => [answer.questionId, answer]));
  const lines = questions.map((question) => formatAnswer(question, byQuestion.get(question.id)));
  const answered = response.answers.filter(
    (answer) => answer.selected.length > 0 || (answer.text?.trim() ?? "") !== "",
  ).length;
  return `用户已回答（${answered}/${questions.length} 题）：\n${lines.join("\n")}`;
}

/**
 * 构造 ask_user 工具。
 *
 * 需要会话 id 与提问服务，所以由运行时按会话创建后注入 tools.ts 的 buildTools（见该函数注释）。
 * 工具本身没有内部状态：它只是把一次调用转成一次提问请求，再等答案。
 */
export function createAskTool(
  deps: AskToolDeps,
): ToolRegistration<typeof askSchema, JsonRepresentation<AskToolDetails>> {
  return {
    name: ASK_TOOL_NAME,

    description: buildAskDescription(Math.round(deps.interactions.timeoutMs() / 1000)),
    parameters: askSchema,
    replay: "safe",
    async execute(
      params,
      api,
      context,
    ): Promise<ToolExecutionResult<JsonRepresentation<AskToolDetails>>> {
      const toolCallId = api.callId;
      const questions = params.questions as AskQuestion[];
      // schema 已限定 1~4 题，这里再兜一层：内核换了校验口径时也不能把空提问丢给用户
      if (questions.length < 1 || questions.length > MAX_QUESTIONS) {
        return {
          output: [
            {
              type: "text",
              text: `Error: ask_user 需要 1~${MAX_QUESTIONS} 道题（收到 ${questions.length} 道），本次未提问。`,
            },
          ],
          details: { outcome: "unanswered", questions, answers: [] },
        };
      }

      const response = await deps.interactions.request({
        sessionId: deps.sessionId,
        toolCallId,
        questions,
        api,
        context,
      });
      const details: AskToolDetails = {
        outcome: response.outcome,
        questions,
        answers: response.answers,
      };

      if (response.outcome === "answered") {
        return { output: [{ type: "text", text: formatAnswers(questions, response) }], details };
      }
      if (response.outcome === "unanswered") {
        const seconds = Math.round(deps.interactions.timeoutMs() / 1000);
        return {
          output: [
            {
              type: "text",
              text:
                `用户未在 ${seconds} 秒内回应。不要重复提问：请按最保守的假设继续，` +
                "或把需要用户决策的点写进最终答复。",
            },
          ],
          details,
        };
      }
      return {
        output: [{ type: "text", text: "本轮运行已停止，未获得用户回答。" }],
        details,
      };
    },
  };
}
