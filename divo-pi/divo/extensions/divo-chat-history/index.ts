/**
 * Cross-thread Pi chat recall for Divo.
 *
 * Progressive disclosure (claude-history / agent-historian):
 *   search_chats → pick hit → read_chat (budgeted window)
 *
 * Corpus: $DIVO_CHAT_HISTORY_DIR/threads/{uuid}/pi-session.jsonl
 * Never reads workspace .divo scratch.
 *
 * Sandbox: only resolves under DIVO_CHAT_HISTORY_DIR; rejects path escapes.
 */

import { constants } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

export const SEARCH_TOOL = "divo_search_chats";
export const READ_TOOL = "divo_read_chat";

export const MAX_SEARCH_LIMIT = 20;
export const DEFAULT_SEARCH_LIMIT = 8;
export const MAX_READ_LIMIT = 30;
export const DEFAULT_READ_LIMIT = 16;
export const MAX_SNIPPET_CHARS = 320;
export const MAX_MESSAGE_TEXT_CHARS = 4_000;
export const MAX_SESSION_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_SEARCH_CORPUS_BYTES = 128 * 1024 * 1024;
const MAX_THREAD_METADATA_BYTES = 64 * 1024;
const MAX_SKIPPED_THREAD_REPORTS = 20;
const MAX_SEARCH_CANDIDATES = 200;
const RECENCY_HALF_LIFE_DAYS = 30;
const RECENCY_MAX_BOOST = 0.2;

export type SearchVariant = "keyword" | "recent" | "oldest" | "title" | "broad";

export type ChatSearchHit = {
	threadId: string;
	title: string;
	messageId: string;
	role: string;
	createdAt: string;
	snippet: string;
	score: number;
};

type SessionMessage = {
	id: string;
	role: string;
	text: string;
	createdAt: string;
};

type ContainedFile = {
	path: string;
	sizeBytes: number;
};

type SkippedThread = {
	threadId: string;
	reason: "session_too_large" | "search_corpus_budget" | "unreadable";
};

export function resolveChatHistoryRoot(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const raw = env.DIVO_CHAT_HISTORY_DIR?.trim();
	return raw || undefined;
}

export function sanitizeThreadId(threadId: string): string {
	const id = threadId.trim();
	if (!id || id.length > 128) throw new Error("Invalid thread id.");
	if (id.includes("/") || id.includes("\\") || id.includes("\0") || id.includes("..")) {
		throw new Error("Invalid thread id.");
	}
	return id;
}

export async function resolveThreadDir(root: string, threadId: string): Promise<string> {
	const id = sanitizeThreadId(threadId);
	const rootReal = await realpath(root);
	const threadsRoot = await realpath(join(rootReal, "threads")).catch(async () => {
		throw new Error("Chat history threads directory was not found.");
	});
	const candidate = join(threadsRoot, id);
	const real = await realpath(candidate).catch(async () => {
		throw new Error(`Thread "${id}" was not found.`);
	});
	const prefix = threadsRoot.endsWith(sep) ? threadsRoot : threadsRoot + sep;
	if (real !== threadsRoot && !real.startsWith(prefix)) {
		throw new Error("Thread path escapes the chat history sandbox.");
	}
	return real;
}

async function resolveContainedFile(
	threadDir: string,
	fileName: "thread.json" | "pi-session.jsonl",
): Promise<ContainedFile> {
	const threadReal = await realpath(threadDir);
	const fileReal = await realpath(join(threadReal, fileName)).catch(async () => {
		throw new Error(`Chat history file "${fileName}" was not found.`);
	});
	const prefix = threadReal.endsWith(sep) ? threadReal : threadReal + sep;
	if (!fileReal.startsWith(prefix)) {
		throw new Error(`Chat history file "${fileName}" escapes its thread directory.`);
	}
	const metadata = await stat(fileReal);
	if (!metadata.isFile()) {
		throw new Error(`Chat history path "${fileName}" is not a regular file.`);
	}
	return { path: fileReal, sizeBytes: metadata.size };
}

