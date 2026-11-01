import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import type { ManualMastery } from "../core/mastery.ts";

export const MASTERY_FILE = path.join(PATHS.graph, "mastery.json");
export function readManualMastery(): Record<string, ManualMastery> {
	try { return JSON.parse(fs.readFileSync(MASTERY_FILE, "utf8")); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
}
export function saveManualMastery(id: string, entry: ManualMastery) {
	const values = readManualMastery(); values[id] = entry;
	fs.mkdirSync(PATHS.graph, { recursive: true });
	const tmp = `${MASTERY_FILE}.tmp-${crypto.randomUUID()}`;
	try { fs.writeFileSync(tmp, JSON.stringify(values, null, 2), "utf8"); fs.renameSync(tmp, MASTERY_FILE); }
	finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}
