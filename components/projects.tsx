"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { Dialog } from "radix-ui";
import { FolderIcon, PencilIcon, PlusIcon, XIcon } from "lucide-react";
import { useServerEvent, useServerResync } from "./server-events";
import { projectIds, projectPath, UNASSIGNED_PROJECT, type KnowledgeProject, type ProjectCatalog } from "@/src/core";

type ProjectView = ProjectCatalog & { counts: Record<string, number> };
const field = "min-h-9 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring";
const button = "inline-flex min-h-9 items-center justify-center gap-2 rounded-md border border-border px-3 text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

const ProjectsContext = createContext<{ data: ProjectView | null; error: string }>({ data: null, error: "" });

/** One catalog read for the sidebar and all pickers; it survives chat navigation. */
export function ProjectsProvider({ children }: { children: ReactNode }) {
	const [data, setData] = useState<ProjectView | null>(null);
	const [error, setError] = useState("");
	const loading = useRef(false);
	const queued = useRef(false);
	const mounted = useRef(false);
	const refresh = useCallback(async () => {
		if (loading.current) { queued.current = true; return; }
		loading.current = true;
		do {
			queued.current = false;
			try {
				const response = await fetch("/api/projects");
				if (!response.ok) throw new Error("Не удалось загрузить проекты");
				const value = await response.json() as ProjectView;
				if (mounted.current) { setData(value); setError(""); }
			} catch (e) {
				if (mounted.current) setError(e instanceof Error ? e.message : String(e));
			}
			// A mutation during a read needs a fresh read after it, not a parallel stale response.
		} while (queued.current && mounted.current);
		loading.current = false;
	}, []);
	useEffect(() => { mounted.current = true; void refresh(); window.addEventListener("lh:projects-changed", refresh); return () => { mounted.current = false; window.removeEventListener("lh:projects-changed", refresh); }; }, [refresh]);
	useServerEvent("activity-changed", refresh);
	useServerEvent("chats-changed", refresh);
	useServerResync(refresh);
	return <ProjectsContext.Provider value={{ data, error }}>{children}</ProjectsContext.Provider>;
}

export function useProjects() { return useContext(ProjectsContext); }

