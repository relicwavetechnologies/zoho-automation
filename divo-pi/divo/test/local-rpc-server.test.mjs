import assert from "node:assert/strict";
import test from "node:test";
import {
	CAPACITY_MESSAGE,
	createAdmissionController,
	createControllerServer,
} from "../local-rpc-server.mjs";
import {
	collectRunAssistantText,
	promptWithTransientRetries,
	projectRuntimeProgress,
} from "../local-rpc-controller.mjs";
import { isTransientDivoRunFailure } from "../run-terminal.mjs";

function deferred() {
	let resolve;
	const promise = new Promise((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

const protectedCustomerRef = {
	provider: "shopify",
	connectionId: "11111111-1111-4111-8111-111111111111",
	resourceType: "customer",
	resourceId: "gid://shopify/Customer/123456789",
};

test("final delivery excludes progress narration before the terminal answer", () => {
	assert.equal(
		collectRunAssistantText([
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Complete report" },
					{ type: "toolCall", name: "divo_todos", arguments: {} },
				],
			},
			{
				role: "toolResult",
				content: [{ type: "text", text: "Checklist complete" }],
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "The report above is complete." }],
			},
		]),
		"The report above is complete.",
	);
});
test("final delivery returns only assistant text and handles a normal terminal answer", () => {
	assert.equal(
		collectRunAssistantText([
			{ role: "user", content: [{ type: "text", text: "Historical prompt" }] },
			{ role: "toolResult", content: [{ type: "text", text: "Private tool output" }] },
			{ role: "assistant", content: [{ type: "thinking", thinking: "Private reasoning" }] },
			{ role: "assistant", content: [{ type: "text", text: "  Final answer  " }] },
		]),
		"Final answer",
	);
});

test("a successful retry does not deliver narration from the failed attempt", () => {
	assert.equal(
		collectRunAssistantText([
			{ role: "assistant", content: [{ type: "text", text: "Let me inspect that." }] },
			{ role: "assistant", stopReason: "error", errorMessage: "502: Upstream unreachable", content: [] },
			{ role: "user", content: [{ type: "text", text: "Continue after the provider failure." }] },
			{
				role: "assistant",
				stopReason: "stop",
				content: [{ type: "text", text: "Final verified answer" }],
			},
		]),
		"Final verified answer",
	);
});

test("transient model failures retry the continuation three times", async () => {
	const completions = [
		...Array.from({ length: 3 }, () => ({
			type: "agent_end",
			messages: [{
				role: "assistant",
				stopReason: "error",
				errorMessage: '502: {"message":"Upstream unreachable","type":"upstream"}',
				content: [],
			}],
		})),
		{
			type: "agent_end",
			messages: [{
				role: "assistant",
				stopReason: "stop",
				usage: { input: 10, output: 5 },
				content: [{ type: "text", text: "Recovered answer" }],
			}],
		},
	];
	const sent = [];
	const retries = [];
	const rpc = {
		waitFor: () => Promise.resolve(completions.shift()),
		send: async (command) => {
			if (command.type === "get_state") return { isStreaming: false, isCompacting: false };
			sent.push(command);
		},
	};

	const completion = await promptWithTransientRetries({
		rpc,
		message: "Original request",
		retryDelayMs: 0,
		onRetry: (retry) => retries.push(retry),
	});

	assert.equal(collectRunAssistantText(completion.messages), "Recovered answer");
	assert.equal(sent.length, 4);
	assert.equal(sent[0].message, "Original request");
	assert.match(sent[1].message, /Do not repeat completed tool calls or side effects/);
	assert.deepEqual(retries.map((retry) => retry.attempt), [1, 2, 3]);
});

test("a terminated provider stream retries the continuation", async () => {
	const completions = [
		{
			messages: [{
				role: "assistant",
				stopReason: "error",
				errorMessage: "terminated",
				content: [],
			}],
		},
		{
			messages: [{
				role: "assistant",
				stopReason: "stop",
				usage: { input: 10, output: 5 },
				content: [{ type: "text", text: "Recovered answer" }],
			}],
		},
	];
	const prompts = [];
	const rpc = {
		waitFor: () => Promise.resolve(completions.shift()),
		send: async (command) => {
			if (command.type === "get_state") return { isStreaming: false, isCompacting: false };
			prompts.push(command.message);
		},
	};

	const completion = await promptWithTransientRetries({
		rpc,
		message: "Original request",
		retryDelayMs: 0,
	});

	assert.equal(collectRunAssistantText(completion.messages), "Recovered answer");
	assert.equal(prompts.length, 2);
});

test("provider transport failures share one retry classification", () => {
	for (const errorMessage of [
		"terminated",
		"Connection error.",
		"Network error",
		"WebSocket closed",
		"stream ended before message_stop",
	]) {
		assert.equal(isTransientDivoRunFailure([{
			role: "assistant",
			stopReason: "error",
			errorMessage,
		}]), true, errorMessage);
	}
	assert.equal(isTransientDivoRunFailure([{
		role: "assistant",
		stopReason: "error",
		errorMessage: "insufficient_quota",
	}]), false);
});

