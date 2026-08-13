/**
 * Divo run-trace capture (Track A).
 *
 * PI runs the desktop agent loop locally, so the complete trace of a run —
 * every tool call, every model call with tokens/cache split — only exists here.
 * This module subscribes to PI runtime hooks, batches events per turn, and
 * fire-and-forget POSTs them to the backend ingest route. It never awaits the
 * network write, so it adds zero latency to the user-facing turn. If the user
 * isn't signed in to Divo (no gateway config), tracing is silently disabled.
 *
 * Boundaries: one agent loop (agent_start → agent_end) is one run. Desktop
 * publishes the runId in the per-prompt correlation file; both trace ingest and
 * the LLM proxy use it as one ExecutionRun requestId.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	classifyDivoRunTerminal,
	isTransientDivoRunFailure,
} from "../../run-terminal.mjs";
import { RUNTIME_MODELS } from "../../runtime-models.mjs";
import { resolveDivoGatewayConfig } from "./gateway-client.ts";
import { readDivoRunCorrelation, type DivoRuntimeChannel } from "./run-correlation.ts";

export { classifyDivoRunTerminal };

const TRACE_PATH = "/api/desktop/trace";
const POST_TIMEOUT_MS = 15_000;
const WIRE_CAP = 16_000; // per-field cap; backend caps again defensively
const MAX_BUFFER = 2_000; // bound memory if the backend is unreachable
const DIVO_PROXY_PROVIDERS = new Set(Object.values(RUNTIME_MODELS));

interface WireUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: number;
}

type TraceEvent =
	| { kind: "tool"; seq: number; ts: number; toolName: string; input?: unknown; output?: unknown; isError?: boolean }
	| { kind: "model"; seq: number; ts: number; provider: string; model: string; responseId?: string; mode?: string; usage?: WireUsage }
	| { kind: "run_start" | "run_end" | "turn_start" | "turn_end"; seq: number; ts: number; title?: string; summary?: string; status?: "ok" | "error" }
	| {
		kind: "learning_context";
		seq: number;
		ts: number;
		userMessages: string[];
		assistantResponse?: string;
		toolSummary: Array<{ toolName: string; isError: boolean }>;
	};

type TraceEventInput = TraceEvent extends infer Event
	? Event extends TraceEvent
		? Omit<Event, "seq" | "ts">
		: never
	: never;

interface RunState {
	runId: string;
	threadId?: string;
	runtimeChannel?: DivoRuntimeChannel;
	proxyOwnsUsage: boolean;
	recoveryAttempted: boolean;
	pendingRecoveryFailure?: DivoRunTerminal;
	pendingRecoveryKind?: "oversize" | "transient";
	seq: number;
	buffer: TraceEvent[];
	learningTools: Array<{ toolName: string; isError: boolean }>;
	protectedDataObserved: boolean;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as JsonRecord)
		: undefined;
}

async function tryReadRunCorrelation(): Promise<{
	runId: string;
	threadId: string;
	channel?: DivoRuntimeChannel;
} | null> {
	try {
		const value = await readDivoRunCorrelation();
		return {
			runId: value.runId,
			threadId: value.threadId,
			...(value.channel ? { channel: value.channel } : {}),
		};
	} catch {
		return null;
	}
}

/** Serialise + size-cap an arbitrary value before putting it on the wire. */
function cap(value: unknown): unknown {
	if (value === undefined || value === null) return value ?? undefined;
	const text = typeof value === "string" ? value : safeStringify(value);
	if (text.length <= WIRE_CAP) return value;
	return { _truncated: true, _bytes: text.length, preview: text.slice(0, WIRE_CAP) };
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

export interface DivoRunTerminal {
	status: "ok" | "error";
	summary?: string;
}

/** Pi recognizes this normalized Divo 413 as context overflow and retries it after compaction. */
export function isRecoverableDivoRequestTooLarge(messages: readonly unknown[]): boolean {
	const last = asRecord(messages.at(-1));
	if (!last || last.role !== "assistant" || last.stopReason !== "error") return false;
	if (!DIVO_PROXY_PROVIDERS.has(String(last.provider))) return false;
	const errorMessage = typeof last.errorMessage === "string" ? last.errorMessage : "";
	return /request[_ ]too[_ ]large|payload[_ ]too[_ ]large|entity\.too\.large|PayloadTooLargeError|\b413\b/i.test(errorMessage);
}

export function registerTraceCapture(pi: ExtensionAPI): void {
	let run: RunState | null = null;
	const pendingArgs = new Map<string, unknown>();

	const startRun = (correlation: {
		runId: string;
		threadId: string;
		channel?: DivoRuntimeChannel;
	}): RunState => {
		run = {
			runId: correlation.runId,
			threadId: correlation.threadId,
			...(correlation.channel ? { runtimeChannel: correlation.channel } : {}),
			proxyOwnsUsage: false,
			recoveryAttempted: false,
			seq: 0,
			buffer: [],
			learningTools: [],
			protectedDataObserved: false,
		};
		pendingArgs.clear();
		return run;
	};
	const ensureRun = (): RunState => {
		if (!run) {
			throw new Error("Divo trace received an event before desktop run correlation was available");
		}
		return run;
	};

	const push = (ev: TraceEventInput): void => {
		const r = ensureRun();
		r.buffer.push({ ...(ev as TraceEvent), seq: r.seq++, ts: Date.now() });
		if (r.buffer.length > MAX_BUFFER) r.buffer.splice(0, r.buffer.length - MAX_BUFFER);
	};

	const flush = (): void => {
		if (!run || run.buffer.length === 0) return;
		const config = resolveDivoGatewayConfig();
		if ("error" in config) {
			run.buffer = []; // not signed in — drop, don't accumulate
			return;
		}
		const runId = run.runId;
		const batch = run.buffer.splice(0);
		// Fire-and-forget: never await, so the turn is not blocked. On failure,
		// restore the batch so the next flush retries it.
		void fetch(`${config.backendUrl}${TRACE_PATH}`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${config.memberToken}`,
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify({
				runId,
				...(run.threadId ? { threadId: run.threadId } : {}),
				...(run.runtimeChannel ? { runtimeChannel: run.runtimeChannel } : {}),
				usageAuthority: run.proxyOwnsUsage ? "proxy" : "desktop",
				...(run.protectedDataObserved ? { protectedDataObserved: true } : {}),
				events: batch,
			}),
			signal: AbortSignal.timeout(POST_TIMEOUT_MS),
		})
			.then((res) => {
				if (!res.ok && run && run.runId === runId) run.buffer.unshift(...batch);
			})
			.catch(() => {
				if (run && run.runId === runId) run.buffer.unshift(...batch);
			});
	};

	const finishRun = (terminal: DivoRunTerminal): void => {
		push({ kind: "run_end", ...terminal });
		flush();
		run = null;
		pendingArgs.clear();
	};

	const failPendingRecovery = (summary?: string): void => {
		if (!run?.pendingRecoveryFailure) return;
		finishRun({
			...run.pendingRecoveryFailure,
			...(summary ? { summary } : {}),
		});
	};

	// A trace bug must never break the agent loop — every handler is guarded.
	const guard = (fn: () => void): void => {
		try {
			fn();
		} catch {
			/* swallow — observability is non-critical */
		}
	};

	pi.on("agent_start", async () => {
		const correlation = await tryReadRunCorrelation();
		guard(() => {
			if (
				run?.pendingRecoveryFailure
				&& (!correlation || run.runId === correlation.runId)
			) {
				// A recovery continuation starts a second low-level agent loop.
				// Keep the same trace/run sequence and suppress a duplicate run_start.
				run.pendingRecoveryFailure = undefined;
				if (run.pendingRecoveryKind === "oversize") run.recoveryAttempted = true;
				run.pendingRecoveryKind = undefined;
				pendingArgs.clear();
				return;
			}
			if (!correlation) return;
			if (run?.pendingRecoveryFailure) {
				failPendingRecovery(
					run.pendingRecoveryKind === "oversize"
						? "Oversized-request recovery ended before a same-run assistant continuation started."
						: "Transient model recovery ended before a same-run assistant continuation started.",
				);
			}
			startRun(correlation);
			push({ kind: "run_start", title: "Run started" });
		});
	});

	// Correlate a Divo-owned model proxy request with this exact desktop
	// run. The proxy keeps authoritative token usage while this extension owns
	// the detailed local tool/model timeline.
	pi.on("before_provider_request", async (event, ctx) => {
			if (!ctx.model || !DIVO_PROXY_PROVIDERS.has(ctx.model.provider)) return undefined;
		if (process.env.DIVO_LLM_PROXY_ACTIVE !== "1") return undefined;
		if ("error" in resolveDivoGatewayConfig()) return undefined;
		const correlation = await tryReadRunCorrelation();
		const payload = asRecord(event.payload);
		const activeRecoveryRunId = run
			&& (run.pendingRecoveryFailure || run.recoveryAttempted)
			? run.runId
			: undefined;
		const runId = correlation?.runId ?? activeRecoveryRunId;
		if (!runId || !payload) return undefined;
		if (run?.runId === runId) run.proxyOwnsUsage = true;
		return {
			...payload,
			divo_run_id: runId,
			divo_trace_mode: "desktop",
		};
	});

	pi.on("turn_start", (event) => {
		guard(() => push({ kind: "turn_start", title: `Turn ${event.turnIndex + 1}` }));
	});

	pi.on("tool_execution_start", (event) => {
		guard(() => pendingArgs.set(event.toolCallId, event.args));
	});

	pi.on("tool_execution_end", (event) => {
		guard(() => {
			const input = pendingArgs.get(event.toolCallId);
			pendingArgs.delete(event.toolCallId);
			if (isProtectedShopifyInvocation(event.toolName, input)) ensureRun().protectedDataObserved = true;
			push({
				kind: "tool",
				toolName: event.toolName,
				input: cap(input),
				output: cap(event.result),
				isError: event.isError,
			});
			const r = ensureRun();
			r.learningTools.push({ toolName: event.toolName, isError: event.isError === true });
			if (r.learningTools.length > 20) r.learningTools.splice(0, r.learningTools.length - 20);
		});
	});

	pi.on("message_end", (event) => {
		guard(() => {
			const m = event.message;
			if (m.role !== "assistant") return;
			const u = m.usage;
			push({
				kind: "model",
				provider: String(m.provider),
				model: m.model,
				...(m.responseId ? { responseId: m.responseId } : {}),
				...(u
					? {
							usage: {
								input: u.input,
								output: u.output,
								cacheRead: u.cacheRead,
								cacheWrite: u.cacheWrite,
								...(u.cost ? { cost: u.cost.total } : {}),
							},
						}
					: {}),
			});
		});
	});

	pi.on("turn_end", (event) => {
		guard(() => {
			push({ kind: "turn_end", title: `Turn ${event.turnIndex + 1} done` });
			flush(); // batch per turn
		});
	});

	pi.on("agent_end", (event) => {
		guard(() => {
			const terminal = classifyDivoRunTerminal(event.messages) as DivoRunTerminal;
			if (
				terminal.status === "error"
				&& (
					(isRecoverableDivoRequestTooLarge(event.messages) && !ensureRun().recoveryAttempted)
					|| isTransientDivoRunFailure(event.messages)
				)
			) {
				// Pi handles oversized context and the controller handles transient
				// provider failures after this event returns. Keep either recovery
				// inside this trace until it succeeds or the session closes.
				ensureRun().pendingRecoveryFailure = terminal;
				ensureRun().pendingRecoveryKind = isRecoverableDivoRequestTooLarge(event.messages)
					? "oversize"
					: "transient";
				pendingArgs.clear();
				flush();
				return;
			}
			if (terminal.status === "ok") {
				const context = buildLearningContext(event.messages, ensureRun().learningTools);
				push({ kind: "learning_context", ...context });
			}
			finishRun(terminal);
		});
	});

	pi.on("session_shutdown", () => {
		guard(() => {
			failPendingRecovery(
				run?.pendingRecoveryKind === "oversize"
					? "Oversized-request recovery ended without an assistant continuation before the session closed."
					: "Transient model recovery ended without an assistant continuation before the session closed.",
			);
		});
	});
}

function isProtectedShopifyInvocation(toolName: string, _input: unknown): boolean {
	return toolName === "divo_shopify_orders" || toolName === "divo_shopify_customers";
}

/** Extract only bounded text needed for the backend's manager-learning pass. */
function buildLearningContext(
	messages: readonly unknown[],
	toolSummary: readonly { toolName: string; isError: boolean }[],
): Omit<Extract<TraceEvent, { kind: "learning_context" }>, "seq" | "ts" | "kind"> {
	const userMessages = messages
		.flatMap(message => {
			const record = asRecord(message);
			return record?.role === "user" ? [messageContentText(record)] : [];
		})
		.filter(Boolean)
		.slice(-12)
		.map(text => text.slice(0, 2_000));
	const assistant = [...messages]
		.reverse()
		.map(asRecord)
		.find(message => message?.role === "assistant" && message.stopReason === "stop");
	const assistantResponse = assistant ? messageContentText(assistant).slice(0, 4_000) : undefined;
	return {
		userMessages,
		...(assistantResponse ? { assistantResponse } : {}),
		toolSummary: toolSummary.slice(-20),
	};
}

function messageContentText(message: JsonRecord): string {
	const content = message.content;
	if (typeof content === "string") return content.trim();
	if (Array.isArray(content)) {
		return content
			.map(part => {
				if (typeof part === "string") return part;
				const record = asRecord(part);
				return typeof record?.text === "string" ? record.text : "";
			})
			.filter(Boolean)
			.join("\n")
			.trim();
	}
	return typeof message.text === "string" ? message.text.trim() : "";
}
