import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	executeKnowledgeReview,
	registerKnowledgeReviewTool,
	type KnowledgeReviewDependencies,
} from "./knowledge-review.ts";

const contextPath = join(mkdtempSync(join(tmpdir(), "divo-knowledge-review-")), "context.json");
process.env.DIVO_RUN_CONTEXT_PATH = contextPath;

const request = {
	kind: "skill",
	action: "publish",
	scope: "department",
	logicalKey: "weekly-risk-report",
	content: {
		name: "Weekly Risk Report",
		slug: "weekly-risk-report",
		summary: "Prepare the weekly report with risks first.",
		markdown: "# Weekly Risk Report\n\nRollback before Owners.",
		toolIds: [],
		tags: ["reporting"],
	},
} as const;

function desktopContext(): void {
	writeFileSync(contextPath, JSON.stringify({ version: 1, threadId: "thread-1", runId: "run-1", channel: "desktop" }));
}

function dependencies(calls: unknown[], options: { targets?: unknown[]; applyStatus?: "success" | "approval_required" } = {}): KnowledgeReviewDependencies {
	return {
		resolveConfig: () => ({ backendUrl: "http://localhost:4000", memberToken: "token" }),
		resolveSkillId: () => "share-memory-skill",
		callGateway: async (_config, call) => {
			calls.push(call);
			if (call.op === "knowledge.review.open") {
				return { httpStatus: 200, body: { ok: true, status: "success", data: { status: "review_pending" } } };
			}
			if (call.op === "knowledge.review.decide") {
				return { httpStatus: 200, body: { ok: true, status: "success", data: { status: "awaiting_approval" } } };
			}
			if (call.op === "tools.prepare") {
				const args = (call.payload as { args: Record<string, any> }).args;
				const exactContent = args.kind === "file"
					? Object.fromEntries(Object.entries(args.content).filter(([key]) => key !== "assetId"))
					: args.content;
				return { httpStatus: 200, body: { ok: true, status: "success", data: {
					intentId: "intent-1",
					kind: `knowledge.${args.kind}.${args.action}`,
					action: "create",
					title: "Review knowledge change",
					presentation: {
						target: args.scope === "personal" ? "Personal" : args.scope === "company" ? "Company" : "Tech Testing",
						content: exactContent,
					},
				} } };
			}
			if (call.op === "tools.commit") {
				return {
					httpStatus: 200,
					body: {
						ok: true,
						status: "success",
						data: { result: {
							operation: "propose",
							mutationId: "00000000-0000-4000-8000-000000000001",
							contentHash: "b".repeat(64),
							status: "awaiting_requester_review",
						} },
					},
				};
			}
			if (call.op !== "tools.invoke") throw new Error(`unexpected op ${call.op}`);
			const args = (call.payload as { args: { operation: string } }).args;
			if (args.operation === "check_targets") {
				return {
					httpStatus: 200,
					body: {
						ok: true,
						status: "success",
						data: { result: { operation: "check_targets", targets: options.targets ?? [
							{ scope: "personal", label: "Personal" },
							{ scope: "department", departmentId: "dept-1", label: "Tech Testing" },
							{ scope: "company", label: "Company" },
						] } },
					},
				};
			}
			return options.applyStatus === "success"
				? {
					httpStatus: 200,
					body: { ok: true, status: "success", data: { result: { operation: "apply", status: "applied" } } },
				}
				: {
					httpStatus: 202,
					body: { ok: false, status: "approval_required", data: { approvalId: "approval-1", approverName: "Abhishek" } },
				};
		},
	};
}

