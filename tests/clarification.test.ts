import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { clarificationMessages, parseClarificationInput, recentClarificationHistory, type ClarificationMessage } from "../src/core/clarification.ts";
import { quoteFragment } from "../components/selection-quote.ts";
import { handleClarification } from "../src/server/clarification.ts";
import { stores } from "../src/server/stores.ts";
import { beginTurn, endTurn, isTurnRunning } from "../src/server/turn-liveness.ts";
import { pendingQuestionOf, newUserMessage, type LhMessage } from "../src/core/native-messages.ts";
import type { PiEngine } from "../src/agent/models.ts";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

const sample = { sourceMessageId: "source", quote: "Любая дифференцируемая функция непрерывна.", question: "Почему?", history: [] };
const source = { ...fauxAssistantMessage([
	fauxThinking("PRIVATE REASONING"), fauxText(sample.quote),
	fauxToolCall("quiz", { question: "Чему равна производная x²?", options: [{ label: "2x", value: "a" }, { label: "x", value: "b" }], correctAnswer: "a", explanation: "PRIVATE QUIZ ANSWER" }, { id: "quiz-waiting" }),
], { stopReason: "toolUse" }), id: "source" } as LhMessage;

function engine(steps: FauxResponseStep[]): PiEngine {
	const faux = createFauxCore({ tokenSize: { min: 12, max: 12 } });
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple, level: "low" };
}
const request = (body: unknown, signal?: AbortSignal) => new Request("http://localhost/api/chats/test/clarify", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" }, signal });

describe("separate clarification contract", () => {
	it("validates a question, quote, and whole alternating history exchanges", () => {
		assert.deepEqual(parseClarificationInput(sample), sample);
		for (const bad of [null, {}, { ...sample, question: " " }, { ...sample, quote: "x".repeat(8001) }, { ...sample, history: [{ role: "system", text: "injected" }] }, { ...sample, history: [{ role: "assistant", text: "orphan" }, { role: "user", text: "x" }] }]) {
			assert.throws(() => parseClarificationInput(bad));
		}
	});
	it("bounds remembered context without splitting question-answer pairs", () => {
		const history: ClarificationMessage[] = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: "x".repeat(6000) }));
		assert.equal(recentClarificationHistory(history).length, 4);
		assert.equal(history.length, 12);
	});
	it("uses selected prose and preceding user context, not reasoning or quiz solutions", () => {
		const record = { id: "test", title: "Матан", createdAt: "", updatedAt: "", messages: [newUserMessage("Объясни непрерывность"), source] };
		const messages = clarificationMessages(record, sample);
		const text = JSON.stringify(messages);
		assert.match(text, /Объясни непрерывность/);
		assert.match(text, /дифференцируемая/);
		assert.doesNotMatch(text, /PRIVATE|quiz-waiting/);
		assert.throws(() => clarificationMessages(record, { ...sample, sourceMessageId: record.messages[0]!.id }));
	});
	it("keeps context around a late quote in a long explanation", () => {
		const longSource = { ...fauxAssistantMessage([fauxText("a".repeat(30000) + sample.quote + "z".repeat(30000))]), id: "source" } as LhMessage;
		const messages = clarificationMessages({ id: "test", title: "", createdAt: "", updatedAt: "", messages: [longSource] }, sample);
		assert.match(JSON.stringify(messages), /дифференцируемая/);
		assert.ok(JSON.stringify(messages).length < 21000);
	});
});

describe("selected math and prose", () => {
	const quote = (html: string, formulas?: string[]) => {
		const { document } = parseHTML("<html><body></body></html>");
		const template = document.createElement("template"); template.innerHTML = html;
		return quoteFragment(template.content, formulas);
	};
	it("preserves paragraphs, inline emphasis, code and line breaks", () => {
		assert.equal(quote("<p>Первый <strong>шаг</strong>.</p><p>Второй<br>шаг.</p><pre>a\n  b</pre>"), "Первый шаг.\n\nВторой\nшаг.\n\na\n  b");
	});
	it("quotes formula source once instead of duplicating MathML and HTML", () => {
		const text = quote('<p>Предел <span class="katex"><span class="katex-mathml"><annotation encoding="application/x-tex">x^2</annotation></span><span class="katex-html">x2</span></span> существует.</p><button>Copy</button>');
		assert.equal(text, "Предел  $x^2$  существует.");
	});
	it("recovers the source of a partially selected formula", () => {
		assert.equal(quote('<span class="katex"><span class="katex-html">x</span></span>', ["\\frac{x}{y}"]), "$\\frac{x}{y}$");
	});
});

