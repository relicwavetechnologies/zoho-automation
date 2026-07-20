/**
 * Pi-owned task planning for Divo.
 *
 * State is stored only in this tool's result details. Pi reconstructs the
 * current branch when a chat is resumed or branched, so separate chat sessions
 * never share a todo board and Divo needs no database-side task state.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
	boardText,
	clearTodos,
	createEmptyBoard,
	createTodos,
	restoreBoard,
	resolveTodoReference,
	snapshot,
	updateTodo,
	type TodoAction,
	type TodoBoard,
	type TodoInput,
	type TodoStatus,
	type TodoUpdate,
} from "./board.ts";

// Pi requires StringEnum for custom-tool enums to stay compatible with every
// configured model provider, including Google's function-calling schema.
const TodoStatusSchema = StringEnum(["pending", "in_progress", "completed", "blocked", "cancelled"] as const);

const TodoInputSchema = Type.Object({
	content: Type.String({ description: "Short task title. Required when creating a task.", minLength: 1, maxLength: 500 }),
	description: Type.Optional(Type.String({ description: "Optional fuller task context.", maxLength: 2_000 })),
	status: Type.Optional(TodoStatusSchema),
	activeForm: Type.Optional(Type.String({ description: "Present-tense activity for the single active task.", maxLength: 500 })),
	blockedBy: Type.Optional(Type.Array(Type.String({ description: "Existing task UUID or #number blocking this task." }), { maxItems: 12 })),
});

const TodoParams = Type.Object({
	action: StringEnum(["create", "update", "list", "clear"] as const),
	tasks: Type.Optional(Type.Array(TodoInputSchema, { description: "Tasks to create (one to sixteen).", maxItems: 16 })),
	id: Type.Optional(Type.String({ description: "Task UUID or #number shown by create/list to update." })),
	content: Type.Optional(Type.String({ description: "Replacement task title.", minLength: 1, maxLength: 500 })),
	description: Type.Optional(Type.Union([Type.String({ maxLength: 2_000 }), Type.Null()])),
	status: Type.Optional(TodoStatusSchema),
	activeForm: Type.Optional(Type.Union([Type.String({ maxLength: 500 }), Type.Null()])),
	blockedBy: Type.Optional(Type.Union([Type.Array(Type.String({ description: "Task UUID or #number." }), { maxItems: 12 }), Type.Null()])),
	completedOnly: Type.Optional(Type.Boolean({ description: "For clear: remove completed tasks only; otherwise clear the whole board." })),
});

type TodoParams = {
	action: TodoAction;
	tasks?: TodoInput[];
	id?: string;
	content?: string;
	description?: string | null;
	status?: TodoStatus;
	activeForm?: string | null;
	blockedBy?: string[] | null;
	completedOnly?: boolean;
};

function reconstructState(ctx: ExtensionContext): TodoBoard {
	let board = createEmptyBoard();
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "toolResult" || message.toolName !== "divo_todos") continue;
		const restored = restoreBoard(message.details);
		if (restored) board = restored;
	}
	return board;
}

function result(board: TodoBoard, action: TodoAction, text: string, error?: string) {
	return {
		content: [{ type: "text" as const, text }],
		details: snapshot(board, action, error),
		...(error ? { isError: true } : {}),
	};
}

function resolveBlockers(board: TodoBoard, blockedBy: string[] | undefined): string[] | undefined {
	return blockedBy?.map(reference => resolveTodoReference(board, reference) ?? reference);
}

export default function divoTodosExtension(pi: ExtensionAPI) {
	let board = createEmptyBoard();
	const restore = (ctx: ExtensionContext) => {
		board = reconstructState(ctx);
	};

	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));

	pi.registerTool({
		name: "divo_todos",
		label: "Divo todos",
		description: "Maintain the current chat's Pi-owned task board. Create a concise plan for substantial multi-step work, keep exactly one task actively in progress, record blockers, and mark tasks completed as work advances. Create/list returns model-friendly #numbers for updates. State is isolated to this Pi session branch.",
		promptSnippet: "For substantial multi-step work, use divo_todos to create a concise, current task board. Update it as work advances and close completed, blocked, or cancelled tasks before the final answer. Skip it for simple one-step replies.",
		promptGuidelines: [
			"The board belongs only to this Pi chat session and branch. It is not a shared project queue and must never be used to coordinate unrelated chats.",
			"Create a small, outcome-oriented plan before substantial multi-step work. Use one in-progress task at a time so the user sees a clear current activity.",
			"Create/list returns task references such as #1. Use that exact reference for update; never guess an ID.",
			"Update task status as work advances and, immediately before the final answer, mark every finished task completed and every unfinished task blocked or cancelled with an honest reason. Do not leave stale pending or in-progress tasks after presenting completed work.",
			"Do not create a board for trivial one-step answers. A todo board is useful only when the user benefits from visible multi-step progress.",
			"When using divo_subagents, the parent agent owns this board: add delegation as a parent task and update it from child results. Child agents do not share or modify this board.",
			"This tool is planning state only. It does not grant permissions, request approvals, make external changes, or continue an agent run automatically.",
		],
		parameters: TodoParams,

		async execute(_toolCallId, params) {
			switch (params.action) {
				case "list":
					return result(board, "list", boardText(board));
				case "create": {
					const tasks = (params.tasks ?? []).map(task => ({
						...task,
						blockedBy: resolveBlockers(board, task.blockedBy),
					}));
					const created = createTodos(board, tasks);
					if (created.error) return result(board, "create", `Unable to create tasks: ${created.error}`, created.error);
					board = created.board!;
					return result(board, "create", `Created ${tasks.length} task${tasks.length === 1 ? "" : "s"}. Use the #references below for updates.\n${boardText(board)}`);
				}
				case "update": {
					if (!params.id?.trim()) return result(board, "update", "Unable to update task: id is required.", "id is required");
					const resolvedId = resolveTodoReference(board, params.id);
					if (!resolvedId) {
						const error = `Task reference ${params.id.trim()} was not found.`;
						return result(board, "update", `Unable to update task: ${error}\n${boardText(board)}`, error);
					}
					const update: TodoUpdate = {
						...(params.content !== undefined ? { content: params.content } : {}),
						...(params.description !== undefined ? { description: params.description } : {}),
						...(params.status !== undefined ? { status: params.status } : {}),
						...(params.activeForm !== undefined ? { activeForm: params.activeForm } : {}),
						...(params.blockedBy !== undefined ? {
							blockedBy: params.blockedBy === null ? null : resolveBlockers(board, params.blockedBy),
						} : {}),
					};
					const updated = updateTodo(board, resolvedId, update);
					if (updated.error) return result(board, "update", `Unable to update task: ${updated.error}`, updated.error);
					board = updated.board!;
					return result(board, "update", `Updated task.\n${boardText(board)}`);
				}
				case "clear": {
					const count = params.completedOnly
						? board.items.filter((item) => item.status === "completed").length
						: board.items.length;
					board = clearTodos(board, Boolean(params.completedOnly));
					return result(board, "clear", `Cleared ${count} task${count === 1 ? "" : "s"}.\n${boardText(board)}`);
				}
			}
		},
	});
}
