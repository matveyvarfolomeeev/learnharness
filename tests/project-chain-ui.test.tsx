import React, { act, useState } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { ChainTableOverlay } from "../components/chain-table.tsx";
import { ProjectsProvider } from "../components/projects.tsx";
import { ServerEventsProvider } from "../components/server-events.tsx";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true });
const nativeClick = dom.window.HTMLInputElement.prototype.click;
dom.window.HTMLInputElement.prototype.click = function () { if (this.type === "checkbox") this.checked = !this.checked; nativeClick.call(this); };
const nodes = ["book", "lesson"].map((source) => ({ id: `n_${source}`, name: source, statement: source, aliases: [], subjectId: "book", provenance: [{ chatId: source, messageId: "m" }], createdAt: "2026-11-01" }));
const catalog = { version: 1, autoDetect: true, projects: [{ id: "book", name: "Матан", createdAt: "2026-11-01" }], assignments: { book: "book", lesson: "book" }, counts: { book: 2 } };
const directory = { organization: { version: 1, folders: [], placements: {} }, sources: [{ id: "book", label: "Конспект", kind: "notes", createdAt: "2026-11-01" }, { id: "lesson", label: "Колок", kind: "chat", createdAt: "2026-11-01" }] };
let root: Root | undefined, host: HTMLDivElement | undefined;
const originalFetch = globalThis.fetch;
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; host?.remove(); globalThis.fetch = originalFetch; });
async function mount(practice = false, callbacks: { onPractice?: () => void; onSelection?: (ids: ReadonlySet<string>) => void } = {}) {
	const requests: string[] = [];
	globalThis.fetch = async (url) => {
		requests.push(String(url));
		if (url === "/api/projects") return Response.json(catalog);
		if (url === "/api/graph/sources") return Response.json(directory);
		throw new Error(`Unexpected request: ${url}`);
	};
	function Harness() {
		const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
		return <ServerEventsProvider connect={() => ({ close() {}, onOpen() {}, onEvent() {} })}><ProjectsProvider>
			<ChainTableOverlay open nodes={nodes} chains={[]} sessions={{ lesson: "Колок" }} fileSources={{ book: "Конспект" }} selectMode={practice} controlledSelection={selection} onSelectionChange={(ids) => { setSelection(ids); callbacks.onSelection?.(ids); }} onPractice={callbacks.onPractice} onClose={() => {}} />
		</ProjectsProvider></ServerEventsProvider>;
	}
	host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
	await act(async () => root!.render(<Harness />));
	return requests;
}
async function click(id: string) {
	const element = document.querySelector<HTMLElement>(`[data-testid="${id}"]`); assert.ok(element, id);
	await act(async () => element.click());
}
const has = (id: string) => document.querySelector(`[data-testid="${id}"]`) !== null;
const checkbox = (id: string) => document.querySelector<HTMLInputElement>(`[data-testid="${id}"]`)!;

it("the overlay opens by project and switching preserves each view's expansion even when project/source IDs match", async () => {
	const requests = await mount();
	assert.equal(document.querySelector('[data-testid="chain-grouping-projects"]')?.getAttribute("aria-pressed"), "true");
	assert.deepEqual(requests, ["/api/projects"]);
	await click("cluster-toggle-book"); assert.ok(has("chain-row-n_book")); assert.ok(has("chain-row-n_lesson"));
	await click("chain-grouping-sources");
	assert.ok(has("cluster-group-lesson")); assert.equal(has("chain-row-n_book"), false);
	await click("cluster-toggle-book"); assert.ok(has("chain-row-n_book"));
	await click("cluster-checkbox-book"); assert.ok(has("chain-delete"));
	await click("chain-grouping-projects");
	assert.ok(has("chain-row-n_book")); assert.ok(has("chain-row-n_lesson")); assert.equal(has("chain-delete"), false);
	await click("chain-grouping-sources");
	assert.ok(has("chain-row-n_book")); assert.equal(checkbox("cluster-checkbox-book").checked, false);
});

it("practice picks survive switching and reflect the same underlying node IDs in both views", async () => {
	await mount(true);
	await click("cluster-checkbox-book");
	assert.match(document.querySelector('[data-testid="chain-selected-summary"]')!.textContent!, /2 nodes/);
	await click("chain-grouping-sources");
	assert.equal(checkbox("cluster-checkbox-book").checked, true); assert.equal(checkbox("cluster-checkbox-lesson").checked, true);
	await click("cluster-checkbox-lesson");
	await click("chain-grouping-projects");
	assert.equal(checkbox("cluster-checkbox-book").indeterminate, true);
	assert.match(document.querySelector('[data-testid="chain-selected-summary"]')!.textContent!, /1 node/);
	assert.equal(has("chain-delete"), false);
});

it("ordinary project selection offers both safe project deletion and practice with the complete project knowledge", async () => {
	let started = false, picked: string[] = [];
	const requests = await mount(false, { onPractice: () => { started = true; }, onSelection: (ids) => { picked = [...ids]; } });
	await click("cluster-checkbox-book");
	assert.equal(checkbox("cluster-checkbox-book").checked, true);
	assert.match(document.querySelector('[data-testid="chain-selected-summary"]')!.textContent!, /Проекты: 1 · знания: 2/);
	assert.equal(document.querySelector('[data-testid="chain-delete"]')!.getAttribute("aria-label"), "Удалить выбранные проекты с переносом знаний");
	assert.equal(started, false); assert.deepEqual(picked, []);
	await click("chain-practice-projects");
	assert.equal(started, true); assert.deepEqual(picked.sort(), ["n_book", "n_lesson"]);
	assert.deepEqual(requests, ["/api/projects"], "picking must not create a session, call a model or delete a source");
});

it("ordinary project selection clears explicitly and cannot turn into a same-id source deletion after switching", async () => {
	await mount(); await click("cluster-checkbox-book"); await click("chain-clear");
	assert.equal(checkbox("cluster-checkbox-book").checked, false); assert.equal(has("chain-selection-bar"), false);
	await click("cluster-checkbox-book"); await click("chain-grouping-sources");
	assert.equal(checkbox("cluster-checkbox-book").checked, false); assert.equal(has("chain-selection-bar"), false);
	await click("chain-grouping-projects"); assert.equal(checkbox("cluster-checkbox-book").checked, false);
});
