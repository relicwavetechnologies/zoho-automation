/**
 * Pure projection from Pi's internal event vocabulary to Divo's bounded
 * runtime progress protocol. No Docker, lease, process, or transport state
 * belongs in this module.
 */

function progressToolId(toolName, args) {
	const direct = args?.toolId;
	const nested = args?.payload?.toolId;
	const value = typeof direct === "string" ? direct : typeof nested === "string" ? nested : undefined;
	if (!value || !/^[A-Za-z0-9._-]{1,80}$/.test(value)) return undefined;
	return isGovernedDivoTool(toolName) || toolName === "call_tool" ? value : undefined;
}
/**
 * A governed Divo capability call.
 *
 * Every governed tool is now its own typed Pi tool named `divo_<toolId>`, so
 * there is no single mega-tool name left to match on. The prefix is the
 * boundary: Divo registers it, Pi's own built-ins never use it.
 */
export function isGovernedDivoTool(toolName) {
	return typeof toolName === "string" && toolName.startsWith("divo_");
}

const PROGRESS_LABEL_MAX = 80;
const PROGRESS_CHILDREN_MAX = 8;
const PROGRESS_TODOS_MAX = 12;

const PROGRESS_DETAIL_MAX = 64;
const PROGRESS_SAY_MAX = 200;
/**
 * Reasoning gets far more room than a sentence, because it is not one.
 *
 * 200 was the right bound for a `say`: a Lark card shows a line of what the
 * model told you, and more would take the card over. A thought is neither of
 * those things — it is not on a card at all, and it is routinely a paragraph.
 * Held to 200 it froze at its first two sentences and then never changed again,
 * because the text is accumulated from the start and truncated from the front:
 * a window built to let you watch the model think would have shown two static
 * lines for the length of the run.
 */
const PROGRESS_THOUGHT_MAX = 1200;

function progressLabel(value, maxLength = PROGRESS_LABEL_MAX) {
	if (typeof value !== "string") return undefined;
	const flat = value.replace(/\s+/g, " ").trim();
	if (!flat) return undefined;
	return flat.length > maxLength ? `${flat.slice(0, maxLength - 1)}…` : flat;
}

/**
 * What a tool call is about, taken from the arguments it was called with.
 *
 * Five rows reading "Terminal / Files / Terminal" say only that something ran.
 * The argument that names the work is already in hand here — the projection
 * simply threw it away — and one short phrase per row is the difference between
 * a progress bar and a log somebody can read.
 *
 * Only the one identifying argument crosses, never the whole object: a tool's
 * arguments can carry a whole file body or a customer record, and this string
 * is rendered into a chat window a room full of colleagues can read.
 */
function progressToolDetail(toolName, args) {
	if (!args || typeof args !== "object") return undefined;
	const fileName = (value) =>
		typeof value === "string" ? value.split("/").filter(Boolean).at(-1) : undefined;

	if (toolName === "bash") return progressLabel(args.command, PROGRESS_DETAIL_MAX);
	if (toolName === "read" || toolName === "write" || toolName === "edit") {
		return progressLabel(fileName(args.file_path ?? args.path), PROGRESS_DETAIL_MAX);
	}
	// The tool id already travels as its own field, and the backend holds the
	// table that turns it into a product name — so only the operation goes here.
	// Sending the raw id too would print it twice, untranslated.
	if (isGovernedDivoTool(toolName)) return progressLabel(governedOperation(args), PROGRESS_DETAIL_MAX);
	return undefined;
}

/**
 * Operations that are plumbing rather than work.
 *
 * An MCP-backed family takes `{ op: 'call', nativeTool, input }`, so `op` says
 * only that a native tool was called — which is true of nearly every row and
 * was reaching the reader as a step literally captioned "call".
 */
const NATIVE_CALL_OPS = new Set(["call", "call_resolved_sheet"]);

/**
 * Which of a governed call's arguments names what it is doing.
 *
 * `nativeTool` for the MCP-backed families, because that is the operation a
 * person would recognise; `op` for the flat ones, where the operation is
 * already what `op` holds. `describe` keeps its own name on purpose: asking a
 * tool for its schema is not performing the operation it describes, and a row
 * that claimed otherwise would be reporting work that never happened.
 */
export function governedOperation(args) {
	const op = typeof args?.op === "string" ? args.op : undefined;
	const operation = typeof args?.operation === "string" ? args.operation : undefined;
	const nativeTool = typeof args?.nativeTool === "string" ? args.nativeTool : undefined;
	if (op && NATIVE_CALL_OPS.has(op) && nativeTool) return nativeTool;
	return op ?? operation;
}