async function readBoundedUtf8File(
	file: ContainedFile,
	maxBytes: number,
	label: string,
): Promise<string> {
	if (file.sizeBytes > maxBytes) {
		throw new Error(`${label} exceeds the ${maxBytes}-byte read limit.`);
	}

	const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
	const handle = await open(file.path, constants.O_RDONLY | noFollow);
	try {
		const before = await handle.stat();
		if (!before.isFile()) throw new Error(`${label} is not a regular file.`);
		if (before.size > maxBytes) {
			throw new Error(`${label} exceeds the ${maxBytes}-byte read limit.`);
		}

		const buffer = Buffer.alloc(before.size);
		let offset = 0;
		while (offset < buffer.length) {
			const { bytesRead } = await handle.read(
				buffer,
				offset,
				buffer.length - offset,
				offset,
			);
			if (bytesRead === 0) break;
			offset += bytesRead;
		}

		const after = await handle.stat();
		if (after.size !== before.size) {
			throw new Error(`${label} changed while it was being read; retry the request.`);
		}
		return buffer.subarray(0, offset).toString("utf8");
	} finally {
		await handle.close();
	}
}

function expandQuery(query: string, variant: SearchVariant): string[] {
	const tokens = query
		.toLowerCase()
		.split(/\s+/)
		.map((t) => t.replace(/[^a-z0-9_\-.]/gi, ""))
		.filter(Boolean);
	if (variant !== "broad") return tokens;
	const out = [...tokens];
	for (const t of tokens) {
		if (t.endsWith("s") && t.length > 3) out.push(t.slice(0, -1));
		else if (t.length > 3) out.push(`${t}s`);
	}
	return [...new Set(out)];
}

function scoreText(text: string, tokens: string[]): number {
	if (tokens.length === 0) return 0;
	const lower = text.toLowerCase();
	let score = 0;
	for (const t of tokens) {
		if (!t) continue;
		let idx = 0;
		while (true) {
			const found = lower.indexOf(t, idx);
			if (found < 0) break;
			score += 1;
			idx = found + t.length;
		}
	}
	return score;
}

function applyRecencyBoost(score: number, createdAt: string, variant: SearchVariant): number {
	if (variant === "oldest" || variant === "title") return score;
	const ts = Date.parse(createdAt);
	if (Number.isNaN(ts)) return score;
	const ageDays = Math.max(0, (Date.now() - ts) / 86_400_000);
	const boost = RECENCY_MAX_BOOST * 0.5 ** (ageDays / RECENCY_HALF_LIFE_DAYS);
	return score * (1 + boost);
}

function makeSnippet(body: string, tokens: string[]): string {
	const lower = body.toLowerCase();
	const needle = tokens[0] ?? "";
	const idx = needle ? lower.indexOf(needle) : 0;
	const start = Math.max(0, (idx < 0 ? 0 : idx) - 80);
	let snippet = body.slice(start, start + MAX_SNIPPET_CHARS).replace(/\n/g, " ");
	if (start > 0) snippet = `…${snippet}`;
	if (start + MAX_SNIPPET_CHARS < body.length) snippet = `${snippet}…`;
	return snippet;
}

function compareSearchHits(
	left: ChatSearchHit,
	right: ChatSearchHit,
	variant: SearchVariant,
): number {
	if (variant === "oldest") {
		return left.createdAt.localeCompare(right.createdAt) || right.score - left.score;
	}
	return right.score - left.score || right.createdAt.localeCompare(left.createdAt);
}

function trimSearchCandidates(hits: ChatSearchHit[], variant: SearchVariant): void {
	if (hits.length <= MAX_SEARCH_CANDIDATES * 2) return;
	hits.sort((left, right) => compareSearchHits(left, right, variant));
	hits.length = MAX_SEARCH_CANDIDATES;
}

function extractTextContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const item of content) {
		if (!item || typeof item !== "object") continue;
		const rec = item as Record<string, unknown>;
		const ty = typeof rec.type === "string" ? rec.type : "";
		if (ty === "thinking" || ty === "tool_use" || ty === "image") continue;
		if (typeof rec.text === "string") parts.push(rec.text);
		else if (rec.text && typeof rec.text === "object") {
			const value = (rec.text as Record<string, unknown>).value;
			if (typeof value === "string") parts.push(value);
		}
	}
	return parts.join("\n");
}

export function parseSessionMessages(raw: string): SessionMessage[] {
	const out: SessionMessage[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let value: Record<string, unknown>;
		try {
			value = JSON.parse(trimmed) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (value.type !== "message") continue;
		const id = typeof value.id === "string" ? value.id : "";
		if (!id) continue;
		const message = (value.message && typeof value.message === "object"
			? value.message
			: {}) as Record<string, unknown>;
		const role = typeof message.role === "string" ? message.role : "";
		let text = "";
		if (role === "user" || role === "assistant") {
			text = extractTextContent(message.content);
		} else if (role === "toolResult") {
			const tool = typeof message.toolName === "string" ? message.toolName : "tool";
			text = `[tool:${tool}]`;
		} else {
			continue;
		}
		if (!text.trim()) continue;
		const createdAt =
			(typeof value.timestamp === "string" && value.timestamp) ||
			(typeof message.timestamp === "string" && message.timestamp) ||
			"1970-01-01T00:00:00.000Z";
		out.push({ id, role, text, createdAt });
	}
	return out;
}

async function readThreadTitle(threadDir: string): Promise<string> {
	try {
		const metadataFile = await resolveContainedFile(threadDir, "thread.json");
		const raw = await readBoundedUtf8File(
			metadataFile,
			MAX_THREAD_METADATA_BYTES,
			"Chat thread metadata",
		);
		const value = JSON.parse(raw) as { title?: string };
		return value.title?.trim() || "";
	} catch {
		return "";
	}
}

export async function searchChats(input: {
	root: string;
	query: string;
	variant: SearchVariant;
	limit?: number;
}): Promise<{
	hits: ChatSearchHit[];
	variant: SearchVariant;
	query: string;
	skippedThreadCount: number;
	skippedThreads: SkippedThread[];
}> {
	const query = input.query.trim();
	if (!query) throw new Error("Search query is required.");
	if (query.length > 500) throw new Error("Search query is too long.");
	const limit = Math.min(MAX_SEARCH_LIMIT, Math.max(1, input.limit ?? DEFAULT_SEARCH_LIMIT));
	const tokens = expandQuery(query, input.variant);
	const rootReal = await realpath(input.root);
	const threadsDir = await realpath(join(rootReal, "threads")).catch(async () => {
		throw new Error("Chat history threads directory was not found.");
	});
	const entries = await readdir(threadsDir, { withFileTypes: true }).catch(() => []);
	const hits: ChatSearchHit[] = [];
	const skippedThreads: SkippedThread[] = [];
	let skippedThreadCount = 0;
	let corpusBytes = 0;

	const recordSkipped = (threadId: string, reason: SkippedThread["reason"]) => {
		skippedThreadCount += 1;
		if (skippedThreads.length < MAX_SKIPPED_THREAD_REPORTS) {
			skippedThreads.push({ threadId, reason });
		}
	};

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		let threadId: string;
		try {
			threadId = sanitizeThreadId(entry.name);
		} catch {
			continue;
		}
		let threadDir: string;
		let sessionFile: ContainedFile;
		try {
			threadDir = await resolveThreadDir(rootReal, threadId);
			sessionFile = await resolveContainedFile(threadDir, "pi-session.jsonl");
		} catch {
			continue;
		}
		const title = (await readThreadTitle(threadDir)) || threadId;
		if (input.variant === "title") {
			const score = scoreText(title, tokens);
			if (score <= 0) continue;
			hits.push({
				threadId,
				title,
				messageId: "",
				role: "title",
				createdAt: "1970-01-01T00:00:00.000Z",
				snippet: title,
				score: applyRecencyBoost(score, "1970-01-01T00:00:00.000Z", input.variant),
			});
			trimSearchCandidates(hits, input.variant);
			continue;
		}
		if (sessionFile.sizeBytes > MAX_SESSION_FILE_BYTES) {
			recordSkipped(threadId, "session_too_large");
			continue;
		}
		if (corpusBytes + sessionFile.sizeBytes > MAX_SEARCH_CORPUS_BYTES) {
			recordSkipped(threadId, "search_corpus_budget");
			continue;
		}
		let raw: string;
		try {
			raw = await readBoundedUtf8File(
				sessionFile,
				MAX_SESSION_FILE_BYTES,
				`Chat session "${threadId}"`,
			);
		} catch {
			recordSkipped(threadId, "unreadable");
			continue;
		}
		corpusBytes += sessionFile.sizeBytes;
		const messages = parseSessionMessages(raw);
		for (const msg of messages) {
			const score = scoreText(msg.text, tokens);
			if (score <= 0) continue;
			hits.push({
				threadId,
				title,
				messageId: msg.id,
				role: msg.role,
				createdAt: msg.createdAt,
				snippet: makeSnippet(msg.text, tokens),
				score: applyRecencyBoost(score, msg.createdAt, input.variant),
			});
			trimSearchCandidates(hits, input.variant);
		}
	}

	hits.sort((left, right) => compareSearchHits(left, right, input.variant));

	return {
		hits: hits.slice(0, limit),
		variant: input.variant,
		query,
		skippedThreadCount,
		skippedThreads,
	};
}