test("a transient retry waits until the Pi runtime is idle", async () => {
	const completions = [
		{
			messages: [{
				role: "assistant",
				stopReason: "error",
				errorMessage: "502: Upstream unreachable",
				content: [],
			}],
		},
		{
			messages: [{
				role: "assistant",
				stopReason: "stop",
				usage: { input: 10, output: 5 },
				content: [{ type: "text", text: "Recovered answer" }],
			}],
		},
	];
	const prompts = [];
	let stateChecks = 0;
	const rpc = {
		waitFor: () => Promise.resolve(completions.shift()),
		send: async (command) => {
			if (command.type === "get_state") {
				stateChecks += 1;
				return { isStreaming: stateChecks < 3, isCompacting: false };
			}
			prompts.push(command.message);
		},
	};

	await promptWithTransientRetries({
		rpc,
		message: "Original request",
		retryDelayMs: 0,
	});

	assert.equal(stateChecks, 3);
	assert.equal(prompts.length, 2);
});

test("cancellation interrupts transient retry backoff before another prompt", async () => {
	const controller = new AbortController();
	const sent = [];
	const rpc = {
		waitFor: () => Promise.resolve({
			messages: [{
				role: "assistant",
				stopReason: "error",
				errorMessage: "502: Upstream unreachable",
				content: [],
			}],
		}),
		send: async (command) => sent.push(command),
	};

	await assert.rejects(
		promptWithTransientRetries({
			rpc,
			message: "Original request",
			retryDelayMs: 60_000,
			signal: controller.signal,
			onRetry: () => controller.abort(new Error("request disconnected")),
		}),
		/request disconnected/,
	);
	assert.equal(sent.length, 1);
});

test("a transient failure after a completed gateway action is not retried", async () => {
	const rpc = {
		waitFor: () => Promise.resolve({
			messages: [
				{ role: "user", content: [{ type: "text", text: "Create the record" }] },
				{
					role: "assistant",
					stopReason: "toolUse",
					content: [{
						type: "toolCall",
						id: "call-1",
						name: "divo_gateway",
						arguments: { op: "tools.invoke" },
					}],
				},
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "divo_gateway",
					isError: false,
					content: [{ type: "text", text: "Created" }],
				},
				{
					role: "assistant",
					stopReason: "error",
					errorMessage: "502: Upstream unreachable",
					content: [],
				},
			],
		}),
		send: async () => undefined,
	};

	await assert.rejects(
		promptWithTransientRetries({
			rpc,
			message: "Original request",
			retryDelayMs: 0,
		}),
		/failed after a company action was issued/,
	);
});

test("a transient failure after a mutation and later read returns a truthful safe completion", async () => {
	let prompts = 0;
	const rpc = {
		waitFor: () => Promise.resolve({
			messages: [
				{ role: "user", content: [{ type: "text", text: "Update the sheet" }] },
				{
					role: "assistant",
					content: [{
						type: "toolCall",
						id: "write-1",
						name: "divo_gateway",
						arguments: { op: "tools.invoke" },
					}],
				},
				{
					role: "toolResult",
					toolCallId: "write-1",
					toolName: "divo_gateway",
					isError: false,
					details: { data: { action: "update" } },
				},
				{
					role: "assistant",
					content: [{
						type: "toolCall",
						id: "read-1",
						name: "divo_gateway",
						arguments: { op: "tools.invoke" },
					}],
				},
				{
					role: "toolResult",
					toolCallId: "read-1",
					toolName: "divo_gateway",
					isError: false,
					details: { data: { action: "read" } },
				},
				{
					role: "assistant",
					stopReason: "error",
					errorMessage: "502: Upstream unreachable",
					content: [],
				},
			],
		}),
		send: async () => {
			prompts += 1;
		},
	};

	const completion = await promptWithTransientRetries({
		rpc,
		message: "Original request",
		retryDelayMs: 0,
	});

	assert.equal(prompts, 1);
	assert.match(collectRunAssistantText(completion.messages), /subsequent read also succeeded/i);
	assert.match(collectRunAssistantText(completion.messages), /did not repeat/i);
});

test("a transient failure after read-only gateway calls may retry", async () => {
	const completions = [
		{
			messages: [
				{ role: "user", content: [{ type: "text", text: "Read the sheet" }] },
				{
					role: "assistant",
					content: [{
						type: "toolCall",
						id: "read-1",
						name: "divo_gateway",
						arguments: { op: "tools.invoke" },
					}],
				},
				{
					role: "toolResult",
					toolCallId: "read-1",
					toolName: "divo_gateway",
					isError: false,
					details: { data: { action: "read" } },
				},
				{
					role: "assistant",
					stopReason: "error",
					errorMessage: "502: Upstream unreachable",
					content: [],
				},
			],
		},
		{
			messages: [{
				role: "assistant",
				stopReason: "stop",
				usage: { input: 10, output: 5 },
				content: [{ type: "text", text: "Recovered read" }],
			}],
		},
	];
	const rpc = {
		waitFor: () => Promise.resolve(completions.shift()),
		send: async (command) => (
			command.type === "get_state"
				? { isStreaming: false, isCompacting: false }
				: undefined
		),
	};

	const completion = await promptWithTransientRetries({
		rpc,
		message: "Original request",
		retryDelayMs: 0,
	});

	assert.equal(collectRunAssistantText(completion.messages), "Recovered read");
});

