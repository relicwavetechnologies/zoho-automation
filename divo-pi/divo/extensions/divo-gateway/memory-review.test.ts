import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	DIVO_MEMORY_REVIEW_PROTOCOL_TITLE,
	executeMemoryReview,
	parseMemoryReviewResponse,
	validateMemoryReviewProposal,
	type MemoryReviewDependencies,
	type MemoryReviewRequestV1,
	type MemoryReviewTargetV1,
} from "./memory-review.ts";

const runContextPath = join(mkdtempSync(join(tmpdir(), "divo-memory-run-")), "context.json");
writeFileSync(runContextPath, JSON.stringify({ version: 1, threadId: "thread-1", runId: "run-1" }));
process.env.DIVO_RUN_CONTEXT_PATH = runContextPath;

const proposal = {
	proposalId: "proposal-1",
	bullets: [
		{ id: "fact-1", text: "Finance reviews refunds over ₹10K." },
		{ id: "fact-2", text: "Acme uses net-60 payment terms." },
	],
} as const;

const canonicalTargets: MemoryReviewTargetV1[] = [
	{ scope: "department", label: "Finance", departmentId: "dept-1" },
];
const authorityTargets = [
	{ scope: "personal", label: "Personal" },
	...canonicalTargets,
];

function reviewRequest(): MemoryReviewRequestV1 {
	return {
		version: 1,
		proposalId: proposal.proposalId,
		bullets: [...proposal.bullets],
		allowedTargets: canonicalTargets,
		runCorrelation: { version: 1, threadId: "thread-1", runId: "run-1" },
	};
}

function dependencies(options: {
	onRequest?: (request: unknown) => void;
	onOptions?: (options: { signal?: AbortSignal } | undefined) => void;
	targets?: unknown[];
	authorityError?: string;
	applyError?: Error;
} = {}): MemoryReviewDependencies {
	return {
		resolveConfig: () => ({
			backendUrl: "http://localhost:4000",
			memberToken: "member-token",
		}),
		callGateway: async (_config, gatewayRequest, requestOptions) => {
			options.onRequest?.(gatewayRequest);
			options.onOptions?.(requestOptions);
			if (gatewayRequest.op === "tools.invoke") {
				const args = (gatewayRequest.payload as { args?: { operation?: string } }).args;
				if (args?.operation === "check_targets") {
					if (options.authorityError) {
						return {
							httpStatus: 503,
							body: {
								ok: false,
								status: "error",
								error: { code: "upstream_failure", message: options.authorityError },
							},
						};
					}
					return {
						httpStatus: 200,
						body: {
							ok: true,
							status: "success",
							data: {
								result: {
									operation: "check_targets",
									targets: options.targets ?? authorityTargets,
								},
							},
						},
					};
				}
				if (args?.operation === "propose") {
					return {
						httpStatus: 400,
						body: {
							ok: false,
							status: "local_approval_required",
							error: { message: "Direct mutation invocation requires local approval." },
						},
					};
				}
				if (args?.operation === "apply") {
					if (options.applyError) throw options.applyError;
					return {
						httpStatus: 200,
						body: {
							ok: true,
							status: "success",
							data: {
								result: {
									operation: "apply",
									mutationId: "00000000-0000-4000-8000-000000000001",
									status: "applied",
									resourceId: "resource-1",
									version: 1,
									projection: "completed",
								},
							},
						},
					};
				}
				throw new Error(`unexpected knowledge operation: ${String(args?.operation)}`);
			}
			if (gatewayRequest.op === "tools.prepare") {
				return {
					httpStatus: 200,
					body: {
						ok: true,
						status: "success",
						data: {
							intentId: "intent-1",
							kind: "knowledge.memory.publish",
							action: "create",
							title: "Review shared memory",
							presentation: { facts: proposal.bullets },
						},
					},
				};
			}
			if (gatewayRequest.op === "tools.commit") {
				return {
					httpStatus: 200,
					body: {
						ok: true,
						status: "success",
						data: {
							result: {
								operation: "propose",
								mutationId: "00000000-0000-4000-8000-000000000001",
								contentHash: "a".repeat(64),
								status: "awaiting_requester_review",
							},
						},
					},
				};
			}
			if (gatewayRequest.op === "knowledge.review.decide") {
				return {
					httpStatus: 200,
					body: {
						ok: true,
						status: "success",
						data: { status: "awaiting_approval" },
					},
				};
			}
			if (gatewayRequest.op === "knowledge.review.open") {
				return {
					httpStatus: 200,
					body: {
						ok: true,
						status: "success",
						data: {
							status: "review_pending",
							message: "The exact facts are waiting in a Lark review card.",
						},
					},
				};
			}
			throw new Error(`unexpected gateway operation: ${gatewayRequest.op}`);
		},
	};
}

