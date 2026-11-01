import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { dictationWav, MAX_DICTATION_PCM_BYTES } from "../src/core/dictation.ts";
import { parseDictationSettingsBody } from "../src/server/settings-body.ts";
import { resolveSettings } from "../src/core/settings-resolution.ts";
import { sanitizeUserSettings } from "../src/core/settings.ts";

const data = mkdtempSync(path.join(tmpdir(), "lh-groq-dictation-"));
process.env.LH_DATA_DIR = data;
process.env.LH_AUTH_FILE = path.join(data, "auth.json");
process.env.GROQ_API_KEY = "test-groq-credential";
const { handleDictation, dictationReady, safeDictationCleanup } = await import("../src/server/dictation.ts");
after(() => { rmSync(data, { recursive: true, force: true }); });

function recording(settings: Record<string, unknown> = {}, audio = dictationWav([new Int16Array(1600)]), signal?: AbortSignal) {
	const form = new FormData();
	form.set("file", new Blob([audio], { type: "audio/wav" }), "recording.wav");
	form.set("settings", JSON.stringify({ engine: "whisper-large-v3", language: "ru", cleanup: false, ...settings }));
	return new Request("http://localhost/api/stt/transcribe", { method: "POST", body: form, signal });
}

test("settings preserve old Deepgram records, validate new choices, and retain independent options", () => {
	assert.equal(resolveSettings({ version: 1, dictation: { language: "ru" } }).dictation.engine, "deepgram");
	const valid = { language: "ru", engine: "whisper-large-v3-turbo", cleanup: true, glossary: "Коши, Python" };
	assert.deepEqual(parseDictationSettingsBody(valid), { ok: true, settings: valid });
	assert.deepEqual(sanitizeUserSettings({ version: 1, dictation: valid })?.dictation, valid);
	for (const invalid of [{ engine: "custom-url" }, { cleanup: "yes" }, { glossary: "x".repeat(601) }]) assert.equal(parseDictationSettingsBody(invalid).ok, false);
	assert.deepEqual(sanitizeUserSettings({ version: 1, dictation: { language: "ru", engine: "bad", cleanup: false } })?.dictation, { language: "ru", cleanup: false });
});

test("WAV preserves frame boundaries, final partial frames and view offsets", () => {
	const frame = new Int16Array([99, 12, -35, 77]);
	const wav = dictationWav([frame.subarray(1, 3), new Int16Array([42])]);
	assert.equal(new DataView(wav).getUint32(40, true), 6);
	assert.deepEqual([...new Int16Array(wav, 44)], [12, -35, 42]);
	assert.throws(() => dictationWav([new ArrayBuffer(MAX_DICTATION_PCM_BYTES + 2)]));
});

test("transcription uses the selected model, Russian hint and glossary, without a cleanup call when disabled", async () => {
	let calls = 0;
	const response = await handleDictation(recording({ engine: "whisper-large-v3-turbo", glossary: "Коши, Python" }), async (url, options) => {
		calls++;
		assert.equal(url, "https://api.groq.com/openai/v1/audio/transcriptions");
		assert.equal(new Headers(options?.headers).get("authorization"), "Bearer test-groq-credential");
		const body = options?.body as FormData;
		assert.equal(body.get("model"), "whisper-large-v3-turbo");
		assert.equal(body.get("language"), "ru");
		assert.equal(body.get("temperature"), "0");
		assert.equal(body.get("prompt"), "Коши, Python");
		return Response.json({ text: "Теорема Коши." });
	});
	assert.deepEqual(await response.json(), { text: "Теорема Коши.", rawText: "Теорема Коши." });
	assert.equal(calls, 1);
});

test("automatic language omits the hint and supported locale aliases use their base language", async () => {
	for (const language of ["multi", "en-GB"]) {
		await handleDictation(recording({ language }), async (_url, options) => {
			assert.equal((options?.body as FormData).get("language"), language === "multi" ? null : "en");
			return Response.json({ text: "Example." });
		});
	}
});

