import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAssistantMessageEventStream, createFauxCore, fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall, type AssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { PiEngine } from "../src/agent/models.ts";
import { Type } from "typebox";
import { createTeacherAgent } from "../src/agent/teacher-agent.ts";
import { SubscriptionRequestCycle } from "../src/agent/subscription-request-cycle.ts";
import { newUserMessage, newUserSteer, toLlmMessages, type LhMessage } from "../src/core/native-messages.ts";
import { runPiTurn } from "../src/server/pi/ui-stream.ts";
import { persistTurn } from "../src/server/turn-service.ts";
import { registerTurn, unregisterTurn } from "../src/server/turn-runs.ts";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-immediate-steering-"));
process.env.LH_DATA_DIR = path.join(scratch, "data");
process.env.LH_AUTH_FILE = path.join(scratch, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");
const { registerLiveAgent, unregisterLiveAgent, reconcileUserSteers, steerLiveChat } = await import("../src/server/jobs.ts");
const { chatStore } = await import("../src/store/chats.ts");
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(r => { resolve = r; });
	return { promise, resolve };
}
type RequestFixture = { context: TranscriptContext; signal?: AbortSignal; finish: (message?: AssistantMessage) => void };
const scope = { accountId: "fixture", epoch: 1, authorityRevision: 1, selectedModelId: "fixture" };

function lesson(options: { subscription?: boolean; tools?: Record<string, AgentTool>; partial?: AssistantMessage } = {}) {
	const chat = chatStore.createChat("Synthetic immediate steering");
	const initial = [newUserMessage("Explain the idea")];
	chatStore.saveMessages(chat.id, initial);
	const purpose = { background: false };
	const cycle = options.subscription ? new SubscriptionRequestCycle({
		initialMessages: initial, foregroundOwed: true, purpose, scopeCurrent: () => true,
		restoreAutomatic() {},
	}) : undefined;
	const requests: RequestFixture[] = [];
	const started = Array.from({ length: 8 }, () => deferred<RequestFixture>());
	let saves = 0, usageSteps = 0, aborted = false;
	const streamFn: PiEngine["streamFn"] = (_model, context, streamOptions) => {
		const output = createAssistantMessageEventStream();
		let finished = false;
		const partial = structuredClone(options.partial ?? fauxAssistantMessage([fauxText("Visible beginning.")]));
		const signal = streamOptions?.signal;
		const finish = (message = fauxAssistantMessage([fauxText("Updated explanation.")])) => {
			if (finished) return;
			finished = true;
			output.push({ type: "done", reason: "stop", message });
		};
		const cancel = () => {
			if (finished) return;
			finished = true;
			const error = { ...partial, stopReason: "aborted" as const, errorMessage: "fixture cancellation" };
			output.push({ type: "error", reason: "aborted", error });
		};
		if (signal?.aborted) cycle?.noDispatch("all");
		else { cycle?.captured(scope); cycle?.beforeDispatch(scope); }
		output.push({ type: "start", partial });
		const request = { context, signal, finish };
		requests.push(request);
		started[requests.length - 1]!.resolve(request);
		if (signal?.aborted) cancel();
		else signal?.addEventListener("abort", cancel, { once: true });
		return output;
	};
	const agent = createTeacherAgent(undefined, {
		messages: initial, engine: { model: createFauxCore({}).getModel(), streamFn }, tools: options.tools ?? {},
		requestCycle: cycle, callPurpose: purpose, onUsage: () => { usageSteps++; },
	});
	let handle: ReturnType<typeof runPiTurn>;
	let wire: Promise<string>;
	const start = () => {
		registerLiveAgent(chat.id, agent);
		handle = runPiTurn({ agent, requestCycle: cycle, onFinish(messages, wasAborted) {
			saves++; aborted = wasAborted;
			persistTurn(chatStore, chat.id, initial.length, messages, wasAborted);
			unregisterTurn(chat.id); unregisterLiveAgent(chat.id);
			reconcileUserSteers(chat.id, chatStore.getChat(chat.id)!.messages);
		} });
		registerTurn(chat.id, handle);
		wire = new Response(handle.subscribe()).text();
	};
	let sequence = 0;
	const steer = (text: string, id = `steer_fixture_${++sequence}`) => {
		assert.equal(steerLiveChat(chat.id, newUserSteer(text, id)), true);
		return id;
	};
	return { agent, start, steer, requests, request: (index: number) => started[index]!.promise,
		stop: () => handle.abort(), wire: () => wire, saved: () => chatStore.getChat(chat.id)!.messages,
		stats: () => ({ saves, aborted, usageSteps }), replay: () => new Response(handle.subscribe()).text() };
}

