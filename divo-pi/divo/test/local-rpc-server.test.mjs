import assert from "node:assert/strict";
import test from "node:test";
import {
	CAPACITY_MESSAGE,
	createAdmissionController,
	createControllerServer,
} from "../local-rpc-server.mjs";
import {
	collectRunAssistantText,
	projectRuntimeProgress,
} from "../local-rpc-controller.mjs";

function deferred() {
	let resolve;
	const promise = new Promise((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

test("final delivery preserves every assistant text block from the completed run", () => {
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
		"Complete report\n\nThe report above is complete.",
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

test("subagent children ride the details the extension already streams", () => {
	const update = projectRuntimeProgress({
		type: "tool_execution_update",
		toolCallId: "call-9",
		toolName: "divo_subagents",
		partialResult: {
			details: {
				parentToolCallId: "call-9",
				children: [
					{ role: "scout", task: "read the pipeline export", state: "running", finalOutput: "must-not-leak" },
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
			{ label: "scout", status: "running", detail: "read the pipeline export" },
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