async function saveProject(body: object) {
	const r = await fetch("/api/projects", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
	const result = await r.json();
	if (!r.ok) throw new Error(result.error ?? "Не удалось сохранить проект");
	window.dispatchEvent(new Event("lh:projects-changed"));
	window.dispatchEvent(new CustomEvent("lh:graph-revision", { detail: { revision: Date.now() } }));
	return result as { id?: string };
}

function options(data: ProjectCatalog, exclude?: string) {
	const hidden = exclude ? projectIds(data, exclude) : new Set<string>();
	return data.projects.filter((p) => !hidden.has(p.id)).map((p) => ({ id: p.id, label: projectPath(data, p.id).map((a) => a.name).join(" / ") })).sort((a, b) => a.label.localeCompare(b.label, "ru"));
}

export function ProjectPicker({ value, onChange, disabled = false }: { value: string; onChange: (id: string) => void; disabled?: boolean }) {
	const { data, error } = useProjects();
	return <label className="lh-no-drag flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
		<FolderIcon className="size-4 shrink-0" aria-hidden />
		<span className="sr-only">Проект занятия</span>
		<select aria-label="Проект занятия" className={`${field} max-w-full truncate text-xs`} value={value} disabled={disabled || !data} onChange={(e) => onChange(e.target.value)}>
			<option value="">{data?.autoDetect ? "Авто: определить при экстракции" : "Без проекта — выбери раздел"}</option>
			{data && options(data).map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
		</select>
		{error && <span role="alert">{error}</span>}
	</label>;
}

export function ChatProjectPicker({ chatId }: { chatId: string }) {
	const { data } = useProjects();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const id = data?.assignments[chatId] ?? "";
	return <div className="lh-no-drag w-48 max-w-[30vw] shrink text-xs">
		<ProjectPicker value={id} disabled={busy} onChange={(projectId) => {
			setBusy(true); setError("");
			void saveProject({ action: "assign", sourceId: chatId, projectId: projectId || UNASSIGNED_PROJECT }).catch((e) => setError(e.message)).finally(() => setBusy(false));
		}} />
		{error && <p role="alert" className="absolute z-50 max-w-sm rounded-md border bg-background p-2 text-destructive">{error}</p>}
	</div>;
}

/** Shared confirmation for sidebar deletion and the table's multi-selection. */
export function DeleteProjectsDialog({ ids, onClose, onDeleted }: { ids: readonly string[]; onClose: () => void; onDeleted: (targetId: string) => void }) {
	const { data } = useProjects();
	const [targetId, setTargetId] = useState(UNASSIGNED_PROJECT);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const hidden = new Set(ids.flatMap((id) => data ? [...projectIds(data, id)] : [id]));
	return <Dialog.Root open onOpenChange={(open) => { if (!open && !busy) onClose(); }}><Dialog.Portal>
		<Dialog.Overlay className="fixed inset-0 z-[100] bg-black/60" />
		<Dialog.Content className="fixed left-1/2 top-1/2 z-[101] max-h-[80vh] w-[min(90vw,28rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border bg-background p-5 text-foreground shadow-xl">
			<Dialog.Title className="pr-8 text-base font-medium">Удалить проекты с переносом знаний</Dialog.Title>
			<Dialog.Description className="mt-2 text-sm text-muted-foreground">Знания, связи, статусы освоения и диалоги сохранятся. Удалятся только перечисленные проекты.</Dialog.Description>
			<Dialog.Close aria-label="Закрыть" disabled={busy} className="absolute right-3 top-3 rounded p-2 hover:bg-accent"><XIcon className="size-4" aria-hidden /></Dialog.Close>
			<form className="mt-5 space-y-4" onSubmit={(event) => {
				event.preventDefault(); if (busy) return; setBusy(true); setError("");
				void saveProject({ action: "delete", ids, targetId }).then(() => {
					onDeleted(targetId);
					const url = new URL(window.location.href);
					if (url.pathname === "/" && ids.includes(url.searchParams.get("project") ?? "")) window.location.assign(`/?project=${encodeURIComponent(targetId)}`);
				}).catch((e) => setError(e.message)).finally(() => setBusy(false));
			}}>
				<ul aria-label="Удаляемые проекты" className="max-h-36 list-disc overflow-y-auto pl-5 text-sm">{ids.map((id) => <li key={id}>{data ? projectPath(data, id).map((p) => p.name).join(" / ") || id : id}</li>)}</ul>
				<label className="block space-y-2 text-sm"><span>Куда перенести знания</span><select autoFocus className={field} value={targetId} disabled={busy} onChange={(e) => setTargetId(e.target.value)}>
					<option value={UNASSIGNED_PROJECT}>Без проекта</option>{data && options(data).filter((p) => p.id !== UNASSIGNED_PROJECT && !hidden.has(p.id)).map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
				</select></label>
				<p className="text-sm text-muted-foreground">{targetId === UNASSIGNED_PROJECT ? "Не выбранные подпроекты сохранятся и станут самостоятельными." : "Не выбранные подпроекты сохранятся внутри выбранного проекта."}</p>
				{error && <p role="alert" className="text-sm text-destructive">{error}</p>}
				<div className="flex flex-wrap justify-end gap-2"><button className={button} type="button" disabled={busy} onClick={onClose}>Отмена</button><button className={`${button} border-destructive/50 text-destructive`} type="submit" disabled={busy || !data || !ids.length || ids.includes(UNASSIGNED_PROJECT)}>{busy ? "Перенос…" : "Перенести и удалить"}</button></div>
			</form>
		</Dialog.Content>
	</Dialog.Portal></Dialog.Root>;
}

export function ProjectSidebar() {
	const { data, error: loadError } = useProjects();
	const [editing, setEditing] = useState<KnowledgeProject | "new" | null>(null);
	const [name, setName] = useState("");
	const [parentId, setParentId] = useState("");
	const [removing, setRemoving] = useState(false);
	const [notice, setNotice] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const open = (p: KnowledgeProject | "new") => { setEditing(p); setName(p === "new" ? "" : p.name); setParentId(p === "new" ? "" : p.parentId ?? ""); setRemoving(false); setNotice(""); setError(""); };
	const row = (p: KnowledgeProject, depth: number) => <div className="flex min-w-0 items-center gap-1" style={{ paddingLeft: Math.min(depth, 5) * 12 }}>
		<Link href={`/?project=${encodeURIComponent(p.id)}`} title={p.name} className="flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded px-2 text-xs hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
			<FolderIcon className="size-3 shrink-0" aria-hidden /><span className="truncate">{p.name}</span><span className="ml-auto text-muted-foreground">{data?.counts[p.id] ?? 0}</span>
		</Link>
		<button type="button" aria-label={`Изменить проект ${p.name}`} title="Название, родительский проект и удаление" onClick={() => open(p)} className="rounded p-2 text-muted-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"><PencilIcon className="size-3" aria-hidden /></button>
	</div>;
	const tree = (parent: string | undefined, depth = 0): React.ReactNode => data?.projects.filter((p) => p.parentId === parent).sort((a, b) => a.name.localeCompare(b.name, "ru")).map((p) => <div key={p.id}>{row(p, depth)}{tree(p.id, depth + 1)}</div>);
	return <section aria-label="Проекты знаний" className="mx-3 mb-3 border-b border-border pb-2">
		<div className="flex items-center justify-between px-2"><Link href="/" className="text-xs uppercase tracking-wider text-muted-foreground hover:text-foreground">Проекты</Link><button type="button" aria-label="Создать проект" title="Создать проект или подраздел" onClick={() => open("new")} className="rounded p-2 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"><PlusIcon className="size-4" aria-hidden /></button></div>
		<label className="mb-2 flex cursor-pointer items-center gap-2 px-2 text-xs text-muted-foreground" title="Новые сессии получают подходящий проект при первой экстракции. Ручной выбор имеет приоритет."><input type="checkbox" role="switch" checked={data?.autoDetect ?? false} disabled={!data || busy} onChange={(e) => { setBusy(true); setError(""); void saveProject({ action: "auto", enabled: e.target.checked }).catch((e) => setError(e.message)).finally(() => setBusy(false)); }} />Автоопределение проекта</label>
		<nav aria-label="Дерево проектов" className="max-h-[32vh] overflow-y-auto">{tree(undefined)}</nav>
		{(loadError || (!editing && error)) && <p role="alert" className="px-2 text-xs text-destructive">{loadError || error}</p>}
		{notice && <p role="status" className="px-2 text-xs text-muted-foreground">{notice}</p>}
		<Dialog.Root open={editing !== null && !removing} onOpenChange={(v) => { if (!v && !busy) setEditing(null); }}><Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-[100] bg-black/60" /><Dialog.Content className="fixed left-1/2 top-1/2 z-[101] max-h-[80vh] w-[min(90vw,28rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border bg-background p-5 text-foreground shadow-xl">
			<Dialog.Title className="pr-8 text-base font-medium">{editing === "new" ? "Новый проект" : "Настройки проекта"}</Dialog.Title><Dialog.Description className="mt-2 text-sm text-muted-foreground">Проект объединяет знания из разных занятий. Родительский проект включает все свои подразделы.</Dialog.Description>
			<Dialog.Close aria-label="Закрыть" disabled={busy} className="absolute right-3 top-3 rounded p-2 hover:bg-accent"><XIcon className="size-4" aria-hidden /></Dialog.Close>
			<form className="mt-5 space-y-4" onSubmit={(event) => {
				event.preventDefault(); if (busy) return; setBusy(true); setError("");
				void saveProject({ action: "save", ...(editing && editing !== "new" ? { id: editing.id } : {}), name, parentId }).then(() => setEditing(null)).catch((e) => setError(e.message)).finally(() => setBusy(false));
			}}><label className="block space-y-2 text-sm"><span>Название</span><input autoFocus required maxLength={100} className={field} value={name} onChange={(e) => setName(e.target.value)} placeholder="Например, рекомендательные системы" /></label>
				<label className="block space-y-2 text-sm"><span>Родительский проект</span><select className={field} value={parentId} onChange={(e) => setParentId(e.target.value)}><option value="">Нет — отдельный предмет</option>{data && options(data, editing && editing !== "new" ? editing.id : undefined).filter((p) => p.id !== UNASSIGNED_PROJECT).map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select></label>
				{error && <p role="alert" className="text-sm text-destructive">{error}</p>}
				<div className="flex flex-wrap justify-end gap-2">{editing && editing !== "new" && editing.id !== UNASSIGNED_PROJECT && <button type="button" className={`${button} mr-auto text-destructive`} disabled={busy} onClick={() => { setRemoving(true); setError(""); }}>Удалить проект…</button>}<Dialog.Close className={button} disabled={busy}>Отмена</Dialog.Close><button className={`${button} bg-accent`} type="submit" disabled={busy || !name.trim()}>{busy ? "Сохранение…" : "Сохранить"}</button></div>
			</form>
		</Dialog.Content></Dialog.Portal></Dialog.Root>
		{removing && editing && editing !== "new" && <DeleteProjectsDialog ids={[editing.id]} onClose={() => setRemoving(false)} onDeleted={() => { setRemoving(false); setEditing(null); setNotice("Проект удалён, знания сохранены."); }} />}
	</section>;
}
