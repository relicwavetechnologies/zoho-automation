import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import {
	approvePreparedDivoIntent,
	DIVO_APPROVAL_PROTOCOL_TITLE,
	handleApprovalToolCall,
} from "./approval-gate.ts";

const runContextPath = join(mkdtempSync(join(tmpdir(), "divo-approval-run-")), "context.json");
writeFileSync(runContextPath, JSON.stringify({ version: 1, threadId: "thread-1", runId: "run-1" }));
process.env.DIVO_RUN_CONTEXT_PATH = runContextPath;

function context(confirm: (title: string, message: string) => Promise<boolean>) {
	return {
		cwd: "/workspace",
		signal: undefined,
		ui: { confirm },
	};
}

function divoEvent(toolName = "divo_google_gmail", input: Record<string, unknown> = { op: "send", to: ["maya@example.com"] }): ToolCallEvent {
	return {
		type: "tool_call",
		toolName,
		toolCallId: "call-1",
		input,
	} as ToolCallEvent;
}

describe("Divo approval gate", () => {
	it("lets an ordinary governed tool call reach the execution path unprompted", async () => {
		let confirmations = 0;
		const event = divoEvent();
		const result = await handleApprovalToolCall(
			event,
			context(async () => {
				confirmations += 1;
				return true;
			}),
		);

		assert.equal(result, undefined);
		assert.equal(confirmations, 0, "the backend owns approval; the gate must not add a local prompt");
	});

	it("emits the versioned presentation and returns only the approved intent", async () => {
		let title = "";
		let message = "";
		const intentId = await approvePreparedDivoIntent(
			"call-1",
			{
				intentId: "intent-1",
				kind: "gmail.send",
				action: "send",
				title: "Send email",
				expiresAt: "2026-07-10T12:00:00Z",
				presentation: { to: ["maya@example.com"], subject: "Hello" },
			},
			context(async (nextTitle, nextMessage) => {
				title = nextTitle;
				message = nextMessage;
				return true;
			}),
		);

		assert.equal(intentId, "intent-1");
		assert.equal(title, DIVO_APPROVAL_PROTOCOL_TITLE);
		assert.deepEqual(JSON.parse(message), {
			version: 1,
			toolCallId: "call-1",
			source: "divo",
			kind: "gmail.send",
			action: "send",
			title: "Send email",
			intentId: "intent-1",
			presentation: { to: ["maya@example.com"], subject: "Hello" },
			runCorrelation: { version: 1, threadId: "thread-1", runId: "run-1" },
			expiresAt: "2026-07-10T12:00:00Z",
		});
	});

	it("rejects denied or malformed prepared intents", async () => {
		await assert.rejects(
			approvePreparedDivoIntent(
				"call-1",
				{ intentId: "intent-1", presentation: {} },
				context(async () => false),
			),
			/The user did not approve/,
		);
		await assert.rejects(
			approvePreparedDivoIntent("call-1", {}, context(async () => true)),
			/complete approval intent/,
		);
	});

	it("blocks raw personal publishing so only the dedicated memory command can write", async () => {
		const event = divoEvent("divo_knowledge", {
			operation: "propose",
			scope: "personal",
			kind: "memory",
			facts: ["A fact"],
		});
		const result = await handleApprovalToolCall(
			event,
			context(async () => true),
		);

		assert.equal(result?.block, true);
		assert.match(result?.reason ?? "", /raw personal-memory proposals are disabled/i);
		assert.match(result?.reason ?? "", /use divo_memory/i);
	});

	it("blocks generic memory recall before an alternate department can reach the gateway", async () => {
		const event = divoEvent("divo_knowledge", {
			operation: "recall",
			query: "quarterly planning conventions",
		});
		const result = await handleApprovalToolCall(
			event,
			context(async () => true),
		);

		assert.equal(result?.block, true);
		assert.match(result?.reason ?? "", /divo_memory_recall/);
		assert.match(result?.reason ?? "", /optional exact department-name ranking preferences/);
		assert.match(result?.reason ?? "", /all active memberships/);
		assert.match(result?.reason ?? "", /do not select or grant scope/);
	});
});

