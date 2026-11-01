import assert from "node:assert/strict";
import { it } from "node:test";
import { practiceKnowledge } from "../src/core/practice-knowledge.ts";
import { masteryEvidence, summarizeMastery, type MasteryReader } from "../src/core/mastery.ts";
import { newGraphContextMessage } from "../src/core/native-messages.ts";
import { concludeTool, problemTool, type PracticeGate } from "../src/agent/tools/practice.ts";
import type { GraphNode, GraphChain } from "../src/core/contracts/graph.ts";
import type { ChatRecord } from "../src/core/contracts/chat.ts";
import type { ProjectCatalog } from "../src/core/projects.ts";
import { resolveTargetId } from "../src/core/chains.ts";

const node = (id: string, subjectId = "math"): GraphNode => ({ id, subjectId, name: id, statement: `Statement ${id}`, aliases: [], provenance: [], createdAt: "2026-10-01" });
const chain = (premises: string[], conclusion: string): GraphChain => ({ id: `${conclusion}-chain`, premises, conclusion, provenance: [], createdAt: "2026" });
const catalog: ProjectCatalog = { version: 1, autoDetect: true, assignments: { c: "math" }, projects: [
	{ id: "math", name: "Математика", createdAt: "2026" }, { id: "analysis", name: "Матанализ", parentId: "math", createdAt: "2026" }, { id: "python", name: "Python", createdAt: "2026" },
] };
const chat = { id: "c", messages: [] };
const empty: MasteryReader = () => ({});
const graph = { nodes: [node("n_failed"), node("n_new", "analysis"), node("n_learning"), node("n_known"), node("n_unrelated", "python")], chains: [] as GraphChain[] };
const history: MasteryReader = (ids) => Object.fromEntries(ids.map((id) => [id, { summary: {
	state: id === "n_failed" || id === "n_unrelated" ? "review" : id === "n_learning" ? "learning" : id === "n_known" ? "known" : "unassessed",
	origin: "checks", checks: 1, passed: 0,
}, recent: [] }]));

it("prioritizes weak and unchecked nodes within a project and its subprojects", () => {
	const result = practiceKnowledge(graph, catalog, chat, history);
	assert.deepEqual(result.nodes.map((n) => n.id), ["n_failed", "n_new", "n_learning", "n_known"]);
	assert.equal(result.totalTargets, 4);
	assert.deepEqual(result.states, { review: 1, unassessed: 1, learning: 1, known: 1 });
});

it("selected goals stay visible, weak supporting premises are inspectable, cycles terminate", () => {
	const selected = { ...chat, messages: [newGraphContextMessage([graph.nodes[3]!], [])] };
	const linked = { ...graph, chains: [chain(["n_unrelated"], "n_known"), chain(["n_known"], "n_unrelated")] };
	const result = practiceKnowledge(linked, catalog, selected, history);
	assert.deepEqual(result.nodes.map((n) => n.id), ["n_known", "n_unrelated"]);
	assert.deepEqual(result.nodes[0]?.premises, [{ id: "n_unrelated", name: "n_unrelated", state: "review" }]);
	assert.equal(result.nodes[1]?.role, "supporting premise");
	assert.equal(practiceKnowledge(linked, catalog, selected, history, { nodeIds: ["n_known"], limit: 1 }).nodes[0]?.id, "n_known");
});

it("an unscoped topic never silently selects unrelated weak nodes; explicit lookup can resolve it", () => {
	const free = { ...chat, id: "free" };
	assert.equal(practiceKnowledge(graph, catalog, free, history).nodes.length, 0);
	assert.equal(practiceKnowledge(graph, catalog, free, history, { projectId: "python" }).nodes[0]?.id, "n_unrelated");
	assert.equal(practiceKnowledge(graph, catalog, free, history, { query: "n_known" }).nodes[0]?.id, "n_known");
	assert.throws(() => practiceKnowledge(graph, catalog, free, history, { nodeIds: ["invented"] }), /Unknown nodeIds/);
	assert.throws(() => practiceKnowledge(graph, catalog, free, history, { projectId: "invented" }), /Unknown projectId/);
});

