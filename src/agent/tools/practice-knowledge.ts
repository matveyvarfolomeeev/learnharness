import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { getGraph } from "../../core/graph.ts";
import { practiceKnowledge, PRACTICE_KNOWLEDGE_GUIDANCE, type PracticeKnowledgeQuery } from "../../core/practice-knowledge.ts";
import { invalidInputResult, toToolResult } from "../tool-execute.ts";
import type { GraphToolContext } from "./graph.ts";

type Context = GraphToolContext & { chatId: string };
function read(ctx: Context, query: PracticeKnowledgeQuery = {}) {
	const chat = ctx.chatStore.getChat(ctx.chatId);
	if (!chat) throw new Error("Practice session not found");
	return practiceKnowledge(getGraph(ctx.graphStore), ctx.projectStore?.read() ?? { version: 1, projects: [], assignments: {}, autoDetect: false }, chat, ctx.readMastery ?? (() => ({})), query);
}

export function practiceKnowledgeContext(ctx: Context): string {
	return `${PRACTICE_KNOWLEDGE_GUIDANCE}\n${JSON.stringify(read(ctx))}`;
}

const schema = Type.Object({
	projectId: Type.Optional(Type.String({ description: "Existing subject project id; includes subprojects. Choose a relevant project from the context catalog." })),
	nodeIds: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 12, description: "Exact existing graph ids to inspect, including their supporting premises." })),
	query: Type.Optional(Type.String({ maxLength: 200, description: "Short keywords in node names/statements/aliases. All words must match. For broad subjects prefer projectId." })),
});

export function practiceKnowledgeTool(ctx: Context): AgentTool<typeof schema> {
	return { name: "practice_knowledge", label: "Освоение знаний", parameters: schema,
		description: "Read current mastery, recent checks from all sessions, graph statements and supporting premises. Returns up to 12 relevant nodes ranked review/unassessed/learning/known. No arguments = this session's selected nodes/project. Resolve free-form topics through projectId or query before posing graph-linked problems. Does not change any marks.",
		execute: async (_id, query) => {
			try { return toToolResult(read(ctx, { ...query, limit: 12 })); }
			catch (e) { return invalidInputResult("practice_knowledge", [(e as Error).message]); }
		},
	};
}
