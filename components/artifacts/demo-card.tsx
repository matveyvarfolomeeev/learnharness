"use client";

import { useContext, useState } from "react";
import { useDemoWorkspace } from "@/components/demo-workspace";
import { DownloadIcon } from "lucide-react";
import { Toggle } from "@/components/settings/controls";
import { InvertDiscIcon } from "@/components/artifacts/invert-disc";
import { ChatActionsContext } from "@/components/chat";
import { downloadFile, slugFilename } from "@/components/artifacts/download";
import { DispatchCard } from "@/components/artifacts/dispatch-card";
import { JobsContext } from "@/components/jobs-context";
import { DemoDeliveryContext, demoFromJob } from "./demo-delivery";
import type { ArtifactPartProps, DemoResult, DemoToolInput } from "@/src/core";
import { isModelsRefusal, isProviderKeyRefusal } from "@/src/core";

/**
 * Completed demos stay as compact launch cards. DemoWorkspace owns the one
 * sandboxed iframe and preserves its state while the presentation changes.
 * Keep the legacy bridge reducer exported for compatibility with consumers.
 */

// ─── bridge injection + message handling (pure, testable) ───────────────────

export { buildDemoSrcDoc, DEMO_BRIDGE_SCRIPT } from "@/src/core";

export interface DemoBridgeState {
	height: number | null;
	error: string | null;
}

export const INITIAL_DEMO_BRIDGE_STATE: DemoBridgeState = { height: null, error: null };

const MIN_HEIGHT = 80;
const MAX_HEIGHT = 2400;

/** Pure reducer over incoming postMessage data (contracts.ts DemoBridgeMessage). */
export function reduceDemoBridgeState(state: DemoBridgeState, data: unknown): DemoBridgeState {
	if (typeof data !== "object" || data === null) return state;
	const message = data as { type?: unknown; height?: unknown; message?: unknown };
	if (message.type === "demo-resize") {
		if (typeof message.height !== "number" || !Number.isFinite(message.height) || message.height <= 0) return state;
		const height = Math.min(Math.max(Math.round(message.height), MIN_HEIGHT), MAX_HEIGHT);
		return height === state.height ? state : { ...state, height };
	}
	if (message.type === "demo-error") {
		const text = typeof message.message === "string" && message.message.trim() ? message.message : "unknown error";
		return text === state.error ? state : { ...state, error: text };
	}
	return state;
}

// ─── the demo card ──────────────────────────────────────────────────────────

/** The original dispatch owns the card, even before the teacher consumes the result. */
export function DemoCard({ part }: ArtifactPartProps) {
	const jobs = useContext(JobsContext), delivery = useContext(DemoDeliveryContext);
	const job = jobs.find((j) => j.kind === "demo" && j.toolCallId === part.toolCallId);
	const artifact = delivery.artifacts.get(part.toolCallId) ?? demoFromJob(job);
	if (part.state !== "output-available") return null;
	if (isModelsRefusal(job?.error) || isProviderKeyRefusal(job?.error)) return <DispatchCard toolCallId={part.toolCallId} kind="demo" />;
	const input = part.input as Partial<DemoToolInput> | undefined;
	if (artifact) return <DemoOutputCard output={artifact.data.result} messageId={artifact.messageId}
		initialInverted={artifact.data.ui?.inverted ?? false} description={input?.description} />;
	return <div className="space-y-2" data-testid="demo-pending">
		{typeof input?.title === "string" && <p className="text-sm font-medium">{input.title}</p>}
		{typeof input?.description === "string" && <p className="text-sm text-muted-foreground">{input.description}</p>}
		<DispatchCard toolCallId={part.toolCallId} kind="demo" />
	</div>;
}

/** The demo artifact — exported: the steer card renders the delivered
 *  result. `messageId` + `initialInverted` carry the PERSISTED invert
 *  switch (details.ui.inverted via the artifact-ui route, owner 2026-10-07). */
