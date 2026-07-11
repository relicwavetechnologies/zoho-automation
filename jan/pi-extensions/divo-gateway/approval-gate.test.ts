import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import {
	DIVO_APPROVAL_PROTOCOL_TITLE,
	handleApprovalToolCall,
	type ApprovalGateDependencies,
} from "./approval-gate.ts";

function context(confirm: (title: string, message: string) => Promise<boolean>) {
	return {
		cwd: "/workspace",
		signal: undefined,
		ui: { confirm },
	};
}

function dependencies(
	data: unknown,
	onRequest?: (request: unknown) => void,
): ApprovalGateDependencies {
	return {
		resolveConfig: () => ({
			backendUrl: "http://localhost:4000",
			memberToken: "member-token",
		}),
		callGateway: async (_config, request) => {
			onRequest?.(request);
			return {
				httpStatus: 200,
				body: { ok: true, status: "success", data },
			};
		},
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
	it("allows a backend-classified read without showing approval", async () => {
		let confirmations = 0;
		let prepared: unknown;
		const event = divoEvent();
		const result = await handleApprovalToolCall(
			event,
			context(async () => {
				confirmations += 1;
				return true;
			}),
			dependencies({ requiresApproval: false }, (request) => {
				prepared = request;
			}),
		);

		assert.equal(result, undefined);
		assert.equal(confirmations, 0);
		assert.deepEqual(prepared, {
			op: "tools.prepare",
			departmentId: "dept-1",
			payload: {
				toolId: "googleGmail",
				args: { op: "send", to: ["maya@example.com"] },
			},
		});
		assert.equal((event.input as Record<string, unknown>).op, "tools.invoke");
	});

	it("emits the versioned presentation and commits only the approved intent", async () => {
		let title = "";
		let message = "";
		const event = divoEvent();
		const result = await handleApprovalToolCall(
			event,
			context(async (nextTitle, nextMessage) => {
				title = nextTitle;
				message = nextMessage;
				return true;
			}),
			dependencies({
				requiresApproval: true,
				intentId: "intent-1",
				kind: "gmail.send",
				action: "send",
				title: "Send email",
				expiresAt: "2026-07-10T12:00:00Z",
				presentation: { to: ["maya@example.com"], subject: "Hello" },
			}),
		);

		assert.equal(result, undefined);
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
			expiresAt: "2026-07-10T12:00:00Z",
		});
		assert.deepEqual(event.input, {
			op: "tools.commit",
			departmentId: "dept-1",
			payload: { intentId: "intent-1" },
		});
	});

	it("blocks denial, malformed prepare responses, and direct commit calls", async () => {
		const denied = divoEvent();
		assert.deepEqual(
			await handleApprovalToolCall(
				denied,
				context(async () => false),
				dependencies({
					requiresApproval: true,
					intentId: "intent-1",
					presentation: {},
				}),
			),
			{ block: true, reason: "The user did not approve this action." },
		);
		assert.equal((denied.input as Record<string, unknown>).op, "tools.invoke");

		const malformed = divoEvent();
		assert.equal(
			(
				await handleApprovalToolCall(
					malformed,
					context(async () => true),
					dependencies({}),
				)
			)?.block,
			true,
		);

		const directCommit = divoEvent();
		(directCommit.input as Record<string, unknown>).op = "tools.commit";
		assert.match(
			(
				await handleApprovalToolCall(
					directCommit,
					context(async () => true),
					dependencies({}),
				)
			)?.reason ?? "",
			/direct tools\.commit/i,
		);
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
		let backendCalls = 0;
		const result = await handleApprovalToolCall(
			event,
			context(async () => true),
			dependencies({}, () => {
				backendCalls += 1;
			}),
		);

		assert.equal(result?.block, true);
		assert.match(result?.reason ?? "", /divo_memory_review/);
		assert.equal(backendCalls, 0);
	});

	it("blocks generic memory recall before an alternate department can reach the gateway", async () => {
		const event = divoEvent();
		(event.input as Record<string, unknown>).departmentId = "dept-alternate";
		(event.input as Record<string, unknown>).payload = {
			toolId: "memoryRecall",
			args: { query: "quarterly planning conventions" },
		};
		let backendCalls = 0;
		const result = await handleApprovalToolCall(
			event,
			context(async () => true),
			dependencies({}, () => {
				backendCalls += 1;
			}),
		);

		assert.equal(result?.block, true);
		assert.match(result?.reason ?? "", /divo_memory_recall/);
		assert.match(result?.reason ?? "", /optional exact department-name ranking preferences/);
		assert.match(result?.reason ?? "", /all active memberships/);
		assert.match(result?.reason ?? "", /do not select or grant scope/);
		assert.equal(backendCalls, 0);
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
		});
	}
});