const conclusion = { outcome: "solvedWithHints" as const, verdict: "Different steps showed different knowledge", rung: "R1" as const, missClass: "execution" as const, retest: true };
it("requires separate multi-node grades and rejects unrelated/duplicate assessments without freeing the problem", async () => {
	const gate: PracticeGate = { problemActive: true, targets: ["n_failed", "n_known"] };
	const tool = concludeTool(gate);
	assert.equal((await tool.execute("a", conclusion)).isError, true);
	assert.equal(gate.problemActive, true);
	const unrelated = [{ nodeId: "n_failed", result: "failed" as const, reason: "wrong" }, { nodeId: "n_unrelated", result: "passed" as const, reason: "ok" }];
	assert.equal((await tool.execute("b", { ...conclusion, knowledgeResults: unrelated })).isError, true);
	assert.equal((await tool.execute("c", { ...conclusion, knowledgeResults: [unrelated[0]!, unrelated[0]!] })).isError, true);
	const valid = [{ nodeId: "n_failed", result: "partial" as const, reason: "hint on this step" }, { nodeId: "n_known", result: "passed" as const, reason: "independent step" }];
	assert.notEqual((await tool.execute("d", { ...conclusion, knowledgeResults: valid })).isError, true);
	assert.equal(gate.problemActive, false);
});

it("a hinted single target cannot be passed and a new pose replaces the committed targets", async () => {
	const gate: PracticeGate = { problemActive: true, targets: ["n_failed"] };
	assert.equal((await concludeTool(gate).execute("x", { ...conclusion, knowledgeResults: [{ nodeId: "n_failed", result: "passed", reason: "ok" }] })).isError, true);
	await concludeTool(gate).execute("y", { ...conclusion, knowledgeResults: [{ nodeId: "n_failed", result: "partial", reason: "hint" }] });
	await problemTool(gate).execute("p", { statement: "Another problem", mode: "recall", modelSolution: "Solution", target: ["n_known"] });
	assert.deepEqual(gate.targets, ["n_known"]);
});

function record(results: unknown[]): ChatRecord {
	return { id: "free", title: "Topic", createdAt: "2026", updatedAt: "2026", messages: [
		{ role: "assistant", id: "a", timestamp: 1000, content: [{ type: "toolCall", id: "p", name: "problem", arguments: { target: ["n_failed", "n_known", "n_new"], mode: "composition" } }] },
		{ role: "toolResult", id: "b", timestamp: 1001, toolCallId: "p", toolName: "problem", isError: false, content: [], details: {} },
		{ role: "assistant", id: "c", timestamp: 1002, content: [{ type: "toolCall", id: "c", name: "conclude", arguments: { ...conclusion, knowledgeResults: results } }] },
		{ role: "toolResult", id: "d", timestamp: 1003, toolCallId: "c", toolName: "conclude", isError: false, content: [], details: {} },
	] as ChatRecord["messages"] };
}
it("per-node results survive the transcript fold without grading unobserved or unrelated nodes", () => {
	const r = record([{ nodeId: "n_failed", result: "partial", reason: "Needed a hint" }, { nodeId: "n_known", result: "passed", reason: "Independent" },
		{ nodeId: "n_new", result: "unassessed", reason: "Not reached" }, { nodeId: "n_unrelated", result: "passed", reason: "Not a target" }]);
	const evidence = masteryEvidence(r, new Set(graph.nodes.map((n) => n.id)));
	assert.deepEqual(evidence.map((e) => [e.nodeId, e.result, e.mode]), [["n_failed", "partial", "composition"], ["n_known", "passed", "composition"]]);
	const read: MasteryReader = (ids) => Object.fromEntries(ids.map((id) => { const events = evidence.filter((e) => e.nodeId === id); return [id, { summary: summarizeMastery(events), recent: events }]; }));
	const context = practiceKnowledge(graph, catalog, r, read);
	assert.equal(context.selectionSource, "earlier problems in this session");
	assert.equal(context.nodes.find((n) => n.id === "n_failed")?.recent[0]?.reason, "Needed a hint");
	assert.equal(context.nodes.find((n) => n.id === "n_new")?.mastery.state, "unassessed");
});

it("caps history and large statement payloads while clearly marking omitted text", () => {
	const huge = { ...node("n_large"), statement: "x".repeat(10000) };
	const result = practiceKnowledge({ nodes: [huge], chains: [] }, catalog, chat, empty);
	assert.equal(result.nodes[0]?.statement.length, 3000);
	assert.equal(result.nodes[0]?.statementTruncated, true);
});

it("duplicate labels never silently attach a check to the first node", () => {
	const nodes = [{ id: "n_statement", name: "Theorem" }, { id: "n_proof", name: "Theorem" }];
	assert.equal(resolveTargetId("Theorem", nodes), null);
	assert.equal(resolveTargetId("n_proof", nodes), "n_proof");
	assert.equal(resolveTargetId("Theorem", [nodes[0]!, nodes[0]!]), "n_statement");
});