/** The text block the model is writing right now, out of the accumulated message. */
function assistantBlockText(assistantMessageEvent) {
	const content = assistantMessageEvent?.partial?.content;
	const block = Array.isArray(content) ? content[assistantMessageEvent.contentIndex] : undefined;
	return block?.type === "text" && typeof block.text === "string" ? block.text : undefined;
}

/**
 * The reasoning block the model is working through right now.
 *
 * `ThinkingContent` in `packages/ai/src/types.ts` — `{ type: "thinking",
 * thinking: string }`, addressed by the delta's own `contentIndex`, which is
 * why the block is looked up rather than searched for: a message holds text and
 * reasoning side by side, and taking the wrong one would print the model's
 * private working as though it had been said to the reader.
 *
 * A redacted block is skipped outright. Its content was removed by the
 * provider's safety filters and what remains is an opaque payload kept only so
 * the conversation can continue — there is nothing in it for a person to read,
 * and forwarding it would put a row on screen that says nothing.
 */
export function assistantThinkingText(assistantMessageEvent) {
	const content = assistantMessageEvent?.partial?.content;
	const block = Array.isArray(content) ? content[assistantMessageEvent.contentIndex] : undefined;
	if (block?.type !== "thinking" || block.redacted === true) return undefined;
	return typeof block.thinking === "string" ? block.thinking : undefined;
}

/**
 * Only whole sentences leave the container.
 *
 * A text delta arrives per token, and forwarding each one would redraw the
 * status card for every word of a thirteen-minute run — hundreds of edits of
 * one chat message, for a card nobody is reading letter by letter. Cutting at
 * the last completed sentence makes the projection self-rate-limiting without
 * any timer: the value only changes when the model finishes saying something.
 */
