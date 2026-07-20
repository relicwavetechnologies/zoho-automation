import assert from "node:assert/strict";
import test from "node:test";
import {
	createEmptyBoard,
	createTodos,
	resolveTodoReference,
	restoreBoard,
	snapshot,
	updateTodo,
} from "./board.ts";

test("todo board creates a single active task and moves the prior task back to pending", () => {
	let board = createEmptyBoard();
	const first = createTodos(board, [{ content: "Research vendors", status: "in_progress", activeForm: "Researching vendors" }]);
	assert.ok(first.board);
	board = first.board!;
	const second = createTodos(board, [{ content: "Write recommendation", status: "in_progress" }]);
	assert.ok(second.board);
	assert.deepEqual(second.board!.items.map((item) => item.status), ["pending", "in_progress"]);
	assert.equal(second.board!.items[0].activeForm, undefined);
});

test("snapshots replay safely and reject malformed or cross-task blocker data", () => {
	const created = createTodos(createEmptyBoard(), [{ content: "Inspect runtime" }]);
	const board = created.board!;
	assert.equal(board.items[0]?.status, "in_progress");
	const replayed = restoreBoard(snapshot(board, "create"));
	assert.deepEqual(replayed, board);

	const malformed = snapshot(board, "create");
	malformed.items[0].blockedBy = ["not-a-task-id"];
	assert.equal(restoreBoard(malformed), undefined);
});

test("updates validate task identity and preserve immutable historic snapshots", () => {
	const created = createTodos(createEmptyBoard(), [{ content: "Plan rollout", status: "pending" }]);
	const board = created.board!;
	const before = snapshot(board, "create");
	const updated = updateTodo(board, board.items[0].id, { status: "completed" });
	assert.ok(updated.board);
	assert.equal(before.items[0].status, "pending");
	assert.equal(updated.board!.items[0].status, "completed");
	assert.ok(updateTodo(board, "missing", { status: "completed" }).error);
	assert.ok(updateTodo(board, board.items[0].id, { activeForm: "Working" }).error);
});

test("resolves model-friendly ordinal references without replacing durable UUIDs", () => {
	const board = createTodos(createEmptyBoard(), [
		{ content: "Research" },
		{ content: "Write" },
	]).board!;
	assert.equal(resolveTodoReference(board, "#1"), board.items[0]?.id);
	assert.equal(resolveTodoReference(board, "2"), board.items[1]?.id);
	assert.equal(resolveTodoReference(board, board.items[0]!.id), board.items[0]?.id);
	assert.equal(resolveTodoReference(board, "#3"), undefined);
});
