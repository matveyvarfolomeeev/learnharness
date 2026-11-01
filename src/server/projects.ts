import { stores } from "./stores.ts";
import { getGraph } from "../core/graph.ts";
import { inProjects, projectIds, projectOf, UNASSIGNED_PROJECT, validateProject } from "../core/projects.ts";
import { emit } from "../core/events.ts";
import { extractionStatuses } from "../agent/subagents/extraction.ts";

export function projectsView() {
	const catalog = stores.projectStore.read();
	const nodes = getGraph(stores.graphStore).nodes;
	return { ...catalog, counts: Object.fromEntries(catalog.projects.map((p) => {
		const scope = projectIds(catalog, p.id);
		return [p.id, nodes.filter((n) => inProjects(n, scope, catalog)).length];
	})) };
}

/** Synchronous read-modify-write; chat transcripts and settings are never rewritten. */
export function assignProject(sourceId: string, projectId: string) {
	const catalog = stores.projectStore.read();
	if (projectId === UNASSIGNED_PROJECT && !catalog.projects.some((p) => p.id === projectId)) catalog.projects.push({ id: projectId, name: "Без проекта", createdAt: new Date().toISOString() });
	if (!catalog.projects.some((p) => p.id === projectId)) throw new Error("Проект не найден");
	if (!stores.chatStore.getChat(sourceId) && !stores.graphStore.readSources().some((s) => s.id === sourceId)) throw new Error("Источник не найден");
	const lines = stores.graphStore.readNodes();
	const born = new Set<string>();
	const seen = new Set<string>();
	for (const node of lines) {
		if (seen.has(node.id)) continue;
		seen.add(node.id);
		if (node.provenance[0]?.chatId === sourceId) born.add(node.id);
	}
	if (born.size) stores.graphStore.rewriteLedgers({ nodes: lines.map((n) => born.has(n.id) ? { ...n, subjectId: projectId } : n) });
	catalog.assignments[sourceId] = projectId;
	stores.projectStore.write(catalog);
	emit("activity-changed", {});
	emit("chats-changed", {});
}

export function updateProjects(body: Record<string, unknown>): { status: number; error?: string; id?: string } {
	const catalog = stores.projectStore.read();
	if (body.action === "delete") {
		const ids = body.ids ?? [body.id];
		if (!Array.isArray(ids) || !ids.length || ids.some((id) => typeof id !== "string" || !id) || typeof body.targetId !== "string" || !body.targetId) return { status: 400, error: "Выбери проекты и место для переноса знаний" };
		const removing = new Set<string>(ids);
		if (removing.has(UNASSIGNED_PROJECT)) return { status: 400, error: "Раздел «Без проекта» нельзя удалить" };
		if ([...removing].some((id) => !catalog.projects.some((p) => p.id === id))) return { status: 404, error: "Проект уже удалён или не найден" };
		if ([...removing].some((id) => projectIds(catalog, id).has(body.targetId as string))) return { status: 400, error: "Нельзя перенести проект в себя или свой подраздел" };
		if (body.targetId !== UNASSIGNED_PROJECT && !catalog.projects.some((p) => p.id === body.targetId)) return { status: 400, error: "Проект для переноса не найден" };
		if (extractionStatuses().length) return { status: 409, error: "Дождись завершения экстракции, затем удали проект" };
		const targetId = body.targetId;
		const next = structuredClone(catalog);
		if (targetId === UNASSIGNED_PROJECT && !next.projects.some((p) => p.id === targetId)) next.projects.push({ id: targetId, name: "Без проекта", createdAt: new Date().toISOString() });
		next.projects = next.projects.filter((p) => !removing.has(p.id)).map((p) => {
			if (!p.parentId || !removing.has(p.parentId)) return p;
			const child = { ...p }; delete child.parentId;
			return targetId === UNASSIGNED_PROJECT ? child : { ...child, parentId: targetId };
		});
		for (const child of next.projects.filter((p) => removing.has(catalog.projects.find((prior) => prior.id === p.id)?.parentId ?? ""))) {
			const error = validateProject(next, child);
			if (error) return { status: 400, error: `Не удалось перенести подраздел «${child.name}»: ${error}` };
		}
		for (const [sourceId, projectId] of Object.entries(next.assignments)) if (removing.has(projectId)) next.assignments[sourceId] = targetId;
		const lines = stores.graphStore.readNodes();
		const moving = new Set(getGraph(stores.graphStore).nodes.filter((node) => removing.has(projectOf(node, catalog))).map((node) => node.id));
		const movedLines = lines.map((node) => moving.has(node.id) || removing.has(node.subjectId ?? "") ? { ...node, subjectId: targetId } : node);
		const changed = movedLines.some((node, index) => node !== lines[index]);
		// Only subjectId changes. Keep every ledger line, ID and provenance point;
		// chains, mastery, coverage, source records and transcripts stay untouched.
		if (changed) stores.graphStore.rewriteLedgers({ nodes: movedLines });
		try { stores.projectStore.write(next); }
		catch (error) {
			// A failed catalog save must not leave a half-completed move.
			if (changed) stores.graphStore.rewriteLedgers({ nodes: lines });
			throw error;
		}
		emit("activity-changed", {});
		emit("chats-changed", {});
		return { status: 200, id: targetId };
	} else if (body.action === "auto") {
		if (typeof body.enabled !== "boolean") return { status: 400, error: "Нужен переключатель true/false" };
		catalog.autoDetect = body.enabled;
		stores.projectStore.write(catalog);
	} else if (body.action === "assign") {
		if (typeof body.sourceId !== "string" || typeof body.projectId !== "string") return { status: 400, error: "Укажите источник и проект" };
		if (extractionStatuses().length) return { status: 409, error: "Дождись завершения экстракции, затем перенеси занятие" };
		try { assignProject(body.sourceId, body.projectId); } catch (e) { return { status: 400, error: (e as Error).message }; }
	} else if (body.action === "save") {
		if (typeof body.name !== "string" || (body.parentId !== undefined && typeof body.parentId !== "string") || (body.id !== undefined && typeof body.id !== "string")) return { status: 400, error: "Неверные поля проекта" };
		const prior = catalog.projects.find((p) => p.id === body.id);
		if (body.id && !prior) return { status: 404, error: "Проект не найден" };
		const project = { id: prior?.id ?? `prj_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`, name: body.name.trim(), ...(body.parentId ? { parentId: body.parentId as string } : {}), createdAt: prior?.createdAt ?? new Date().toISOString() };
		const error = validateProject(catalog, project);
		if (error) return { status: 400, error };
		catalog.projects = [...catalog.projects.filter((p) => p.id !== project.id), project];
		stores.projectStore.write(catalog);
		emit("activity-changed", {});
		return { status: 200, id: project.id };
	} else return { status: 400, error: "Неизвестное действие" };
	return { status: 200 };
}
