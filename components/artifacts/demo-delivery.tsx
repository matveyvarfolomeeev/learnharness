"use client";

import { Component, createContext, useMemo, type ReactNode, type RefObject } from "react";
import type { StickToBottomContext } from "use-stick-to-bottom";
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

type ReadingAnchorProps = { revision: string; scrollContextRef?: RefObject<StickToBottomContext | null>; children: ReactNode };
type ReadingAnchor = { scroller: HTMLElement; element: Element; top: number } | null;

/** Measure before React replaces a pending card, then retain the visible prose.
 * Reading above the live bottom must not jump when a background demo finishes. */
class DemoReadingAnchor extends Component<ReadingAnchorProps> {
	getSnapshotBeforeUpdate(previous: ReadingAnchorProps): ReadingAnchor {
		if (previous.revision === this.props.revision) return null;
		const context = this.props.scrollContextRef?.current;
		const scroller = context?.scrollRef.current;
		if (!scroller || context?.isAtBottom) return null;
		const bounds = scroller.getBoundingClientRect();
		const element = Array.from(scroller.querySelectorAll('[data-source-message-id] :is(p,h1,h2,h3,h4,li,pre)'))
			.find(node => { const box = node.getBoundingClientRect(); return box.bottom > bounds.top && box.top < bounds.bottom; });
		return element ? { scroller, element, top: element.getBoundingClientRect().top } : null;
	}
	componentDidUpdate(_previous: ReadingAnchorProps, _state: unknown, anchor: ReadingAnchor) {
		if (anchor?.element.isConnected) anchor.scroller.scrollTop += anchor.element.getBoundingClientRect().top - anchor.top;
	}
	render() { return this.props.children; }
}

export function DemoDeliveryProvider({ messages, jobs, children, scrollContextRef }: {
	messages: LhViewMessage[]; jobs: JobRecord[]; children: ReactNode; scrollContextRef?: RefObject<StickToBottomContext | null>;
}) {
	const value = useMemo(() => indexDemoDelivery(messages, jobs), [messages, jobs]);
	const revision = [...value.artifacts.keys()].sort().join("\n");
	return <DemoReadingAnchor revision={revision} scrollContextRef={scrollContextRef}>
		<DemoDeliveryContext.Provider value={value}>{children}</DemoDeliveryContext.Provider>
	</DemoReadingAnchor>;
}
