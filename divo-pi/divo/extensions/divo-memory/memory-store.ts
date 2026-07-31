import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type MemoryTarget = "user" | "memory";
export type MemoryAction = "read" | "add" | "replace" | "remove" | "batch";

export interface MemoryOperation {
	action: "add" | "replace" | "remove";
	content?: string;
	oldText?: string;
}

export interface MemoryRequest {
	action?: MemoryAction;
	target?: MemoryTarget;
	content?: string;
	oldText?: string;
	operations?: MemoryOperation[];
}

export interface MemoryResult {
	success: boolean;
	done: boolean;
	target: MemoryTarget;
	message?: string;
	error?: string;
	usage: string;
	entryCount: number;
	entries?: string[];
	systemPromptBlock?: string;
}

const ENTRY_DELIMITER = "\n§\n";
const TARGET_FILE_NAMES: Record<MemoryTarget, string> = {
	user: "USER.md",
	memory: "MEMORY.md",
};
const TARGET_LABELS: Record<MemoryTarget, string> = {
	user: "USER MEMORY",
	memory: "AGENT MEMORY",
};
const TARGET_LIMITS: Record<MemoryTarget, number> = {
	user: 2200,
	memory: 2200,
};

const THREAT_PATTERNS: Array<{ id: string; pattern: RegExp }> = [
	{ id: "prompt_injection", pattern: /\b(ignore|forget|override)\b.{0,80}\b(system|developer|previous|above)\b/i },
	{ id: "system_prompt_exfiltration", pattern: /\b(system prompt|developer message|hidden instructions)\b/i },
	{ id: "credential_exfiltration", pattern: /\b(send|upload|exfiltrate|leak)\b.{0,80}\b(api key|token|password|secret|credential)s?\b/i },
	{ id: "invisible_unicode", pattern: /[\u200B-\u200F\u202A-\u202E\u2060-\u206F]/ },
];
const mutationQueues = new Map<string, Promise<void>>();

function memoryDir(): string {
	return process.env.DIVO_MEMORY_DIR?.trim() || join(resolveAgentDir(), "memories");
}

function resolveAgentDir(): string {
	if (process.env.PI_CODING_AGENT_DIR?.trim()) return process.env.PI_CODING_AGENT_DIR.trim();
	if (process.env.PI_AGENT_DIR?.trim()) return process.env.PI_AGENT_DIR.trim();
	return join(process.env.HOME || process.cwd(), ".pi", "agent");
}

export function memoryPath(target: MemoryTarget): string {
	return join(memoryDir(), TARGET_FILE_NAMES[target]);
}

function normalizeTarget(target: unknown): MemoryTarget {
	return target === "memory" ? "memory" : "user";
}

function normalizeEntry(content: unknown): string {
	return String(content ?? "").trim();
}

function splitEntries(raw: string): string[] {
	return raw
		.split(ENTRY_DELIMITER)
		.map((entry) => entry.trim())
		.filter(Boolean);
}

function renderEntries(entries: string[]): string {
	return entries.join(ENTRY_DELIMITER);
}

async function readEntries(target: MemoryTarget): Promise<string[]> {
	const path = memoryPath(target);
	if (!existsSync(path)) return [];
	const raw = await readFile(path, "utf8");
	if (!raw.trim()) return [];
	return Array.from(new Set(splitEntries(raw)));
}

async function atomicWrite(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
	await writeFile(tmpPath, content ? `${content}\n` : "", "utf8");
	await rename(tmpPath, path);
}

async function writeEntries(target: MemoryTarget, entries: string[]): Promise<void> {
	const path = memoryPath(target);
	const previous = mutationQueues.get(path) ?? Promise.resolve();
	const next = previous.then(async () => {
		await atomicWrite(path, renderEntries(entries));
	});
	mutationQueues.set(path, next.catch(() => undefined));
	await next;
}

function charCount(entries: string[]): number {
	return renderEntries(entries).length;
}

function usage(target: MemoryTarget, entries: string[]): string {
	const count = charCount(entries);
	const limit = TARGET_LIMITS[target];
	const pct = limit > 0 ? Math.min(100, Math.round((count / limit) * 100)) : 0;
	return `${pct}% - ${count}/${limit} chars`;
}

function scanContent(content: string): string | undefined {
	for (const item of THREAT_PATTERNS) {
		if (item.pattern.test(content)) {
			return `Memory entry rejected: matched ${item.id}. Store durable facts only, not instructions, secrets, or prompt-control text.`;
		}
	}
	return undefined;
}

