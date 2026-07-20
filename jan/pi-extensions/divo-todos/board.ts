import { randomUUID } from "node:crypto";

export const DIVO_TODO_DETAILS_VERSION = 1;
export const MAX_TODOS = 48;
export const MAX_CREATE_ITEMS = 16;
export const MAX_CONTENT_CHARS = 500;
export const MAX_DESCRIPTION_CHARS = 2_000;
export const MAX_ACTIVE_FORM_CHARS = 500;
export const MAX_BLOCKERS = 12;

export type TodoStatus = "pending" | "in_progress" | "completed" | "blocked" | "cancelled";
export type TodoAction = "create" | "update" | "list" | "clear";

export type TodoItem = {
	id: string;
	content: string;
	description?: string;
	status: TodoStatus;
	activeForm?: string;
	blockedBy?: string[];
	createdAt: string;
	updatedAt: string;
};

export type TodoBoard = {
	version: typeof DIVO_TODO_DETAILS_VERSION;
	boardId: string;
	revision: number;
	items: TodoItem[];
	updatedAt: string;
};

export type TodoDetails = TodoBoard & {
	action: TodoAction;
	error?: string;
};

export type TodoInput = {
	content: string;
	description?: string;
	status?: TodoStatus;
	activeForm?: string;
	blockedBy?: string[];
};

export type TodoUpdate = {
	content?: string;
	description?: string | null;
	status?: TodoStatus;
	activeForm?: string | null;
	blockedBy?: string[] | null;
};

const STATUSES = new Set<TodoStatus>(["pending", "in_progress", "completed", "blocked", "cancelled"]);
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function clone<T>(value: T): T {
	return structuredClone(value);
}

function now(): string {
	return new Date().toISOString();
}

function isNonEmptyString(value: unknown, maxChars: number): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= maxChars;
}

function isOptionalText(value: unknown, maxChars: number): value is string | undefined {
	return value === undefined || (typeof value === "string" && value.length <= maxChars);
}

function isTodoStatus(value: unknown): value is TodoStatus {
	return typeof value === "string" && STATUSES.has(value as TodoStatus);
}

function isTimestamp(value: unknown): value is string {
	return typeof value === "string" && ISO_DATE_RE.test(value) && !Number.isNaN(Date.parse(value));
}

