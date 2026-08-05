import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, it } from "node:test";
import {
	classifyDivoRunTerminal,
	isRecoverableDivoRequestTooLarge,
	registerTraceCapture,
} from "./trace.ts";

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = ORIGINAL_FETCH;
	delete process.env.DIVO_RUN_CONTEXT_PATH;
	delete process.env.DIVO_BACKEND_URL;
	delete process.env.DIVO_MEMBER_TOKEN;
	delete process.env.DIVO_LLM_PROXY_ACTIVE;
});

async function traceHarness(runId: string, channel?: "lark") {
	const directory = await mkdtemp(join(tmpdir(), "divo-trace-lifecycle-"));
	const contextPath = join(directory, "run.json");
	await writeFile(contextPath, JSON.stringify({
		version: 1,
		threadId: `thread-${runId}`,
		runId,
		...(channel ? { channel } : {}),
	}));
	process.env.DIVO_RUN_CONTEXT_PATH = contextPath;
	process.env.DIVO_BACKEND_URL = "http://localhost:8000";
	process.env.DIVO_MEMBER_TOKEN = "member-token";
	process.env.DIVO_LLM_PROXY_ACTIVE = "1";

	const batches: Array<Record<string, any>> = [];
	globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
		batches.push(JSON.parse(String(init?.body)));
		return new Response(JSON.stringify({ success: true }), { status: 202 });
	}) as typeof fetch;
	const handlers = new Map<string, (event: any, ctx: any) => unknown>();
	registerTraceCapture({
		on: (name: string, handler: (event: any, ctx: any) => unknown) => {
			handlers.set(name, handler);
		},
	} as never);
	return { batches, handlers };
}

const REQUEST_TOO_LARGE_MESSAGE = {
	role: "assistant",
	provider: "deepseek",
	model: "deepseek-v4-flash",
	stopReason: "error",
	errorMessage: "request_too_large (HTTP 413, payload_too_large)",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const SUCCESS_MESSAGE = {
	role: "assistant",
	provider: "deepseek",
	model: "deepseek-v4-flash",
	stopReason: "stop",
	usage: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0 },
};

const LUNA_REQUEST_TOO_LARGE_MESSAGE = {
	...REQUEST_TOO_LARGE_MESSAGE,
	provider: "openai",
	model: "gpt-5.6-luna",
};

describe("Divo trace terminal classification", () => {
	it("accepts only a stopped assistant completion with recorded tokens", () => {
		assert.deepEqual(classifyDivoRunTerminal([{
			role: "assistant",
			stopReason: "stop",
			usage: { input: 12, output: 3, cacheRead: 0, cacheWrite: 0 },
		}]), { status: "ok" });
	});

	it("fails an explicit zero-token completion", () => {
		assert.deepEqual(classifyDivoRunTerminal([{
			role: "assistant",
			stopReason: "stop",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		}]), {
			status: "error",
			summary: "Assistant model call completed with zero tokens; no model continuation was produced.",
		});
	});

	it("fails a provider error and preserves a bounded reason", () => {
		assert.deepEqual(classifyDivoRunTerminal([{
			role: "assistant",
			stopReason: "error",
			errorMessage: "request_too_large (HTTP 413, payload_too_large)",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		}]), {
			status: "error",
			summary: "Assistant error: request_too_large (HTTP 413, payload_too_large)",
		});
	});

	it("identifies request-too-large failures from every Divo-proxied provider as recoverable", () => {
		assert.equal(isRecoverableDivoRequestTooLarge([REQUEST_TOO_LARGE_MESSAGE]), true);
		assert.equal(isRecoverableDivoRequestTooLarge([LUNA_REQUEST_TOO_LARGE_MESSAGE]), true);
		assert.equal(isRecoverableDivoRequestTooLarge([{
			...REQUEST_TOO_LARGE_MESSAGE,
			provider: "anthropic",
		}]), false);
		assert.equal(isRecoverableDivoRequestTooLarge([{
			...REQUEST_TOO_LARGE_MESSAGE,
			errorMessage: "429 rate limit",
		}]), false);
	});

	it("fails when agent_end arrives before the post-tool assistant continuation", () => {
		assert.deepEqual(classifyDivoRunTerminal([
			{ role: "assistant", stopReason: "toolUse", usage: { input: 10, output: 2 } },
			{ role: "toolResult", toolCallId: "call-1" },
		]), {
			status: "error",
			summary: "Run ended before the assistant continuation completed (terminal toolResult).",
		});
	});
});

