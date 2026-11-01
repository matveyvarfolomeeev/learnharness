import { stores } from "./stores.ts";
import { masteryEvidence, summarizeMastery, type MasteryEvidence, type MasteryReader } from "../core/mastery.ts";
import { readManualMastery } from "../store/mastery.ts";

export const masteryDetails: MasteryReader = (ids) => {
	if (!ids.length) return {};
	const known = new Set(ids); const byNode = new Map<string, MasteryEvidence[]>();
	for (const c of stores.chatStore.listChats()) {
		const chat = stores.chatStore.getChat(c.id); if (!chat) continue;
		for (const event of masteryEvidence(chat, known)) { const list = byNode.get(event.nodeId) ?? []; list.push(event); byNode.set(event.nodeId, list); }
	}
	const manual = readManualMastery();
	return Object.fromEntries(ids.map((id) => {
		const events = byNode.get(id) ?? [];
		return [id, { summary: summarizeMastery(events, manual[id]), recent: events.sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id)).slice(0, 5) }];
	}));
};

export function masteryView(ids: readonly string[]) {
	return Object.fromEntries(Object.entries(masteryDetails(ids)).map(([id, value]) => [id, value.summary]));
}