function isTaskId(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function normaliseOptionalText(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function normaliseBlockers(value: string[] | undefined): string[] | undefined {
	if (!value?.length) return undefined;
	return [...new Set(value.map((id) => id.trim()))];
}

function validateBlockers(blockedBy: string[] | undefined, validIds: Set<string>, ownId?: string): string | undefined {
	if (!blockedBy) return undefined;
	if (blockedBy.length > MAX_BLOCKERS) return `A task can reference at most ${MAX_BLOCKERS} blockers.`;
	if (blockedBy.some((id) => !isTaskId(id))) return "Blocker IDs must be task UUIDs.";
	if (new Set(blockedBy).size !== blockedBy.length) return "Blocker IDs must be unique.";
	if (ownId && blockedBy.includes(ownId)) return "A task cannot block itself.";
	if (blockedBy.some((id) => !validIds.has(id))) return "Every blocker must refer to an existing task in this board.";
	return undefined;
}

function validateInput(input: TodoInput, validIds: Set<string>): string | undefined {
	if (!isNonEmptyString(input.content, MAX_CONTENT_CHARS)) {
		return `Task content is required and limited to ${MAX_CONTENT_CHARS} characters.`;
	}
	if (!isOptionalText(input.description, MAX_DESCRIPTION_CHARS)) {
		return `Task description is limited to ${MAX_DESCRIPTION_CHARS} characters.`;
	}
	if (input.status !== undefined && !isTodoStatus(input.status)) return "Task status is invalid.";
	if (!isOptionalText(input.activeForm, MAX_ACTIVE_FORM_CHARS)) {
		return `Active task text is limited to ${MAX_ACTIVE_FORM_CHARS} characters.`;
	}
	if (input.status !== "in_progress" && input.activeForm?.trim()) {
		return "activeForm is only valid for an in-progress task.";
	}
	return validateBlockers(input.blockedBy, validIds);
}

function validateUpdate(
	update: TodoUpdate,
	validIds: Set<string>,
	ownId: string,
	currentStatus: TodoStatus,
): string | undefined {
	if (!Object.keys(update).length) return "Provide at least one field to update.";
	if (update.content !== undefined && !isNonEmptyString(update.content, MAX_CONTENT_CHARS)) {
		return `Task content is required and limited to ${MAX_CONTENT_CHARS} characters.`;
	}
	if (update.description !== undefined && update.description !== null && !isOptionalText(update.description, MAX_DESCRIPTION_CHARS)) {
		return `Task description is limited to ${MAX_DESCRIPTION_CHARS} characters.`;
	}
	if (update.status !== undefined && !isTodoStatus(update.status)) return "Task status is invalid.";
	if (update.activeForm !== undefined && update.activeForm !== null && !isOptionalText(update.activeForm, MAX_ACTIVE_FORM_CHARS)) {
		return `Active task text is limited to ${MAX_ACTIVE_FORM_CHARS} characters.`;
	}
	if ((update.status ?? currentStatus) !== "in_progress" && update.activeForm?.trim()) {
		return "activeForm is only valid for an in-progress task.";
	}
	return validateBlockers(update.blockedBy ?? undefined, validIds, ownId);
}

export function createEmptyBoard(): TodoBoard {
	return {
		version: DIVO_TODO_DETAILS_VERSION,
		boardId: randomUUID(),
		revision: 0,
		items: [],
		updatedAt: now(),
	};
}

export function snapshot(board: TodoBoard, action: TodoAction, error?: string): TodoDetails {
	return { ...clone(board), action, ...(error ? { error } : {}) };
}

export function restoreBoard(value: unknown): TodoBoard | undefined {
	if (!value || typeof value !== "object") return undefined;
	const details = value as Partial<TodoDetails>;
	if (
		details.version !== DIVO_TODO_DETAILS_VERSION ||
		!isTaskId(details.boardId) ||
		!Number.isSafeInteger(details.revision) ||
		details.revision < 0 ||
		!Array.isArray(details.items) ||
		details.items.length > MAX_TODOS ||
		!isTimestamp(details.updatedAt)
	) {
		return undefined;
	}

	const ids = new Set<string>();
	let activeCount = 0;
	for (const item of details.items) {
		if (!item || typeof item !== "object") return undefined;
		if (!isTaskId(item.id) || ids.has(item.id) || !isNonEmptyString(item.content, MAX_CONTENT_CHARS)) return undefined;
		if (!isOptionalText(item.description, MAX_DESCRIPTION_CHARS) || !isTodoStatus(item.status)) return undefined;
		if (!isOptionalText(item.activeForm, MAX_ACTIVE_FORM_CHARS)) return undefined;
		if (!isTimestamp(item.createdAt) || !isTimestamp(item.updatedAt)) return undefined;
		if (item.status !== "in_progress" && item.activeForm) return undefined;
		if (item.status === "in_progress") activeCount += 1;
		ids.add(item.id);
	}
	if (activeCount > 1) return undefined;
	for (const item of details.items) {
		const blockerError = validateBlockers(item.blockedBy, ids, item.id);
		if (blockerError) return undefined;
	}
	return clone({
		version: DIVO_TODO_DETAILS_VERSION,
		boardId: details.boardId,
		revision: details.revision,
		items: details.items,
		updatedAt: details.updatedAt,
	});
}

function nextBoard(board: TodoBoard, items: TodoItem[]): TodoBoard {
	return {
		...board,
		revision: board.revision + 1,
		items,
		updatedAt: now(),
	};
}

function settleExistingActive(items: TodoItem[], exceptId?: string): TodoItem[] {
	const updatedAt = now();
	return items.map((item) =>
		item.id !== exceptId && item.status === "in_progress"
			? { ...item, status: "pending", activeForm: undefined, updatedAt }
			: item,
	);
}

export function createTodos(board: TodoBoard, inputs: TodoInput[]): { board?: TodoBoard; error?: string } {
	if (!Array.isArray(inputs) || !inputs.length) return { error: "Provide one or more tasks to create." };
	if (inputs.length > MAX_CREATE_ITEMS) return { error: `Create at most ${MAX_CREATE_ITEMS} tasks at once.` };
	if (board.items.length + inputs.length > MAX_TODOS) return { error: `A board can contain at most ${MAX_TODOS} tasks.` };
	if (inputs.filter((input) => input.status === "in_progress").length > 1) {
		return { error: "Only one task can be in progress at a time." };
	}
	const ids = new Set(board.items.map((item) => item.id));
	for (const input of inputs) {
		const error = validateInput(input, ids);
		if (error) return { error };
	}

	let items = clone(board.items);
	if (inputs.some((input) => input.status === "in_progress")) items = settleExistingActive(items);
	const createdAt = now();
	for (const input of inputs) {
		items.push({
			id: randomUUID(),
			content: input.content.trim(),
			description: normaliseOptionalText(input.description),
			status: input.status ?? "pending",
			activeForm: input.status === "in_progress" ? normaliseOptionalText(input.activeForm) : undefined,
			blockedBy: normaliseBlockers(input.blockedBy),
			createdAt,
			updatedAt: createdAt,
		});
	}
	return { board: nextBoard(board, items) };
}

export function updateTodo(board: TodoBoard, id: string, update: TodoUpdate): { board?: TodoBoard; error?: string } {
	const current = board.items.find((item) => item.id === id);
	if (!current) return { error: `Task ${id} was not found.` };
	const error = validateUpdate(update, new Set(board.items.map((item) => item.id)), id, current.status);
	if (error) return { error };

	const nextStatus = update.status ?? current.status;
	const updatedAt = now();
	let items = clone(board.items);
	if (nextStatus === "in_progress") items = settleExistingActive(items, id);
	items = items.map((item) => {
		if (item.id !== id) return item;
		return {
			...item,
			content: update.content === undefined ? item.content : update.content.trim(),
			description: update.description === undefined ? item.description : normaliseOptionalText(update.description ?? undefined),
			status: nextStatus,
			activeForm:
				nextStatus === "in_progress"
					? update.activeForm === undefined
						? item.activeForm
						: normaliseOptionalText(update.activeForm ?? undefined)
					: undefined,
			blockedBy: update.blockedBy === undefined ? item.blockedBy : normaliseBlockers(update.blockedBy ?? undefined),
			updatedAt,
		};
	});
	return { board: nextBoard(board, items) };
}

export function clearTodos(board: TodoBoard, completedOnly: boolean): TodoBoard {
	const items = completedOnly ? board.items.filter((item) => item.status !== "completed") : [];
	return nextBoard(board, items);
}

export function boardText(board: TodoBoard): string {
	if (!board.items.length) return "No tasks on this chat's Pi todo board.";
	const active = board.items.find((item) => item.status === "in_progress");
	const counts = board.items.reduce<Record<TodoStatus, number>>(
		(acc, item) => ({ ...acc, [item.status]: acc[item.status] + 1 }),
		{ pending: 0, in_progress: 0, completed: 0, blocked: 0, cancelled: 0 },
	);
	const summary = `${counts.completed}/${board.items.length} completed, ${counts.in_progress} active, ${counts.pending} upcoming`;
	return active ? `${summary}\nActive: ${active.activeForm || active.content}` : summary;
}
