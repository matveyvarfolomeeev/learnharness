import type { ChatRecord } from "./contracts/chat.ts";
import { problemInputForConclude } from "./native-messages.ts";

export type MasteryState = "unassessed" | "learning" | "known" | "review";
export const MASTERY_LABELS: Record<MasteryState, string> = { unassessed: "Не проверял", learning: "Изучаю", known: "Знаю", review: "Нужно повторить" };
export interface ManualMastery { state: MasteryState; at: string }
export interface MasteryEvidence { id: string; nodeId: string; chatId: string; at: string; result: "passed" | "partial" | "failed"; reason: string; mode?: string; rung?: string | null; missClass?: string | null }
export interface MasterySummary { state: MasteryState; origin: "manual" | "checks" | "none"; checks: number; passed: number; at?: string; reason?: string; chatId?: string }
export interface MasteryDetails { summary: MasterySummary; recent: MasteryEvidence[] }
export type MasteryReader = (ids: readonly string[]) => Record<string, MasteryDetails>;

/** Only explicit, answered checks with known graph targets count. Reading is not a check. */
export function masteryEvidence(chat: ChatRecord, validIds: ReadonlySet<string>): MasteryEvidence[] {
	const calls = new Map<string, { name: string; args: Record<string, unknown> }>();
	const results = new Map<string, { details: Record<string, unknown>; at: string; error: boolean }>();
	for (const m of chat.messages) {
		if (m.role === "assistant") for (const part of m.content) if (part.type === "toolCall") calls.set(part.id, { name: part.name, args: part.arguments });
		if (m.role === "toolResult") results.set(m.toolCallId, { details: (m.details ?? {}) as Record<string, unknown>, at: new Date(m.timestamp).toISOString(), error: Boolean(m.isError) });
	}
	const events: MasteryEvidence[] = [];
	for (const [id, call] of calls) {
		const ack = results.get(id);
		if (!ack || ack.error) continue;
		let ids: unknown; let result: MasteryEvidence["result"] | undefined; let reason = ""; let eventId = id;
		let practice: ReturnType<typeof problemInputForConclude>;
		if ((call.name === "quiz" || call.name === "probe") && call.args.type !== "predict" && !ack.details.dismissed) {
			ids = call.args.knowledgeIds;
			result = ack.details.dontKnow ? "failed" : ack.details.correct === true ? "passed" : ack.details.correct === false ? "failed" : undefined;
			reason = result === "passed" ? "Правильный ответ на проверочный вопрос" : "Ошибка или ответ «не знаю»";
		} else if (call.name === "conclude") {
			practice = problemInputForConclude(chat.messages, id);
			ids = practice?.target;
			result = call.args.outcome === "solved" ? (call.args.rung == null ? "passed" : "partial") : call.args.outcome === "solvedWithHints" ? "partial" : call.args.outcome === "surrendered" ? "failed" : undefined;
			reason = typeof call.args.verdict === "string" ? call.args.verdict : "Результат практики";
		} else if (call.name === "assess_knowledge") {
			const questionId = typeof call.args.questionCallId === "string" ? call.args.questionCallId : "";
			const question = calls.get(questionId); const answer = results.get(questionId);
			if (!question || !["explain", "recall"].includes(question.name) || !answer || answer.error || answer.details.dismissed || question.args.type === "predict") continue;
			const targets = question.args.knowledgeIds;
			ids = Array.isArray(targets) && Array.isArray(call.args.knowledgeIds) ? call.args.knowledgeIds.filter((id) => targets.includes(id)) : [];
			if (answer.details.dontKnow && call.args.result !== "failed") continue;
			eventId = questionId;
			result = ["passed", "partial", "failed"].includes(String(call.args.result)) ? call.args.result as MasteryEvidence["result"] : undefined;
			reason = typeof call.args.reason === "string" ? call.args.reason : "Оценка объяснения преподавателем";
		}
		if (!result || !Array.isArray(ids)) continue;
		for (const nodeId of new Set(ids)) if (typeof nodeId === "string" && validIds.has(nodeId)) {
			let nodeResult = result; let nodeReason = reason;
			if (call.name === "conclude" && Array.isArray(call.args.knowledgeResults)) {
				const assessment = call.args.knowledgeResults.find((a) => a && typeof a === "object" && a.nodeId === nodeId);
				// A blocked/unobserved step is no evidence about that node. Never borrow another step's grade.
				if (!assessment || !["passed", "partial", "failed"].includes(assessment.result)) continue;
				nodeResult = assessment.result;
				nodeReason = typeof assessment.reason === "string" ? assessment.reason : reason;
				if (ids.length === 1 && nodeResult === "passed" && call.args.rung != null) nodeResult = "partial";
			}
			const key = `${chat.id}:${eventId}:${nodeId}`;
			if (!events.some((e) => e.id === key)) events.push({ id: key, nodeId, chatId: chat.id, at: typeof ack.details.answeredAt === "string" ? ack.details.answeredAt : ack.at, result: nodeResult, reason: nodeReason,
				...(practice ? { mode: typeof practice.mode === "string" ? practice.mode : undefined,
					rung: typeof call.args.rung === "string" ? call.args.rung : null, missClass: typeof call.args.missClass === "string" ? call.args.missClass : null } : {}),
			});
		}
	}
	return events;
}

export function summarizeMastery(events: readonly MasteryEvidence[], manual?: ManualMastery): MasterySummary {
	const ordered = [...events].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
	let summary: MasterySummary = { state: manual?.state ?? "unassessed", origin: manual ? "manual" : "none", checks: ordered.length, passed: ordered.filter((e) => e.result === "passed").length, ...(manual ? { at: manual.at, reason: "Твоя отметка" } : {}) };
	const successes = new Set<string>();
	for (const e of ordered) {
		if (manual && e.at <= manual.at) continue;
		if (e.result === "passed") successes.add(`${e.chatId}:${e.at.slice(0, 10)}`); else successes.clear();
		// Two independent sessions/days, with no intervening failure or hints. Not a calibrated probability.
		const state = e.result === "failed" ? "review" : e.result === "partial" ? "learning" : successes.size >= 2 || summary.state === "known" ? "known" : "learning";
		summary = { ...summary, state, origin: "checks", at: e.at, reason: e.reason, chatId: e.chatId };
	}
	return summary;
}