describe("Divo trace correlation", () => {
	it("marks a Lark trace so the backend does not capture personal learning twice", async () => {
		const { batches, handlers } = await traceHarness("run-lark", "lark");

		await handlers.get("agent_start")?.({ type: "agent_start" }, {});
		handlers.get("agent_end")?.({ messages: [SUCCESS_MESSAGE] }, {});

		assert.ok(batches.length > 0);
		assert.equal(batches.every((batch) => batch.runtimeChannel === "lark"), true);
	});

	it("injects desktop run correlation into every governed model request", async () => {
		const directory = await mkdtemp(join(tmpdir(), "divo-trace-"));
		const contextPath = join(directory, "run.json");
		await writeFile(contextPath, JSON.stringify({
			version: 1,
			threadId: "thread-1",
			runId: "run-1",
		}));
		process.env.DIVO_RUN_CONTEXT_PATH = contextPath;
		process.env.DIVO_BACKEND_URL = "http://localhost:8000";
		process.env.DIVO_MEMBER_TOKEN = "member-token";
		process.env.DIVO_LLM_PROXY_ACTIVE = "1";

		const handlers = new Map<string, (event: any, ctx: any) => unknown>();
		registerTraceCapture({
			on: (name: string, handler: (event: any, ctx: any) => unknown) => {
				handlers.set(name, handler);
			},
		} as never);

		await handlers.get("agent_start")?.({ type: "agent_start" }, {});
		const payload = await handlers.get("before_provider_request")?.(
			{ type: "before_provider_request", payload: { model: "deepseek-v4-flash" } },
			{ model: { provider: "deepseek" } },
		);
		assert.deepEqual(payload, {
			model: "deepseek-v4-flash",
			divo_run_id: "run-1",
			divo_trace_mode: "desktop",
		});

		const lunaPayload = await handlers.get("before_provider_request")?.(
			{ type: "before_provider_request", payload: { model: "gpt-5.6-luna" } },
			{ model: { provider: "openai" } },
		);
		assert.deepEqual(lunaPayload, {
			model: "gpt-5.6-luna",
			divo_run_id: "run-1",
			divo_trace_mode: "desktop",
		});

		const untouched = await handlers.get("before_provider_request")?.(
			{ type: "before_provider_request", payload: { model: "other" } },
			{ model: { provider: "anthropic" } },
		);
		assert.equal(untouched, undefined);
	});

	it("keeps one monotonic run across 413 compaction retry and final success", async () => {
		const { batches, handlers } = await traceHarness("run-recovered");

		await handlers.get("agent_start")?.({ type: "agent_start" }, {});
		handlers.get("message_end")?.({ message: REQUEST_TOO_LARGE_MESSAGE }, {});
		handlers.get("turn_end")?.({ turnIndex: 0 }, {});
		handlers.get("agent_end")?.({ messages: [REQUEST_TOO_LARGE_MESSAGE] }, {});

		assert.equal(
			batches.flatMap((batch) => batch.events).some((event) => event.kind === "run_end"),
			false,
		);

		process.env.DIVO_RUN_CONTEXT_PATH = join(
			tmpdir(),
			`missing-divo-correlation-${Date.now()}.json`,
		);
		await handlers.get("agent_start")?.({ type: "agent_start" }, {});
		const retryPayload = await handlers.get("before_provider_request")?.(
			{ payload: { model: "deepseek-v4-flash" } },
			{ model: { provider: "deepseek" } },
		);
		assert.deepEqual(retryPayload, {
			model: "deepseek-v4-flash",
			divo_run_id: "run-recovered",
			divo_trace_mode: "desktop",
		});
		handlers.get("message_end")?.({ message: SUCCESS_MESSAGE }, {});
		handlers.get("turn_end")?.({ turnIndex: 0 }, {});
		handlers.get("agent_end")?.({ messages: [SUCCESS_MESSAGE] }, {});

		const events = batches.flatMap((batch) => batch.events);
		assert.deepEqual(batches.map((batch) => batch.runId), [
			"run-recovered",
			"run-recovered",
			"run-recovered",
		]);
		assert.deepEqual(events.map((event) => event.seq), [0, 1, 2, 3, 4, 5, 6]);
		assert.equal(events.filter((event) => event.kind === "run_start").length, 1);
		assert.deepEqual(events.filter((event) => event.kind === "learning_context"), [{
			kind: "learning_context",
			userMessages: [],
			toolSummary: [],
			seq: 5,
			ts: events[5].ts,
		}]);
		assert.deepEqual(events.filter((event) => event.kind === "run_end"), [{
			kind: "run_end",
			status: "ok",
			seq: 6,
			ts: events.at(-1).ts,
		}]);
	});

	it("marks every later batch after a protected Shopify invocation", async () => {
		const { batches, handlers } = await traceHarness("run-shopify-protected");
		await handlers.get("agent_start")?.({ type: "agent_start" }, {});
		handlers.get("tool_execution_start")?.({
			toolCallId: "call-1",
			args: {
				op: "tools.invoke",
				payload: { toolId: "shopifyCustomers", args: { operation: "count_customers" } },
			},
		}, {});
		handlers.get("tool_execution_end")?.({
			toolCallId: "call-1",
			toolName: "divo_gateway",
			result: { data: { count: 0 } },
			isError: false,
		}, {});
		handlers.get("turn_end")?.({ turnIndex: 0 }, {});
		handlers.get("agent_end")?.({ messages: [SUCCESS_MESSAGE] }, {});

		assert.equal(batches.length, 2);
		assert.ok(batches.every(batch => batch.protectedDataObserved === true));
	});

	it("emits one failure after the 413 recovery retry produces no real continuation", async () => {
		const { batches, handlers } = await traceHarness("run-recovery-exhausted");

		await handlers.get("agent_start")?.({ type: "agent_start" }, {});
		handlers.get("message_end")?.({ message: REQUEST_TOO_LARGE_MESSAGE }, {});
		handlers.get("turn_end")?.({ turnIndex: 0 }, {});
		handlers.get("agent_end")?.({ messages: [REQUEST_TOO_LARGE_MESSAGE] }, {});
		await handlers.get("agent_start")?.({ type: "agent_start" }, {});
		handlers.get("message_end")?.({ message: REQUEST_TOO_LARGE_MESSAGE }, {});
		handlers.get("turn_end")?.({ turnIndex: 0 }, {});
		handlers.get("agent_end")?.({ messages: [REQUEST_TOO_LARGE_MESSAGE] }, {});

		const events = batches.flatMap((batch) => batch.events);
		assert.deepEqual(events.map((event) => event.seq), [0, 1, 2, 3, 4, 5]);
		assert.equal(events.filter((event) => event.kind === "run_start").length, 1);
		assert.deepEqual(events.filter((event) => event.kind === "run_end"), [{
			kind: "run_end",
			status: "error",
			summary: "Assistant error: request_too_large (HTTP 413, payload_too_large)",
			seq: 5,
			ts: events.at(-1).ts,
		}]);
	});

	it("fails a deferred 413 when the session closes without any recovery continuation", async () => {
		const { batches, handlers } = await traceHarness("run-no-recovery");

		await handlers.get("agent_start")?.({ type: "agent_start" }, {});
		handlers.get("message_end")?.({ message: REQUEST_TOO_LARGE_MESSAGE }, {});
		handlers.get("turn_end")?.({ turnIndex: 0 }, {});
		handlers.get("agent_end")?.({ messages: [REQUEST_TOO_LARGE_MESSAGE] }, {});
		handlers.get("session_shutdown")?.({ reason: "exit" }, {});

		const events = batches.flatMap((batch) => batch.events);
		assert.deepEqual(events.filter((event) => event.kind === "run_end"), [{
			kind: "run_end",
			status: "error",
			summary: "Oversized-request recovery ended without an assistant continuation before the session closed.",
			seq: 3,
			ts: events.at(-1).ts,
		}]);
	});

	it("emits a failed terminal run event for an unstarted continuation", async () => {
		const directory = await mkdtemp(join(tmpdir(), "divo-trace-terminal-"));
		const contextPath = join(directory, "run.json");
		await writeFile(contextPath, JSON.stringify({
			version: 1,
			threadId: "thread-terminal",
			runId: "run-terminal",
		}));
		process.env.DIVO_RUN_CONTEXT_PATH = contextPath;
		process.env.DIVO_BACKEND_URL = "http://localhost:8000";
		process.env.DIVO_MEMBER_TOKEN = "member-token";

		const batches: Array<Record<string, any>> = [];
		globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
			batches.push(JSON.parse(String(init?.body)));
			return new Response(JSON.stringify({ success: true }), { status: 202 });
		}) as typeof fetch;
		const handlers = new Map<string, (event: any, ctx: any) => unknown>();
		registerTraceCapture({
			on: (name: string, handler: (event: any, ctx: any) => unknown) => {
				handlers.set(name, handler);
			},
		} as never);

		await handlers.get("agent_start")?.({ type: "agent_start" }, {});
		handlers.get("agent_end")?.({
			type: "agent_end",
			messages: [
				{ role: "assistant", stopReason: "toolUse", usage: { input: 10, output: 2 } },
				{ role: "toolResult", toolCallId: "call-1" },
			],
		}, {});

		assert.equal(batches.length, 1);
		assert.deepEqual(batches[0]?.events.at(-1), {
			kind: "run_end",
			status: "error",
			summary: "Run ended before the assistant continuation completed (terminal toolResult).",
			seq: 1,
			ts: batches[0]?.events.at(-1).ts,
		});
	});
});