test("optional cleanup returns the edited transcript and always retains the raw transcript", async () => {
	let calls = 0;
	const response = await handleDictation(recording({ cleanup: true }), async (_url, options) => {
		if (++calls === 1) return Response.json({ text: "ну производная равна 2" });
		const body = JSON.parse(options?.body as string);
		assert.equal(body.model, "openai/gpt-oss-20b");
		assert.match(body.messages[0].content, /never answer/);
		return Response.json({ choices: [{ finish_reason: "stop", message: { content: "Производная равна 2." } }] });
	});
	assert.deepEqual(await response.json(), { text: "Производная равна 2.", rawText: "ну производная равна 2" });
});

test("cleanup preserves numbers, negations and mathematical comparisons", () => {
	assert.equal(safeDictationCleanup("Это не верно при x < 2", "Это верно при x < 2."), false);
	assert.equal(safeDictationCleanup("x < 2", "x < 3"), false);
	assert.equal(safeDictationCleanup("x < 2", "x > 2"), false);
	assert.equal(safeDictationCleanup("это не верно при x < 2", "Это не верно при x < 2."), true);
});

test("cleanup errors, truncation and unsafe edits fall back to the original", async () => {
	for (const cleanup of [new Response(null, { status: 429 }), Response.json({ choices: [{ finish_reason: "length", message: { content: "Неполный" } }] }), Response.json({ choices: [{ finish_reason: "stop", message: { content: "Производная равна 3." } }] })]) {
		let calls = 0;
		const response = await handleDictation(recording({ cleanup: true }), async () => ++calls === 1 ? Response.json({ text: "Производная равна 2." }) : cleanup);
		const body = await response.json();
		assert.equal(body.text, "Производная равна 2.");
		assert.match(body.warning, /исходная/);
	}
});

test("rate limit and invalid key failures are actionable and never echo upstream secrets", async () => {
	for (const status of [429, 401, 403, 500]) {
		const response = await handleDictation(recording(), async () => Response.json({ error: "test-groq-credential provider detail" }, { status }));
		const body = await response.text();
		assert.equal(response.status, status === 429 ? 429 : 502);
		assert.equal(body.includes("test-groq-credential"), false);
	}
});

test("an overall deadline reached during optional cleanup retains the completed transcript", async (t) => {
	const deadline = new AbortController();
	t.mock.method(AbortSignal, "timeout", () => deadline.signal);
	let calls = 0;
	const response = await handleDictation(recording({ cleanup: true }), async () => {
		if (++calls === 1) return Response.json({ text: "Производная равна 2." });
		deadline.abort(new DOMException("Deadline reached", "TimeoutError"));
		throw deadline.signal.reason;
	});
	assert.equal(response.status, 200);
	const body = await response.json();
	assert.equal(body.text, "Производная равна 2.");
	assert.match(body.warning, /исходная/);
});

test("rejects invalid or oversized uploads before provider dispatch", async () => {
	const unexpected: typeof fetch = async () => { throw new Error("must not call provider"); };
	for (const req of [recording({ engine: "unknown" }), recording({}, new ArrayBuffer(400)), new Request("http://localhost/api/stt/transcribe", { method: "POST", headers: { "content-length": "99999999" }, body: "x" })]) {
		assert.equal((await handleDictation(req, unexpected)).status, 400);
	}
});

test("silence never becomes a hallucinated transcript or a cleanup request", async () => {
	let calls = 0;
	const result = await handleDictation(recording({ cleanup: true }), async () => { calls++; return Response.json({ text: "Спасибо за просмотр.", segments: [{ no_speech_prob: 0.99 }] }); });
	assert.equal((await result.json()).text, "");
	assert.equal(calls, 1);
});

test("an already cancelled upload never reaches the provider", async () => {
	const abort = new AbortController(); abort.abort();
	let calls = 0;
	const result = await handleDictation(recording({}, undefined, abort.signal), async () => { calls++; return Response.json({ text: "late" }); });
	assert.equal(result.status, 502);
	assert.equal(calls, 0);
});

test("missing key is reported without returning any credential", async () => {
	delete process.env.GROQ_API_KEY;
	assert.deepEqual(await dictationReady().json(), { ready: false });
	assert.equal((await handleDictation(recording())).status, 503);
});
