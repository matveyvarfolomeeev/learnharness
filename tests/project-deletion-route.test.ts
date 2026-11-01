import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, it } from "node:test";
import type { GraphNode, ProjectCatalog } from "../src/core/index.ts";
import { getGraph } from "../src/core/graph.ts";
import { UNASSIGNED_PROJECT } from "../src/core/projects.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-project-removal-"));
process.env.LH_DATA_DIR = root;
process.env.LH_AUTH_FILE = path.join(root, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}\n");
const { PUT } = await import("../app/api/projects/route.ts");
const { stores } = await import("../src/server/stores.ts");
const { projectsView } = await import("../src/server/projects.ts");
const { saveManualMastery } = await import("../src/store/mastery.ts");
beforeEach(() => { fs.rmSync(root, { recursive: true, force: true }); fs.mkdirSync(root); fs.writeFileSync(process.env.LH_AUTH_FILE!, "{}\n"); });
after(() => fs.rmSync(root, { recursive: true, force: true }));
const remove = (id: unknown, targetId: unknown) => PUT(new Request("http://localhost/api/projects", { method: "PUT", body: JSON.stringify({ action: "delete", id, targetId }) }));
function node(id: string, subjectId: string | undefined, source: string): GraphNode {
	return { id, ...(subjectId ? { subjectId } : {}), name: id, statement: `${id} statement`, aliases: [], createdAt: "2026-11-01", provenance: [{ chatId: source, messageId: "m" }] };
}
function fixture() {
	const chat = stores.chatStore.createChat("Analysis lesson");
	const catalog: ProjectCatalog = { version: 1, autoDetect: true, projects: [
		{ id: "math", name: "Анализ", createdAt: "2026-11-01" },
		{ id: "series", name: "Ряды", parentId: "math", createdAt: "2026-11-01" },
		{ id: "ml", name: "Машинное обучение", createdAt: "2026-11-01" },
	], assignments: { book: "math", [chat.id]: "math", other: "ml", child: "series" } };
	stores.projectStore.write(catalog);
	for (const id of ["book", "other", "child"]) stores.graphStore.upsertSource({ id, filePath: `${id}.md`, importedAt: "2026-11-01" });
	stores.graphStore.appendNode(node("own", "math", "book"));
	stores.graphStore.appendNode(node("own", "math", chat.id));
	stores.graphStore.appendNode(node("legacy", undefined, "book"));
	stores.graphStore.appendNode(node("shared", "ml", "other"));
	stores.graphStore.appendNode(node("shared", "math", chat.id));
	stores.graphStore.appendNode(node("child-node", "series", "child"));
	stores.graphStore.appendChain({ id: "argument", premises: ["own"], conclusion: "legacy", provenance: [{ chatId: chat.id, messageId: "m" }], createdAt: "2026-11-01" });
	stores.graphStore.appendCoverage({ chatId: chat.id, fp: "covered", tokens: 10, foldedAt: "2026-11-01" });
	stores.graphStore.appendCheckpoint({ chatId: chat.id, foldedAt: "2026-11-01" });
	saveManualMastery("own", { state: "known", at: "2026-11-01" });
	return { chat, catalog };
}
function files() {
	return Object.fromEntries(fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => {
		const absolute = path.join(entry.parentPath, entry.name);
		return [path.relative(root, absolute).replaceAll("\\", "/"), fs.readFileSync(absolute, "utf8")];
	}));
}

