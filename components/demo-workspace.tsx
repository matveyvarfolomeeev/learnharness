"use client";

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { DownloadIcon, SettingsIcon, XIcon } from "lucide-react";
import type { StickToBottomContext } from "use-stick-to-bottom";
import { buildDemoSrcDoc } from "@/src/core";
import { useAppearance } from "./settings/appearance";
import { useSettingsDialog } from "./settings/settings-dialog";
import { Toggle } from "./settings/controls";
import { downloadFile, slugFilename } from "./artifacts/download";

export type OpenDemo = { title: string; html: string; messageId?: string; inverted: boolean; onInvertedChange?: (inverted: boolean) => void; onSendError?: (message: string) => void };
const DemoContext = createContext<{
	show: (demo: OpenDemo, trigger: HTMLElement) => void;
	selected: OpenDemo | null;
	setInverted: (inverted: boolean) => void;
} | null>(null);
export const useDemoWorkspace = () => useContext(DemoContext);

export function demoIsFullscreen(mode: "side" | "fullscreen", width: number): boolean {
	return mode === "fullscreen" || width < 900;
}
export function demoPanelWidth(width: number, ratio: number): number {
	return Math.max(360, Math.min(width - 400, width * ratio));
}

/** One mounted iframe per session, including while closed; changing presentation never changes srcDoc. */
export function DemoWorkspace({ children, chatId, scrollContextRef }: {
	children: ReactNode; chatId: string; scrollContextRef: RefObject<StickToBottomContext | null>;
}) {
	const { appearance } = useAppearance();
	const settings = useSettingsDialog();
	const rootRef = useRef<HTMLDivElement>(null), paneRef = useRef<HTMLElement>(null), frameRef = useRef<HTMLIFrameElement>(null);
	const triggerRef = useRef<HTMLElement | null>(null), closeRef = useRef<HTMLButtonElement>(null);
	const [selected, setSelected] = useState<OpenDemo | null>(null), [open, setOpen] = useState(false);
	const [width, setWidth] = useState(0), [ratio, setRatio] = useState(.5);
	const [error, setError] = useState<string | null>(null), [supportsSteps, setSupportsSteps] = useState<boolean | null>(null);
	const full = demoIsFullscreen(appearance.demoView, width), panelWidth = demoPanelWidth(width, ratio);
	const scrollSnapshot = useRef<{ element: Element | null; offset: number; top: number } | null>(null);
	const captureScroll = useCallback(() => {
		const ctx = scrollContextRef.current, scroller = ctx?.scrollRef.current;
		if (!scroller) return;
		ctx.stopScroll();
		const top = scroller.getBoundingClientRect().top;
		const element = Array.from(scroller.querySelectorAll('[data-session-find-root] > *')).find((el) => el.getBoundingClientRect().bottom > top) ?? null;
		scrollSnapshot.current = { element, offset: (element?.getBoundingClientRect().top ?? top) - top, top: scroller.scrollTop };
	}, [scrollContextRef]);
	const close = useCallback(() => { captureScroll(); setOpen(false); }, [captureScroll]);
	const show = useCallback((demo: OpenDemo, trigger: HTMLElement) => {
		captureScroll(); triggerRef.current = trigger;
		if (selected?.html !== demo.html || selected.messageId !== demo.messageId) {
			setError(null); setSupportsSteps(null); setSelected(demo);
		}
		setOpen(true);
	}, [captureScroll, selected]);
	const setInverted = useCallback((inverted: boolean) => {
		setSelected((current) => current ? { ...current, inverted } : current);
		selected?.onInvertedChange?.(inverted);
		if (selected?.messageId) void fetch(`/api/chats/${chatId}/artifact-ui`, {
			method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input: { messageId: selected.messageId, inverted } }),
		}).catch(() => {});
	}, [chatId, selected?.messageId, selected?.onInvertedChange]);
	const html = selected?.html;
	const srcDoc = useMemo(() => html ? buildDemoSrcDoc(html) : "", [html]);
	useEffect(() => {
		const el = rootRef.current;
		if (!el) return;
		const update = () => setWidth(el.clientWidth);
		update(); const observer = new ResizeObserver(update); observer.observe(el);
		return () => observer.disconnect();
	}, []);
	useLayoutEffect(() => {
		const restore = () => {
			const scroller = scrollContextRef.current?.scrollRef.current, snap = scrollSnapshot.current;
			if (scroller && snap) scroller.scrollTop = snap.element?.isConnected
				? scroller.scrollTop + snap.element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - snap.offset : snap.top;
		};
		restore();
		const raf = requestAnimationFrame(() => { restore(); scrollSnapshot.current = null; });
		if (open) closeRef.current?.focus({ preventScroll: true });
		else triggerRef.current?.focus({ preventScroll: true });
		return () => cancelAnimationFrame(raf);
	}, [open, scrollContextRef]);
	const sendConfig = useCallback(() => frameRef.current?.contentWindow?.postMessage({
		type: "lh-demo-config", steps: appearance.demoSteps, modal: full, visible: open,
	}, "*"), [appearance.demoSteps, full, open]);
	useEffect(sendConfig, [sendConfig]);
	useEffect(() => {
		const listener = (event: MessageEvent) => {
			if (!frameRef.current || event.source !== frameRef.current.contentWindow || !event.data || typeof event.data !== "object") return;
			const data = event.data;
			if (data.type === "demo-ready" && typeof data.supportsSteps === "boolean") { setSupportsSteps(data.supportsSteps); sendConfig(); }
			if (data.type === "demo-error" && typeof data.message === "string") setError(data.message.slice(0, 2000));
			if (data.type === "demo-escape" && open) close();
			if (data.type === "demo-focus-boundary" && open && full) closeRef.current?.focus({ preventScroll: true });
		};
		window.addEventListener("message", listener);
		return () => window.removeEventListener("message", listener);
	}, [sendConfig, open, full, close]);
	useEffect(() => {
		if (!open) return;
		const higherDialog = () => Array.from(document.querySelectorAll('[role="dialog"]')).some((el) => el !== paneRef.current && !paneRef.current?.contains(el) && el.getClientRects().length > 0);
		const onKey = (e: KeyboardEvent) => {
			if (higherDialog()) return;
			if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); close(); }
		};
		const onFocus = (e: FocusEvent) => {
			if (full && !higherDialog() && !paneRef.current?.contains(e.target as Node)) closeRef.current?.focus({ preventScroll: true });
		};
		document.addEventListener("keydown", onKey, true); document.addEventListener("focusin", onFocus);
		return () => { document.removeEventListener("keydown", onKey, true); document.removeEventListener("focusin", onFocus); };
	}, [open, full, close]);
	const drag = useRef(false);
	const [resizing, setResizing] = useState(false);
	const buttonClass = "rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring";
	return <DemoContext.Provider value={{ show, selected, setInverted }}>
		<div ref={rootRef} className="relative flex h-dvh min-w-0" data-testid="demo-workspace" style={resizing ? { cursor: "col-resize", userSelect: "none" } : undefined}>
			{children}
			{selected && <aside ref={paneRef} role={full ? "dialog" : "region"} aria-modal={open && full ? true : undefined} aria-label={selected.title}
				data-testid="demo-viewer" data-view={full ? "fullscreen" : "side"} inert={!open}
				onKeyDown={(e) => e.stopPropagation()}
				className="z-30 flex min-h-0 shrink-0 flex-col border-l border-border bg-background lh-no-drag"
				style={{ display: open ? "flex" : "none", ...(full ? { position: "absolute", inset: "60px 0 0" } : { width: panelWidth, position: "relative" }) }}>
				{!full && <div role="separator" aria-label="Ширина демонстрации" aria-orientation="vertical" aria-valuemin={360} aria-valuemax={Math.max(360, width - 400)} aria-valuenow={Math.round(panelWidth)} tabIndex={0}
					data-testid="demo-resizer" className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize touch-none hover:bg-primary/25 focus-visible:bg-primary/25"
					onPointerDown={(e) => { if (e.button !== 0) return; drag.current = true; setResizing(true); captureScroll(); e.currentTarget.setPointerCapture(e.pointerId); e.preventDefault(); }}
					onPointerMove={(e) => { if (drag.current && rootRef.current) setRatio(demoPanelWidth(width, (rootRef.current.getBoundingClientRect().right - e.clientX) / width) / width); }}
					onPointerUp={() => { drag.current = false; setResizing(false); }} onPointerCancel={() => { drag.current = false; setResizing(false); }}
					onLostPointerCapture={() => { drag.current = false; setResizing(false); }}
					onKeyDown={(e) => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); setRatio(demoPanelWidth(width, ratio + (e.key === "ArrowLeft" ? 32 : -32) / width) / width); } }} />}
				<header className="flex min-h-15 shrink-0 items-center gap-2 border-b border-border px-3">
					<span className="min-w-0 flex-1 truncate font-medium" title={selected.title}>{selected.title}</span>
					<Toggle checked={selected.inverted} label="Invert demo brightness" title="Инверсия цветов" onChange={setInverted} />
					<button className={buttonClass} type="button" aria-label="Скачать демку" onClick={() => downloadFile(`${slugFilename(selected.title)}.html`, selected.html, "text/html")}><DownloadIcon className="size-4" /></button>
					<button className={buttonClass} type="button" aria-label="Настройки демонстраций" onClick={() => settings.open("appearance")}><SettingsIcon className="size-4" /></button>
					<button ref={closeRef} className={buttonClass} type="button" aria-label="Закрыть демонстрацию" onClick={close}><XIcon className="size-5" /></button>
				</header>
				{supportsSteps === false && appearance.demoSteps && <p className="px-3 py-1 text-xs text-muted-foreground">Эта демка открыта в исходном виде — шаги доступны для новых демок.</p>}
				{error && <div role="alert" className="max-h-24 overflow-auto px-3 py-2 text-sm text-destructive">Ошибка демонстрации: {error}
					{selected.onSendError && <button type="button" className="ml-2 underline" onClick={() => selected.onSendError?.(error)}>Отправить преподавателю</button>}
				</div>}
				<iframe key={selected.messageId ?? selected.html} ref={frameRef} title={selected.title} sandbox="allow-scripts" srcDoc={srcDoc}
					onLoad={sendConfig} className="min-h-0 w-full flex-1 border-0 bg-white" data-testid="demo-iframe"
					style={{ filter: selected.inverted ? "invert(1) hue-rotate(180deg)" : undefined, pointerEvents: resizing ? "none" : undefined }} />
			</aside>}
		</div>
	</DemoContext.Provider>;
}
