import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createNdjsonStreamWriter } from "../ndjson-stream-writer.mjs";

class FakeResponse extends EventEmitter {
	destroyed = false;
	writableEnded = false;
	lines = [];
	blockNextWrite = false;

	write(line) {
		this.lines.push(line);
		if (!this.blockNextWrite) return true;
		this.blockNextWrite = false;
		return false;
	}
}

test("the NDJSON writer coalesces a provider token burst", async () => {
	const response = new FakeResponse();
	const writer = createNdjsonStreamWriter(response, { flushMs: 1_000 });
	for (let index = 0; index < 100; index += 1) {
		writer.enqueue({
			type: "progress",
			progress: { type: "answer_delta", index: 0, delta: String(index % 10) },
		});
	}
	await writer.flush();

	assert.equal(response.lines.length, 1);
	const event = JSON.parse(response.lines[0]);
	assert.equal(event.progress.type, "answer_delta");
	assert.equal(event.progress.delta.length, 100);
});

test("the NDJSON writer bounds live prose while the socket is backpressured", async () => {
	const response = new FakeResponse();
	response.blockNextWrite = true;
	const writer = createNdjsonStreamWriter(response, {
		flushMs: 1_000,
		maxBufferedBytes: 256,
	});

	// An important lifecycle frame owns the blocked write. Live prose arriving
	// behind it may be compacted or cleared, but may not grow without a ceiling.
	writer.enqueue({ type: "progress", progress: { type: "ready" } });
	for (let index = 0; index < 100; index += 1) {
		writer.enqueue({
			type: "progress",
			progress: { type: "answer_delta", index: 0, delta: "abcdefghij" },
		});
	}
	assert.ok(writer.bufferedBytes < 256);

	response.emit("drain");
	writer.enqueue({ type: "result", text: "The complete authoritative answer" });
	await writer.flush();

	const events = response.lines.map(line => JSON.parse(line));
	assert.equal(events[0].progress.type, "ready");
	assert.ok(events.some(event => event.progress?.type === "answer_reset"));
	assert.equal(events.at(-1).type, "result");
});