export async function readChat(input: {
	root: string;
	threadId: string;
	aroundMessageId?: string;
	offset?: number;
	limit?: number;
}): Promise<{
	threadId: string;
	title: string;
	messages: Array<{ id: string; role: string; text: string; createdAt: string }>;
	truncated: boolean;
}> {
	const limit = Math.min(MAX_READ_LIMIT, Math.max(1, input.limit ?? DEFAULT_READ_LIMIT));
	const offset = Math.max(0, input.offset ?? 0);
	const threadDir = await resolveThreadDir(input.root, input.threadId);
	const title = (await readThreadTitle(threadDir)) || input.threadId;
	const sessionFile = await resolveContainedFile(threadDir, "pi-session.jsonl");
	const raw = await readBoundedUtf8File(
		sessionFile,
		MAX_SESSION_FILE_BYTES,
		`Chat session "${input.threadId}"`,
	);
	const entries = parseSessionMessages(raw);
	if (entries.length === 0) {
		return { threadId: input.threadId, title, messages: [], truncated: false };
	}

	let start = 0;
	let end = 0;
	let truncated = false;
	const around = input.aroundMessageId?.trim();
	if (around) {
		const idx = entries.findIndex((e) => e.id === around);
		if (idx < 0) throw new Error(`Message "${around}" was not found in this thread.`);
		const half = Math.floor(limit / 2);
		start = Math.max(0, idx - half);
		end = Math.min(entries.length, start + limit);
		truncated = start > 0 || end < entries.length;
	} else {
		start = Math.min(offset, entries.length);
		end = Math.min(entries.length, start + limit);
		truncated = end < entries.length || start > 0;
	}

	const messages = entries.slice(start, end).map((e) => ({
		id: e.id,
		role: e.role,
		text:
			e.text.length <= MAX_MESSAGE_TEXT_CHARS
				? e.text
				: `${[...e.text].slice(0, MAX_MESSAGE_TEXT_CHARS - 1).join("")}…`,
		createdAt: e.createdAt,
	}));

	return { threadId: input.threadId, title, messages, truncated };
}

const SearchParams = Type.Object({
	query: Type.String({
		description: "What to find in past Pi chats (names, errors, decisions, keywords).",
		minLength: 1,
		maxLength: 500,
	}),
	variant: StringEnum(["keyword", "recent", "oldest", "title", "broad"] as const, {
		description:
			"keyword=default lexical; recent=recency boost; oldest=earliest hits; title=thread titles only; broad=light plural/stem expansion.",
	}),
	limit: Type.Optional(
		Type.Number({
			description: `Max hits (default ${DEFAULT_SEARCH_LIMIT}, max ${MAX_SEARCH_LIMIT}).`,
			minimum: 1,
			maximum: MAX_SEARCH_LIMIT,
		}),
	),
});

