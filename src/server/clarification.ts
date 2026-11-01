import { randomUUID } from "node:crypto";
import { normalizeContext } from "@earendil-works/pi-ai";
import { piEngineForSpec, type PiEngine } from "../agent/models.ts";
import { isSubscriptionProvider } from "../agent/subscription-connections.ts";
import { CLARIFICATION_PROMPT, clarificationMessages, parseClarificationInput, ClarificationInputError, type ClarificationEvent } from "../core/clarification.ts";
import { resolveConversationSpec } from "../core/settings-resolution.ts";
import { effectiveSettings, stores } from "./stores.ts";
import { providerKeyPresent } from "./keys.ts";
import { refreshConnectionCatalog } from "./model-catalog.ts";
import { CustomBodyLimitError, readBoundedJson } from "./custom-provider-body.ts";

// Independent from the lesson's turn registry: clarification never owns its dock.
const running = new Set<string>();

export async function handleClarification(req: Request, chatId: string, testEngine?: PiEngine): Promise<Response> {
	const record = stores.chatStore.getChat(chatId);
	if (!record) return Response.json({ error: "Занятие не найдено." }, { status: 404 });
	let messages;
	try {
		messages = clarificationMessages(record, parseClarificationInput(await readBoundedJson(req, 200_000)));
	} catch (err) {
		if (err instanceof ClarificationInputError || err instanceof CustomBodyLimitError || err instanceof SyntaxError) {
			return Response.json({ error: err instanceof ClarificationInputError ? err.message : "Не удалось прочитать вопрос: неверный формат или слишком большой объём." }, { status: 400 });
		}
		throw err;
	}
	let engine = testEngine;
	if (!engine) {
		const spec = resolveConversationSpec(record.settings, effectiveSettings().models.strong);
		if (!spec) return Response.json({ error: "Сначала выбери модель в настройках." }, { status: 503 });
		try {
			if (isSubscriptionProvider(spec.provider)) await refreshConnectionCatalog(spec.provider);
			if (!providerKeyPresent(spec.provider)) return Response.json({ error: "Подключение к модели недоступно. Проверь Providers в настройках." }, { status: 503 });
			// The learner explicitly asks for this operation. Same account/model and
			// Fast preference as the lesson; only this call uses lower reasoning.
			engine = piEngineForSpec({ ...spec, thinkingLevel: "low" }, false);
		} catch {
			return Response.json({ error: "Не удалось подключить выбранную модель. Проверь Providers в настройках." }, { status: 503 });
		}
	}
	if (running.has(chatId)) return Response.json({ error: "Уточнение ещё выполняется. Дождись ответа или останови его." }, { status: 409 });
	if (req.signal.aborted) return new Response(null, { status: 499 });
	running.add(chatId);
	const abort = new AbortController();
	const signal = AbortSignal.any([req.signal, abort.signal, AbortSignal.timeout(120_000)]);
	const encoder = new TextEncoder();
	const selected = engine;
	let cancelled = false;
	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			const emit = (event: ClarificationEvent) => { if (!cancelled) controller.enqueue(encoder.encode(JSON.stringify(event) + "\n")); };
			try {
				const stream = selected.streamFn(selected.model, normalizeContext({ systemPrompt: CLARIFICATION_PROMPT, messages, tools: [] }), {
					signal, sessionId: `clarify-${randomUUID()}`, maxTokens: 2400,
				});
				for await (const event of stream) {
					signal.throwIfAborted();
					if (event.type === "text_delta") emit({ type: "text", text: event.delta });
					if (event.type === "error") throw new Error("provider error");
					if (event.type === "done") {
						const text = event.message.content.filter((b) => b.type === "text").map((b) => b.text).join("\n\n");
						if (event.message.stopReason !== "stop" || !text.trim()) throw new Error("incomplete answer");
						emit({ type: "done", text });
						return;
					}
				}
				throw new Error("incomplete stream");
			} catch {
				emit({ type: "error", error: signal.aborted ? "Ответ остановлен. Можно отправить вопрос ещё раз." : "Не удалось завершить ответ. Проверь подключение и лимиты модели, затем повтори вопрос." });
			} finally {
				running.delete(chatId);
				if (!cancelled) controller.close();
			}
		},
		cancel() { cancelled = true; abort.abort(); },
	});
	return new Response(body, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
}
