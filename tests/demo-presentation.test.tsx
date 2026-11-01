import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAppearanceSettingsBody } from "../src/server/settings-body.ts";
import { resolveSettings, sanitizeUserSettings } from "../src/core/index.ts";
import { resolveAppearance } from "../components/settings/appearance.tsx";
import { demoIsFullscreen, demoPanelWidth } from "../components/demo-workspace.tsx";

test("demo defaults also apply to older appearance records", () => {
	for (const settings of [null, { version: 1, appearance: { proseFontSize: 18 } }]) {
		assert.equal(resolveSettings(settings).appearance.demoView, "side");
		assert.equal(resolveSettings(settings).appearance.demoSteps, true);
		assert.equal(resolveAppearance(settings?.appearance).demoView, "side");
	}
});

test("all four presentation combinations survive validation and both resolution paths", () => {
	for (const demoView of ["side", "fullscreen"] as const) for (const demoSteps of [true, false]) {
		const appearance = { demoView, demoSteps, proseFontSize: 18 };
		const parsed = parseAppearanceSettingsBody(appearance);
		assert.deepEqual(parsed, { ok: true, settings: appearance });
		const record = sanitizeUserSettings(JSON.parse(JSON.stringify({ version: 1, appearance })));
		assert.deepEqual(record?.appearance, appearance);
		for (const resolved of [resolveSettings(record).appearance, resolveAppearance(record?.appearance)]) {
			assert.equal(resolved.demoView, demoView); assert.equal(resolved.demoSteps, demoSteps);
			assert.equal(resolved.proseFontSize, 18);
		}
	}
});

test("invalid presentation preferences are refused by the API and ignored in old disk data", () => {
	for (const invalid of [{ demoView: "popup" }, { demoSteps: "false" }]) {
		assert.equal(parseAppearanceSettingsBody(invalid).ok, false);
		const record = sanitizeUserSettings({ version: 1, appearance: { ...invalid, proseFontSize: 18 } });
		assert.deepEqual(record?.appearance, { proseFontSize: 18 });
	}
});

test("narrow sessions fall back to large view and panel resizing leaves room for the lesson", () => {
	assert.equal(demoIsFullscreen("side", 899), true);
	assert.equal(demoIsFullscreen("side", 900), false);
	assert.equal(demoIsFullscreen("fullscreen", 1400), true);
	assert.equal(demoPanelWidth(1200, .5), 600);
	assert.equal(demoPanelWidth(1200, .99), 800);
	assert.equal(demoPanelWidth(1200, .01), 360);
});