test("a transient failure after an unknown gateway action is not retried", async () => {
	let prompts = 0;
	const rpc = {
		waitFor: () => Promise.resolve({
			messages: [
				{ role: "user", content: [{ type: "text", text: "Approve the request" }] },
				{
					role: "assistant",
					content: [{
						type: "toolCall",
						id: "unknown-1",
						name: "divo_gateway",
						arguments: { op: "tools.invoke" },
					}],
				},
				{
					role: "toolResult",
					toolCallId: "unknown-1",
					toolName: "divo_gateway",
					isError: false,
					details: { data: { action: "approve" } },
				},
				{
					role: "assistant",
					stopReason: "error",
					errorMessage: "502: Upstream unreachable",
					content: [],
				},
			],
		}),
		send: async () => {
			prompts += 1;
		},
	};

	await assert.rejects(
		promptWithTransientRetries({
			rpc,
			message: "Original request",
			retryDelayMs: 0,
		}),
		/failed after a company action was issued/,
	);
	assert.equal(prompts, 1);
});

test("a transient failure after an issued gateway action is not retried without its result", async () => {
	let prompts = 0;
	const rpc = {
		waitFor: () => Promise.resolve({
			messages: [
				{ role: "user", content: [{ type: "text", text: "Create the record" }] },
				{
					role: "assistant",
					stopReason: "error",
					errorMessage: "Connection error.",
					content: [{
						type: "toolCall",
						id: "call-1",
						name: "divo_gateway",
						arguments: { op: "tools.invoke" },
					}],
				},
			],
		}),
		send: async () => {
			prompts += 1;
		},
	};

	await assert.rejects(
		promptWithTransientRetries({
			rpc,
			message: "Original request",
			retryDelayMs: 0,
		}),
		/failed after a company action was issued/,
	);
	assert.equal(prompts, 1);
});

test("exhausted transient retries fail instead of delivering earlier narration", async () => {
	const completion = {
		type: "agent_end",
		messages: [{
			role: "assistant",
			stopReason: "error",
			errorMessage: "502: Upstream unreachable",
			content: [],
		}],
	};
	const rpc = {
		waitFor: () => Promise.resolve(completion),
		send: async () => undefined,
	};

	await assert.rejects(
		promptWithTransientRetries({
			rpc,
			message: "Original request",
			maxRetries: 1,
			retryDelayMs: 0,
		}),
		(error) =>
			error.code === "model_continuation_failed"
			&& error.statusCode === 502
			&& /Upstream unreachable/.test(error.message),
	);
});

test("terminal model failure preserves protected-attempt metadata for cleanup", async () => {
	const rpc = {
		send: async () => undefined,
		waitFor: async () => ({
			messages: [
				{ role: "user", content: [] },
				{
					role: "assistant",
					content: [{
						type: "toolCall",
						id: "call-shopify",
						name: "divo_gateway",
						arguments: {
							op: "tools.invoke",
							payload: { toolId: "shopifyCustomers", args: { operation: "count_customers" } },
						},
					}],
					stopReason: "error",
					errorMessage: "provider failed",
				},
			],
		}),
	};

	await assert.rejects(
		promptWithTransientRetries({ rpc, message: "count", maxRetries: 0 }),
		(error) => {
			assert.equal(error.code, "model_continuation_failed");
			assert.equal(error.protectedDataUsed, true);
			assert.deepEqual(error.protectedRefs, []);
			return true;
		},
	);
});

test("subagent children ride the details the extension already streams", () => {
	const update = projectRuntimeProgress({
		type: "tool_execution_update",
		toolCallId: "call-9",
		toolName: "divo_subagents",
		partialResult: {
			details: {
				parentToolCallId: "call-9",
				children: [
					{
						role: "scout",
						task: "read the pipeline export",
						state: "running",
						startedAt: new Date(Date.now() - 90_000).toISOString(),
						finalOutput: "must-not-leak",
					},
					{ role: "reviewer", task: "check last week's numbers", state: "completed" },
				],
			},
		},
	});

	assert.deepEqual(update, {
		type: "tool_progress",
		callId: "call-9",
		toolName: "divo_subagents",
		children: [
			{ label: "scout", status: "running", detail: "read the pipeline export · working 1m 30s" },
			{ label: "reviewer", status: "done", detail: "check last week's numbers" },
		],
	});
	// A child's output is the run's internals; the card is shown in a chat window.
	assert.doesNotMatch(JSON.stringify(update), /must-not-leak/);
});

// A run that ends between the last update and completion would otherwise leave
// children stuck running underneath a parent already marked done.
test("the final tool result settles every child at once", () => {
	assert.deepEqual(
		projectRuntimeProgress({
			type: "tool_execution_end",
			toolCallId: "call-9",
			toolName: "divo_subagents",
			isError: false,
			result: {
				details: {
					children: [
						{ role: "scout", task: "read the export", state: "completed" },
						{ role: "reviewer", task: "check totals", state: "failed" },
					],
				},
			},
		}),
		{
			type: "tool_end",
			callId: "call-9",
			toolName: "divo_subagents",
			isError: false,
			children: [
				{ label: "scout", status: "done", detail: "read the export" },
				{ label: "reviewer", status: "failed", detail: "check totals" },
			],
		},
	);
});

