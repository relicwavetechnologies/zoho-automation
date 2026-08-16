import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import extension, {
	DIVO_ARTIFACT_TOOL_NAME,
	artifactIdFromPath,
	buildArtifactDetails,
	mimeFromPath,
	resolveWorkspaceFilePath,
	safeArtifactId,
	titleFromPath,
} from "./index.ts";

test("registers divo_artifact as a path badge with write/edit guidelines", () => {
	const tools: Array<{
		name?: string;
		promptSnippet?: string;
		promptGuidelines?: string[];
		description?: string;
	}> = [];
	extension({
		registerTool(tool: (typeof tools)[number]) {
			tools.push(tool);
		},
		on() {},
	} as never);

	assert.equal(tools.length, 1);
	assert.equal(tools[0]?.name, DIVO_ARTIFACT_TOOL_NAME);
	assert.match(tools[0]?.description ?? "", /badge/i);
	assert.match(tools[0]?.promptSnippet ?? "", /write\/edit/i);
	assert.ok(tools[0]?.promptGuidelines?.some((line) => /Prefer edit/i.test(line)));
	assert.ok(tools[0]?.promptGuidelines?.some((line) => /Stay in chat/i.test(line)));
	assert.ok(tools[0]?.promptGuidelines?.some((line) => /presentation only/i.test(line)));
	assert.ok(tools[0]?.promptGuidelines?.some((line) => /webSearch/i.test(line) || /web lookup/i.test(line)));
});

/** Register the tool and hand back its execute, with no Pi around it. */
function toolExecute(): (
	toolCallId: string,
	params: unknown,
) => Promise<{ content: Array<{ text: string }>; details: never; isError?: boolean }> {
	let registered: { execute?: never } | undefined;
	extension({
		registerTool(tool: typeof registered) {
			registered = tool;
		},
		on() {},
	} as never);
	return registered?.execute as never;
}

/** A workspace with one markdown file in it, and the run context beside it. */
async function workspaceWithBrief(body = "# Findings\n\n- One\n"): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "divo-artifact-"));
	await mkdir(join(dir, "artifacts"), { recursive: true });
	await writeFile(join(dir, "artifacts", "research-brief.md"), body, "utf8");
	await writeFile(
		join(dir, "run-context.json"),
		JSON.stringify({ version: 1, threadId: "web_thread-1", runId: "run-1", channel: "web" }),
		"utf8",
	);
	return dir;
}

test("stores the document's body and reports the version the reader will get", async () => {
	const dir = await workspaceWithBrief();
	const previousCwd = process.cwd();
	const realFetch = globalThis.fetch;
	const calls: Array<{ url: string; body: Record<string, unknown>; auth: string }> = [];

	try {
		process.chdir(dir);
		process.env.DIVO_BACKEND_URL = "https://divo.test/";
		process.env.DIVO_MEMBER_TOKEN = "member-token";
		process.env.DIVO_RUN_CONTEXT_PATH = join(dir, "run-context.json");
		globalThis.fetch = (async (url: string, init: RequestInit) => {
			calls.push({
				url: String(url),
				body: JSON.parse(String(init.body)),
				auth: String((init.headers as Record<string, string>).Authorization),
			});
			return {
				ok: true,
				status: 200,
				json: async () => ({ ok: true, artifact: { version: 4 } }),
			};
		}) as never;

		const result = await toolExecute()("artifact-call", {
			path: "artifacts/research-brief.md",
			title: "Research Brief",
			summaryForChat: "Full brief is beside the chat.",
			artifactId: "art-fixed-id",
		});

		assert.equal(result?.isError, undefined);

		// The body has to leave the container. A path alone names a file that
		// stops existing the moment the run ends.
		assert.equal(calls.length, 1);
		assert.equal(calls[0]?.url, "https://divo.test/api/artifacts");
		assert.equal(calls[0]?.auth, "Bearer member-token");
		assert.equal(calls[0]?.body.body, "# Findings\n\n- One\n");
		assert.equal(calls[0]?.body.artifactId, "art-fixed-id");
		// Filed under the conversation it came out of, read from the run context
		// rather than guessed.
		assert.equal(calls[0]?.body.threadId, "web_thread-1");
		assert.equal(calls[0]?.body.executionRunId, "run-1");

		const details = result?.details as unknown as {
			version: number;
			artifactId: string;
			storedVersion?: number;
			content?: string;
		};
		assert.equal(details.version, 2);
		assert.equal(details.artifactId, "art-fixed-id");
		// The store counts revisions, not the runtime — so the number comes back
		// from the store rather than being invented here.
		assert.equal(details.storedVersion, 4);
		assert.equal("content" in details, false);
	} finally {
		globalThis.fetch = realFetch;
		delete process.env.DIVO_BACKEND_URL;
		delete process.env.DIVO_MEMBER_TOKEN;
		delete process.env.DIVO_RUN_CONTEXT_PATH;
		process.chdir(previousCwd);
		await rm(dir, { recursive: true, force: true });
	}
});

