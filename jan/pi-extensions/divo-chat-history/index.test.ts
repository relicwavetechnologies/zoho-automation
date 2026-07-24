import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
	MAX_READ_LIMIT,
	MAX_SESSION_FILE_BYTES,
	parseSessionMessages,
	readChat,
	sanitizeThreadId,
	searchChats,
} from "./index.ts";

async function fixtureRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "divo-chat-history-"));
	const threadA = join(root, "threads", "thread-a");
	const threadB = join(root, "threads", "thread-b");
	await mkdir(threadA, { recursive: true });
	await mkdir(threadB, { recursive: true });
	await writeFile(join(threadA, "thread.json"), JSON.stringify({ id: "thread-a", title: "Gmail rebuild" }));
	await writeFile(join(threadB, "thread.json"), JSON.stringify({ id: "thread-b", title: "Cats" }));
	await writeFile(
		join(threadA, "pi-session.jsonl"),
		[
			`{"type":"session","id":"s","cwd":"/tmp","version":3,"timestamp":"2026-01-01T00:00:00.000Z"}`,
			`{"type":"message","id":"m1","parentId":null,"timestamp":"2026-07-20T10:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"Rebuild Gmail analysis tabs"}]}}`,
			`{"type":"message","id":"m2","parentId":"m1","timestamp":"2026-07-20T10:01:00.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Using four sheet tabs for inbox stats"}]}}`,
			"",
		].join("\n"),
	);
	await writeFile(
		join(threadB, "pi-session.jsonl"),
		[
			`{"type":"session","id":"s","cwd":"/tmp","version":3,"timestamp":"2026-01-01T00:00:00.000Z"}`,
			`{"type":"message","id":"n1","parentId":null,"timestamp":"2026-07-01T10:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"Write a haiku about cats"}]}}`,
			"",
		].join("\n"),
	);
	// Scratch that must never be searched
	const scratch = join(root, ".divo", "threads", "evil");
	await mkdir(scratch, { recursive: true });
	await writeFile(
		join(scratch, "pi-session.jsonl"),
		`{"type":"message","id":"x","message":{"role":"user","content":[{"type":"text","text":"secret scratch gmail"}]}}\n`,
	);
	return root;
}

describe("divo-chat-history", () => {
	it("parses user/assistant and skips thinking", () => {
		const msgs = parseSessionMessages(
			[
				`{"type":"session","id":"s"}`,
				`{"type":"message","id":"1","timestamp":"2026-07-20T10:00:00.000Z","message":{"role":"assistant","content":[{"type":"thinking","text":"secret"},{"type":"text","text":"hello"}]}}`,
			].join("\n"),
		);
		assert.equal(msgs.length, 1);
		assert.equal(msgs[0]?.text, "hello");
	});

	it("rejects invalid thread ids", () => {
		assert.throws(() => sanitizeThreadId("../etc"));
	});

	it("searches across threads and ignores .divo scratch", async () => {
		const root = await fixtureRoot();
		const result = await searchChats({
			root,
			query: "Gmail tabs",
			variant: "keyword",
			limit: 5,
		});
		assert.ok(result.hits.length > 0);
		assert.equal(result.hits[0]?.threadId, "thread-a");
		assert.ok(result.hits.every((h) => h.threadId !== "evil"));
	});

	it("reads a budgeted window around a message", async () => {
		const root = await fixtureRoot();
		const result = await readChat({
			root,
			threadId: "thread-a",
			aroundMessageId: "m2",
			limit: 10,
		});
		assert.equal(result.threadId, "thread-a");
		assert.ok(result.messages.some((m) => m.id === "m2"));
		assert.ok(result.messages.length <= MAX_READ_LIMIT);
	});

	it("rejects path escape via thread id", async () => {
		const root = await fixtureRoot();
		await assert.rejects(() => readChat({ root, threadId: "../etc" }), /Invalid thread id/);
	});

	it("rejects a session file symlink that escapes its thread directory", async () => {
		const root = await fixtureRoot();
		const external = join(root, "outside-session.jsonl");
		const thread = join(root, "threads", "thread-symlink");
		await mkdir(thread, { recursive: true });
		await writeFile(
			external,
			`{"type":"message","id":"secret","timestamp":"2026-07-20T10:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"outside secret"}]}}\n`,
		);
		await symlink(external, join(thread, "pi-session.jsonl"));

		await assert.rejects(
			() => readChat({ root, threadId: "thread-symlink" }),
			/escapes its thread directory/,
		);
		const result = await searchChats({
			root,
			query: "outside secret",
			variant: "keyword",
		});
		assert.equal(result.hits.length, 0);
	});

	it("does not read a title symlink that escapes its thread directory", async () => {
		const root = await fixtureRoot();
		const external = join(root, "outside-thread.json");
		const thread = join(root, "threads", "thread-title-symlink");
		await mkdir(thread, { recursive: true });
		await writeFile(external, JSON.stringify({ title: "Leaked title" }));
		await writeFile(
			join(thread, "pi-session.jsonl"),
			`{"type":"message","id":"safe","timestamp":"2026-07-20T10:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"safe marker"}]}}\n`,
		);
		await symlink(external, join(thread, "thread.json"));

		const result = await readChat({ root, threadId: "thread-title-symlink" });
		assert.equal(result.title, "thread-title-symlink");
	});

	it("skips oversized sessions during search and rejects direct reads explicitly", async () => {
		const root = await fixtureRoot();
		const sessionPath = join(root, "threads", "thread-a", "pi-session.jsonl");
		await truncate(sessionPath, MAX_SESSION_FILE_BYTES + 1);

		const search = await searchChats({
			root,
			query: "Gmail",
			variant: "keyword",
		});
		assert.equal(search.hits.length, 0);
		assert.equal(search.skippedThreadCount, 1);
		assert.deepEqual(search.skippedThreads, [
			{ threadId: "thread-a", reason: "session_too_large" },
		]);
		await assert.rejects(
			() => readChat({ root, threadId: "thread-a" }),
			/exceeds the .*read limit/,
		);
	});

	it("clamps read limit to hard budget", async () => {
		const root = await fixtureRoot();
		const result = await readChat({
			root,
			threadId: "thread-a",
			offset: 0,
			limit: 999,
		});
		assert.ok(result.messages.length <= MAX_READ_LIMIT);
	});
});