for (const subscription of [false, true]) {
	test(`interrupts thinking immediately and saves one continuous response (subscription=${subscription})`, { timeout: 5000 }, async () => {
		const s = lesson({ subscription, partial: fauxAssistantMessage([
			fauxThinking("Incomplete reasoning"), fauxText("Visible beginning."), fauxToolCall("read", { path: "unfinished" }, { id: "partial-tool" }),
		]) });
		s.start();
		const first = await s.request(0);
		const id = s.steer("Use a Python example");
		assert.equal(first.signal?.aborted, true, "does not wait for the original response to finish");
		const next = await s.request(1);
		assert.match(JSON.stringify(next.context), /Use a Python example/);
		assert.match(JSON.stringify(next.context), /Visible beginning/);
		assert.doesNotMatch(JSON.stringify(next.context), /partial-tool|Incomplete reasoning|interruptedBySteer|fixture cancellation/);
		assert.equal(next.signal?.aborted, false);
		next.finish();
		const wire = await s.wire();
		assert.equal(s.stats().saves, 1); assert.equal(s.stats().aborted, false);
		assert.equal(s.saved().filter(m => m.id === id).length, 1);
		assert(s.saved().some(m => m.role === "assistant" && m.stopReason === "aborted" && m.interruptedBySteer));
		assert.equal(wire.match(/data: \[DONE\]/g)?.length, 1);
		assert.equal(wire.match(/"type":"agent_end"/g)?.length, 1);
		assert.doesNotMatch(wire, /fixture cancellation/);
		assert.equal(await s.replay(), wire, "reattachment keeps the same logical turn");
		const replay = toLlmMessages(JSON.parse(JSON.stringify(s.saved())));
		assert.match(JSON.stringify(replay), /Visible beginning/);
		assert.doesNotMatch(JSON.stringify(replay), /partial-tool|Incomplete reasoning|interruptedBySteer/);
	});
}

test("rapid additions are combined once, and an already delivered HTTP id is not requeued", { timeout: 5000 }, async () => {
	const s = lesson(); s.start(); await s.request(0);
	const firstId = s.steer("First clarification");
	const secondId = s.steer("Second clarification");
	s.steer("First clarification", firstId);
	const next = await s.request(1);
	assert.equal(next.context.messages.filter(m => m.role === "user" && m.content === "First clarification").length, 1);
	assert.match(JSON.stringify(next.context), /Second clarification/);
	s.steer("First clarification", firstId);
	assert.equal(next.signal?.aborted, false);
	next.finish(); await s.wire();
	assert.equal(s.requests.length, 2);
	for (const id of [firstId, secondId]) assert.equal(s.saved().filter(m => m.id === id).length, 1);
});

test("Stop wins over an in-flight redirect and does not start a replacement request", { timeout: 5000 }, async () => {
	const s = lesson(); s.start(); await s.request(0);
	s.steer("Change direction"); s.stop();
	await s.wire();
	assert.equal(s.requests.length, 1); assert.equal(s.stats().aborted, true);
});

test("a steer during context preparation prevents the stale request from progressing", { timeout: 5000 }, async () => {
	const s = lesson(); const preparing = deferred(), release = deferred();
	const prepare = s.agent.prepareRequest;
	let calls = 0;
	s.agent.prepareRequest = async (request, signal) => {
		const result = await prepare?.(request, signal);
		if (++calls === 1) { preparing.resolve(); await release.promise; }
		return result ?? undefined;
	};
	s.start(); await preparing.promise;
	s.steer("Clarification before the first token"); release.resolve();
	const stale = await s.request(0);
	assert.equal(stale.signal?.aborted, true);
	const next = await s.request(1); assert.match(JSON.stringify(next.context), /Clarification before/);
	next.finish(); await s.wire();
});

for (const endAfterTool of [false, true]) {
	test(`a running tool finishes once before applying the steer (stopper=${endAfterTool})`, { timeout: 5000 }, async () => {
		const running = deferred(), release = deferred(); let executions = 0;
		const s = lesson({ tools: { read_fixture: { name: "read_fixture", label: "Read fixture", description: "Fixture", parameters: Type.Object({}),
			async execute(_id, _input, signal) {
				executions++; running.resolve(); await release.promise;
				assert.equal(signal?.aborted, false);
				return { content: [{ type: "text", text: "Saved tool result" }], details: {} };
			},
		} } });
		if (endAfterTool) s.agent.finishTurn = context => context.toolResults.length ? { action: "end" } : undefined;
		s.start(); const first = await s.request(0);
		first.finish(fauxAssistantMessage([fauxToolCall("read_fixture", {}, { id: "read-once" })], { stopReason: "toolUse" }));
		await running.promise; s.steer("Explain the tool result more simply");
		assert.equal(first.signal?.aborted, false);
		release.resolve();
		const next = await s.request(1);
		assert.match(JSON.stringify(next.context), /Saved tool result/);
		assert.match(JSON.stringify(next.context), /more simply/);
		next.finish(); await s.wire();
		assert.equal(executions, 1);
		assert.equal(s.saved().filter(m => m.role === "toolResult").length, 1);
	});
}

test("ordinary queued background input does not interrupt a learner response", { timeout: 5000 }, async () => {
	const s = lesson(); s.start(); const first = await s.request(0);
	s.agent.steer({ role: "custom", id: "background-fixture", customType: "subagent-steer", content: "Demo is ready", details: {}, display: true, timestamp: 1 });
	assert.equal(first.signal?.aborted, false);
	first.finish(); const next = await s.request(1);
	assert.match(JSON.stringify(next.context), /Demo is ready/);
	next.finish(); await s.wire(); assert.equal(s.requests.length, 2);
});