test("fails the call when the document could not be filed anywhere", async () => {
	const dir = await workspaceWithBrief();
	const previousCwd = process.cwd();
	const realFetch = globalThis.fetch;

	try {
		process.chdir(dir);

		// No store configured at all: announcing a document a reader can never
		// open is the one outcome worse than telling the model it failed.
		const unconfigured = await toolExecute()("artifact-call", {
			path: "artifacts/research-brief.md",
		});
		assert.equal(unconfigured?.isError, true);

		process.env.DIVO_BACKEND_URL = "https://divo.test";
		process.env.DIVO_MEMBER_TOKEN = "member-token";
		globalThis.fetch = (async () => ({ ok: false, status: 503, json: async () => ({}) })) as never;

		const refused = await toolExecute()("artifact-call", {
			path: "artifacts/research-brief.md",
		});
		assert.equal(refused?.isError, true);
		assert.match(refused?.content[0]?.text ?? "", /503/);
	} finally {
		globalThis.fetch = realFetch;
		delete process.env.DIVO_BACKEND_URL;
		delete process.env.DIVO_MEMBER_TOKEN;
		process.chdir(previousCwd);
		await rm(dir, { recursive: true, force: true });
	}
});

test("normalizes an id the store and a URL would both refuse", () => {
	// Mechanical, not interpretive: strip what cannot travel and keep the rest,
	// because rejecting the call over punctuation loses the document.
	assert.equal(safeArtifactId("reports/q3 review.md", "/ws/a.md"), "reports-q3-review.md");
	assert.equal(safeArtifactId("../../etc/passwd", "/ws/a.md"), "etc-passwd");
	assert.equal(safeArtifactId("  ", "/ws/a.md"), artifactIdFromPath("/ws/a.md"));
	assert.equal(safeArtifactId("---", "/ws/a.md"), artifactIdFromPath("/ws/a.md"));
	assert.equal(safeArtifactId(undefined, "/ws/a.md"), artifactIdFromPath("/ws/a.md"));
	assert.ok(safeArtifactId("x".repeat(400), "/ws/a.md").length <= 120);
});

test("rejects missing files and paths outside the workspace", async () => {
	const dir = await mkdtemp(join(tmpdir(), "divo-artifact-jail-"));
	const previousCwd = process.cwd();

	let registered:
		| {
				execute?: (
					toolCallId: string,
					params: unknown,
				) => Promise<{ isError?: boolean; details: { error?: string } }>;
		  }
		| undefined;
	extension({
		registerTool(tool: typeof registered) {
			registered = tool;
		},
		on() {},
	} as never);

	try {
		process.chdir(dir);

		const missing = await registered?.execute?.("artifact-call", {
			path: "artifacts/missing.md",
		});
		assert.equal(missing?.isError, true);
		assert.match(missing?.details.error ?? "", /not found/i);

		const outside = await resolveWorkspaceFilePath("../outside.md", dir);
		assert.equal(outside.ok, false);
		if (!outside.ok) assert.match(outside.error, /inside the workspace/i);
	} finally {
		process.chdir(previousCwd);
		await rm(dir, { recursive: true, force: true });
	}
});

test("helpers derive mime, title, and stable id from path", () => {
	assert.equal(mimeFromPath("a/b/brief.md"), "text/markdown");
	assert.equal(mimeFromPath("a/b/note.txt"), undefined);
	assert.equal(titleFromPath("artifacts/lark-approvals-brief.md"), "Lark Approvals Brief");
	assert.equal(
		artifactIdFromPath("/ws/artifacts/a.md"),
		artifactIdFromPath("/ws/artifacts/a.md"),
	);
	const details = buildArtifactDetails({
		artifactId: "a1",
		title: "T",
		mime: "text/markdown",
		path: "/tmp/a.md",
	});
	assert.equal("summaryForChat" in details, false);
	assert.equal(details.version, 2);
});