it("deleting a project transfers its knowledge and assignments while preserving every node, relation, source, session and mastery record", async () => {
	const { chat } = fixture();
	const before = files(), original = stores.graphStore.readNodes();
	const response = await remove("math", "ml"); assert.equal(response.status, 200);
	assert.equal((await response.json()).id, "ml");
	const after = files();
	assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
	for (const [name, value] of Object.entries(before)) if (!["graph/nodes.jsonl", "graph/projects.json"].includes(name)) assert.equal(after[name], value, name);
	assert.deepEqual(stores.graphStore.readNodes(), original.map((n) => n.subjectId === "math" || n.id === "legacy" ? { ...n, subjectId: "ml" } : n));
	assert.deepEqual(getGraph(stores.graphStore).nodes.map((n) => n.id), ["own", "legacy", "shared", "child-node"]);
	const catalog = stores.projectStore.read();
	assert.ok(!catalog.projects.some((p) => p.id === "math"));
	assert.equal(catalog.assignments[chat.id], "ml"); assert.equal(catalog.assignments.book, "ml");
	assert.equal(catalog.projects.find((p) => p.id === "series")?.parentId, "ml");
	assert.equal(catalog.assignments.child, "series");
	assert.equal(projectsView().counts.ml, 4);
	const saved = files(); assert.equal((await remove("math", "ml")).status, 404); assert.deepEqual(files(), saved);
});

it("the unassigned destination is created and survives a fresh read; subprojects become top-level projects", async () => {
	fixture(); assert.equal((await remove("math", UNASSIGNED_PROJECT)).status, 200);
	const catalog = stores.projectStore.read();
	assert.equal(catalog.projects.find((p) => p.id === UNASSIGNED_PROJECT)?.name, "Без проекта");
	assert.equal(catalog.projects.find((p) => p.id === "series")?.parentId, undefined);
	assert.equal(catalog.assignments.book, UNASSIGNED_PROJECT);
	assert.equal(projectsView().counts[UNASSIGNED_PROJECT], 3, "shared provenance follows its moved source without duplicating the node");
	assert.equal(getGraph(stores.graphStore).nodes.length, 4);
});

it("invalid targets, descendants and the protected unassigned pool refuse before any writes", async () => {
	fixture(); const before = files();
	for (const [id, target] of [["math", "math"], ["math", "series"], ["math", "missing"], ["math", ""], ["math", 1], [null, "ml"], [UNASSIGNED_PROJECT, "ml"]]) {
		assert.equal((await remove(id, target)).status, 400); assert.deepEqual(files(), before);
	}
});

it("a child-name collision is reported before moving knowledge or changing the hierarchy", async () => {
	fixture(); const catalog = stores.projectStore.read();
	catalog.projects.push({ id: "other-series", name: "Ряды", parentId: "ml", createdAt: "2026-11-01" }); stores.projectStore.write(catalog);
	const before = files(); const response = await remove("math", "ml");
	assert.equal(response.status, 400); assert.match((await response.json()).error, /Ряды/); assert.deepEqual(files(), before);
});

it("running extraction blocks a project removal without cancelling work or changing files", async () => {
	fixture(); const before = files();
	const globals = globalThis as { __lhExtractionRuns?: unknown }, saved = globals.__lhExtractionRuns;
	const controller = new AbortController();
	try {
		globals.__lhExtractionRuns = { running: new Map([["busy", { chatId: "busy", startedAt: 1, controller }]]), inFlight: new Set(), lastStartedAt: 0 };
		assert.equal((await remove("math", "ml")).status, 409);
		assert.equal(controller.signal.aborted, false); assert.deepEqual(files(), before);
	} finally { globals.__lhExtractionRuns = saved; }
});

it("a failed catalog save restores the original node ledger and reports an error", async () => {
	fixture(); const before = files(), write = stores.projectStore.write;
	try {
		stores.projectStore.write = () => { throw new Error("synthetic disk failure"); };
		assert.equal((await remove("math", "ml")).status, 500);
		assert.deepEqual(files(), before);
	} finally { stores.projectStore.write = write; }
});

it("a failed node rewrite leaves the project catalog and all data intact", async () => {
	fixture(); const before = files(), rewrite = stores.graphStore.rewriteLedgers;
	try {
		stores.graphStore.rewriteLedgers = () => { throw new Error("synthetic disk failure"); };
		assert.equal((await remove("math", "ml")).status, 500); assert.deepEqual(files(), before);
	} finally { stores.graphStore.rewriteLedgers = rewrite; }
});