test("a declared checklist rides the same details", () => {
	assert.deepEqual(
		projectRuntimeProgress({
			type: "tool_execution_end",
			toolCallId: "call-3",
			toolName: "divo_todos",
			isError: false,
			result: {
				details: {
					items: [
						{ title: "Pull the deals", status: "done" },
						{ title: "Draft the summary", status: "running" },
					],
				},
			},
		}),
		{
			type: "tool_end",
			callId: "call-3",
			toolName: "divo_todos",
			isError: false,
			todos: [
				{ title: "Pull the deals", status: "done" },
				{ title: "Draft the summary", status: "running" },
			],
		},
	);
});

// Most tools stream partial stdout, which the card has no use for; redrawing
// the status bubble for each chunk would rate-limit the run's real updates out.
test("a tool streaming plain output produces no progress event", () => {
	assert.equal(
		projectRuntimeProgress({
			type: "tool_execution_update",
			toolCallId: "call-4",
			toolName: "bash",
			partialResult: { content: [{ type: "text", text: "half the output" }], details: { truncation: null } },
		}),
		undefined,
	);
});

test("Pi events become sanitized progress events", () => {
	assert.deepEqual(
		projectRuntimeProgress({
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "divo_gateway",
			args: {
				payload: {
					toolId: "googleDrive",
					token: "must-not-leak",
				},
			},
		}),
		{
			type: "tool_start",
			callId: "call-1",
			toolName: "divo_gateway",
			toolId: "googleDrive",
		},
	);
	assert.deepEqual(
		projectRuntimeProgress({
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "divo_gateway",
			result: { secret: "must-not-leak" },
			isError: false,
		}),
		{
			type: "tool_end",
			callId: "call-1",
			toolName: "divo_gateway",
			isError: false,
		},
	);
	assert.deepEqual(
		projectRuntimeProgress({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "private answer text" },
		}),
		{ type: "writing" },
	);
});

test("admission isolates profiles, rejects overload, and accepts a retry", async () => {
	const gates = new Map();
	const calls = [];
	const admission = createAdmissionController({
		maxActiveRuns: 2,
		execute: async (profile) => {
			calls.push(profile);
			const gate = deferred();
			gates.set(profile, gate);
			await gate.promise;
			return { profile, text: "done" };
		},
	});
	const abhishek = admission.run({ profile: "abhishek", message: "work" });
	const anish = admission.run({ profile: "anish", message: "work" });
	assert.equal(admission.activeCount, 2);
	await assert.rejects(
		admission.run({ profile: "abhishek", message: "duplicate" }),
		(error) => error.statusCode === 409 && error.code === "user_busy",
	);
	await assert.rejects(
		admission.run({ profile: "third", message: "overload" }),
		(error) => error.statusCode === 429 && error.code === "capacity_full",
	);
	assert.deepEqual(calls, ["abhishek", "anish"]);
	gates.get("abhishek").resolve();
	await abhishek;
	const third = admission.run({ profile: "third", message: "retry" });
	assert.deepEqual(calls, ["abhishek", "anish", "third"]);
	gates.get("third").resolve();
	gates.get("anish").resolve();
	assert.equal((await third).profile, "third");
	await anish;
	assert.equal(admission.activeCount, 0);
});

test("admission default is not capped at two active profiles", async () => {
	const gates = new Map();
	const admission = createAdmissionController({
		execute: async (profile) => {
			const gate = deferred();
			gates.set(profile, gate);
			await gate.promise;
			return { profile, text: "done" };
		},
	});
	const first = admission.run({ profile: "one", message: "work" });
	const second = admission.run({ profile: "two", message: "work" });
	const third = admission.run({ profile: "three", message: "work" });
	assert.equal(admission.maxActiveRuns, 8);
	assert.equal(admission.activeCount, 3);
	for (const gate of gates.values()) gate.resolve();
	await Promise.all([first, second, third]);
});

test("manual admission forwards the request disconnect signal to Pi execution", async () => {
	const controller = new AbortController();
	let receivedOptions;
	const admission = createAdmissionController({
		execute: async (_profile, _message, options) => {
			receivedOptions = options;
			return { text: "done" };
		},
	});

	await admission.run({
		profile: "anish",
		message: "work",
		signal: controller.signal,
	});

	assert.equal(receivedOptions.signal, controller.signal);
});

test("HTTP overload response is immediate, friendly, and retryable", async (context) => {
	const gate = deferred();
	const { admission, server } = createControllerServer({
		maxActiveRuns: 1,
		execute: async (profile) => {
			await gate.promise;
			return { profile, text: "done" };
		},
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	context.after(() => server.close());
	const { port } = server.address();
	const endpoint = `http://127.0.0.1:${port}/v1/runs`;
	const first = fetch(endpoint, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ profile: "abhishek", message: "work" }),
	});
	while (admission.activeCount === 0) {
		await new Promise((resolve) => setImmediate(resolve));
	}
	const startedAt = Date.now();
	const overloaded = await fetch(endpoint, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ profile: "anish", message: "work" }),
	});
	const payload = await overloaded.json();
	assert.equal(overloaded.status, 429);
	assert.equal(overloaded.headers.get("retry-after"), "60");
	assert.equal(payload.error.code, "capacity_full");
	assert.equal(payload.error.message, CAPACITY_MESSAGE);
	assert.equal(payload.error.retryAfterSeconds, 60);
	assert.ok(Date.now() - startedAt < 1_000);
	gate.resolve();
	assert.equal((await first).status, 200);
});

