import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { UNASSIGNED_PROJECT, type ProjectCatalog, type ProjectStore } from "../core/projects.ts";
import { graphStore } from "./graph.ts";
import { chatStore } from "./chats.ts";

export const PROJECTS_FILE = path.join(PATHS.graph, "projects.json");

function initialCatalog(): ProjectCatalog {
	const catalog: ProjectCatalog = { version: 1, autoDetect: true, projects: [], assignments: {} };
	const sources = new Map(graphStore.readSources().map((s) => [s.id, s.filePath]));
	const seen = new Set<string>();
	for (const node of graphStore.readNodes()) {
		if (seen.has(node.id)) continue;
		seen.add(node.id);
		const id = node.subjectId ?? node.provenance[0]?.chatId ?? UNASSIGNED_PROJECT;
		if (!catalog.projects.some((p) => p.id === id)) catalog.projects.push({ id, name: sources.get(id) ?? chatStore.getChat(id)?.title ?? "Без проекта", createdAt: node.createdAt });
		if (!node.subjectId && node.provenance[0]) catalog.assignments[node.provenance[0].chatId] = id;
	}
	return catalog;
}

export const projectStore: ProjectStore = {
	read() {
		let text: string;
		try { text = fs.readFileSync(PROJECTS_FILE, "utf8"); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return initialCatalog(); throw error; }
		const value = JSON.parse(text) as ProjectCatalog;
		if (value.version !== 1 || !Array.isArray(value.projects) || typeof value.assignments !== "object" || value.assignments === null || typeof value.autoDetect !== "boolean") throw new Error("Unsupported project catalog");
		return value;
	},
	write(value) {
		fs.mkdirSync(path.dirname(PROJECTS_FILE), { recursive: true });
		const tmp = `${PROJECTS_FILE}.tmp-${crypto.randomUUID()}`;
		try { fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8"); fs.renameSync(tmp, PROJECTS_FILE); }
		finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
	},
};