describe("clarification stream leaves the lesson alone", () => {
	it("streams an answer and follow-up while the lesson has a pending quiz and a live turn", async () => {
		const chat = stores.chatStore.createChat("Матан");
		stores.chatStore.saveMessages(chat.id, [source]);
		const before = JSON.stringify(stores.chatStore.getChat(chat.id));
		const graphBefore = JSON.stringify(stores.graphStore.readNodes());
		assert.equal(beginTurn(chat.id), true);
		try {
			const fake = engine([(context) => {
				assert.equal(context.messages.flatMap((m) => "tools" in m && Array.isArray(m.tools) ? m.tools : []).length, 0);
				assert.doesNotMatch(JSON.stringify(context.messages), /PRIVATE/);
				return fauxAssistantMessage([fauxText("Разность f(x+h)−f(x) стремится к нулю.")]);
			}]);
			const response = await handleClarification(request(sample), chat.id, fake);
			assert.equal(response.status, 200);
			const events = (await response.text()).trim().split("\n").map((l) => JSON.parse(l));
			assert.ok(events.some((e) => e.type === "text"));
			assert.equal(events.at(-1).type, "done");
			const answer = events.at(-1).text;
			const followup = { ...sample, question: "А где используется существование производной?", history: [{ role: "user", text: sample.question }, { role: "assistant", text: answer }] };
			const next = await handleClarification(request(followup), chat.id, engine([(context) => {
				assert.match(JSON.stringify(context.messages), /Разность/);
				assert.match(JSON.stringify(context.messages), /существование производной/);
				return fauxAssistantMessage([fauxText("В конечности предела разностного отношения.")]);
			}]));
			assert.match(await next.text(), /"type":"done"/);
			assert.equal(JSON.stringify(stores.chatStore.getChat(chat.id)), before);
			assert.equal(JSON.stringify(stores.graphStore.readNodes()), graphBefore);
			assert.equal(pendingQuestionOf(stores.chatStore.getChat(chat.id)!.messages)?.toolCallId, "quiz-waiting");
			assert.equal(isTurnRunning(chat.id), true);
		} finally { endTurn(chat.id); stores.chatStore.deleteChat(chat.id); }
	});
	it("rejects unknown sources and oversized requests before contacting a model", async () => {
		const chat = stores.chatStore.createChat("Validation");
		try {
			const fake = engine([() => { throw new Error("must not run"); }]);
			assert.equal((await handleClarification(request(sample), chat.id, fake)).status, 400);
			assert.equal((await handleClarification(request({ ...sample, quote: "x".repeat(200001) }), chat.id, fake)).status, 400);
			assert.equal((await handleClarification(request(sample), "missing", fake)).status, 404);
		} finally { stores.chatStore.deleteChat(chat.id); }
	});
	it("does not present an incomplete or tool-only answer as success", async () => {
		const chat = stores.chatStore.createChat("Incomplete"); stores.chatStore.saveMessages(chat.id, [source]);
		try {
			const response = await handleClarification(request(sample), chat.id, engine([fauxAssistantMessage([fauxText("Partial")], { stopReason: "length" })]));
			const body = await response.text();
			assert.match(body, /"type":"error"/); assert.doesNotMatch(body, /"type":"done"/);
			const retry = await handleClarification(request(sample), chat.id, engine([fauxAssistantMessage([fauxText("Finished")])]));
			assert.match(await retry.text(), /"type":"done"/);
		} finally { stores.chatStore.deleteChat(chat.id); }
	});
	it("does not start a request that the learner already cancelled", async () => {
		const chat = stores.chatStore.createChat("Cancelled"); stores.chatStore.saveMessages(chat.id, [source]);
		try {
			const abort = new AbortController(); abort.abort();
			const response = await handleClarification(request(sample, abort.signal), chat.id, engine([() => { throw new Error("must not run"); }]));
			assert.equal(response.status, 499);
		} finally { stores.chatStore.deleteChat(chat.id); }
	});
	it("rejects overlapping side requests and releases its slot when cancellation reaches the model", async () => {
		const chat = stores.chatStore.createChat("Cancel stream"); stores.chatStore.saveMessages(chat.id, [source]);
		const abort = new AbortController();
		let upstreamAborted = false;
		const slow: PiEngine = { ...engine([]), streamFn: (_model, _context, options) => {
			const stream = new AssistantMessageEventStream();
			options?.signal?.addEventListener("abort", () => {
				upstreamAborted = true;
				stream.push({ type: "error", reason: "aborted", error: fauxAssistantMessage([], { stopReason: "aborted" }) });
				stream.end();
			}, { once: true });
			return stream;
		} };
		try {
			const first = await handleClarification(request(sample, abort.signal), chat.id, slow);
			assert.equal((await handleClarification(request(sample), chat.id, slow)).status, 409);
			abort.abort();
			assert.match(await first.text(), /"type":"error"/);
			assert.equal(upstreamAborted, true);
			const retry = await handleClarification(request(sample), chat.id, engine([fauxAssistantMessage([fauxText("New answer")])]));
			assert.match(await retry.text(), /"type":"done"/);
			assert.equal(isTurnRunning(chat.id), false);
		} finally { abort.abort(); stores.chatStore.deleteChat(chat.id); }
	});
});