test("Lark runs admit only the profile derived from a validated runtime lease", async () => {
	const calls = [];
	const admission = createAdmissionController({
		maxActiveRuns: 1,
		resolveLease: async ({ backendUrl, lease }) => {
			calls.push({ kind: "resolve", backendUrl, lease });
			return {
				profile: "cloud-derived",
				thread: "lark-derived",
				backendUrl,
				token: lease,
				userId: "user-1",
				companyId: "company-1",
				instanceId: "pi-local-1",
				channel: "lark",
				runId: "backend-run-1",
				runtimeThreadId: "lark:tenant:chat:dm",
			};
		},
		executeRuntime: async (runtime, message, options) => {
			calls.push({ kind: "execute", runtime, message, options });
			return { profile: runtime.profile, thread: runtime.thread, text: "done" };
		},
	});

	const result = await admission.runRuntime({
		backendUrl: "https://backend.example",
		runtimeLease: "signed-lease",
		message: " hello ",
		profile: "caller-choice-is-ignored",
		approve: true,
	});

	assert.deepEqual(result, {
		profile: "cloud-derived",
		thread: "lark-derived",
		text: "done",
	});
	assert.equal(calls[1].message, "hello");
	assert.equal(calls[1].runtime.profile, "cloud-derived");
	assert.equal("approve" in calls[1], false);
	assert.equal(calls[1].options.signal, undefined);
});

test("session lifecycle admits only private leases and keeps the profile fenced", async () => {
	const calls = [];
	const admission = createAdmissionController({
		resolveLease: async ({ backendUrl, lease }) => ({
			profile: "cloud-derived",
			thread: "lark-derived",
			backendUrl,
			token: lease,
			userId: "user-1",
			companyId: "company-1",
			instanceId: "pi-local-1",
			contextAudience: "private",
		}),
		executeSessionLifecycle: async (runtime, operation, options) => {
			calls.push({ runtime, operation, options });
			return { profile: runtime.profile, thread: runtime.thread, operation };
		},
	});

	const result = await admission.runSessionLifecycle({
		backendUrl: "https://backend.example",
		runtimeLease: "signed-lease",
		operation: "reset",
		signal: undefined,
	});

	assert.deepEqual(result, {
		profile: "cloud-derived",
		thread: "lark-derived",
		operation: "reset",
	});
	assert.equal(calls[0].operation, "reset");
	await assert.rejects(
		admission.runSessionLifecycle({
			backendUrl: "https://backend.example",
			runtimeLease: "signed-lease",
			operation: "invalid",
		}),
		(error) => error.code === "invalid_session_operation" && error.statusCode === 400,
	);
});

test("HTTP exposes the fenced private session lifecycle route", async (context) => {
	const calls = [];
	const admission = createAdmissionController({
		resolveLease: async () => ({
			profile: "cloud-derived",
			thread: "lark-derived",
			contextAudience: "private",
		}),
		executeSessionLifecycle: async (_runtime, operation) => {
			calls.push(operation);
			return { ok: true, operation };
		},
	});
	const { server } = createControllerServer({ admission });
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	context.after(() => server.close());
	const { port } = server.address();
	const response = await fetch(`http://127.0.0.1:${port}/v1/lark-sessions`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			backendUrl: "https://backend.example",
			runtimeLease: "signed-lease",
			operation: "prepare",
		}),
	});

	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { ok: true, operation: "prepare" });
	assert.deepEqual(calls, ["prepare"]);
});

test("a protected thread run requests exact session cleanup before returning provenance", async () => {
	const cleanup = [];
	const runtime = {
		profile: "cloud-derived",
		thread: "lark-derived",
		backendUrl: "https://backend.example",
		token: "signed-lease",
		userId: "user-1",
		companyId: "company-1",
		instanceId: "pi-local-1",
	};
	const admission = createAdmissionController({
		resolveLease: async () => runtime,
		executeRuntime: async () => ({
			text: "Customer account is active.",
			protectedDataUsed: true,
			protectedRefs: [protectedCustomerRef],
		}),
		cleanupProtectedSession: async (request) => { cleanup.push(request); },
	});

	const result = await admission.runRuntime({
		backendUrl: runtime.backendUrl,
		runtimeLease: runtime.token,
		message: "Check this customer",
	});

	assert.deepEqual(cleanup, [{
		runtime,
		references: [protectedCustomerRef],
		provenanceValid: true,
	}]);
	assert.deepEqual(result, {
		text: "Customer account is active.",
		protectedDataUsed: true,
		protectedRefs: [protectedCustomerRef],
	});
});

test("a protected durable run fails closed when session cleanup is not wired", async () => {
	const admission = createAdmissionController({
		resolveLease: async () => ({ profile: "cloud-derived" }),
		executeRuntime: async () => ({
			text: "Sensitive",
			protectedDataUsed: true,
			protectedRefs: [protectedCustomerRef],
		}),
	});

	await assert.rejects(
		admission.runRuntime({
			backendUrl: "https://backend.example",
			runtimeLease: "signed-lease",
			message: "Check this customer",
		}),
		(error) => {
			assert.equal(error.code, "protected_session_cleanup_unavailable");
			assert.equal(error.statusCode, 503);
			return true;
		},
	);
});

