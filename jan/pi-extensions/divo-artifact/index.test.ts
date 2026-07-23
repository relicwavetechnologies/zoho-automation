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

test("badges an existing workspace file and returns v2 details without content", async () => {
	const dir = await mkdtemp(join(tmpdir(), "divo-artifact-"));
	const filePath = join(dir, "artifacts", "research-brief.md");
	await mkdir(join(dir, "artifacts"), { recursive: true });
	await writeFile(filePath, "# Findings\n\n- One\n", "utf8");

	const previousCwd = process.cwd();
	try {
		process.chdir(dir);

		let registered:
			| {
					execute?: (
						toolCallId: string,
						params: unknown,
					) => Promise<{ content: Array<{ text: string }>; details: unknown; isError?: boolean }>;
			  }
			| undefined;
		extension({
			registerTool(tool: typeof registered) {
				registered = tool;
			},
			on() {},
		} as never);

		const result = await registered?.execute?.("artifact-call", {
			path: "artifacts/research-brief.md",
			title: "Research Brief",
			summaryForChat: "Full brief is in the sidebar.",
			artifactId: "art-fixed-id",
		});

		assert.equal(result?.isError, undefined);
		const details = result?.details as {
			version: number;
			artifactId: string;
			title: string;
			mime: string;
			path: string;
			content?: string;
			summaryForChat?: string;
		};
		assert.equal(details.version, 2);
		assert.equal(details.artifactId, "art-fixed-id");
		assert.equal(details.title, "Research Brief");
		assert.equal(details.mime, "text/markdown");
		assert.equal(details.summaryForChat, "Full brief is in the sidebar.");
		assert.equal("content" in details, false);
		assert.ok(details.path.endsWith(`${join("artifacts", "research-brief.md")}`) || details.path.includes("research-brief.md"));
		assert.match(result?.content[0]?.text ?? "", /sidebar/i);
	} finally {
		process.chdir(previousCwd);
		await rm(dir, { recursive: true, force: true });
	}
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
