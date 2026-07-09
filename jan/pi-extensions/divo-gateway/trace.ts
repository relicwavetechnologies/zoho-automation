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
 * Boundaries: one agent loop (agent_start → agent_end) is one run. PI mints the
 * runId; the backend correlates it (as requestId) into a single ExecutionRun.
 */

import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveDivoGatewayConfig } from "./gateway-client.ts";

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
	seq: number;
	buffer: TraceEvent[];
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

	const startRun = (): RunState => {
		run = { runId: randomUUID(), seq: 0, buffer: [] };
		pendingArgs.clear();
		return run;
	};
	const ensureRun = (): RunState => run ?? startRun();

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
			body: JSON.stringify({ runId, events: batch }),
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

	pi.on("agent_start", () => {
		guard(() => {
			startRun();
			push({ kind: "run_start", title: "Run started" });
		});
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
