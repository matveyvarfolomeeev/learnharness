import assert from "node:assert/strict";
import { it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import type { GraphStore, ChatStore } from "../src/core/ports.ts";
import type { GraphNode, GraphChain } from "../src/core/contracts.ts";
import { graphSnapshot, getGraph, mergeFindings, graphSessionPropositions } from "../src/core/graph.ts";
import { inProjects, projectIds, projectPath, projectDigest, validateProject, UNASSIGNED_PROJECT, type ProjectCatalog, type ProjectStore } from "../src/core/projects.ts";
import { selectSourceProject } from "../src/agent/subagents/project-selection.ts";
import { createExtractionPipeline } from "../src/agent/subagents/extraction.ts";

function catalog(): ProjectCatalog { return { version: 1, autoDetect: true, projects: [
	{ id: "ml", name: "Машинное обучение", createdAt: "2026" },
	{ id: "dl", name: "Глубокое обучение", parentId: "ml", createdAt: "2026" },
	{ id: "math", name: "Математический анализ", createdAt: "2026" },
], assignments: { old: "math", lesson: "math" } }; }
function projectStore(initial = catalog()): ProjectStore { let value = initial; return { read: () => structuredClone(value), write: (v) => { value = structuredClone(v); } }; }
const node = (id: string, subjectId: string, source = "old"): GraphNode => ({ id, subjectId, name: id, statement: `Statement ${id}`, aliases: [], provenance: [{ chatId: source, messageId: "m" }], createdAt: "2026" });
function ledgers(initial: GraphNode[] = []): GraphStore {
	let nodes = [...initial]; let chains: GraphChain[] = [];
	return { readNodes: () => structuredClone(nodes), appendNode: (n) => { nodes.push(n); }, readChains: () => structuredClone(chains), appendChain: (c) => { chains.push(c); }, readPositions: () => ({}), writePositions: () => {}, readCheckpoints: () => [], appendCheckpoint: () => {}, readCoverage: () => [], appendCoverage: () => {}, readSources: () => [], deleteSources: () => 0, upsertSource: () => {}, appendSourceUsage: () => {}, rewriteLedgers: (next) => { if (next.nodes) nodes = next.nodes; if (next.chains) chains = next.chains; } };
}
const chats = { getChat: () => null, listChats: () => [] } as unknown as ChatStore;
function engine(steps: FauxResponseStep[]) { const faux = createFauxCore({}); faux.setResponses(steps); return { model: faux.getModel(), streamFn: faux.streamSimple }; }
function call(name: string, args: Record<string, unknown>) { return fauxAssistantMessage([fauxToolCall(name, args as ToolCall["arguments"], { id: `${name}-call` })], { stopReason: "toolUse" }); }
const quiet = () => {};

it("hierarchy rolls up descendants and rejects self/descendant parenting", () => {
	const c = catalog();
	assert.deepEqual([...projectIds(c, "ml")], ["ml", "dl"]);
	assert.deepEqual(projectPath(c, "dl").map((p) => p.id), ["ml", "dl"]);
	assert.ok(validateProject(c, { ...c.projects[0]!, parentId: "dl" }));
	assert.equal(validateProject(c, { ...c.projects[1]!, parentId: "math" }), null);
	assert.ok(validateProject(c, { id: "new", name: "Машинное обучение", createdAt: "2026" }));
});

it("shared knowledge appears in both project views without duplicate nodes or invented edges", () => {
	const c = catalog(); c.assignments.old = "dl"; c.assignments.lesson = "math";
	const shared = node("n_shared", "dl"); shared.provenance.push({ chatId: "lesson", messageId: "q" });
	assert.ok(inProjects(shared, projectIds(c, "math"), c));
	const deps = { chatStore: chats, graphStore: ledgers([shared, node("n_child", "dl"), node("n_math", "math", "lesson")]), projectStore: projectStore(c) };
	assert.equal(graphSnapshot(deps, {}, "ml").propositions.length, 2);
	assert.equal(graphSnapshot(deps, {}, "math").propositions.length, 2);
	assert.equal(graphSnapshot(deps).propositions.length, 3);
	assert.equal(graphSnapshot(deps, {}, "math").edges.length, 0);
	assert.equal(graphSessionPropositions(deps, "ml").length, 2);
});

it("project digest includes earlier sessions and parent foundations, bounded by budget", () => {
	const c = catalog(); c.assignments.lesson = "dl";
	const graph = { nodes: [node("n_parent", "ml", "base"), node("n_child", "dl", "previous"), node("n_other", "math", "unrelated")], chains: [] };
	const digest = projectDigest(graph, c, "lesson", "parent child", 2000);
	assert.match(digest, /n_parent/); assert.match(digest, /n_child/); assert.doesNotMatch(digest, /n_other/);
	assert.match(digest, /NOT evidence of mastery/);
});

it("manual project wins and automatic discovery off makes one unassigned pool without a model", async () => {
	const store = projectStore();
	assert.equal(await selectSourceProject({ store, sourceId: "lesson", source: "Python", onStep: quiet }), "math");
	const c = store.read(); c.autoDetect = false; store.write(c);
	assert.equal(await selectSourceProject({ store, sourceId: "a", source: "Unrelated", onStep: quiet }), UNASSIGNED_PROJECT);
	assert.equal(await selectSourceProject({ store, sourceId: "b", source: "Anything", onStep: quiet }), UNASSIGNED_PROJECT);
	assert.equal(store.read().projects.filter((p) => p.id === UNASSIGNED_PROJECT).length, 1);
});

it("automatic discovery reuses an existing subject and only creates a genuinely new project", async () => {
	const store = projectStore();
	const model = engine([call("select_project", { projectId: "math", newName: "", parentId: "" }), call("select_project", { projectId: "", newName: "Топология", parentId: "math" })]);
	assert.equal(await selectSourceProject({ store, sourceId: "colloquium", source: "Колок по матану", engine: model, onStep: quiet }), "math");
	const id = await selectSourceProject({ store, sourceId: "topology", source: "Топология", engine: model, onStep: quiet });
	assert.equal(store.read().projects.find((p) => p.id === id)?.parentId, "math");
	assert.equal(store.read().projects.length, 4);
});

it("manual assignment during classification wins over a stale automatic choice", async () => {
	const store = projectStore();
	const model = engine([() => { const c = store.read(); c.assignments.new = "ml"; store.write(c); return call("select_project", { projectId: "math", newName: "", parentId: "" }); }]);
	assert.equal(await selectSourceProject({ store, sourceId: "new", source: "lesson", engine: model, onStep: quiet }), "ml");
});

it("merger reuses global identity, keeps provenance, assigns only new nodes, and connects sessions", () => {
	const store = ledgers([node("n_base", "math")]);
	mergeFindings("lesson", { propositions: [{ id: "duplicate", name: "n_base", statement: "Statement n_base", aliases: [], messageId: "m2" }, { id: "new", name: "New theorem", statement: "A consequence", aliases: [] }], chains: [{ premises: ["n_base"], conclusion: "new" }] }, { links: [{ id: "duplicate", linkTo: "n_base" }] }, { graphStore: store, chatStore: chats }, { foldedAt: "2026", subjectId: "ml" });
	const graph = getGraph(store);
	assert.equal(graph.nodes.length, 2); assert.equal(graph.chains.length, 1);
	assert.equal(graph.nodes.find((n) => n.id === "n_base")?.subjectId, "math");
	assert.equal(graph.nodes.find((n) => n.name === "New theorem")?.subjectId, "ml");
	assert.equal(graph.nodes.find((n) => n.id === "n_base")?.provenance.length, 2);
});

it("notes pipeline selects a project before extraction and supplies other-session knowledge", async () => {
	const store = projectStore(); const graphStore = ledgers([node("n_base", "math")]);
	const extractor = engine([
		call("select_project", { projectId: "math", newName: "", parentId: "" }),
		(context) => { assert.match(JSON.stringify(context), /PROJECT KNOWLEDGE/); assert.match(JSON.stringify(context), /n_base/); return call("submit_findings", { propositions: [{ id: "new", name: "Next theorem", statement: "A consequence of the base theorem", aliases: [] }], chains: [{ premises: ["n_base"], conclusion: "new" }] }); },
	]);
	const pipeline = createExtractionPipeline({ chatStore: chats, graphStore, projectStore: store, extractor, auditor: engine([call("submit_review", { links: [] })]) });
	const result = await pipeline.importNotes({ filePath: "new-analysis-notes.md", text: "The base theorem implies the next theorem." });
	assert.equal(result.nodes, 1);
	const graph = getGraph(graphStore); assert.equal(graph.nodes.length, 2);
	assert.equal(graph.nodes.find((n) => n.name === "Next theorem")?.subjectId, "math");
	assert.equal(graph.nodes.find((n) => n.id === "n_base")?.provenance.length, 2);
});
