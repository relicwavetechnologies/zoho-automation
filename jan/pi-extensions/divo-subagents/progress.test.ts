import assert from "node:assert/strict";
import test from "node:test";
import {
	addAssistantOutput,
	completeChild,
	createChild,
	makeDetails,
	setToolActivity,
	startChild,
} from "./progress.ts";

test("subagent progress snapshots preserve child identity and lifecycle", () => {
	const child = createChild(0, "scout", "Locate the Pi runtime");
	const id = child.id;

	startChild(child);
	setToolActivity(child, "child-tool-1", "read runtime.rs", "tool_started");
	addAssistantOutput(child, "The runtime starts Pi through the bundled Bun executable.");
	completeChild(child, "Found the runtime launch path.", 0, "end");

	const details = makeDetails("parent-tool-1", "single", [child]);
	assert.equal(details.parentToolCallId, "parent-tool-1");
	assert.equal(details.children[0].id, id);
	assert.equal(details.children[0].state, "completed");
	assert.equal(details.summary.completed, 1);
	assert.equal(details.summary.running, 0);
	assert.equal(details.children[0].events.at(-1)?.kind, "completed");
});

test("failed and cancelled children remain distinct in a parallel summary", () => {
	const failed = createChild(0, "scout", "Inspect one area");
	const cancelled = createChild(1, "reviewer", "Inspect another area");
	startChild(failed);
	startChild(cancelled);
	completeChild(failed, "child process exited", 1, "error");
	completeChild(cancelled, "", 1, "aborted");

	const details = makeDetails("parent-tool-2", "parallel", [failed, cancelled]);
	assert.equal(details.state, "failed");
	assert.deepEqual(details.summary, {
		total: 2,
		queued: 0,
		running: 0,
		completed: 0,
		failed: 1,
		cancelled: 1,
	});
});

test("snapshot details are immutable copies of the live child state", () => {
	const child = createChild(0, "planner", "Plan the feature");
	const snapshot = makeDetails("parent-tool-3", "single", [child]);

	startChild(child);
	assert.equal(snapshot.children[0].state, "queued");
	assert.equal(child.state, "running");
});
