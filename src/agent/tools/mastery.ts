import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ChatStore, GraphStore } from "../../core/ports.ts";
import { invalidInputResult, toToolResult } from "../tool-execute.ts";

const schema = Type.Object({
	questionCallId: Type.String({ description: "The answered explain/recall tool call id, not its message id." }),
	knowledgeIds: Type.Array(Type.String(), { minItems: 1, maxItems: 12, description: "Existing n_ graph ids actually tested by this answer. Never all project knowledge." }),
	result: Type.Union([Type.Literal("passed"), Type.Literal("partial"), Type.Literal("failed")]),
	reason: Type.String({ minLength: 1, maxLength: 1000, description: "Brief Russian explanation of what the learner demonstrated, what was missing, and whether hints were needed." }),
});

/** The assessment persists through the normal tool-call transcript, with an answered-check guard. */
export function knowledgeAssessmentTool(chatId: string, chatStore: ChatStore, graphStore: GraphStore): AgentTool<typeof schema> {
	return { name: "assess_knowledge", label: "Оценка знания", parameters: schema,
		description: "After a learner answers an explain/recall check, record evidence of their knowledge of its existing graph targets. Compare their own reasoning against the committed answer. passed requires a correct independent explanation; hints or incomplete reasoning mean partial; an incorrect answer or don't know means failed. Never assess from teacher prose, reading, predictions, acknowledgements, or an unanswered question. Quiz scores and practice conclusions are recorded automatically.",
		execute: async (_id, input) => {
			const record = chatStore.getChat(chatId);
			const calls = record?.messages.flatMap((m) => m.role === "assistant" ? m.content.filter((p) => p.type === "toolCall") : []) ?? [];
			const question = calls.find((p) => p.type === "toolCall" && p.id === input.questionCallId);
			const answer = record?.messages.find((m) => m.role === "toolResult" && m.toolCallId === input.questionCallId && !m.isError);
			const details = answer?.role === "toolResult" ? answer.details as Record<string, unknown> | undefined : undefined;
			if (!question || !["explain", "recall"].includes(question.name) || question.arguments.type === "predict" || !details || details.dismissed || (!details.dontKnow && typeof details.text !== "string")) return invalidInputResult("assess_knowledge", ["Reference an answered explain/recall check; predictions, dismissed or unanswered questions cannot be assessed."]);
			if (details.dontKnow && input.result !== "failed") return invalidInputResult("assess_knowledge", ["A don't-know answer is failed, never passed or partial."]);
			const targets = question.arguments.knowledgeIds;
			if (!Array.isArray(targets) || input.knowledgeIds.some((id) => !targets.includes(id))) return invalidInputResult("assess_knowledge", ["Assess only knowledgeIds committed on the answered question. Do not attach unrelated nodes after seeing the answer."]);
			const known = new Set(graphStore.readNodes().map((n) => n.id));
			if (input.knowledgeIds.some((id) => !known.has(id))) return invalidInputResult("assess_knowledge", ["Use existing graph proposition ids; omit assessment if the tested knowledge is not yet extracted."]);
			return toToolResult({ recorded: true });
		},
	};
}
