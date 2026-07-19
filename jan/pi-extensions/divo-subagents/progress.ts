import { randomUUID } from "node:crypto";

export const DIVO_SUBAGENT_DETAILS_VERSION = 1;
export const MAX_SUBAGENT_EVENT_LOG = 24;
export const MAX_OUTPUT_PREVIEW_CHARS = 1_200;
export const MAX_FINAL_OUTPUT_CHARS = 16_000;

export type SubagentMode = "single" | "parallel" | "chain";
export type SubagentState = "queued" | "running" | "completed" | "failed" | "cancelled";
export type SubagentActivityKind = "queued" | "thinking" | "tool" | "waiting" | "complete" | "failed" | "cancelled";
export type SubagentEventKind =
	| "queued"
	| "started"
	| "thinking"
	| "tool_started"
	| "tool_updated"
	| "tool_completed"
	| "message"
	| "completed"
	| "failed"
	| "cancelled";

export type SubagentUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
};

export type SubagentActivity = {
	kind: SubagentActivityKind;
	label?: string;
	toolCallId?: string;
};

export type SubagentEvent = {
	seq: number;
	at: string;
	kind: SubagentEventKind;
	label?: string;
};

export type SubagentChild = {
	id: string;
	index: number;
	role: string;
	task: string;
	state: SubagentState;
	startedAt?: string;
	endedAt?: string;
	exitCode?: number;
	activity: SubagentActivity;
	usage: SubagentUsage;
	model?: string;
	outputPreview?: string;
	finalOutput?: string;
	error?: string;
	stopReason?: string;
	events: SubagentEvent[];
};

export type SubagentSummary = {
	total: number;
	queued: number;
	running: number;
	completed: number;
	failed: number;
	cancelled: number;
};

export type SubagentDetails = {
	version: typeof DIVO_SUBAGENT_DETAILS_VERSION;
	parentToolCallId: string;
	mode: SubagentMode;
	state: "running" | "completed" | "failed" | "cancelled";
	summary: SubagentSummary;
	children: SubagentChild[];
	updatedAt: string;
};

export function emptyUsage(): SubagentUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

export function truncateText(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	return `${value.slice(0, maxChars)}…`;
}

export function createChild(index: number, role: string, task: string): SubagentChild {
	const now = new Date().toISOString();
	return {
		id: randomUUID(),
		index,
		role,
		task,
		state: "queued",
		activity: { kind: "queued", label: "Queued" },
		usage: emptyUsage(),
		events: [{ seq: 1, at: now, kind: "queued", label: "Queued" }],
	};
}

export function addEvent(child: SubagentChild, kind: SubagentEventKind, label?: string): void {
	const nextSeq = (child.events.at(-1)?.seq ?? 0) + 1;
	child.events.push({ seq: nextSeq, at: new Date().toISOString(), kind, label });
	if (child.events.length > MAX_SUBAGENT_EVENT_LOG) {
		child.events.splice(0, child.events.length - MAX_SUBAGENT_EVENT_LOG);
	}
}

export function startChild(child: SubagentChild): void {
	if (child.state !== "queued") return;
	child.state = "running";
	child.startedAt = new Date().toISOString();
	child.activity = { kind: "thinking", label: "Starting" };
	addEvent(child, "started", "Started");
}

export function setThinking(child: SubagentChild, label = "Working"): void {
	if (child.state !== "running") return;
	child.activity = { kind: "thinking", label: truncateText(label, 180) };
	addEvent(child, "thinking", child.activity.label);
}

export function setToolActivity(
	child: SubagentChild,
	toolCallId: string | undefined,
	label: string,
	kind: "tool_started" | "tool_updated" | "tool_completed"
): void {
	if (child.state !== "running") return;
	const safeLabel = truncateText(label, 180);
	child.activity =
		kind === "tool_completed"
			? { kind: "thinking", label: "Continuing" }
			: { kind: "tool", toolCallId, label: safeLabel };
	addEvent(child, kind, safeLabel);
}

export function addAssistantOutput(child: SubagentChild, text: string): void {
	if (!text.trim()) return;
	child.outputPreview = truncateText(text.trim(), MAX_OUTPUT_PREVIEW_CHARS);
	addEvent(child, "message", "Produced an update");
}

export function completeChild(child: SubagentChild, finalOutput: string, exitCode: number, stopReason?: string): void {
	child.exitCode = exitCode;
	child.endedAt = new Date().toISOString();
	child.stopReason = stopReason;
	if (exitCode === 0 && stopReason !== "error" && stopReason !== "aborted") {
		child.state = "completed";
		child.activity = { kind: "complete", label: "Completed" };
		child.finalOutput = truncateText(finalOutput, MAX_FINAL_OUTPUT_CHARS);
		child.outputPreview = child.finalOutput || child.outputPreview;
		addEvent(child, "completed", "Completed");
		return;
	}
	child.state = stopReason === "aborted" ? "cancelled" : "failed";
	child.activity = {
		kind: child.state === "cancelled" ? "cancelled" : "failed",
		label: child.state === "cancelled" ? "Cancelled" : "Failed",
	};
	child.error = truncateText(finalOutput || "Subagent process failed", MAX_OUTPUT_PREVIEW_CHARS);
	addEvent(child, child.state === "cancelled" ? "cancelled" : "failed", child.error);
}

export function summarize(children: SubagentChild[]): SubagentSummary {
	const summary: SubagentSummary = {
		total: children.length,
		queued: 0,
		running: 0,
		completed: 0,
		failed: 0,
		cancelled: 0,
	};
	for (const child of children) summary[child.state] += 1;
	return summary;
}

export function makeDetails(
	parentToolCallId: string,
	mode: SubagentMode,
	children: SubagentChild[],
	state?: SubagentDetails["state"]
): SubagentDetails {
	const summary = summarize(children);
	const resolvedState =
		state ??
		(summary.running > 0 || summary.queued > 0
			? "running"
			: summary.failed > 0
				? "failed"
				: summary.cancelled === summary.total && summary.total > 0
					? "cancelled"
					: "completed");
	return {
		version: DIVO_SUBAGENT_DETAILS_VERSION,
		parentToolCallId,
		mode,
		state: resolvedState,
		summary,
		children: children.map((child) => structuredClone(child)),
		updatedAt: new Date().toISOString(),
	};
}