function result(
	target: MemoryTarget,
	entries: string[],
	success: boolean,
	patch: Partial<MemoryResult> = {},
): MemoryResult {
	return {
		success,
		done: true,
		target,
		usage: usage(target, entries),
		entryCount: entries.length,
		...patch,
	};
}

function validateBudget(target: MemoryTarget, entries: string[]): string | undefined {
	const count = charCount(entries);
	const limit = TARGET_LIMITS[target];
	if (count <= limit) return undefined;
	return `Memory would exceed ${limit} chars (${count}/${limit}). Remove or replace stale entries in the same batch, then retry.`;
}

function findEntry(entries: string[], oldText: string): { index?: number; error?: string } {
	const needle = oldText.trim();
	if (!needle) return { error: "oldText is required." };

	const matches = entries
		.map((entry, index) => ({ entry, index }))
		.filter(({ entry }) => entry.includes(needle));

	if (matches.length === 0) return { error: `No memory entry matched oldText: ${needle}` };
	if (new Set(matches.map(({ entry }) => entry)).size > 1) {
		return { error: `oldText matched multiple memory entries: ${needle}` };
	}
	return { index: matches[0]?.index };
}

function applyOperation(entries: string[], operation: MemoryOperation): { entries: string[]; error?: string } {
	const action = operation.action;
	const next = [...entries];

	if (action === "add") {
		const content = normalizeEntry(operation.content);
		if (!content) return { entries, error: "content is required for add." };
		const scanError = scanContent(content);
		if (scanError) return { entries, error: scanError };
		if (!next.includes(content)) next.push(content);
		return { entries: next };
	}

	if (action === "replace") {
		const content = normalizeEntry(operation.content);
		if (!content) return { entries, error: "content is required for replace." };
		const scanError = scanContent(content);
		if (scanError) return { entries, error: scanError };
		const match = findEntry(next, normalizeEntry(operation.oldText));
		if (match.error || match.index === undefined) return { entries, error: match.error };
		next[match.index] = content;
		return { entries: next };
	}

	if (action === "remove") {
		const match = findEntry(next, normalizeEntry(operation.oldText));
		if (match.error || match.index === undefined) return { entries, error: match.error };
		next.splice(match.index, 1);
		return { entries: next };
	}

	return { entries, error: `Unsupported memory operation: ${String(action)}` };
}

export async function handleMemoryRequest(request: MemoryRequest): Promise<MemoryResult> {
	const target = normalizeTarget(request.target);
	const action = request.action ?? "read";
	const current = await readEntries(target);

	if (action === "read") {
		return result(target, current, true, {
			message: "Current memory loaded.",
			entries: current,
			systemPromptBlock: renderMemoryPromptBlock(target, current),
		});
	}

	const operations: MemoryOperation[] =
		action === "batch"
			? request.operations ?? []
			: [
					{
						action: action as MemoryOperation["action"],
						content: request.content,
						oldText: request.oldText,
					},
				];

	if (operations.length === 0) {
		return result(target, current, false, {
			error: "No memory operations provided.",
			entries: current,
		});
	}

	let next = current;
	for (const operation of operations) {
		const applied = applyOperation(next, operation);
		if (applied.error) {
			return result(target, current, false, {
				error: applied.error,
				entries: current,
			});
		}
		next = applied.entries;
	}

	const budgetError = validateBudget(target, next);
	if (budgetError) {
		return result(target, current, false, {
			error: budgetError,
			entries: current,
		});
	}

	await writeEntries(target, next);
	return result(target, next, true, {
		message: `Applied ${operations.length} memory operation(s). This update is complete; do not repeat it.`,
	});
}

export function renderMemoryPromptBlock(target: MemoryTarget, entries: string[]): string {
	if (entries.length === 0) return "";
	const label = TARGET_LABELS[target];
	const rendered = renderEntries(entries);
	const limit = TARGET_LIMITS[target];
	const pct = Math.min(100, Math.round((rendered.length / limit) * 100));
	return [
		"=".repeat(46),
		`${label} [${pct}% - ${rendered.length}/${limit} chars]`,
		"=".repeat(46),
		rendered,
	].join("\n");
}

export async function renderAllMemoryPromptBlocks(): Promise<string> {
	const userEntries = await readEntries("user");
	const memoryEntries = await readEntries("memory");
	return [renderMemoryPromptBlock("user", userEntries), renderMemoryPromptBlock("memory", memoryEntries)]
		.filter(Boolean)
		.join("\n\n");
}
