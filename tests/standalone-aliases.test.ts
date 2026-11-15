import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { materializeTracedAliases } from "../scripts/materialize-traced-aliases.mjs";

test("a relocated traced alias retains its nested dependency version without its source checkout", async () => {
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-alias-"));
	const root = path.join(scratch, "build"), moved = path.join(scratch, "installed");
	const writePackage = (directory: string, name: string, source: string) => {
		fs.mkdirSync(directory, { recursive: true });
		fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
		fs.writeFileSync(path.join(directory, "index.js"), source);
	};
	try {
		const scope = path.join(root, "node_modules", "outer", "node_modules");
		const canonical = path.join(scope, "nested");
		writePackage(canonical, "nested", 'export { version } from "dependency";');
		writePackage(path.join(scope, "dependency"), "dependency", 'export const version = "nested-version";');
		writePackage(path.join(root, "node_modules", "dependency"), "dependency", 'export const version = "wrong-root-version";');
		const alias = path.join(root, ".next", "node_modules", "nested-hash");
		fs.mkdirSync(path.dirname(alias), { recursive: true });
		fs.symlinkSync(canonical, alias, process.platform === "win32" ? "junction" : "dir");
		assert.equal(materializeTracedAliases(root), 1);
		assert.equal(fs.lstatSync(alias).isSymbolicLink(), false);
		fs.renameSync(root, moved);
		const value = await import(pathToFileURL(path.join(moved, ".next", "node_modules", "nested-hash", "index.js")).href);
		assert.equal(value.version, "nested-version");
	} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});