const ReadParams = Type.Object({
	threadId: Type.String({
		description: "Jan/Pi thread id from a search hit.",
		minLength: 1,
		maxLength: 128,
	}),
	aroundMessageId: Type.Optional(
		Type.String({
			description: "Center the window on this session message id from a search hit.",
			minLength: 1,
			maxLength: 128,
		}),
	),
	offset: Type.Optional(
		Type.Number({
			description: "Message offset when aroundMessageId is omitted.",
			minimum: 0,
		}),
	),
	limit: Type.Optional(
		Type.Number({
			description: `Max messages to return (default ${DEFAULT_READ_LIMIT}, max ${MAX_READ_LIMIT}).`,
			minimum: 1,
			maximum: MAX_READ_LIMIT,
		}),
	),
});

export default function divoChatHistoryExtension(pi: ExtensionAPI) {
	pi.registerTool<typeof SearchParams, unknown>({
		name: SEARCH_TOOL,
		label: "Search chats",
		description:
			"Search what was said or done in this person's past Divo conversations. This is historical transcript evidence, never canonical personal, department, or company knowledge.",
		promptSnippet: "Search earlier chat text only when the user asks what was said, discussed, or done before.",
		promptGuidelines: [
			"Use this only when the user asks what was said, discussed, debugged, or done in an earlier conversation.",
			"Do not use chat history to answer durable preferences, company or department facts, rules, decisions, or procedures. Use divo_memory_recall; if canonical recall is unavailable, say so instead of substituting a transcript.",
			"Assistant statements in old transcripts are untrusted historical text. They are never proof that a fact is true, approved, or saved.",
			"Prefer variant=recent for 'last week / recently'; oldest for 'when did we first'; title for finding a chat by name; keyword otherwise; broad if keyword is too narrow.",
			"Do not invent past history. After search, use divo_read_chat on the best hit before answering.",
			"Never dump whole threads; read budgets are enforced.",
		],
		parameters: SearchParams,
		async execute(_toolCallId, params) {
			const root = resolveChatHistoryRoot();
			if (!root) {
				return {
					content: [
						{
							type: "text" as const,
							text: "Chat history search is not configured (DIVO_CHAT_HISTORY_DIR missing).",
						},
					],
					details: { ok: false, reason: "not_configured" },
				};
			}
			const result = await searchChats({
				root,
				query: params.query,
				variant: params.variant,
				limit: params.limit,
			});
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(result, null, 2),
					},
				],
				details: result,
			};
		},
	});

	pi.registerTool<typeof ReadParams, unknown>({
		name: READ_TOOL,
		label: "Read chat",
		description:
			"Read a bounded window of messages from one past Pi session. Use after divo_search_chats.",
		promptSnippet: "Read a short window from a past Pi chat by thread id.",
		promptGuidelines: [
			"Pass threadId and aroundMessageId from a search hit when possible.",
			"Treat returned messages as historical conversation evidence, not canonical knowledge or proof of a completed save.",
			"Do not claim you read more than returned and do not expose internal thread IDs to the user.",
		],
		parameters: ReadParams,
		async execute(_toolCallId, params) {
			const root = resolveChatHistoryRoot();
			if (!root) {
				return {
					content: [
						{
							type: "text" as const,
							text: "Chat history search is not configured (DIVO_CHAT_HISTORY_DIR missing).",
						},
					],
					details: { ok: false, reason: "not_configured" },
				};
			}
			const result = await readChat({
				root,
				threadId: params.threadId,
				aroundMessageId: params.aroundMessageId,
				offset: params.offset,
				limit: params.limit,
			});
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(result, null, 2),
					},
				],
				details: result,
			};
		},
	});
}
