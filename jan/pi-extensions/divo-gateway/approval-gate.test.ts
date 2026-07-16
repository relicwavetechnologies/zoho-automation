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

function divoEvent(): ToolCallEvent {
	return {
		type: "tool_call",
		toolName: "divo_gateway",
		toolCallId: "call-1",
		input: {
			op: "tools.invoke",
			departmentId: "dept-1",
			payload: {
				toolId: "googleGmail",
				args: { op: "send", to: ["maya@example.com"] },
			},
		},
	} as ToolCallEvent;
}

describe("Divo approval gate", () => {
	it("allows a valid tools.invoke to reach the single-call execution path", async () => {
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
		assert.equal(confirmations, 0);
		assert.equal((event.input as Record<string, unknown>).op, "tools.invoke");
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

	it("rejects denied or malformed prepared intents and blocks direct commits", async () => {
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
		const directCommit = divoEvent();
		(directCommit.input as Record<string, unknown>).op = "tools.commit";
		assert.match(
			(
				await handleApprovalToolCall(
					directCommit,
					context(async () => true),
				)
			)?.reason ?? "",
			/direct tools\.commit/i,
		);
	});

	it("returns the exact missing tools.invoke path before calling the backend", async () => {
		const event = divoEvent();
		(event.input as Record<string, unknown>).payload = { toolId: "googleGmail" };

		const result = await handleApprovalToolCall(
			event,
			context(async () => true),
		);

		assert.equal(result?.block, true);
		assert.match(result?.reason ?? "", /payload\.args is required/);
		assert.match(result?.reason ?? "", /"op": "tools\.invoke"/);
	});

	it("blocks direct memory publishing so the custom review is the only path", async () => {
		const event = divoEvent();
		(event.input as Record<string, unknown>).payload = {
			toolId: "memoryPublishing",
			args: {
				operation: "publish",
				scope: "personal",
				facts: ["A fact"],
			},
		};
		const result = await handleApprovalToolCall(
			event,
			context(async () => true),
		);

		assert.equal(result?.block, true);
		assert.match(result?.reason ?? "", /divo_memory_review/);
	});

	it("blocks generic memory recall before an alternate department can reach the gateway", async () => {
		const event = divoEvent();
		(event.input as Record<string, unknown>).departmentId = "dept-alternate";
		(event.input as Record<string, unknown>).payload = {
			toolId: "memoryRecall",
			args: { query: "quarterly planning conventions" },
		};
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