export function DemoOutputCard({
	output,
	messageId,
	initialInverted = false,
	description,
}: {
	output: unknown;
	messageId?: string;
	initialInverted?: boolean;
	description?: string;
}) {
	const result = output as DemoResult | undefined;
	if (!result || typeof result.html !== "string" || typeof result.title !== "string") {
		return (
			<div className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
				Demo completed, but the result could not be displayed.
			</div>
		);
	}
	const failed = result.html.length === 0;
	if (failed) {
		return (
			<div className="rounded-xl border bg-card p-4 text-card-foreground" data-testid="demo-card-failed">
				<div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
					Interactive demo
					<span className="rounded bg-red-500/15 px-1.5 py-0.5 text-red-500">failed</span>
				</div>
				<p className="mt-2 text-sm text-muted-foreground">{result.notes ?? "The demo could not be built."}</p>
			</div>
		);
	}
	return (
		<DemoFrame title={result.title} html={result.html} description={result.description || description || result.notes}
			messageId={messageId} initialInverted={initialInverted} />
	);
}

function DemoFrame({ title, html, description, messageId, initialInverted = false }: {
	title: string; html: string; description?: string; messageId?: string; initialInverted?: boolean;
}) {
	const actions = useContext(ChatActionsContext), workspace = useDemoWorkspace();
	// Until the learner acts, follow persisted state arriving from the jobs feed.
	const [localInverted, setLocalInverted] = useState<boolean>();
	const selected = workspace?.selected?.html === html && workspace.selected.messageId === messageId;
	const inverted = selected ? workspace!.selected!.inverted : localInverted ?? initialInverted;
	const toggleInverted = (next: boolean) => {
		setLocalInverted(next);
		if (selected) { workspace!.setInverted(next); return; }
		if (actions?.chatId && messageId) void fetch(`/api/chats/${actions.chatId}/artifact-ui`, {
			method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input: { messageId, inverted: next } }),
		}).catch(() => {});
	};
	return <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-card px-4 py-3 text-card-foreground" data-testid="demo-card">
		<div className="min-w-0 flex-1">
			<span role="status" className="block text-[11px] uppercase tracking-wide text-muted-foreground">Interactive demo · Готова</span>
			<span className="block truncate text-sm font-medium" title={title}>{title}</span>
			{description && <p className="mt-1 line-clamp-3 break-words text-sm text-muted-foreground" title={description} data-testid="demo-description">{description}</p>}
		</div>
		<Toggle checked={inverted} onChange={toggleInverted} label="Invert demo brightness" title="Invert colors" discIcon={<InvertDiscIcon className="size-3" />} />
		<button type="button" aria-label="Download demo as HTML" title="Download as HTML" onClick={() => downloadFile(`${slugFilename(title)}.html`, html, "text/html")}
			data-testid="demo-download" className="rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-foreground"><DownloadIcon className="size-3.5" /></button>
		<button type="button" disabled={!workspace} data-testid="demo-open" aria-label={`Открыть: ${title}`}
			className="rounded-md border border-border px-3 py-2 text-sm hover:bg-accent disabled:opacity-40"
			onClick={(e) => workspace?.show({ title, html, messageId, inverted, onInvertedChange: setLocalInverted,
				onSendError: actions ? (message) => actions.sendText(`The demo "${title}" threw an error: ${message}`) : undefined,
			}, e.currentTarget)}>Открыть</button>
	</div>;
}

export function DemoErrorChip({
	title,
	message,
	onSend,
}: {
	title: string;
	message: string;
	onSend?: () => void;
}) {
	return (
		<div
			className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-500"
			data-testid="demo-error-chip"
		>
			<span className="font-medium">This demo threw an error</span>
			<span className="min-w-0 flex-1 truncate font-mono text-xs" title={message}>
				{message}
			</span>
			{onSend && (
				<button
					type="button"
					onClick={onSend}
					className="rounded-md border border-red-500/40 px-2 py-1 text-xs font-medium hover:bg-red-500/15"
					data-testid="demo-error-send"
				>
					Send to teacher
				</button>
			)}
		</div>
	);
}