describe("shared knowledge review", () => {
	it("exposes a provider-compatible top-level object schema", () => {
		const registered: Array<Record<string, unknown>> = [];
		registerKnowledgeReviewTool({
			registerTool: (tool: Record<string, unknown>) => registered.push(tool),
		} as never);
		const parameters = registered[0]?.parameters as Record<string, unknown>;
		assert.equal(parameters.type, "object");
		assert.equal(parameters.anyOf, undefined);
		assert.equal(parameters.additionalProperties, false);
	});

	it("reviews and applies a personal skill without a shared approver", async () => {
		desktopContext();
		const calls: unknown[] = [];
		let presentation: Record<string, unknown> | undefined;
		const result = await executeKnowledgeReview(
			"tool-call-personal",
			{ ...request, scope: "personal" },
			{ ui: { confirm: async (_title: string, message: string) => {
				presentation = JSON.parse(message) as Record<string, unknown>;
				return true;
			} } as never },
			dependencies(calls, { applyStatus: "success" }),
		);

		assert.equal((presentation?.presentation as Record<string, unknown>).target, "Personal");
		const invocations = calls as Array<Record<string, any>>;
		const proposal = invocations.find(call => call.payload?.args?.operation === "propose");
		const apply = invocations.find(call => call.payload?.args?.operation === "apply");
		assert.equal(proposal?.departmentId, undefined);
		assert.equal(proposal?.payload.args.scope, "personal");
		assert.equal(apply?.payload.args.scope, "personal");
		assert.equal(result.isError, undefined);
	});

	it("binds exact skill content to the backend target and central approval flow", async () => {
		desktopContext();
		const calls: unknown[] = [];
		let presentation: Record<string, unknown> | undefined;
		const result = await executeKnowledgeReview(
			"tool-call-1",
			request,
			{
				ui: {
					confirm: async (_title: string, message: string) => {
						presentation = JSON.parse(message) as Record<string, unknown>;
						return true;
					},
				} as never,
			},
			dependencies(calls),
		);

		assert.equal((presentation?.presentation as Record<string, unknown>).target, "Tech Testing");
		assert.deepEqual((presentation?.presentation as Record<string, unknown>).content, request.content);
		const normalized = (calls as Array<Record<string, unknown>>).map((call) => {
			const { execution: _execution, ...rest } = call;
			return rest;
		});
		assert.deepEqual(normalized, [
			{
				op: "tools.invoke",
				payload: { skillId: "share-memory-skill", toolId: "knowledge", args: { operation: "check_targets" } },
			},
			{
				op: "tools.prepare",
				departmentId: "dept-1",
				payload: { skillId: "share-memory-skill", toolId: "knowledge", args: {
					operation: "propose",
					kind: "skill",
					action: "publish",
					scope: "department",
					departmentId: "dept-1",
					logicalKey: "weekly-risk-report",
					content: request.content,
				} },
			},
			{
				op: "tools.commit",
				departmentId: "dept-1",
				payload: { intentId: "intent-1" },
			},
			{
				op: "knowledge.review.decide",
				payload: {
					mutationId: "00000000-0000-4000-8000-000000000001",
					contentHash: "b".repeat(64),
					decision: "approve",
				},
			},
			{
				op: "tools.invoke",
				departmentId: "dept-1",
				payload: { skillId: "share-memory-skill", toolId: "knowledge", args: {
					operation: "apply",
					mutationId: "00000000-0000-4000-8000-000000000001",
					contentHash: "b".repeat(64),
					kind: "skill",
					action: "publish",
					scope: "department",
					departmentId: "dept-1",
					content: request.content,
				} },
			},
		]);
		assert.equal((result.details as { mutationId: string }).mutationId, "00000000-0000-4000-8000-000000000001");
		assert.equal(result.isError, undefined);
	});

	it("does not create a proposal when requester review is cancelled", async () => {
		desktopContext();
		const calls: unknown[] = [];
		const result = await executeKnowledgeReview(
			"tool-call-1",
			request,
			{ ui: { confirm: async () => false } as never },
			dependencies(calls),
		);
		assert.equal(calls.length, 2);
		assert.equal((calls[1] as { op: string }).op, "tools.prepare");
		assert.equal(calls.some((call) => (call as { op: string }).op === "tools.commit"), false);
		assert.match(result.content[0]?.text ?? "", /cancelled.*nothing was saved/i);
	});

	it("reviews a local file before private staging and sends only the backend descriptor", async () => {
		desktopContext();
		const calls: unknown[] = [];
		let staged = 0;
		let shown: Record<string, unknown> | undefined;
		const deps = dependencies(calls);
		deps.prepareFile = async () => ({
			buffer: Buffer.from("reviewed bytes"),
			fileName: "procedure.pdf",
			mimeType: "application/pdf",
			sizeBytes: 14,
			sha256: "a".repeat(64),
		});
		deps.stageFile = async () => {
			staged += 1;
			return {
				assetId: "00000000-0000-4000-8000-000000000099",
				fileName: "procedure.pdf",
				mimeType: "application/pdf",
				sizeBytes: 14,
				sha256: "a".repeat(64),
			};
		};
		const result = await executeKnowledgeReview(
			"tool-call-file",
			{
				kind: "file",
				action: "publish",
				scope: "department",
				logicalKey: "procedure-pdf",
				content: { localPath: "artifacts/procedure.pdf" },
			},
			{ ui: { confirm: async (_title: string, message: string) => {
				shown = JSON.parse(message) as Record<string, unknown>;
				return true;
			} } as never },
			deps,
		);
		assert.equal(staged, 1);
		assert.equal(result.isError, undefined);
		const presentation = shown?.presentation as Record<string, unknown>;
		assert.deepEqual(presentation.content, {
			fileName: "procedure.pdf",
			mimeType: "application/pdf",
			sizeBytes: 14,
			sha256: "a".repeat(64),
		});
		const propose = (calls as Array<Record<string, any>>).find(call => call.op === "tools.prepare" && call.payload?.args?.operation === "propose");
		assert.equal(propose?.payload.args.content.assetId, "00000000-0000-4000-8000-000000000099");
		assert.equal(propose?.payload.args.content.localPath, undefined);
	});

	it("rejects model-controlled targets and invalid optimistic-version envelopes", async () => {
		desktopContext();
		for (const invalid of [
			{ ...request, departmentId: "dept-other" },
			{ ...request, action: "update" },
			{ ...request, action: "delete", content: request.content, baseVersion: 1 },
		]) {
			const calls: unknown[] = [];
			const result = await executeKnowledgeReview(
				"tool-call-1",
				invalid,
				{ ui: { confirm: async () => true } as never },
				dependencies(calls),
			);
			assert.equal(calls.length, 0);
			assert.equal(result.isError, true);
		}
	});

	it("fails closed when the requested shared target is unavailable", async () => {
		desktopContext();
		const calls: unknown[] = [];
		const result = await executeKnowledgeReview(
			"tool-call-1",
			request,
			{ ui: { confirm: async () => { throw new Error("must not open"); } } as never },
			dependencies(calls, { targets: [{ scope: "company", label: "Company" }] }),
		);
		assert.equal(calls.length, 1);
		assert.match(result.content[0]?.text ?? "", /department target is not available/i);
	});

	it("opens the backend-owned requester card for Lark", async () => {
		writeFileSync(contextPath, JSON.stringify({ version: 1, threadId: "thread-1", runId: "run-1", channel: "lark" }));
		const calls: unknown[] = [];
		const result = await executeKnowledgeReview(
			"tool-call-1",
			request,
			{ ui: { confirm: async () => true } as never },
			dependencies(calls),
		);
		assert.equal(calls.length, 2);
		assert.equal((calls[1] as { op: string }).op, "knowledge.review.open");
		assert.equal(result.isError, undefined);
	});
});
