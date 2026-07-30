import assert from "node:assert/strict";
import { test } from "node:test";

import {
	MAX_TODO_ITEMS,
	buildTodosDetails,
	normalizeTodoItems,
	summarizeTodos,
} from "./index.ts";

test("an omitted status means the step has not started", () => {
	assert.deepEqual(normalizeTodoItems([{ title: "Pull the deals" }]), [
		{ title: "Pull the deals", status: "pending" },
	]);
});

// Two live rows would make the card contradict its own progress count, and
// guessing which one the model meant is worse than taking the last.
test("only the last running step stays running", () => {
	assert.deepEqual(
		normalizeTodoItems([
			{ title: "Pull the deals", status: "running" },
			{ title: "Draft the summary", status: "running" },
			{ title: "Post it", status: "pending" },
		]),
		[
			{ title: "Pull the deals", status: "done" },
			{ title: "Draft the summary", status: "running" },
			{ title: "Post it", status: "pending" },
		],
	);
});

test("blank steps are dropped rather than rendered as empty rows", () => {
	assert.deepEqual(normalizeTodoItems([{ title: "   " }, { title: "Real step" }]), [
		{ title: "Real step", status: "pending" },
	]);
});

test("a runaway list is capped instead of filling the card", () => {
	const items = Array.from({ length: MAX_TODO_ITEMS + 5 }, (_, i) => ({ title: `Step ${i}` }));
	assert.equal(normalizeTodoItems(items).length, MAX_TODO_ITEMS);
});

test("progress counts settled steps, and skipping counts as settled", () => {
	const details = buildTodosDetails([
		{ title: "Pull the deals", status: "done" },
		{ title: "Ask finance", status: "skipped" },
		{ title: "Draft the summary", status: "running" },
		{ title: "Post it", status: "pending" },
	]);

	assert.equal(details.done, 2);
	assert.equal(details.total, 4);
	assert.equal(details.current, "Draft the summary");
});

test("nothing running means no current step, not a guessed one", () => {
	const details = buildTodosDetails([{ title: "Pull the deals", status: "pending" }]);
	assert.equal(details.current, undefined);
});

test("the model reads back the list it just declared", () => {
	const summary = summarizeTodos(
		buildTodosDetails([
			{ title: "Pull the deals", status: "done" },
			{ title: "Draft the summary", status: "running" },
		]),
	);

	assert.match(summary, /1\/2/);
	assert.match(summary, /\[x\] Pull the deals/);
	assert.match(summary, /\[~\] Draft the summary/);
});
