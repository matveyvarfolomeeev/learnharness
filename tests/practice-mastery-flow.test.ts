import assert from "node:assert/strict";
import { it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createPracticeAgent } from "../src/agent/teacher-agent.ts";
import { handleChatRequest } from "../src/server/chat-handler.ts";
import { runningTurn } from "../src/server/turn-runs.ts";
import { stores } from "../src/server/stores.ts";
import { masteryDetails } from "../src/server/mastery.ts";
import { graphView } from "../src/server/graph.ts";
import { newGraphContextMessage, type LhMessage } from "../src/core/native-messages.ts";
import { practiceKnowledgeTool } from "../src/agent/tools/practice-knowledge.ts";

process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

it("saved check → next session context → real tool verdict → graph status → refreshed next-turn context", async () => {
	const node = { id: `n_test_${crypto.randomUUID()}`, name: "Even sum", statement: "The sum of two odd integers is even.", aliases: [], provenance: [], createdAt: new Date().toISOString() };
	const prior = stores.chatStore.createChat("Prior check", "practice");
	const current = stores.chatStore.createChat("Practice the same knowledge", "practice");
	const pose = { statement: "Prove the sum of two odd integers is even.", mode: "recall", target: [node.id], modelSolution: "(2a+1)+(2b+1)=2(a+b+1)." };
	const conclude = { outcome: "solved", verdict: "Самостоятельно представил оба числа и получил чётную сумму.", rung: null, missClass: null, retest: false, knowledgeResults: [{ nodeId: node.id, result: "passed", reason: "Верное самостоятельное доказательство." }] };
	const ack = (id: string, name: string, timestamp: number): LhMessage => ({ role: "toolResult", id: `result-${id}`, toolCallId: id, toolName: name, content: [{ type: "text", text: "OK" }], details: {}, isError: false, timestamp });
	stores.graphStore.appendNode(node);
	stores.chatStore.saveMessages(prior.id, [
		{ ...fauxAssistantMessage([fauxToolCall("problem", pose, { id: "old-p" })], { stopReason: "toolUse" }), id: "old-a", timestamp: 1000 }, ack("old-p", "problem", 1001),
		{ ...fauxAssistantMessage([fauxToolCall("conclude", conclude, { id: "old-c" })], { stopReason: "toolUse" }), id: "old-b", timestamp: 1002 }, ack("old-c", "conclude", 1003),
	]);
	stores.chatStore.saveMessages(current.id, [newGraphContextMessage([node], [])]);
	stores.chatStore.saveSettings(current.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	const faux = createFauxCore({});
	faux.setResponses([
		() => fauxAssistantMessage([fauxToolCall("problem", pose, { id: "new-p" })], { stopReason: "toolUse" }),
		() => fauxAssistantMessage([fauxToolCall("conclude", conclude, { id: "new-c" })], { stopReason: "toolUse" }),
		() => fauxAssistantMessage([fauxText("Знание подтверждено самостоятельным решением.")]),
		() => fauxAssistantMessage([fauxText("Теперь попробуем другую форму задачи.")]),
	]);
	const contexts: string[] = [];
	const factory: NonNullable<Parameters<typeof handleChatRequest>[1]> = (opts) => {
		contexts.push(opts.projectContext ?? "");
		const agent = createPracticeAgent({ chatId: current.id, chatStore: stores.chatStore, graphNodes: () => stores.graphStore.readNodes(), graph: { ...stores, readMastery: masteryDetails } },
			{ ...opts, engine: { model: faux.getModel(), streamFn: faux.streamSimple } });
		assert.ok(agent.state.systemPrompt.includes(opts.projectContext!));
		assert.ok(agent.state.tools.some((t) => t.name === "practice_knowledge"));
		return agent;
	};
	const send = async (input: object) => {
		const response = await handleChatRequest(new Request("http://test/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId: current.id, input }) }), factory);
		assert.equal(response.status, 200, await response.text());
		const turn = runningTurn(current.id);
		if (turn) await new Response(turn.subscribe()).text();
	};
	try {
		await send({ type: "text", text: "Проверь, насколько я это помню" });
		assert.match(contexts[0]!, /"state":"learning"/);
		assert.ok(contexts[0]!.includes(prior.id), "earlier session evidence is present");
		await send({ type: "thinking", problemCallId: "new-p", text: "Запишем числа 2a+1 и 2b+1. Их сумма 2(a+b+1), поэтому она чётна." });
		const details = masteryDetails([node.id])[node.id]!;
		assert.equal(details.summary.state, "known");
		assert.equal(details.summary.checks, 2);
		assert.equal(details.recent[0]?.chatId, current.id);
		assert.equal(graphView().propositions.find((n) => n.id === node.id)?.mastery?.state, "known");
		const read = await practiceKnowledgeTool({ ...stores, chatId: current.id, readMastery: masteryDetails }).execute("read", { nodeIds: [node.id] });
		assert.ok(JSON.stringify(read).includes('known'));
		await send({ type: "text", text: "Дальше" });
		assert.match(contexts.at(-1)!, /"state":"known"/);
		assert.match(contexts.at(-1)!, /"checks":2/);
	} finally {
		stores.chatStore.deleteChat(prior.id); stores.chatStore.deleteChat(current.id);
		stores.graphStore.rewriteLedgers({ nodes: stores.graphStore.readNodes().filter((n) => n.id !== node.id) });
	}
});