describe("local mutation approval gate", () => {
	for (const [toolName, input, expected] of [
		["bash", { command: "rm report.csv", timeout: 30 }, "bash.execute"],
		[
			"edit",
			{ path: "report.md", edits: [{ oldText: "old", newText: "new" }] },
			"file.edit",
		],
		["write", { path: "report.md", content: "new" }, "file.write"],
	] as const) {
		it(`always asks before ${toolName}`, async () => {
			let payload: Record<string, unknown> | undefined;
			const result = await handleApprovalToolCall(
				{
					type: "tool_call",
					toolName,
					toolCallId: `call-${toolName}`,
					input,
				} as ToolCallEvent,
				context(async (title, message) => {
					assert.equal(title, DIVO_APPROVAL_PROTOCOL_TITLE);
					payload = JSON.parse(message);
					return false;
				}),
			);

			assert.equal(result?.block, true);
			assert.equal(payload?.version, 1);
			assert.equal(payload?.source, toolName);
			assert.equal(payload?.kind, expected);
			assert.deepEqual(payload?.runCorrelation, { version: 1, threadId: "thread-1", runId: "run-1" });
		});
	}
});

describe("obvious local Lark fallback tripwire", () => {
	it("blocks lark-cli before Bash approval or execution", async () => {
		for (const command of [
			"lark-cli contact +search --name Anish",
			"/usr/local/bin/lark-cli contact +search --name Anish",
		]) {
			let confirmations = 0;
			const result = await handleApprovalToolCall(
				{
					type: "tool_call",
					toolName: "bash",
					toolCallId: "call-lark-cli",
					input: { command },
				} as ToolCallEvent,
				context(async () => {
					confirmations += 1;
					return true;
				}),
			);

			assert.equal(result?.block, true, command);
			assert.match(result?.reason ?? "", /lark-cli is disabled/i);
			assert.equal(confirmations, 0);
		}
	});

	it("blocks explicit local lark-* skill paths across file tools and Bash", async () => {
		const attempts = [
			{ toolName: "read", input: { path: "/Users/me/.agents/skills/lark-contact/SKILL.md" } },
			{ toolName: "grep", input: { path: "~/.codex/skills/lark-doc", pattern: "OpenAPI" } },
			{ toolName: "bash", input: { command: "cat ~/.agents/skills/lark-contact/SKILL.md" } },
			{ toolName: "read", input: { path: "C:\\Users\\me\\.agents\\skills\\lark-contact\\SKILL.md" } },
		] as const;

		for (const attempt of attempts) {
			let confirmations = 0;
			const result = await handleApprovalToolCall(
				{
					type: "tool_call",
					toolName: attempt.toolName,
					toolCallId: "call-local-lark-skill",
					input: attempt.input,
				} as ToolCallEvent,
				context(async () => {
					confirmations += 1;
					return true;
				}),
			);

			assert.equal(result?.block, true, JSON.stringify(attempt));
			assert.match(result?.reason ?? "", /Local lark-\* skill paths are disabled/);
			assert.equal(confirmations, 0);
		}
	});

	it("does not block similarly named non-executable text or unrelated paths", async () => {
		let confirmations = 0;
		const result = await handleApprovalToolCall(
			{
				type: "tool_call",
				toolName: "bash",
				toolCallId: "call-unrelated",
				input: { command: "echo lark-cli-notes && cat ./skills/larkish/README.md" },
			} as ToolCallEvent,
			context(async () => {
				confirmations += 1;
				return false;
			}),
		);

		assert.equal(result?.block, true);
		assert.match(result?.reason ?? "", /did not approve/);
		assert.equal(confirmations, 1);
	});

	it("documents that shell and interpreter indirection bypass text matching and still require normal Bash approval", async () => {
		const indirectCommands = [
			'bin=lark; "${bin}-cli" contact +search --name Anish',
			"`printf 'lark%s' '-cli'` contact +search --name Anish",
			"python -c \"import os; os.execvp(''.join(['lark','-cli']), [])\"",
			'base="$HOME/.agents"; leaf="lark-contact"; cat "$base/skills/$leaf/SKILL.md"',
		];

		for (const command of indirectCommands) {
			let confirmations = 0;
			const result = await handleApprovalToolCall(
				{
					type: "tool_call",
					toolName: "bash",
					toolCallId: "call-indirect-lark",
					input: { command },
				} as ToolCallEvent,
				context(async () => {
					confirmations += 1;
					return false;
				}),
			);

			assert.equal(confirmations, 1, command);
			assert.equal(result?.block, true);
			assert.match(result?.reason ?? "", /did not approve/);
			assert.doesNotMatch(result?.reason ?? "", /lark-cli is disabled|lark-\* skill paths are disabled/i);
		}
	});
});
