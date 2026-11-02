"use client";

import { createContext, useMemo, type ReactNode } from "react";
import type { JobRecord, LhViewMessage, SubagentArtifactData, SubagentResultMeta } from "@/src/core";

export interface DeliveredDemo {
	messageId: string;
	data: SubagentArtifactData;
}

/** Display ownership only: the persisted transcript and teacher delivery stay unchanged. */
export function indexDemoDelivery(messages: LhViewMessage[], jobs: JobRecord[]) {
	const artifacts = new Map<string, DeliveredDemo>();
	const anchoredMessageIds = new Set<string>();
	const dispatches = new Set<string>();
	for (const message of messages) {
		for (const part of message.parts) {
			if (part.type === "tool-demo" && part.state === "output-available" && part.toolCallId) dispatches.add(part.toolCallId);
		}
		const meta = (message.metadata as { subagentResult?: SubagentResultMeta } | undefined)?.subagentResult;
		const data = message.parts.find((part) => part.type === "data-subagent-artifact")?.data as SubagentArtifactData | undefined;
		if (meta?.toolCallId && data?.kind === "demo") artifacts.set(meta.toolCallId, { messageId: message.id, data });
	}
	// Jobs publish the tested result before a pending question lets the teacher consume it.
	for (const job of jobs) {
		const ready = demoFromJob(job);
		if (!ready) continue;
		const delivered = artifacts.get(job.toolCallId);
		artifacts.set(job.toolCallId, delivered
			? { ...delivered, data: { ...delivered.data, ui: job.ui ?? delivered.data.ui } }
			: ready);
	}
	for (const toolCallId of dispatches) {
		const artifact = artifacts.get(toolCallId);
		if (artifact) anchoredMessageIds.add(artifact.messageId);
	}
	return { artifacts, anchoredMessageIds };
}

export function demoFromJob(job: JobRecord | undefined): DeliveredDemo | undefined {
	if (!job || job.kind !== "demo" || job.status === "running" || job.delivery?.kind === "abort") return;
	const result = job.result as { title?: unknown; html?: unknown; tested?: unknown } | undefined;
	if (!result || typeof result.title !== "string" || typeof result.html !== "string" || result.tested !== true) return;
	return { messageId: `steer_${job.id}`, data: { kind: "demo", result: job.result as SubagentArtifactData["result"], ui: job.ui } };
}

export const DemoDeliveryContext = createContext(indexDemoDelivery([], []));

export function DemoDeliveryProvider({ messages, jobs, children }: { messages: LhViewMessage[]; jobs: JobRecord[]; children: ReactNode }) {
	const value = useMemo(() => indexDemoDelivery(messages, jobs), [messages, jobs]);
	return <DemoDeliveryContext.Provider value={value}>{children}</DemoDeliveryContext.Provider>;
}