test("malformed protected provenance still deletes the session before rejection", async () => {
	const cleanup = [];
	const admission = createAdmissionController({
		resolveLease: async () => ({ profile: "cloud-derived", thread: "lark-derived" }),
		executeRuntime: async () => ({
			text: "Sensitive",
			protectedDataUsed: true,
			protectedRefs: [{ ...protectedCustomerRef, resourceId: "not-a-shopify-id" }],
		}),
		cleanupProtectedSession: async (request) => { cleanup.push(request); },
	});

	await assert.rejects(
		admission.runRuntime({
			backendUrl: "https://backend.example",
			runtimeLease: "signed-lease",
			message: "Check this customer",
		}),
		(error) => error.code === "invalid_protected_run_references",
	);
	assert.equal(cleanup.length, 1);
	assert.deepEqual(cleanup[0].references, []);
	assert.equal(cleanup[0].provenanceValid, false);
});

test("a protected call followed by runtime failure still requests session cleanup", async () => {
	const cleanup = [];
	const admission = createAdmissionController({
		resolveLease: async () => ({ profile: "cloud-derived", thread: "lark-derived" }),
		executeRuntime: async (_runtime, _message, { onProgress }) => {
			onProgress({
				type: "tool_start",
				callId: "call-1",
				toolName: "divo_gateway",
				toolId: "shopifyOrders",
			});
			throw Object.assign(new Error("model failed"), { code: "model_continuation_failed" });
		},
		cleanupProtectedSession: async request => { cleanup.push(request); },
	});

	await assert.rejects(
		admission.runRuntime({
			backendUrl: "https://backend.example",
			runtimeLease: "signed-lease",
			message: "Find an order",
		}),
		(error) => {
			assert.equal(error.code, "model_continuation_failed");
			assert.equal(error.statusCode, 500);
			assert.equal(error.message, "Protected run failed after its durable session was removed");
			assert.doesNotMatch(error.message, /model failed/);
			return true;
		},
	);
	assert.equal(cleanup.length, 1);
	assert.deepEqual(cleanup[0].references, []);
});

test("attached protected terminal metadata is cleaned before a safe error is rethrown", async () => {
	const cleanup = [];
	const cleanupGate = deferred();
	let rejected = false;
	const admission = createAdmissionController({
		resolveLease: async () => ({ profile: "cloud-derived", thread: "lark-derived" }),
		executeRuntime: async () => {
			throw Object.assign(new Error("private customer output must not escape"), {
				code: "model_continuation_failed",
				statusCode: 502,
				protectedDataUsed: true,
				protectedRefs: [protectedCustomerRef],
				protectedProvenanceValid: true,
			});
		},
		cleanupProtectedSession: async request => {
			cleanup.push(request);
			await cleanupGate.promise;
		},
	});

	const run = admission.runRuntime({
		backendUrl: "https://backend.example",
		runtimeLease: "signed-lease",
		message: "Check customer",
	}).catch((error) => {
		rejected = true;
		throw error;
	});
	while (cleanup.length === 0) await new Promise((resolve) => setImmediate(resolve));
	assert.equal(rejected, false);
	cleanupGate.resolve();
	await assert.rejects(
		run,
		(error) => {
			assert.equal(error.code, "model_continuation_failed");
			assert.equal(error.statusCode, 502);
			assert.equal(error.message, "Protected run failed after its durable session was removed");
			assert.doesNotMatch(error.message, /private customer output/);
			return true;
		},
	);
	assert.equal(cleanup.length, 1);
	assert.deepEqual(cleanup[0].references, [protectedCustomerRef]);
});

test("protected cleanup failure is surfaced instead of returning protected content", async () => {
	const admission = createAdmissionController({
		resolveLease: async () => ({ profile: "cloud-derived", thread: "lark-derived" }),
		executeRuntime: async () => ({
			text: "must not be returned",
			protectedDataUsed: true,
			protectedRefs: [],
		}),
		cleanupProtectedSession: async () => { throw new Error("disk failure"); },
	});

	await assert.rejects(
		admission.runRuntime({
			backendUrl: "https://backend.example",
			runtimeLease: "signed-lease",
			message: "Count customers",
		}),
		(error) => error.code === "protected_session_cleanup_failed" && error.statusCode === 503,
	);
});

test("a normal thread run does not request session cleanup", async () => {
	let cleanupCalls = 0;
	const admission = createAdmissionController({
		resolveLease: async () => ({ profile: "cloud-derived" }),
		executeRuntime: async () => ({ text: "Ordinary answer" }),
		cleanupProtectedSession: async () => { cleanupCalls++; },
	});

	assert.deepEqual(await admission.runRuntime({
		backendUrl: "https://backend.example",
		runtimeLease: "signed-lease",
		message: "Ordinary question",
	}), { text: "Ordinary answer" });
	assert.equal(cleanupCalls, 0);
});