export function settledSentences(text) {
	const match = /^[\s\S]*[.!?…](?=["'’”)\]]*(?:\s|$))/.exec(text ?? "");
	return match ? match[0].trim() : "";
}

/** Pi child states, in the vocabulary the status card renders. */
const CHILD_STATE_STATUS = {
	queued: "pending",
	running: "running",
	completed: "done",
	failed: "failed",
	cancelled: "skipped",
};

function progressElapsedLabel(value) {
	if (typeof value !== "string") return undefined;
	const startedAt = Date.parse(value);
	if (!Number.isFinite(startedAt)) return undefined;
	const seconds = Math.max(1, Math.floor((Date.now() - startedAt) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	if (minutes < 60) return `${minutes}m ${String(remainingSeconds).padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
}

function progressChildDetail(child) {
	const elapsed = child?.state === "running"
		? progressElapsedLabel(child?.startedAt)
		: undefined;
	if (!elapsed) return progressLabel(child?.task, PROGRESS_DETAIL_MAX);
	const suffix = `working ${elapsed}`;
	const task = progressLabel(
		child?.task,
		Math.max(16, PROGRESS_DETAIL_MAX - suffix.length - 3),
	);
	return task ? `${task} · ${suffix}` : suffix;
}

/**
 * Subagent children, from the details `divo_subagents` already streams.
 *
 * Only the role, the task and the state cross this boundary. A child's output,
 * usage and event log are the run's internals, and the status card is shown in
 * a chat window — anything forwarded here is something a bystander may read.
 */
function progressChildren(details) {
	const children = details?.children;
	if (!Array.isArray(children) || children.length === 0) return undefined;
	const rows = children.slice(0, PROGRESS_CHILDREN_MAX).flatMap((child) => {
		const label = progressLabel(child?.role);
		if (!label) return [];
		const status = CHILD_STATE_STATUS[child?.state] ?? "running";
		const detail = progressChildDetail(child);
		return [{ label, status, ...(detail ? { detail } : {}) }];
	});
	return rows.length > 0 ? rows : undefined;
}

/** The checklist `divo_todos` declared, if this tool call was that one. */
function progressTodos(details) {
	const items = details?.items;
	if (!Array.isArray(items) || items.length === 0) return undefined;
	const rows = items.slice(0, PROGRESS_TODOS_MAX).flatMap((item) => {
		const title = progressLabel(item?.title);
		if (!title) return [];
		const status = typeof item?.status === "string" ? item.status : "pending";
		return [{ title, status }];
	});
	return rows.length > 0 ? rows : undefined;
}

/**
 * What a tool's own details say about the work underneath it.
 *
 * Both extensions that have something to show already stream it as tool
 * details, so neither needs a transport of its own — the shape of the details
 * decides which it is.
 */
function progressDetail(details) {
	if (!details || typeof details !== "object") return undefined;
	const children = progressChildren(details);
	if (children) return { children };
	const todos = progressTodos(details);
	if (todos) return { todos };
	// Some tools can name their work only after returning structured details.
	const name = progressLabel(details.name, PROGRESS_DETAIL_MAX);
	if (name && typeof details.revision === "number") return { detail: name };
	return undefined;
}

export function projectRuntimeProgress(event) {
	if (!event || typeof event !== "object") return undefined;
	if (event.type === "agent_start" || event.type === "turn_start") {
		return { type: "thinking" };
	}
	if (event.type === "tool_execution_start") {
		const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
		const toolId = progressToolId(toolName, event.args);
		const detail = progressToolDetail(toolName, event.args);
		return {
			type: "tool_start",
			callId: String(event.toolCallId ?? ""),
			toolName,
			...(toolId ? { toolId } : {}),
			...(detail ? { detail } : {}),
		};
	}
	if (event.type === "tool_execution_update") {
		// Most tools stream partial stdout, which the card has no use for. Only a
		// call that describes structured work underneath itself is worth a redraw.
		const detail = progressDetail(event.partialResult?.details);
		if (!detail) return undefined;
		return {
			type: "tool_progress",
			callId: String(event.toolCallId ?? ""),
			toolName: typeof event.toolName === "string" ? event.toolName : "tool",
			...detail,
		};
	}
	if (event.type === "tool_execution_end") {
		// The final details settle every child at once: a run that ended between
		// the last update and here would otherwise leave children stuck running
		// under a parent already marked done.
		return {
			type: "tool_end",
			callId: String(event.toolCallId ?? ""),
			toolName: typeof event.toolName === "string" ? event.toolName : "tool",
			isError: event.isError === true,
			...(progressDetail(event.result?.details) ?? {}),
		};
	}
	if (
		event.type === "message_update"
		&& event.assistantMessageEvent?.type === "text_delta"
	) {
		// A long run that says nothing reads as a hang, however much work it is
		// doing. What the model says between its tool calls is the only thing on
		// the card written for a person rather than derived from one, so it is
		// forwarded rather than flattened into a bare "writing" flag.
		const said = progressLabel(
			settledSentences(assistantBlockText(event.assistantMessageEvent)),
			PROGRESS_SAY_MAX,
		);
		if (!said) return { type: "writing" };
		return {
			type: "say",
			index: Number.isInteger(event.assistantMessageEvent.contentIndex)
				? event.assistantMessageEvent.contentIndex
				: 0,
			text: said,
		};
	}
	if (
		event.type === "message_update"
		&& event.assistantMessageEvent?.type === "thinking_delta"
	) {
		/*
		 * Reasoning, forwarded — and it did not used to be.
		 *
		 * The rule here was "reasoning stays inside the container", on the
		 * grounds that `thinking_delta` is the model talking to itself and a
		 * Lark status card is read by everyone in the chat. The second half of
		 * that is still true and is still enforced, but it is a fact about a
		 * *card*, not about the run — and it was being enforced at the wrong
		 * end. Withholding it here withheld it from the web thread as well,
		 * which is one person reading their own conversation, and where the
		 * reasoning is most of what makes a long run legible rather than a
		 * silent thirty seconds.
		 *
		 * So it leaves as its own event kind, capped and sentence-cut exactly
		 * like `say`, and each surface decides. The Lark card drops it.
		 */
		const thought = progressLabel(
			settledSentences(assistantThinkingText(event.assistantMessageEvent)),
			PROGRESS_THOUGHT_MAX,
		);
		if (!thought) return { type: "thinking" };
		return {
			type: "thought",
			index: Number.isInteger(event.assistantMessageEvent.contentIndex)
				? event.assistantMessageEvent.contentIndex
				: 0,
			text: thought,
		};
	}
	return undefined;
}

/**
 * The exact answer fragment the model just produced.
 *
 * `projectRuntimeProgress` deliberately sentence-batches prose because a Lark
 * status card must not be edited for every token. That projection is useful
 * for a work log and fundamentally wrong for a browser answer: once the raw
 * delta is discarded, the only remaining option is to receive the completed
 * answer and pretend to stream it locally. Keep the two lanes separate. The
 * shared runtime still emits its low-frequency status projection, while a
 * surface capable of rendering live prose can consume these ordered deltas.
 */
export function projectRuntimeAnswerDelta(event) {
	if (
		event?.type !== "message_update"
		|| event.assistantMessageEvent?.type !== "text_delta"
		|| typeof event.assistantMessageEvent.delta !== "string"
		|| event.assistantMessageEvent.delta.length === 0
	) return undefined;
	return {
		type: "answer_delta",
		index: Number.isInteger(event.assistantMessageEvent.contentIndex)
			? event.assistantMessageEvent.contentIndex
			: 0,
		delta: event.assistantMessageEvent.delta,
	};
}