describe("memory review protocol", () => {
	it("validates proposal-only input and rejects model-asserted targets", () => {
		const validated = validateMemoryReviewProposal(proposal);
		assert.equal(validated.bullets.length, 2);
		assert.throws(
			() => validateMemoryReviewProposal({ proposalId: "proposal-1", bullets: [] }),
			/bounded bullet list/,
		);
		assert.throws(
			() => validateMemoryReviewProposal({ ...proposal, unexpected: true }),
			/unsupported fields/,
		);
		assert.throws(
			() => validateMemoryReviewProposal({
				...proposal,
				bullets: [{ ...proposal.bullets[0], unexpected: true }],
			}),
			/bullets\[0\] contains unsupported fields/,
		);
		assert.equal(
			validateMemoryReviewProposal({ ...proposal, requestedScope: "company" }).requestedScope,
			"company",
		);
		assert.throws(
			() => validateMemoryReviewProposal({ ...proposal, requestedScope: "personal" }),
			/requestedScope must be department or company/,
		);
		assert.throws(
			() =>
				validateMemoryReviewProposal({
					...proposal,
					allowedTargets: [
						{ scope: "company", label: "Fabricated company" },
						{
							scope: "department",
							label: "Other department",
							departmentId: "dept-other",
						},
					],
				}),
			/allowedTargets must not be supplied/,
		);
		assert.throws(
			() =>
				validateMemoryReviewProposal({
					...proposal,
					departmentId: "dept-other",
				}),
			/departmentId must not be supplied/,
		);

		assert.throws(
			() =>
				parseMemoryReviewResponse(
					{
						version: 1,
						proposalId: "proposal-1",
						decision: "approve",
						selectedTarget: { scope: "company" },
						selectedBulletIds: ["fact-1"],
					},
					reviewRequest(),
				),
			/not allowed/,
		);
		assert.throws(
			() => parseMemoryReviewResponse({
				version: 1,
				proposalId: "proposal-1",
				decision: "cancel",
				selectedTarget: null,
				selectedBulletIds: [],
				unexpected: true,
			}, reviewRequest()),
			/unsupported fields/,
		);
	});

	it("renders only freshly backend-authorized targets and publishes the exact selection", async () => {
		let title = "";
		let cardRequest: MemoryReviewRequestV1 | undefined;
		const calls: unknown[] = [];
		const requestSignals: Array<AbortSignal | undefined> = [];
		const controller = new AbortController();
		const result = await executeMemoryReview(
			"tool-call-1",
			proposal,
			{
				ui: {
					confirm: async () => true,
					editor: async (nextTitle: string, prefill?: string) => {
						title = nextTitle;
						cardRequest = JSON.parse(prefill ?? "") as MemoryReviewRequestV1;
						return JSON.stringify({
							version: 1,
							proposalId: "proposal-1",
							decision: "approve",
							selectedTarget: {
								scope: "department",
								departmentId: "dept-1",
							},
							selectedBulletIds: ["fact-2"],
						});
					},
				} as never,
				signal: controller.signal,
			},
			dependencies({
				onRequest: (call) => calls.push(call),
				onOptions: options => requestSignals.push(options?.signal),
			}),
		);

		assert.equal(title, DIVO_MEMORY_REVIEW_PROTOCOL_TITLE);
		assert.deepEqual(cardRequest?.runCorrelation, { version: 1, threadId: "thread-1", runId: "run-1" });
		assert.deepEqual(cardRequest?.allowedTargets, canonicalTargets);
		assert.ok(requestSignals.length > 0);
		assert.ok(requestSignals.every(signal => signal === controller.signal));
		assert.equal(
			cardRequest?.allowedTargets.some(
				(target) =>
					target.scope === "company" || target.departmentId === "dept-other",
			),
			false,
		);
		const gatewayCalls = calls as Array<{
			op: string;
			departmentId?: string;
			payload?: unknown;
			execution?: { version: number; threadId: string; runId: string; actionId: string };
		}>;
		assert.deepEqual(
			gatewayCalls.map(({ execution, ...call }) => call),
			[
				{
					op: "tools.invoke",
					payload: {
						toolId: "knowledge",
						args: { operation: "check_targets" },
					},
				},
				{
					op: "tools.prepare",
					departmentId: "dept-1",
					payload: {
						toolId: "knowledge",
						args: {
							operation: "propose",
							kind: "memory",
							action: "publish",
							scope: "department",
							departmentId: "dept-1",
							logicalKey: "proposal-1",
							content: { facts: ["Acme uses net-60 payment terms."] },
						},
					},
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
						contentHash: "a".repeat(64),
						decision: "approve",
					},
				},
				{
					op: "tools.invoke",
					departmentId: "dept-1",
					payload: {
						toolId: "knowledge",
						args: {
							operation: "apply",
							mutationId: "00000000-0000-4000-8000-000000000001",
							contentHash: "a".repeat(64),
							kind: "memory",
							action: "publish",
							scope: "department",
							departmentId: "dept-1",
							content: { facts: ["Acme uses net-60 payment terms."] },
						},
					},
				},
			],
		);
		const executions = gatewayCalls.map((call) => call.execution);
		assert.ok(executions.every((execution) => execution !== undefined));
		assert.ok(executions.every((execution) => execution?.version === 1));
		assert.ok(executions.every((execution) => execution?.threadId === "thread-1"));
		assert.ok(executions.every((execution) => execution?.runId === "run-1"));
		assert.equal(new Set(executions.map((execution) => execution?.actionId)).size, 1);
		assert.match(executions[0]?.actionId ?? "", /^memory-review:/);
		assert.equal((result.details as { published?: boolean }).published, true);
	});

	it("requires local approval before committing the exact shared-memory proposal", async () => {
		const calls: Array<{ op?: string }> = [];
		const result = await executeMemoryReview(
			"tool-call-approval",
			proposal,
			{
				ui: {
					editor: async () => JSON.stringify({
						version: 1,
						proposalId: "proposal-1",
						decision: "approve",
						selectedTarget: { scope: "department", departmentId: "dept-1" },
						selectedBulletIds: ["fact-1"],
					}),
					confirm: async () => false,
				} as never,
			},
			dependencies({ onRequest: (call) => calls.push(call as { op?: string }) }),
		);

		assert.deepEqual(calls.map((call) => call.op), ["tools.invoke", "tools.prepare"]);
		assert.match(result.content[0]?.text ?? "", /cancelled.*nothing was saved/i);
		assert.equal((result.details as { published?: boolean }).published, false);
	});

	it("does not open a card when the model supplies fabricated targets", async () => {
		let editorCalls = 0;
		let gatewayCalls = 0;
		const result = await executeMemoryReview(
			"tool-call-1",
			{
				...proposal,
				allowedTargets: [{ scope: "company", label: "Fabricated" }],
			},
			{
				ui: {
					editor: async () => {
						editorCalls += 1;
						return undefined;
					},
				} as never,
			},
			dependencies({ onRequest: () => (gatewayCalls += 1) }),
		);

		assert.equal(editorCalls, 0);
		assert.equal(gatewayCalls, 0);
		assert.match(result.content[0]?.text ?? "", /allowedTargets must not be supplied/);
	});

	it("opens the backend-owned Lark card without a model-supplied skill binding", async () => {
		writeFileSync(runContextPath, JSON.stringify({
			version: 1,
			threadId: "thread-1",
			runId: "run-1",
			channel: "lark",
		}));
		const calls: unknown[] = [];
		try {
			const result = await executeMemoryReview(
				"tool-call-1",
				{ ...proposal, requestedScope: "company" },
				{ ui: { editor: async () => { throw new Error("desktop editor must not open"); } } as never },
				dependencies({ onRequest: (call) => calls.push(call) }),
			);
			assert.equal(result.content[0]?.text, "The exact facts are waiting in a Lark review card.");
			assert.deepEqual(calls, [{
				op: "knowledge.review.open",
				execution: {
					version: 1,
					threadId: "thread-1",
					runId: "run-1",
					actionId: (calls[0] as any).execution.actionId,
				},
				payload: {
					requestId: "proposal-1",
					kind: "memory",
					bullets: [
						"Finance reviews refunds over ₹10K.",
						"Acme uses net-60 payment terms.",
					],
					requestedScope: "company",
				},
			}]);
		} finally {
			writeFileSync(runContextPath, JSON.stringify({
				version: 1,
				threadId: "thread-1",
				runId: "run-1",
			}));
		}
	});

	it("requires an explicit shared scope before opening a Lark memory review", async () => {
		writeFileSync(runContextPath, JSON.stringify({
			version: 1,
			threadId: "thread-1",
			runId: "run-1",
			channel: "lark",
		}));
		const calls: unknown[] = [];
		try {
			const result = await executeMemoryReview(
				"tool-call-lark-scope",
				proposal,
				{ ui: { editor: async () => { throw new Error("desktop editor must not open"); } } as never },
				dependencies({ onRequest: (call) => calls.push(call) }),
			);
			assert.equal(calls.length, 0);
			assert.match(result.content[0]?.text ?? "", /explicit department or company scope/i);
			assert.equal((result.details as { decision: string }).decision, "cancel");
		} finally {
			writeFileSync(runContextPath, JSON.stringify({
				version: 1,
				threadId: "thread-1",
				runId: "run-1",
			}));
		}
	});

	it("does not open a card when backend storage is unavailable", async () => {
		let editorCalls = 0;
		const result = await executeMemoryReview(
			"tool-call-1",
			proposal,
			{
				ui: {
					editor: async () => {
						editorCalls += 1;
						return undefined;
					},
				},
			} as never,
			dependencies({ authorityError: "memory storage is unavailable" }),
		);

		assert.equal(editorCalls, 0);
		assert.match(result.content[0]?.text ?? "", /memory storage is unavailable/);
	});

	it("does not open a card when personal is the only backend target", async () => {
		let editorCalls = 0;
		const result = await executeMemoryReview(
			"tool-call-1",
			proposal,
			{
				ui: {
					editor: async () => {
						editorCalls += 1;
						return undefined;
					},
				},
			} as never,
			dependencies({ targets: [{ scope: "personal", label: "Personal" }] }),
		);

		assert.equal(editorCalls, 0);
		assert.match(result.content[0]?.text ?? "", /no shared memory target/i);
	});

	it("rejects a model-controlled department before authority lookup", async () => {
		let editorCalls = 0;
		let gatewayCalls = 0;
		const result = await executeMemoryReview(
			"tool-call-1",
			{ ...proposal, departmentId: "dept-other" },
			{
				ui: {
					editor: async () => {
						editorCalls += 1;
						return undefined;
					},
				} as never,
			},
			dependencies({ onRequest: () => (gatewayCalls += 1) }),
		);

		assert.equal(editorCalls, 0);
		assert.equal(gatewayCalls, 0);
		assert.match(result.content[0]?.text ?? "", /departmentId must not be supplied/);
	});

	it("returns revision or cancellation without preparing a publish", async () => {
		const calls: Array<{ op?: string }> = [];
		const deps = dependencies({
			onRequest: (call) => calls.push(call as { op?: string }),
		});
		const revised = await executeMemoryReview(
			"tool-call-1",
			proposal,
			{
				ui: {
					editor: async () =>
						JSON.stringify({
							version: 1,
							proposalId: "proposal-1",
							decision: "revise",
							selectedTarget: null,
							selectedBulletIds: [],
							revision: "Remember the escalation threshold instead.",
						}),
				} as never,
			},
			deps,
		);
		assert.equal((revised.details as { decision: string }).decision, "revise");

		const cancelled = await executeMemoryReview(
			"tool-call-1",
			proposal,
			{ ui: { editor: async () => undefined } as never },
			deps,
		);
		assert.equal((cancelled.details as { decision: string }).decision, "cancel");
		assert.deepEqual(
			calls.map((call) => call.op),
			["tools.invoke", "tools.invoke"],
		);
	});

	it("reports apply transport failure as indeterminate and preserves mutationId", async () => {
		const result = await executeMemoryReview(
			"tool-call-1",
			proposal,
			{
				ui: {
					confirm: async () => true,
					editor: async () =>
						JSON.stringify({
							version: 1,
							proposalId: "proposal-1",
							decision: "approve",
							selectedTarget: {
								scope: "department",
								departmentId: "dept-1",
							},
							selectedBulletIds: ["fact-1"],
						}),
				} as never,
			},
			dependencies({ applyError: new Error("connection reset") }),
		);

		assert.match(result.content[0]?.text ?? "", /could not be confirmed/i);
		assert.match(result.content[0]?.text ?? "", /do not retry automatically/i);
		assert.doesNotMatch(result.content[0]?.text ?? "", /was not saved/i);
		assert.deepEqual(result.details, {
			version: 1,
			proposalId: "proposal-1",
			decision: "approve",
			selectedTarget: { scope: "department", departmentId: "dept-1" },
			selectedBulletIds: ["fact-1"],
			outcome: "indeterminate",
			published: null,
			intentId: "00000000-0000-4000-8000-000000000001",
			error: "connection reset",
		});
	});
});
