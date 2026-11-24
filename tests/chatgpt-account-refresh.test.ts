import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AUTH_PROVIDER_ENV_VARS } from "../src/core/auth-keys.ts";
import { configureWebSubscriptionRuntime } from "../src/agent/subscription-runtime.ts";

test("a subscription-only refresh intersects trusted Responses metadata with the current account", async (t) => {
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-account-models-"));
	t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
	process.env.LH_DATA_DIR = scratch;
	process.env.LH_AUTH_FILE = path.join(scratch, "auth.json");
	fs.writeFileSync(process.env.LH_AUTH_FILE, "{}\n");
	for (const key of AUTH_PROVIDER_ENV_VARS) delete process.env[key];
	delete process.env.LH_DESKTOP_SERVER;
	delete process.env.LH_DESKTOP_API_SECRET;
	const { refreshModelCatalog } = await import("../src/server/remote-model-catalog.ts");
	const { catalogContextLimits, modelCatalog, refreshConnectionCatalog } = await import("../src/server/model-catalog.ts");
	const { effectiveThresholdTokens } = await import("../src/server/compaction.ts");
	const { piEngineForSpec } = await import("../src/agent/models.ts");
	const id = "account-refresh-example";
	let connected = true;
	let offered = [{ id, name: "Name from account", contextWindow: 500_000 }, { id: "unknown-metadata", name: "Unknown" }];
	configureWebSubscriptionRuntime(async <T>(channel: string, op: string): Promise<T> => {
		assert.equal(channel, "lh:chatgpt");
		assert.ok(op === "status" || op === "models");
		const stamp = { epoch: connected ? 1 : 2, authorityRevision: connected ? 1 : 2, revision: connected ? 1 : 2 };
		const status = { available: true, pending: false, allowBackgroundUse: true, activeId: connected ? "A" : null,
			accounts: connected ? [{ id: "A", connected: true, planEnabled: true }] : [], error: null };
		return { ...stamp, status, accountId: status.activeId, models: offered } as T;
	});
	const base = { api: "openai-responses", provider: "openai", baseUrl: "https://api.openai.com/v1", id, name: "Public metadata",
		reasoning: true, input: ["text", "image"], thinkingLevelMap: { high: "high", xhigh: "xhigh" },
		contextWindow: 120000, maxTokens: 8192, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } };
	const publicFeed = t.mock.method(globalThis, "fetch", async (url: URL, init: RequestInit) => {
		assert.equal(url.href, "https://pi.dev/api/models/providers/openai?types=chat");
		assert.equal(init.credentials, "omit");
		assert.deepEqual([...new Headers(init.headers)], [["accept", "application/json"]]);
		return Response.json([base, { ...base, id: "not-offered-by-account" }]);
	});
	await refreshConnectionCatalog("chatgpt");
	assert.equal(publicFeed.mock.callCount(), 0);
	assert.equal(modelCatalog().models.some(model => model.id === id), false);
	assert.equal(await refreshModelCatalog(), "updated");
	assert.equal(publicFeed.mock.callCount(), 1);
	const rows = modelCatalog().models.filter(model => model.provider === "chatgpt");
	assert.deepEqual(rows.map(model => [model.id, model.name, model.contextWindow]), [[id, "Name from account", 500_000]]);
	assert.equal(modelCatalog().models.some(model => model.provider === "openai"), false);
	const engine = piEngineForSpec({ provider: "chatgpt", id, thinkingLevel: "xhigh" });
	assert.equal(engine.level, "xhigh");
	assert.equal(engine.model.contextWindow, 500_000);
	assert.equal(effectiveThresholdTokens(450_000, catalogContextLimits().get(`chatgpt:${id}`)), 450_000);
	assert.equal(engine.model.maxTokens, 8192);
	assert.deepEqual(engine.model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	assert.equal(await refreshModelCatalog(), "unchanged");
	offered = [];
	await refreshConnectionCatalog("chatgpt");
	assert.deepEqual(modelCatalog().models.filter(model => model.provider === "chatgpt"), []);
	connected = false;
	assert.equal(await refreshModelCatalog(), "no-providers");
	assert.equal(publicFeed.mock.callCount(), 2);
});
