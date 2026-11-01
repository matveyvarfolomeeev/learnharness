"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { MASTERY_LABELS, type MasteryState, type MasterySummary } from "@/src/core";

export function MasteryControl({ nodeId, summary, compact = false }: { nodeId: string; summary?: MasterySummary; compact?: boolean }) {
	const [state, setState] = useState<MasteryState>(summary?.state ?? "unassessed");
	const [busy, setBusy] = useState(false); const [error, setError] = useState("");
	useEffect(() => { setState(summary?.state ?? "unassessed"); }, [nodeId, summary?.state, summary?.at]);
	return <div className={compact ? "min-w-36 text-xs" : "mt-3 space-y-2 border-t border-border pt-3 text-xs"}>
		<label className="flex items-center gap-2"><span className={compact ? "sr-only" : "text-muted-foreground"}>Моё знание</span><select aria-label="Статус знания" disabled={busy} className="min-h-8 min-w-0 flex-1 rounded border border-border bg-background px-1 text-foreground focus-visible:ring-2 focus-visible:ring-ring" value={state} onChange={(event) => {
			const next = event.target.value as MasteryState; setBusy(true); setError("");
			void fetch("/api/graph/mastery", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nodeId, state: next }) }).then(async (r) => { if (!r.ok) throw new Error((await r.json()).error ?? "Не удалось сохранить"); setState(next); window.dispatchEvent(new CustomEvent("lh:graph-revision", { detail: { revision: Date.now() } })); }).catch((e) => setError(e.message)).finally(() => setBusy(false));
		}}>{Object.entries(MASTERY_LABELS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
		{!compact && <>
			<p className="text-muted-foreground">{summary?.origin === "manual" ? "Твоя отметка" : summary?.origin === "checks" ? `${summary.passed} успешных проверок из ${summary.checks}. ${summary.reason ?? ""}` : "Проверок пока нет. Наличие в графе не означает освоение."}</p>
			{summary?.chatId && <Link className="block underline underline-offset-2" href={`/chat/${summary.chatId}`}>Занятие с последней проверкой</Link>}
			<Link className="inline-flex min-h-8 items-center rounded border border-border px-2 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring" href={`/chat/new?mode=practice&node=${encodeURIComponent(nodeId)}`}>Проверить практикой</Link>
		</>}
		{error && <p role="alert" className="text-destructive">{error}</p>}
	</div>;
}
