/**
 * Pi-owned checklist for Divo.
 *
 * Upstream Pi ships no to-do tool on purpose — its README's position is that
 * built-in to-dos confuse models. That reasoning is about a to-do list the
 * agent is told to maintain as a working memory, which competes with its own
 * plan. This tool is a narrower thing: a declaration, for the person watching,
 * of the steps a long request was broken into.
 *
 * So it holds no authority and stores nothing. The list lives for the length of
 * the run, is replaced wholesale on every call, and exists to be rendered. The
 * agent is not asked to consult it, and nothing downstream reads it back.
 *
 * Whole-list replacement is deliberate: an add/complete/remove API needs stable
 * ids, and an agent that loses track of an id silently corrupts the list. A
 * model that can restate four steps can always restate them.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const DIVO_TODOS_TOOL_NAME = "divo_todos";
export const DIVO_TODOS_DETAILS_VERSION = 1 as const;
export const MAX_TODO_ITEMS = 12;
export const MAX_TODO_TITLE_CHARS = 80;

export const TODO_STATUSES = ["pending", "running", "done", "skipped"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

const TodosParams = Type.Object({
	items: Type.Array(
		Type.Object({
			title: Type.String({
				description: "The step, as a short phrase the user would recognise. Written in English.",
				minLength: 1,
				maxLength: MAX_TODO_TITLE_CHARS,
			}),
			status: Type.Optional(
				Type.Union(TODO_STATUSES.map((status) => Type.Literal(status)), {
					description: "Defaults to pending. Exactly one step should be running at a time.",
				}),
			),
		}),
		{
			description: "The complete checklist, in order. Always send every step, not just the changed one.",
			minItems: 1,
			maxItems: MAX_TODO_ITEMS,
		},
	),
});

type TodosParams = {
	items: Array<{ title: string; status?: TodoStatus }>;
};

export type TodoItem = {
	title: string;
	status: TodoStatus;
};

export type DivoTodosDetails = {
	version: typeof DIVO_TODOS_DETAILS_VERSION;
	items: TodoItem[];
	done: number;
	total: number;
	current?: string;
	updatedAt: string;
};

/**
 * Two steps marked running at once would make the card show two live rows and
 * the progress count disagree with them, so the later one wins and the rest are
 * demoted. Guessing which the model meant is worse than picking the last.
 */
export function normalizeTodoItems(items: readonly { title: string; status?: TodoStatus }[]): TodoItem[] {
	const trimmed = items
		.map((item) => ({
			title: item.title.trim().slice(0, MAX_TODO_TITLE_CHARS),
			status: item.status ?? "pending",
		}))
		.filter((item) => item.title.length > 0)
		.slice(0, MAX_TODO_ITEMS);

	const lastRunning = trimmed.map((item) => item.status).lastIndexOf("running");
	return trimmed.map((item, index) =>
		item.status === "running" && index !== lastRunning ? { ...item, status: "done" } : item,
	);
}

export function buildTodosDetails(
	items: readonly TodoItem[],
	updatedAt = new Date().toISOString(),
): DivoTodosDetails {
	const settled = items.filter((item) => item.status === "done" || item.status === "skipped").length;
	const current = items.find((item) => item.status === "running")?.title;
	return {
		version: DIVO_TODOS_DETAILS_VERSION,
		items: items.map((item) => ({ ...item })),
		done: settled,
		total: items.length,
		...(current ? { current } : {}),
		updatedAt,
	};
}

/** The line the model reads back, so it can tell the call landed. */
export function summarizeTodos(details: DivoTodosDetails): string {
	const marker: Record<TodoStatus, string> = {
		pending: "[ ]",
		running: "[~]",
		done: "[x]",
		skipped: "[-]",
	};
	const list = details.items.map((item) => `${marker[item.status]} ${item.title}`).join("\n");
	const completionInstruction = details.done === details.total
		? "\nChecklist complete. Now send the complete user-facing result in a separate final message; text beside this tool call is not delivered as the terminal answer."
		: "";
	return `Checklist shown to the user (${details.done}/${details.total}):\n${list}${completionInstruction}`;
}

export default function divoTodosExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: DIVO_TODOS_TOOL_NAME,
		label: "Divo checklist",
		description:
			"Show the user the steps this request was broken into, and which one is in progress. Replaces the whole checklist on every call. Display only: it is not a Lark task, not a document checklist, and not a reminder — it disappears when the run ends, grants no permission, and performs no work.",
		promptSnippet:
			"For a request that takes several distinct steps, call divo_todos once with the full plan, then again as each step starts and finishes, so the person watching can see where the work is.",
		promptGuidelines: [
			"This is the progress display for work you are doing right now. It is never what the user means when they ask for a to-do list, a task, a checklist, or a reminder they can keep.",
			"A task the user wants to own, assign, or see later is a Lark task — reach it through the company capability gateway, not here. A checklist that belongs inside a document is a document todo block. Both of those outlive the conversation; this does not.",
			"If a request could mean either, ask. Showing this checklist when the user wanted a real task looks like it worked and leaves nothing behind.",
			"Use it for multi-step requests only. A single lookup, a short answer, or one tool call needs no checklist and looks worse with one.",
			"Send the entire list every time, including steps already done. There is no add or complete call; the newest list replaces the previous one.",
			"Mark exactly one step running. Move it forward as work progresses rather than marking everything done at the end, which shows the user nothing while it matters.",
			"Complete the checklist before writing the final answer. Never combine user-visible result text with a divo_todos call; after the tool returns, send the complete result in a separate final message.",
			"Write steps as outcomes the user would recognise (\"Pull last week's closed deals\"), not as tool names or internal operations.",
			"Keep it to the real shape of the work — a handful of steps. A checklist longer than the answer is noise.",
			"Calling this tool does not do the work and does not authorize anything. Marking a step done does not make it done.",
			"Write every step in English.",
		],
		parameters: TodosParams,

		async execute(_toolCallId: string, params: TodosParams) {
			const items = normalizeTodoItems(params.items);
			if (items.length === 0) {
				return {
					content: [{ type: "text" as const, text: "Checklist not shown: every step was empty." }],
					details: { version: DIVO_TODOS_DETAILS_VERSION, error: "no items" },
					isError: true,
				};
			}

			const details = buildTodosDetails(items);
			return {
				content: [{ type: "text" as const, text: summarizeTodos(details) }],
				details,
			};
		},
	});
}