test("Lark runs stream progress and one final result as NDJSON", async (context) => {
	const admission = createAdmissionController({
		resolveLease: async ({ backendUrl, lease }) => ({
			profile: "cloud-derived",
			thread: "lark-derived",
			backendUrl,
			token: lease,
			userId: "user-1",
			companyId: "company-1",
			instanceId: "pi-local-1",
		}),
		executeRuntime: async (_runtime, _message, { onProgress }) => {
			onProgress({ type: "ready" });
			onProgress({
				type: "tool_start",
				callId: "call-1",
				toolName: "bash",
			});
			onProgress({
				type: "tool_end",
				callId: "call-1",
				toolName: "bash",
				isError: false,
			});
			return { text: "Finished" };
		},
	});
	const { server } = createControllerServer({ admission });
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	context.after(() => server.close());
	const { port } = server.address();
	const response = await fetch(`http://127.0.0.1:${port}/v1/lark-runs`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/x-ndjson",
		},
		body: JSON.stringify({
			backendUrl: "https://backend.example",
			runtimeLease: "signed-lease",
			message: "work",
		}),
	});

	assert.match(response.headers.get("content-type"), /application\/x-ndjson/);
	const events = (await response.text())
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	assert.deepEqual(events, [
		{ type: "progress", progress: { type: "ready" } },
		{
			type: "progress",
			progress: { type: "tool_start", callId: "call-1", toolName: "bash" },
		},
		{
			type: "progress",
			progress: {
				type: "tool_end",
				callId: "call-1",
				toolName: "bash",
				isError: false,
			},
		},
		{ type: "result", text: "Finished" },
	]);
});

test("protected provenance crosses the NDJSON boundary only after cleanup", async (context) => {
	let cleaned = false;
	const { server } = createControllerServer({
		resolveLease: async () => ({ profile: "cloud-derived", thread: "lark-derived" }),
		executeRuntime: async () => ({
			text: "Customer account is active.",
			protectedDataUsed: true,
			protectedRefs: [protectedCustomerRef],
		}),
		cleanupProtectedSession: async () => { cleaned = true; },
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	context.after(() => server.close());
	const { port } = server.address();
	const response = await fetch(`http://127.0.0.1:${port}/v1/lark-runs`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/x-ndjson",
		},
		body: JSON.stringify({
			backendUrl: "https://backend.example",
			runtimeLease: "signed-lease",
			message: "Check this customer",
		}),
	});

	assert.equal(cleaned, true);
	assert.deepEqual(JSON.parse((await response.text()).trim()), {
		type: "result",
		text: "Customer account is active.",
		protectedDataUsed: true,
		protectedRefs: [protectedCustomerRef],
	});
});

test("Lark run streams stay alive while the runtime is silent", async (context) => {
	const finish = deferred();
	const admission = createAdmissionController({
		resolveLease: async ({ backendUrl, lease }) => ({
			profile: "cloud-derived",
			thread: "lark-derived",
			backendUrl,
			token: lease,
			userId: "user-1",
			companyId: "company-1",
			instanceId: "pi-local-1",
		}),
		executeRuntime: async () => {
			await finish.promise;
			return { text: "Finished" };
		},
	});
	const { server } = createControllerServer({ admission, streamHeartbeatMs: 5 });
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	context.after(() => server.close());
	const { port } = server.address();
	const response = await fetch(`http://127.0.0.1:${port}/v1/lark-runs`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/x-ndjson",
		},
		body: JSON.stringify({
			backendUrl: "https://backend.example",
			runtimeLease: "signed-lease",
			message: "work",
		}),
	});

	finish.resolve();
	const events = (await response.text())
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	assert.deepEqual(events[0], { type: "heartbeat" });
	assert.deepEqual(events.at(-1), { type: "result", text: "Finished" });
});

test("a failed model continuation streams an error and never a narration result", async (context) => {
	const admission = createAdmissionController({
		resolveLease: async ({ backendUrl, lease }) => ({
			profile: "cloud-derived",
			thread: "lark-derived",
			backendUrl,
			token: lease,
			userId: "user-1",
			companyId: "company-1",
			instanceId: "pi-local-1",
		}),
		executeRuntime: async () => {
			const error = new Error("Assistant error: 502: Upstream unreachable");
			error.code = "model_continuation_failed";
			error.statusCode = 502;
			throw error;
		},
	});
	const { server } = createControllerServer({ admission });
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	context.after(() => server.close());
	const { port } = server.address();
	const response = await fetch(`http://127.0.0.1:${port}/v1/lark-runs`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/x-ndjson",
		},
		body: JSON.stringify({
			backendUrl: "https://backend.example",
			runtimeLease: "signed-lease",
			message: "work",
		}),
	});
	const events = (await response.text())
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));

	assert.deepEqual(events, [{
		type: "error",
		error: {
			code: "model_continuation_failed",
			message: "Assistant error: 502: Upstream unreachable",
		},
	}]);
});

