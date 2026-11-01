import assert from "node:assert/strict";
import { it } from "node:test";
import { masteryEvidence, summarizeMastery, type MasteryEvidence } from "../src/core/mastery.ts";
import type { ChatRecord } from "../src/core/contracts.ts";
import { knowledgeAssessmentTool } from "../src/agent/tools/mastery.ts";
import type { ChatStore, GraphStore } from "../src/core/ports.ts";

function event(id: string, chatId: string, result: MasteryEvidence["result"], at = "2026-10-31T10:00:00Z"): MasteryEvidence { return { id, nodeId: "n_x", chatId, result, at, reason: "Проверка" }; }
function chat(calls: { id: string; name: string; args: object; details?: object; error?: boolean }[]): ChatRecord {
	return { id: "chat", title: "Lesson", createdAt: "2026", updatedAt: "2026", messages: calls.flatMap((c, i) => [
		{ role: "assistant", id: `a${i}`, timestamp: 1793440800000 + i, content: [{ type: "toolCall", id: c.id, name: c.name, arguments: c.args }] },
		...(c.details ? [{ role: "toolResult", id: `r${i}`, timestamp: 1793440800010 + i, toolCallId: c.id, toolName: c.name, content: [], details: c.details, isError: c.error ?? false }] : []),
	]) as ChatRecord["messages"] };
}
it("untested and read-only material has no mastery claim", () => {
	assert.equal(summarizeMastery([]).state, "unassessed");
	assert.deepEqual(masteryEvidence(chat([{ id: "q", name: "quiz", args: { knowledgeIds: ["n_x"] } }]), new Set(["n_x"])), []);
});
it("independent confirmations accumulate, hints and failures reset confirmation", () => {
	assert.equal(summarizeMastery([event("1", "a", "passed")]).state, "learning");
	assert.equal(summarizeMastery([event("1", "a", "passed"), event("2", "a", "passed")]).state, "learning");
	assert.equal(summarizeMastery([event("1", "a", "passed"), event("2", "b", "passed")]).state, "known");
	assert.equal(summarizeMastery([event("1", "a", "passed"), event("2", "b", "passed"), event("3", "b", "failed")]).state, "review");
	assert.equal(summarizeMastery([event("1", "a", "passed"), event("2", "b", "partial")]).state, "learning");
});
it("manual marks override earlier evidence, later failures remain visible", () => {
	const manual = { state: "known" as const, at: "2026-10-31T11:00:00Z" };
	assert.equal(summarizeMastery([event("1", "a", "failed")], manual).origin, "manual");
	assert.equal(summarizeMastery([event("2", "a", "passed", "2026-10-31T12:00:00Z")], manual).state, "known");
	assert.equal(summarizeMastery([event("3", "a", "failed", "2026-10-31T12:00:00Z")], manual).state, "review");
});
it("quiz evidence requires explicit existing graph targets; prediction and dismissal do not count", () => {
	const record = chat([
		{ id: "q1", name: "quiz", args: { knowledgeIds: ["n_x", "missing"], type: "check" }, details: { correct: true, answeredAt: "2026-10-31T10:00:00Z" } },
		{ id: "q2", name: "quiz", args: { knowledgeIds: ["n_x"], type: "predict" }, details: { correct: false } },
		{ id: "q3", name: "quiz", args: { knowledgeIds: ["n_x"] }, details: { dismissed: true, dontKnow: true } },
		{ id: "q4", name: "quiz", args: { nodeId: "n_x" }, details: { correct: true } },
	]);
	const evidence = masteryEvidence(record, new Set(["n_x"]));
	assert.equal(evidence.length, 1); assert.equal(evidence[0]?.result, "passed");
});
it("practice conclusions preserve hinted outcomes and ignore skipped problems", () => {
	const record = chat([
		{ id: "p", name: "problem", args: { target: ["n_x"] }, details: {} },
		{ id: "c", name: "conclude", args: { outcome: "solvedWithHints", verdict: "Понадобилась подсказка", rung: "R1" }, details: {} },
		{ id: "p2", name: "problem", args: { target: ["n_x"] }, details: {} },
		{ id: "c2", name: "conclude", args: { outcome: "dismissed" }, details: {} },
	]);
	const events = masteryEvidence(record, new Set(["n_x"])); assert.equal(events.length, 1); assert.equal(events[0]?.result, "partial");
});
it("free-recall assessment requires an answered check and records one event per question", async () => {
	const record = chat([{ id: "e", name: "explain", args: { knowledgeIds: ["n_x"] }, details: { text: "My reasoning" } },
		{ id: "s", name: "assess_knowledge", args: { questionCallId: "e", knowledgeIds: ["n_x"], result: "passed", reason: "Верно" }, details: {} },
		{ id: "s2", name: "assess_knowledge", args: { questionCallId: "e", knowledgeIds: ["n_x"], result: "passed", reason: "Верно" }, details: {} },
	]);
	assert.equal(masteryEvidence(record, new Set(["n_x"])).length, 1);
	const tool = knowledgeAssessmentTool("chat", { getChat: () => record } as unknown as ChatStore, { readNodes: () => [{ id: "n_x" }] } as unknown as GraphStore);
	const rejected = await tool.execute("t", { questionCallId: "missing", knowledgeIds: ["n_x"], result: "passed", reason: "ok" });
	assert.equal(rejected.isError, true);
	const accepted = await tool.execute("t", { questionCallId: "e", knowledgeIds: ["n_x"], result: "passed", reason: "ok" });
	assert.notEqual(accepted.isError, true);
});

it("an explanation cannot be retrospectively attached to unrelated existing knowledge", async () => {
	const record = chat([{ id: "e", name: "explain", args: { knowledgeIds: ["n_x"] }, details: { text: "Reasoning about x" } }]);
	const tool = knowledgeAssessmentTool("chat", { getChat: () => record } as unknown as ChatStore, { readNodes: () => [{ id: "n_x" }, { id: "n_y" }] } as unknown as GraphStore);
	assert.equal((await tool.execute("s", { questionCallId: "e", knowledgeIds: ["n_y"], result: "passed", reason: "Wrong attachment" })).isError, true);
});
