import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ChainTableBody } from "../components/chain-table.tsx";
import type { GraphNode, ProjectCatalog, SourceDirectory } from "../src/core/index.ts";

const projects: ProjectCatalog = { version: 1, autoDetect: true, projects: [
	{ id: "math", name: "Математический анализ", createdAt: "2026-11-01" },
	{ id: "ml", name: "Машинное обучение", createdAt: "2026-11-01" },
	{ id: "dl", name: "Глубокое обучение", parentId: "ml", createdAt: "2026-11-01" },
], assignments: { notes: "math", colloquium: "math", neural: "dl" } };
const node = (id: string, subjectId: string | undefined, source: string): GraphNode => ({ id, name: id, statement: id, subjectId, aliases: [], provenance: [{ chatId: source, messageId: "m" }], createdAt: "2026-11-01" });
const nodes = [node("derivative", "math", "notes"), node("series", undefined, "colloquium"), node("network", "dl", "neural")];
const directory: SourceDirectory = { organization: { version: 1, folders: [], placements: {} }, sources: [
	{ id: "notes", kind: "notes", label: "Импорт анализа", createdAt: "2026-11-01" },
	{ id: "colloquium", kind: "chat", label: "Колок по матану", createdAt: "2026-11-01" },
	{ id: "neural", kind: "notes", label: "Нейронные сети и grokking", createdAt: "2026-11-01" },
] };
const base: Parameters<typeof ChainTableBody>[0] = {
	nodes, chains: [], sessions: {}, fileSources: {}, projects, directory, grouping: "projects",
	query: "", onQuery() {}, sort: { col: "name", dir: 1 }, onSort() {}, selection: new Set(),
	expandedClusters: new Set(["math", "ml", "dl"]), expandedChains: new Set(), onToggleCluster() {}, onToggleChain() {}, onToggleNodes() {}, onClear() {}, onDelete() {}, onClose() {},
};
const render = (props: Partial<typeof base> = {}) => renderToStaticMarkup(<ChainTableBody {...base} {...props} />);

it("one subject combines notes and teaching sessions and never exposes source deletion controls", () => {
	const html = render({ selectedSources: new Set(["notes"]) });
	assert.equal((html.match(/data-testid="cluster-group-math"/g) ?? []).length, 1);
	assert.match(html, /chain-row-derivative/); assert.match(html, /chain-row-series/);
	assert.doesNotMatch(html, /cluster-group-(?:notes|colloquium)|Колок по матану|Импорт анализа/);
	assert.doesNotMatch(html, /chain-delete|add-source-folder|chain-show-empty/);
	assert.match(html, /cluster-checkbox-math/);
	assert.match(html, /data-testid="chain-grouping-projects"[^>]*aria-pressed="true"/);
});

it("subprojects are nested under the parent and hidden when its branch is collapsed", () => {
	assert.doesNotMatch(render({ expandedClusters: new Set() }), /cluster-group-dl/);
	const html = render();
	assert.match(html, /data-testid="cluster-group-dl"[^>]*margin-left:36px/);
	assert.match(html, /Глубокое обучение/); assert.match(html, /chain-row-network/);
	assert.ok(html.indexOf("cluster-group-ml") < html.indexOf("cluster-group-dl"));
});

it("search opens the path to matched knowledge and accepts project names", () => {
	for (const query of ["network", "Глубокое обучение", "Машинное обучение"]) {
		const html = render({ query, expandedClusters: new Set() });
		assert.match(html, /cluster-group-ml/); assert.match(html, /cluster-group-dl/); assert.match(html, /chain-row-network/);
		assert.doesNotMatch(html, /cluster-group-math/);
	}
});

it("a project-scoped view retains shared knowledge and excludes unrelated project headings", () => {
	const shared = node("shared", "dl", "neural"); shared.provenance.push({ chatId: "colloquium", messageId: "m" });
	const html = render({ nodes: [...nodes.slice(0, 2), shared], projectId: "math" });
	assert.match(html, /chain-row-shared/); assert.doesNotMatch(html, /cluster-group-(?:ml|dl)/);
});

it("practice can select a whole project including its descendants without double-counting a shared idea", () => {
	const parentShared = node("network", "dl", "neural"); parentShared.provenance.push({ chatId: "parent-notes", messageId: "m" });
	const html = render({ projects: { ...projects, assignments: { ...projects.assignments, "parent-notes": "ml" } }, nodes: [parentShared], selectMode: true, selection: new Set(["network"]) });
	assert.match(html, /data-testid="cluster-checkbox-ml"[^>]*checked/);
	assert.match(html, /data-testid="cluster-checkbox-dl"[^>]*checked/);
	assert.equal((html.match(/data-testid="chain-row-network"/g) ?? []).length, 1);
});

it("source mode keeps original source names and separates the two inputs independently of their shared project", () => {
	const html = render({ grouping: "sources", expandedClusters: new Set(["notes", "colloquium", "neural"]) });
	assert.match(html, /cluster-group-notes/); assert.match(html, /cluster-group-colloquium/);
	assert.match(html, /Колок по матану/); assert.match(html, /Нейронные сети и grokking/);
	assert.doesNotMatch(html, /cluster-group-math/);
});

it("knowledge without a surviving project is visible in the unassigned pool", () => {
	const html = render({ nodes: [node("orphan", "gone", "unknown")], expandedClusters: new Set(["prj_unassigned"]) });
	assert.match(html, /Без проекта/); assert.match(html, /chain-row-orphan/);
});

it("a premise in another subject's chain remains discoverable in its own project without inflating the other project's selection", () => {
	const html = render({ nodes: [nodes[0]!, nodes[2]!], chains: [{ id: "cross", premises: ["derivative"], conclusion: "network", provenance: [], createdAt: "2026-11-01" }], selectMode: true, selection: new Set(["network"]) });
	assert.match(html, /chain-row-derivative/);
	assert.match(html, /chain-row-cross/);
	assert.match(html, /data-testid="cluster-checkbox-dl"[^>]*checked/);
});