test("disconnecting a Lark request aborts its admitted runtime", async (context) => {
	const started = deferred();
	const aborted = deferred();
	const admission = createAdmissionController({
		resolveLease: async ({ backendUrl, lease }) => ({
			profile: "cloud-derived",
			thread: "lark-derived",
			backendUrl,
			token: lease,
			userId: "user-1",
			companyId: "company-1",
			instanceId: "pi-local-1",
		}),
		executeRuntime: async (_runtime, _message, { signal }) => {
			started.resolve();
			await new Promise((_, reject) => {
				signal.addEventListener(
					"abort",
					() => {
						aborted.resolve();
						reject(new Error("stopped"));
					},
					{ once: true },
				);
			});
		},
	});
	const { server } = createControllerServer({ admission });
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	context.after(() => server.close());
	const { port } = server.address();
	const controller = new AbortController();
	const request = fetch(`http://127.0.0.1:${port}/v1/lark-runs`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			backendUrl: "https://backend.example",
			runtimeLease: "signed-lease",
			message: "work",
		}),
		signal: controller.signal,
	});
	await started.promise;
	controller.abort();

	await assert.rejects(request, (error) => error.name === "AbortError");
	await aborted.promise;
	while (admission.activeCount !== 0) {
		await new Promise((resolve) => setImmediate(resolve));
	}
	assert.equal(admission.activeCount, 0);
});

test("a Lark run carries its session scope to the runtime, defaulting to the thread", async () => {
	const scopes = [];
	const admission = createAdmissionController({
		resolveLease: async ({ backendUrl, lease }) => ({
			profile: "cloud-derived",
			thread: "lark-derived",
			backendUrl,
			token: lease,
			userId: "user-1",
			companyId: "company-1",
			instanceId: "pi-local-1",
		}),
		executeRuntime: async (runtime, _message, options) => {
			scopes.push(options.sessionScope);
			return { profile: runtime.profile, thread: runtime.thread, text: "done" };
		},
	});

	await admission.runRuntime({
		backendUrl: "https://backend.example",
		runtimeLease: "signed-lease",
		message: "group turn",
		sessionScope: "run",
	});
	await admission.runRuntime({
		backendUrl: "https://backend.example",
		runtimeLease: "signed-lease",
		message: "direct message turn",
	});

	assert.deepEqual(scopes, ["run", "thread"]);
});

test("an unknown session scope is rejected before any container starts", async () => {
	let started = false;
	const admission = createAdmissionController({
		resolveLease: async () => {
			started = true;
			return {};
		},
		executeRuntime: async () => {
			started = true;
			return { text: "done" };
		},
	});

	await assert.rejects(
		admission.runRuntime({
			backendUrl: "https://backend.example",
			runtimeLease: "signed-lease",
			message: "group turn",
			sessionScope: "everything",
		}),
		(error) => {
			assert.equal(error.code, "invalid_session_scope");
			assert.equal(error.statusCode, 400);
			return true;
		},
	);
	assert.equal(started, false);
});

// Five rows reading "Terminal / Files / Terminal" say only that something ran.
// The argument that names the work was already in hand and was being discarded.
test("a tool call carries the argument that says what it is about", () => {
	const detailOf = (toolName, args) =>
		projectRuntimeProgress({ type: "tool_execution_start", toolCallId: "c1", toolName, args }).detail;

	assert.equal(detailOf("bash", { command: "airtable  list-bases\n" }), "airtable list-bases");
	assert.equal(detailOf("read", { file_path: "/data/workspace/.divo/inbox/bases.json" }), "bases.json");
	// Only the operation: the tool id already travels as its own field, and the
	// table that turns it into "Zoho Books" lives in the backend.
	assert.equal(detailOf("divo_gateway", { op: "tools.invoke", payload: { toolId: "zohoBooks" } }), "tools.invoke");
	// An unmapped tool has no argument worth naming, and a card row is better
	// bare than filled with whichever key happened to sort first.
	assert.equal(detailOf("mystery_tool", { whatever: "x" }), undefined);
});

// A tool's arguments can hold a whole file body or a customer record.
test("only the identifying argument crosses, never the whole object", () => {
	const update = projectRuntimeProgress({
		type: "tool_execution_start",
		toolCallId: "c1",
		toolName: "write",
		args: { file_path: "/tmp/report.md", content: "must-not-leak" },
	});

	assert.equal(update.detail, "report.md");
	assert.doesNotMatch(JSON.stringify(update), /must-not-leak/);
});

// A long run that says nothing reads as a hang, however much work it is doing.
test("a finished sentence leaves the container, a half-typed one does not", () => {
	const say = (text) => projectRuntimeProgress({
		type: "message_update",
		assistantMessageEvent: {
			type: "text_delta",
			contentIndex: 0,
			partial: { content: [{ type: "text", text }] },
		},
	});

	// Mid-sentence: nothing to show yet, so the run only reports that it writes.
	assert.deepEqual(say("Let me check which Airtable bases"), { type: "writing" });
	// Complete: the sentence goes, the half-typed tail behind it stays.
	assert.deepEqual(
		say("Found 3 bases. I'll profile the la"),
		{ type: "say", index: 0, text: "Found 3 bases." },
	);
});

// Reasoning is the model talking to itself; the card is read by the whole room.
test("thinking never leaves the container", () => {
	assert.equal(
		projectRuntimeProgress({
			type: "message_update",
			assistantMessageEvent: {
				type: "thinking_delta",
				contentIndex: 0,
				partial: { content: [{ type: "thinking", text: "the user probably means." }] },
			},
		}),
		undefined,
	);
});
