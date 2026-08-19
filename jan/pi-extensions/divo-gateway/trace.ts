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
import { resolveDivoGatewayConfig } from "./gateway-client.ts";
import { readDivoRunCorrelation } from "./run-correlation.ts";

const TRACE_PATH = "/api/desktop/trace";
const POST_TIMEOUT_MS = 15_000;
const WIRE_CAP = 16_000; // per-field cap; backend caps again defensively
const MAX_BUFFER = 2_000; // bound memory if the backend is unreachable

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
	| {
		kind: "span";
		seq: number;
		ts: number;
		spanId: string;
		parentSpanId?: string;
		name: string;
		category: "provider" | "tool";
		source: "pi-extension";
		startedAt: number;
		endedAt: number;
		durationMs: number;
		status: "ok" | "error";
		attributes?: Record<string, string | number | boolean | null>;
	}
	| { kind: "run_start" | "run_end" | "turn_start" | "turn_end"; seq: number; ts: number; title?: string; summary?: string; status?: "ok" | "error" }
	| {
		kind: "learning_context";
		seq: number;
		ts: number;
		userMessages: string[];
		assistantResponse?: string;
		toolSummary: Array<{ toolName: string; isError: boolean }>;
	};

interface RunState {
	runId: string;
	threadId?: string;
	runtimeChannel?: "lark";
	proxyOwnsUsage: boolean;
	recoveryAttempted: boolean;
	pendingRecoveryFailure?: DivoRunTerminal;
	seq: number;
	buffer: TraceEvent[];
	learningTools: Array<{ toolName: string; isError: boolean }>;
	protectedDataObserved: boolean;
	providerAttempt: number;
	pendingProvider?: {
		spanId: string;
		startedAt: number;
		provider: string;
		model: string;
		attempt: number;
	};
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
	channel?: "lark";
} | null> {
	try {
		const value = await readDivoRunCorrelation();
		return {
			runId: value.runId,
			threadId: value.threadId,
			...(value.channel === "lark" ? { channel: "lark" as const } : {}),
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

/**
 * Pi emits agent_end for both successful and failed loops. A run is complete
 * only when its final generated message is a real assistant completion with a
 * successful stop reason and any explicitly reported usage is non-zero.
 */
export function classifyDivoRunTerminal(messages: readonly unknown[]): DivoRunTerminal {
	const last = asRecord(messages.at(-1));
	if (!last || last.role !== "assistant") {
		const role = typeof last?.role === "string" ? last.role : "no message";
		return {
			status: "error",
			summary: `Run ended before the assistant continuation completed (terminal ${role}).`,
		};
	}

	const stopReason = typeof last.stopReason === "string" ? last.stopReason : undefined;
	if (stopReason !== "stop") {
		const errorMessage = typeof last.errorMessage === "string"
			? last.errorMessage.trim().slice(0, 1_500)
			: "";
		return {
			status: "error",
			summary: errorMessage
				? `Assistant ${stopReason ?? "unknown"}: ${errorMessage}`
				: `Assistant ended with non-success stop reason ${stopReason ?? "unknown"}.`,
		};
	}

	const usage = asRecord(last.usage);
	const input = usage?.input;
	const output = usage?.output;
	if (typeof input === "number" && typeof output === "number") {
		const cacheRead = typeof usage?.cacheRead === "number" ? usage.cacheRead : 0;
		const cacheWrite = typeof usage?.cacheWrite === "number" ? usage.cacheWrite : 0;
		if (input + output + cacheRead + cacheWrite === 0) {
			return {
				status: "error",
				summary: "Assistant model call completed with zero tokens; no model continuation was produced.",
			};
		}
	}

	return { status: "ok" };
}

/** Pi recognizes this normalized Divo 413 as context overflow and retries it after compaction. */
export function isRecoverableDivoRequestTooLarge(messages: readonly unknown[]): boolean {
	const last = asRecord(messages.at(-1));
	if (!last || last.role !== "assistant" || last.stopReason !== "error") return false;
	if (last.provider !== "deepseek") return false;
	const errorMessage = typeof last.errorMessage === "string" ? last.errorMessage : "";
	return /request[_ ]too[_ ]large|payload[_ ]too[_ ]large|entity\.too\.large|PayloadTooLargeError|\b413\b/i.test(errorMessage);
}

export function registerTraceCapture(pi: ExtensionAPI): void {
	let run: RunState | null = null;
	const pendingTools = new Map<string, {
		args: unknown;
		startedAt: number;
		spanId: string;
		toolName: string;
	}>();

	const startRun = (correlation: {
		runId: string;
		threadId: string;
		channel?: "lark";
	}): RunState => {
		run = {
			runId: correlation.runId,
			threadId: correlation.threadId,
			...(correlation.channel === "lark" ? { runtimeChannel: "lark" as const } : {}),
			proxyOwnsUsage: false,
			recoveryAttempted: false,
			seq: 0,
			buffer: [],
			learningTools: [],
			protectedDataObserved: false,
			providerAttempt: 0,
		};
		pendingTools.clear();
		return run;
	};
	const ensureRun = (): RunState => {
		if (!run) {
			throw new Error("Divo trace received an event before desktop run correlation was available");
		}
		return run;
	};

	const push = (ev: Omit<Extract<TraceEvent, { kind: string }>, "seq" | "ts">): void => {
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
		pendingTools.clear();
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
				// Pi's compact-and-retry path starts a second low-level agent loop.
				// Keep the same trace/run sequence and suppress a duplicate run_start.
				run.pendingRecoveryFailure = undefined;
				run.recoveryAttempted = true;
				pendingTools.clear();
				return;
			}
			if (!correlation) return;
			if (run?.pendingRecoveryFailure) {
				failPendingRecovery(
					"Oversized-request recovery ended before a same-run assistant continuation started.",
				);
			}
			startRun(correlation);
			push({ kind: "run_start", title: "Run started" });
		});
	});

	// Correlate the Divo-owned DeepSeek proxy request with this exact desktop
	// run. The proxy keeps authoritative token usage while this extension owns
	// the detailed local tool/model timeline.
	pi.on("before_provider_request", async (event, ctx) => {
		if (!ctx.model || !run) return undefined;
		const provider = String(ctx.model.provider);
		const requestPayload = asRecord(event.payload);
		const model = String(requestPayload?.model ?? "unknown");
		const attempt = ++run.providerAttempt;
		const spanId = `pi.provider.${attempt}`;
		if (run.pendingProvider) {
			const previous = run.pendingProvider;
			const endedAt = Date.now();
			push({
				kind: "span",
				spanId: previous.spanId,
				...(run.runtimeChannel ? { parentSpanId: "controller.model" } : {}),
				name: "provider.continuation",
				category: "provider",
				source: "pi-extension",
				startedAt: previous.startedAt,
				endedAt,
				durationMs: Math.max(0, endedAt - previous.startedAt),
				status: "error",
				attributes: {
					provider: previous.provider,
					model: previous.model,
					attempt: previous.attempt,
					reason: "superseded",
				},
			});
		}
		run.pendingProvider = { spanId, startedAt: Date.now(), provider, model, attempt };
		if (ctx.model.provider !== "deepseek") return undefined;
		if (process.env.DIVO_LLM_PROXY_ACTIVE !== "1") return undefined;
		if ("error" in resolveDivoGatewayConfig()) return undefined;
		const correlation = await tryReadRunCorrelation();
		const payload = requestPayload;
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
			divo_parent_span_id: spanId,
		};
	});

	pi.on("turn_start", (event) => {
		guard(() => push({ kind: "turn_start", title: `Turn ${event.turnIndex + 1}` }));
	});

	pi.on("tool_execution_start", (event) => {
		guard(() => pendingTools.set(event.toolCallId, {
			args: event.args,
			startedAt: Date.now(),
			spanId: toolSpanId(event.toolCallId),
			toolName: event.toolName,
		}));
	});

	pi.on("tool_execution_end", (event) => {
		guard(() => {
			const pending = pendingTools.get(event.toolCallId);
			const input = pending?.args;
			pendingTools.delete(event.toolCallId);
			if (pending) {
				const endedAt = Date.now();
				push({
					kind: "span",
					spanId: pending.spanId,
					...(ensureRun().runtimeChannel ? { parentSpanId: "controller.model" } : {}),
					name: "tool.execute",
					category: "tool",
					source: "pi-extension",
					startedAt: pending.startedAt,
					endedAt,
					durationMs: Math.max(0, endedAt - pending.startedAt),
					status: event.isError ? "error" : "ok",
					attributes: { toolName: event.toolName || pending.toolName },
				});
			}
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
			const pending = ensureRun().pendingProvider;
			if (pending) {
				const endedAt = Date.now();
				push({
					kind: "span",
					spanId: pending.spanId,
					...(ensureRun().runtimeChannel ? { parentSpanId: "controller.model" } : {}),
					name: "provider.continuation",
					category: "provider",
					source: "pi-extension",
					startedAt: pending.startedAt,
					endedAt,
					durationMs: Math.max(0, endedAt - pending.startedAt),
					status: m.stopReason === "error" ? "error" : "ok",
					attributes: {
						provider: pending.provider,
						model: pending.model,
						attempt: pending.attempt,
						...(u ? {
							inputTokens: u.input,
							outputTokens: u.output,
							cacheReadTokens: u.cacheRead,
							cacheWriteTokens: u.cacheWrite,
						} : {}),
					},
				});
				ensureRun().pendingProvider = undefined;
			}
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
			const terminal = classifyDivoRunTerminal(event.messages);
			if (
				terminal.status === "error"
				&& isRecoverableDivoRequestTooLarge(event.messages)
				&& !ensureRun().recoveryAttempted
			) {
				// Pi decides whether to compact and retry only after this extension
				// event returns. Defer the terminal event until the retry succeeds,
				// exhausts recovery, or another lifecycle boundary proves no retry ran.
				ensureRun().pendingRecoveryFailure = terminal;
				pendingTools.clear();
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
				"Oversized-request recovery ended without an assistant continuation before the session closed.",
			);
		});
	});
}

/** Stable parent ID shared with the backend gateway adapter. */
function toolSpanId(toolCallId: string): string {
	return `pi.tool.${toolCallId}`.slice(0, 300);
}

function isProtectedShopifyInvocation(toolName: string, input: unknown): boolean {
	if (toolName !== "divo_gateway") return false;
	const request = asRecord(input);
	if (request?.op !== "tools.invoke") return false;
	const toolId = asRecord(request.payload)?.toolId;
	return toolId === "shopifyOrders" || toolId === "shopifyCustomers";
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
