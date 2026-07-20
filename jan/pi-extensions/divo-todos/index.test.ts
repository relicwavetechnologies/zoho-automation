import assert from "node:assert/strict";
import test from "node:test";
import extension from "./index.ts";

test("registers a single session-local Pi todo tool without desktop UI hooks", () => {
	const tools: Array<{ name?: string; description?: string; promptGuidelines?: string[] }> = [];
	const events = new Map<string, unknown>();
	extension({
		registerTool(tool: { name?: string }) {
			tools.push(tool);
		},
		on(event: string, handler: unknown) {
			events.set(event, handler);
		},
	} as never);

	assert.equal(tools.length, 1);
	assert.equal(tools[0]?.name, "divo_todos");
	assert.match(tools[0]?.description ?? "", /current chat/i);
	assert.equal(events.has("extension_ui_request"), false);
	assert.ok(tools[0]?.promptGuidelines?.some((line) => /does not grant permissions/i.test(line)));
});

test("tool results expose the versioned board snapshot without a separate transport", async () => {
	let registered:
		| {
				name?: string;
				execute?: (toolCallId: string, params: unknown) => Promise<{ details: unknown }>;
		  }
		| undefined;
	extension({
		registerTool(tool: typeof registered) {
			registered = tool;
		},
		on() {},
	} as never);

	const created = await registered?.execute?.("todo-call", {
		action: "create",
		tasks: [{ content: "Inspect the runtime", status: "in_progress", activeForm: "Inspecting the runtime" }],
	});
	assert.ok(created);
	const details = created.details as { version: number; boardId: string; revision: number; items: Array<{ status: string }> };
	assert.equal(details.version, 1);
	assert.equal(details.revision, 1);
	assert.equal(details.items[0]?.status, "in_progress");
	assert.match(details.boardId, /^[0-9a-f-]{36}$/i);
});

test("reconstructs only the current Pi session branch after resume or branch switch", async () => {
	let registered:
		| {
				execute?: (toolCallId: string, params: unknown) => Promise<{ details: unknown }>;
		  }
		| undefined;
	const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
	let branch: unknown[] = [];

	extension({
		registerTool(tool: typeof registered) {
			registered = tool;
		},
		on(event: string, handler: (event: unknown, ctx: unknown) => void) {
			handlers.set(event, handler);
		},
	} as never);

	const context = {
		sessionManager: { getBranch: () => branch },
	};
	const restore = handlers.get("session_start");
	const switchBranch = handlers.get("session_tree");
	assert.ok(restore);
	assert.ok(switchBranch);

	branch = [
		{
			type: "message",
			message: {
				role: "toolResult",
				toolName: "divo_todos",
				details: {
					version: 1,
					boardId: "123e4567-e89b-42d3-a456-426614174000",
					revision: 3,
					updatedAt: "2026-07-19T18:00:00.000Z",
					items: [{
						id: "123e4567-e89b-42d3-a456-426614174001",
						content: "Resume this branch",
						status: "in_progress",
						createdAt: "2026-07-19T18:00:00.000Z",
						updatedAt: "2026-07-19T18:00:00.000Z",
					}],
					action: "update",
				},
			},
		},
	];
	restore!({}, context);
	let listed = await registered?.execute?.("todo-call", { action: "list" });
	assert.match(JSON.stringify(listed?.details), /Resume this branch/);

	branch = [
		{
			type: "message",
			message: {
				role: "toolResult",
				toolName: "divo_todos",
				details: {
					version: 1,
					boardId: "123e4567-e89b-42d3-a456-426614174010",
					revision: 1,
					updatedAt: "2026-07-19T18:01:00.000Z",
					items: [{
						id: "123e4567-e89b-42d3-a456-426614174011",
						content: "Sibling branch only",
						status: "pending",
						createdAt: "2026-07-19T18:01:00.000Z",
						updatedAt: "2026-07-19T18:01:00.000Z",
					}],
					action: "create",
				},
			},
		},
	];
	switchBranch!({}, context);
	listed = await registered?.execute?.("todo-call", { action: "list" });
	assert.match(JSON.stringify(listed?.details), /Sibling branch only/);
	assert.doesNotMatch(JSON.stringify(listed?.details), /Resume this branch/);
});
