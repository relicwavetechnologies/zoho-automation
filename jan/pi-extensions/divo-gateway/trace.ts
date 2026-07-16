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
	| { kind: "run_start" | "run_end" | "turn_start" | "turn_end"; seq: number; ts: number; title?: string; status?: "ok" | "error" };

interface RunState {
	runId: string;
	threadId?: string;
	proxyOwnsUsage: boolean;
	seq: number;
	buffer: TraceEvent[];
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as JsonRecord)
		: undefined;
}

async function tryReadRunCorrelation(): Promise<{ runId: string; threadId: string } | null> {
	try {
		const value = await readDivoRunCorrelation();
		return { runId: value.runId, threadId: value.threadId };
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

export function registerTraceCapture(pi: ExtensionAPI): void {
	let run: RunState | null = null;
	const pendingArgs = new Map<string, unknown>();

	const startRun = (correlation: { runId: string; threadId: string }): RunState => {
		run = {
			runId: correlation.runId,
			threadId: correlation.threadId,
			proxyOwnsUsage: false,
			seq: 0,
			buffer: [],
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
				usageAuthority: run.proxyOwnsUsage ? "proxy" : "desktop",
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
		if (!correlation) return;
		guard(() => {
			startRun(correlation);
			push({ kind: "run_start", title: "Run started" });
		});
	});

	// Correlate the Divo-owned DeepSeek proxy request with this exact desktop
	// run. The proxy keeps authoritative token usage while this extension owns
	// the detailed local tool/model timeline.
	pi.on("before_provider_request", async (event, ctx) => {
		if (ctx.model?.provider !== "deepseek") return undefined;
		if (process.env.DIVO_LLM_PROXY_ACTIVE !== "1") return undefined;
		if ("error" in resolveDivoGatewayConfig()) return undefined;
		const correlation = await tryReadRunCorrelation();
		const payload = asRecord(event.payload);
		if (!correlation || !payload) return undefined;
		if (run?.runId === correlation.runId) run.proxyOwnsUsage = true;
		return {
			...payload,
			divo_run_id: correlation.runId,
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
			push({
				kind: "tool",
				toolName: event.toolName,
				input: cap(input),
				output: cap(event.result),
				isError: event.isError,
			});
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

	pi.on("agent_end", () => {
		guard(() => {
			push({ kind: "run_end", status: "ok" });
			flush();
			run = null;
			pendingArgs.clear();
		});
	});
}
