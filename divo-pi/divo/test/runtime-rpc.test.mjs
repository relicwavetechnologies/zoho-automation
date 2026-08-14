import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { JsonlRpc } from "../runtime-rpc.mjs";

/**
 * A stand-in for the `docker exec` child, driven a line at a time.
 *
 * The suite had no such double, and that is the whole reason two missing
 * imports in this module reached a commit: nothing ever built a `JsonlRpc` over
 * a stream that emitted anything, so a `ReferenceError` in the constructor and
 * another on the first event line both passed 243 green tests.
 */
function fakeRuntime() {
	const child = new EventEmitter();
	child.stdout = new PassThrough();
	child.stdin = new PassThrough();
	const written = [];
	child.stdin.on("data", (chunk) => {
		for (const line of String(chunk).split("\n").filter(Boolean)) written.push(JSON.parse(line));
	});
	return {
		child,
		written,
		/** Emit one JSONL line the way Pi does, and let the reader drain it. */
		async emit(value) {
			child.stdout.write(`${JSON.stringify(value)}\n`);
			await new Promise((resolve) => setImmediate(resolve));
		},
	};
}

test("a run's events reach whoever is watching it", async () => {
	const runtime = fakeRuntime();
	const seen = [];
	new JsonlRpc(runtime.child, async () => {}, (event) => seen.push(event));

	await runtime.emit({ type: "agent_start" });
	await runtime.emit({
		type: "tool_execution_start",
		toolCallId: "call-1",
		toolName: "divo_zoho_books",
		args: {},
	});

	// Both projections of a Pi event have to fire. They are separate on purpose —
	// the answer stream a browser renders and the status line a Lark card redraws
	// are different things — and each was reached through a name this module did
	// not import, so neither ran at all.
	assert.deepEqual(seen.map((event) => event.type), ["thinking", "tool_start"]);
});

test("a reply is matched to the request that asked for it", async () => {
	const runtime = fakeRuntime();
	const rpc = new JsonlRpc(runtime.child, async () => {}, () => {});

	const pending = rpc.send({ type: "get_state" });
	const sent = runtime.written.at(-1);
	assert.equal(sent.type, "get_state");
	await runtime.emit({ type: "response", id: sent.id, success: true, data: { ready: true } });

	assert.deepEqual(await pending, { ready: true });
});

test("a caller waiting on a named event is released by it", async () => {
	const runtime = fakeRuntime();
	const rpc = new JsonlRpc(runtime.child, async () => {}, () => {});
	const waiting = rpc.waitFor("agent_end");
	await runtime.emit({ type: "agent_end" });
	assert.equal((await waiting).type, "agent_end");
});

test("a permission prompt is answered back down the same wire", async () => {
	const runtime = fakeRuntime();
	new JsonlRpc(
		runtime.child,
		async (request, respond) => respond({ type: "extension_ui_response", id: request.id, confirmed: true }),
		() => {},
	);
	await runtime.emit({ type: "extension_ui_request", id: "req-1", method: "confirm", title: "t" });
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(runtime.written.at(-1), {
		type: "extension_ui_response", id: "req-1", confirmed: true,
	});
});

test("a runtime that dies fails everyone waiting on it rather than hanging them", async () => {
	const runtime = fakeRuntime();
	const rpc = new JsonlRpc(runtime.child, async () => {}, () => {});
	const pending = rpc.send({ type: "get_state" });
	const waiting = rpc.waitFor("agent_end");
	runtime.child.emit("exit", 1, null);
	await assert.rejects(pending, /Docker attach exited/);
	await assert.rejects(waiting, /Docker attach exited/);
});

test("a line that is not JSON fails the run instead of being skipped", async () => {
	const runtime = fakeRuntime();
	const rpc = new JsonlRpc(runtime.child, async () => {}, () => {});
	const pending = rpc.send({ type: "get_state" });
	// Silently dropping it would leave the caller waiting on a reply that the
	// runtime has already lost the ability to send.
	runtime.child.stdout.write("not json\n");
	await assert.rejects(pending, /invalid JSONL/);
});
