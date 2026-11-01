"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { CornerDownLeftIcon, MessageCircleQuestionIcon, SquareIcon, XIcon } from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message";
import { MAX_QUOTE_LENGTH, recentClarificationHistory, type ClarificationEvent, type ClarificationMessage } from "@/src/core";
import { selectedPassage, type SelectedPassage } from "./selection-quote";

const ACTION = "rounded-md px-3 py-2 text-sm transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-40";

/** A read-only side conversation. Its state and stream never enter useChatSession,
 * so neither a pending quiz nor the lesson's transcript is replaced. */
export function SelectionClarification({ chatId, scopeRef }: { chatId: string; scopeRef: RefObject<HTMLDivElement | null> }) {
	const [selection, setSelection] = useState<SelectedPassage | null>(null);
	const [passage, setPassage] = useState<SelectedPassage | null>(null);
	const [open, setOpen] = useState(false);
	const [question, setQuestion] = useState("");
	const [history, setHistory] = useState<ClarificationMessage[]>([]);
	const [partial, setPartial] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const controller = useRef<AbortController | null>(null);
	const dialog = useRef<HTMLDialogElement | null>(null);
	const input = useRef<HTMLTextAreaElement | null>(null);
	const toolbar = useRef<HTMLDivElement | null>(null);
	const output = useRef<HTMLDivElement | null>(null);
	const follow = useRef(true);
	const resume = useRef<HTMLButtonElement | null>(null);
	const selectionRef = useRef(selection);
	selectionRef.current = selection;
	const close = useCallback(() => {
		controller.current?.abort();
		setOpen(false);
		setSelection(null);
		requestAnimationFrame(() => resume.current?.focus({ preventScroll: true }));
	}, []);

	useEffect(() => {
		if (open) return;
		let frame = 0;
		const read = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				if (toolbar.current?.contains(document.activeElement)) return;
				setSelection(scopeRef.current ? selectedPassage(scopeRef.current, window.getSelection()) : null);
			});
		};
		const hide = () => setSelection(null);
		const onKeyUp = (event: KeyboardEvent) => { if (event.key !== "Escape" && event.key !== "Tab") read(); };
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape" && selectionRef.current) { event.preventDefault(); event.stopPropagation(); hide(); }
			if (event.key === "Tab" && selectionRef.current && !event.shiftKey && !toolbar.current?.contains(event.target as Node)) {
				event.preventDefault(); event.stopPropagation();
				toolbar.current?.querySelector<HTMLButtonElement>("button")?.focus();
			}
		};
		document.addEventListener("pointerup", read);
		document.addEventListener("keyup", onKeyUp);
		window.addEventListener("scroll", hide, true);
		window.addEventListener("resize", hide);
		document.addEventListener("keydown", onKey, true);
		return () => {
			cancelAnimationFrame(frame);
			document.removeEventListener("pointerup", read);
			document.removeEventListener("keyup", onKeyUp);
			window.removeEventListener("scroll", hide, true);
			window.removeEventListener("resize", hide);
			document.removeEventListener("keydown", onKey, true);
		};
	}, [open, scopeRef]);

	useEffect(() => {
		if (!open) { dialog.current?.close(); return; }
		if (dialog.current && !dialog.current.open) {
			dialog.current.showModal();
			input.current?.focus({ preventScroll: true });
		}
		// Keep the app's global Tab / Escape shortcuts out of the modal,
		// including when disabling the input during a request removes focus.
		const key = (event: KeyboardEvent) => {
			if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); close(); }
			else if (event.key === "Tab") {
				event.stopImmediatePropagation();
				const items = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])') ?? [])].filter((el) => el.getClientRects().length > 0);
				const first = items[0], last = items.at(-1);
				if (!first) { event.preventDefault(); return; }
				if (event.shiftKey && (document.activeElement === first || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
				else if (!event.shiftKey && (document.activeElement === last || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
			}
		};
		document.addEventListener("keydown", key, true);
		return () => document.removeEventListener("keydown", key, true);
	}, [open, close]);
	useEffect(() => () => controller.current?.abort(), []);
	useEffect(() => {
		if (follow.current && output.current) output.current.scrollTop = output.current.scrollHeight;
	}, [partial, history, error]);

	const ask = async (source: SelectedPassage, text: string, previous: ClarificationMessage[]) => {
		if (controller.current || !text.trim()) return;
		const request = new AbortController();
		controller.current = request;
		setBusy(true); setError(""); setPartial(""); follow.current = true;
		try {
			const response = await fetch(`/api/chats/${encodeURIComponent(chatId)}/clarify`, {
				method: "POST", headers: { "Content-Type": "application/json" }, signal: request.signal,
				body: JSON.stringify({ sourceMessageId: source.sourceMessageId, quote: source.quote, question: text, history: recentClarificationHistory(previous) }),
			});
			request.signal.throwIfAborted();
			if (!response.ok) {
				const body = await response.json().catch(() => null);
				throw new Error(typeof body?.error === "string" ? body.error : "Не удалось отправить вопрос.");
			}
			if (!response.body) throw new Error("Ответ не получен.");
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "", completed = false;
			try {
				for (;;) {
					const chunk = await reader.read();
					request.signal.throwIfAborted();
					buffer += decoder.decode(chunk.value, { stream: !chunk.done });
					let end;
					while ((end = buffer.indexOf("\n")) >= 0) {
						const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
						if (!line.trim()) continue;
						const event = JSON.parse(line) as ClarificationEvent;
						if (event.type === "text") setPartial((value) => value + event.text);
						if (event.type === "error") throw new Error(event.error);
						if (event.type === "done") {
							completed = true;
							setHistory([...previous, { role: "user", text }, { role: "assistant", text: event.text }]);
							setQuestion(""); setPartial("");
						}
					}
					if (chunk.done) break;
				}
			} finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
			if (!completed) throw new Error("Соединение прервалось. Можно повторить вопрос.");
		} catch (err) {
			setError(request.signal.aborted ? "Ответ остановлен. Вопрос сохранён — можно повторить." : err instanceof Error ? err.message : "Не удалось получить ответ.");
		} finally {
			if (controller.current === request) controller.current = null;
			setBusy(false);
		}
	};
	const begin = (source: SelectedPassage, explain: boolean) => {
		if (source.quote.length > MAX_QUOTE_LENGTH || controller.current) return;
		const same = passage?.sourceMessageId === source.sourceMessageId && passage.quote === source.quote;
		const previous = same ? history : [];
		setPassage(source); setSelection(null); setOpen(true);
		window.getSelection()?.removeAllRanges();
		if (!same) { setHistory([]); setQuestion(""); setPartial(""); setError(""); }
		if (explain) {
			const text = "Объясни этот фрагмент подробнее и понятнее. Если уместно, приведи короткий пример.";
			setQuestion(text);
			void ask(source, text, previous);
		}
	};

	return <>
		{passage && <button ref={resume} type="button" className={`${ACTION} lh-no-drag flex shrink-0 items-center gap-1.5 text-muted-foreground`} onClick={() => { setOpen(true); setSelection(null); }} aria-label="Вернуться к уточнению">
			<MessageCircleQuestionIcon className="size-4" aria-hidden /> Уточнение
		</button>}
		{selection && !open && createPortal(
			<div ref={toolbar} role="toolbar" aria-label="Действия с выделенным фрагментом" data-testid="selection-actions" className="fixed z-50 flex max-w-[calc(100vw-16px)] flex-wrap items-center rounded-lg border border-border bg-popover p-1 font-ui text-popover-foreground shadow-lg"
				style={{ left: Math.max(8, Math.min(selection.left, window.innerWidth - 340)), top: Math.max(8, Math.min(selection.top - 48, window.innerHeight - 56)) }} onMouseDown={(event) => event.preventDefault()} onKeyDown={(event) => event.stopPropagation()}>
				{selection.quote.length > MAX_QUOTE_LENGTH ? <span className="px-2 py-1 text-xs">Выдели фрагмент короче {MAX_QUOTE_LENGTH} символов</span> : <>
					<button type="button" className={ACTION} onClick={() => begin(selection, false)}>Спросить</button>
					<button type="button" className={ACTION} onClick={() => begin(selection, true)}>Объясни подробнее</button>
				</>}
			</div>, document.body)}
		{passage && createPortal(
			<dialog ref={dialog} role="dialog" aria-labelledby="clarification-title" aria-describedby="clarification-description" data-testid="clarification-dialog"
				className="fixed inset-0 m-auto max-h-[85dvh] w-[min(38rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-border bg-card p-0 text-card-foreground shadow-xl backdrop:bg-black/25"
				onCancel={(event) => { event.preventDefault(); close(); }}
				onClick={(event) => { if (event.target === event.currentTarget) { const r = event.currentTarget.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) close(); } }}
				onKeyDown={(event) => { event.stopPropagation(); if (event.key === "Escape") { event.preventDefault(); close(); } }}>
				<div className="flex max-h-[85dvh] flex-col">
					<header className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-5 py-4">
						<div><h2 id="clarification-title" className="font-ui text-base font-medium">Уточнение по фрагменту</h2>
							<p id="clarification-description" className="mt-1 font-ui text-xs text-muted-foreground">Отдельно от урока · быстрый ответ</p></div>
						<button type="button" className={`${ACTION} -mr-2 -mt-1`} aria-label="Закрыть уточнение" onClick={close}><XIcon className="size-4" aria-hidden /></button>
					</header>
					<blockquote className="mx-5 my-3 max-h-28 shrink-0 overflow-auto whitespace-pre-wrap break-words border-l-2 border-primary/60 pl-3 text-sm text-muted-foreground" data-testid="clarification-quote">{passage.quote}</blockquote>
					<div ref={output} className="min-h-16 flex-1 space-y-4 overflow-y-auto overscroll-contain px-5 pb-4" data-testid="clarification-messages"
						onScroll={(event) => { const el = event.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48; }}>
						{history.map((m, i) => <div key={i} className={m.role === "user" ? "rounded-lg bg-secondary px-3 py-2 font-ui text-sm whitespace-pre-wrap" : "lh-prose text-sm"}>
							{m.role === "assistant" ? <MessageResponse>{m.text}</MessageResponse> : m.text}
						</div>)}
						{partial && <div className="lh-prose text-sm"><MessageResponse>{partial}</MessageResponse></div>}
						{busy && <p role="status" className="font-ui text-xs text-muted-foreground">{partial ? "Продолжает ответ…" : "Готовит пояснение…"}</p>}
						{error && <p role="alert" className="font-ui text-sm text-destructive">{error}</p>}
						{!history.length && !busy && !error && <p className="font-ui text-sm text-muted-foreground">Что разобрать в выделенном фрагменте?</p>}
					</div>
					<form className="shrink-0 border-t border-border p-4" onSubmit={(event) => { event.preventDefault(); void ask(passage, question, history); }}>
						<label htmlFor="clarification-question" className="mb-2 block font-ui text-xs text-muted-foreground">{history.length ? "Уточнить ещё" : "Твой вопрос"}</label>
						<div className="flex items-end gap-2">
							<textarea id="clarification-question" ref={input} value={question} disabled={busy} maxLength={4000} rows={2} placeholder="Например: почему здесь можно сделать такой переход?"
								className="min-h-20 max-h-40 min-w-0 flex-1 resize-y rounded-lg border border-border bg-background px-3 py-2 font-ui text-sm focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-60" onChange={(event) => setQuestion(event.target.value)}
								onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void ask(passage, question, history); } }} />
							{busy ? <button type="button" className={`${ACTION} bg-secondary`} aria-label="Остановить уточнение" onClick={(event) => { event.preventDefault(); controller.current?.abort(); }}><SquareIcon className="size-5" aria-hidden /></button>
								: <button type="submit" className={`${ACTION} bg-primary text-primary-foreground hover:opacity-90 hover:bg-primary`} disabled={!question.trim()} aria-label="Отправить уточнение"><CornerDownLeftIcon className="size-5" aria-hidden /></button>}
						</div>
						<p className="mt-2 font-ui text-xs text-muted-foreground">Enter — отправить · Shift+Enter — новая строка</p>
					</form>
				</div>
			</dialog>, document.body)}
	</>;
}
