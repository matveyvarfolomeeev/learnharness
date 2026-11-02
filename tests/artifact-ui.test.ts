/**
 * THE ARTIFACT-UI ROUTE (owner, 2026-10-07): POST /api/chats/:id/artifact-ui
 * persists the learner's invert switch onto a demo/figure steer message
 * (details.ui.inverted) — the silent record-write route (no wake, no SSE).
 * The pure core (setSteerUiInverted) is pinned in tests/demos.test.tsx;
 * this file pins the ROUTE contract: 404 unknown chat, 400 for a bad body
 * or a non-artifact message id, and the record actually carrying the flag
 * after a write.
 *
 * Runs under an isolated LH_DATA_DIR (the chat-birth-stamp discipline:
 * the seam is set before any config-loading import, so every app-module
 * import is dynamic).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-artifact-ui-"));
process.env.LH_DATA_DIR = TMP_DATA;

type Post = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
let POST: Post;
let createChat: (title: string, kind?: "practice") => { id: string; title: string };
let saveMessages: (id: string, messages: unknown[]) => void;
let getChat: (id: string) => { messages: unknown[] } | undefined;
let buildSubagentSteerFn: typeof import("../src/core/contracts.ts").buildSubagentSteer;
let jobStore: typeof import("../src/store/jobs.ts").jobStore;

before(async () => {
	const route = await import("../app/api/chats/[id]/artifact-ui/route.ts");
	POST = route.POST;
	const server = await import("../src/server/chats.ts");
	createChat = server.createChat;
	getChat = server.getChat as typeof getChat;
	const { chatStore } = await import("../src/store/chats.ts");
	saveMessages = (id, messages) => chatStore.saveMessages(id, messages as never);
	const contracts = await import("../src/core/contracts.ts");
	buildSubagentSteerFn = contracts.buildSubagentSteer;
	jobStore = (await import("../src/store/jobs.ts")).jobStore;
});

const post = (id: string, body: unknown) =>
	POST(new Request("http://x/api", { method: "POST", body: JSON.stringify(body) }), {
		params: Promise.resolve({ id }),
	});

describe("POST /api/chats/:id/artifact-ui", () => {
	it("persists inversion before teacher delivery without adding messages or waking a turn", async () => {
		const chat = createChat("Pending demo");
		const other = createChat("Different chat");
		const job = jobStore.createJob({ kind: "demo", chatId: chat.id, toolCallId: "pending-demo" });
		const messageId = `steer_${job.id}`;
		const body = { input: { messageId, inverted: true } };
		assert.equal((await post(chat.id, body)).status, 400, "still running");
		jobStore.updateJob(job.id, { status: "done", result: { title: "T", html: "<p>Tested</p>", tested: true }, delivery: { kind: "result", status: "pending" } });
		assert.equal((await post(other.id, body)).status, 400, "cannot change another chat's artifact");
		assert.equal((await post(chat.id, body)).status, 200);
		assert.deepEqual(jobStore.getJob(job.id)?.ui, { inverted: true });
		assert.equal(jobStore.getJob(job.id)?.delivery?.status, "pending");
		assert.deepEqual(getChat(chat.id)!.messages, []);
		const steer = buildSubagentSteerFn(job, jobStore.getJob(job.id)!.result as never);
		saveMessages(chat.id, [steer]);
		assert.equal((await post(chat.id, { input: { messageId, inverted: false } })).status, 200);
		assert.deepEqual(jobStore.getJob(job.id)?.ui, { inverted: false });
		const saved = getChat(chat.id)!.messages as [{ details: { ui?: { inverted?: boolean } } }];
		assert.equal(saved[0].details.ui?.inverted, false);
	});
	it("404s an unknown chat", async () => {
		const res = await post("nope", { input: { messageId: "x", inverted: true } });
		assert.equal(res.status, 404);
	});

	it("400s a malformed body and a non-artifact message id", async () => {
		const chat = createChat("Artifact UI guards");
		const steer = buildSubagentSteerFn(
			{ id: "jg", kind: "demo", toolCallId: "cg" },
			{ title: "T", html: "<p>x</p>", tested: true },
		);
		saveMessages(chat.id, [
			{ id: "m1", role: "user", content: "hi" },
			steer as never,
		]);
		assert.equal((await post(chat.id, { input: { messageId: "m1", inverted: true } })).status, 400);
		assert.equal((await post(chat.id, { input: { messageId: "missing", inverted: true } })).status, 400);
		assert.equal((await post(chat.id, {})).status, 400);
		assert.equal((await post(chat.id, { input: { messageId: "m1", inverted: "yes" } })).status, 400);
	});

	it("persists ui.inverted onto the demo steer and toggles it back", async () => {
		const chat = createChat("Artifact UI round trip");
		const steer = buildSubagentSteerFn(
			{ id: "jk", kind: "visual", toolCallId: "ck" },
			{ svg: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>' },
		);
		saveMessages(chat.id, [steer as never]);

		assert.equal((await post(chat.id, { input: { messageId: steer.id, inverted: true } })).status, 200);
		let saved = getChat(chat.id)!.messages as [{ details: { ui?: { inverted?: boolean } } }];
		assert.equal(saved[0]!.details.ui?.inverted, true, "the flag rides the record");

		assert.equal((await post(chat.id, { input: { messageId: steer.id, inverted: false } })).status, 200);
		saved = getChat(chat.id)!.messages as [{ details: { ui?: { inverted?: boolean } } }];
		assert.equal(saved[0]!.details.ui?.inverted, false, "and toggles back off");
	});
});

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});
