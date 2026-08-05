import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import {
	callDivoGateway,
	formatGatewayResponse,
	resolveDivoGatewayConfig,
	type DivoGatewayConfig,
	type GatewayExecutionContext,
	type GatewayRequestBody,
	type GatewayResponseBody,
} from "./gateway-client.ts";
import { approvePreparedDivoIntent } from "./approval-gate.ts";
import { readDivoRunCorrelation, type DivoRunCorrelationV1 } from "./run-correlation.ts";

export const DIVO_MEMORY_REVIEW_PROTOCOL_TITLE = "divo_memory_review_v1";
export const MAX_MEMORY_REVIEW_BULLETS = 10;
export const MAX_MEMORY_REVIEW_BULLET_LENGTH = 500;
export const MAX_MEMORY_REVIEW_REVISION_LENGTH = 1_000;

type JsonRecord = Record<string, unknown>;
type MemoryScope = "department" | "company";

export interface MemoryReviewTargetV1 {
	scope: MemoryScope;
	label: string;
	departmentId?: string;
}

export interface MemoryReviewBulletV1 {
	id: string;
	text: string;
}

export interface MemoryReviewRequestV1 {
	version: 1;
	proposalId: string;
	bullets: MemoryReviewBulletV1[];
	allowedTargets: MemoryReviewTargetV1[];
	runCorrelation: DivoRunCorrelationV1;
}

type MemoryReviewPayloadV1 = Omit<MemoryReviewRequestV1, "runCorrelation">;

export interface MemoryReviewProposalV1 {
	proposalId: string;
	bullets: MemoryReviewBulletV1[];
	requestedScope?: MemoryScope;
}

export interface MemoryReviewResponseV1 {
	version: 1;
	proposalId: string;
	decision: "approve" | "revise" | "cancel";
	selectedTarget: { scope: MemoryScope; departmentId?: string } | null;
	selectedBulletIds: string[];
	revision?: string;
}

export interface MemoryReviewDependencies {
	resolveConfig: () => DivoGatewayConfig | { error: string };
	resolveSkillId: (toolId: string, runId: string) => string | undefined;
	callGateway: (
		config: DivoGatewayConfig,
		request: GatewayRequestBody,
		options?: { signal?: AbortSignal },
	) => Promise<{ body: GatewayResponseBody; httpStatus: number }>;
}

const DEFAULT_DEPENDENCIES: MemoryReviewDependencies = {
	resolveConfig: resolveDivoGatewayConfig,
	resolveSkillId: () => undefined,
	callGateway: (config, request, options) => callDivoGateway(config, request, fetch, options),
};

const MEMORY_REVIEW_PARAMS = Type.Object({
	proposalId: Type.String({
		description: "Unique identifier for this exact memory proposal.",
	}),
	bullets: Type.Array(
		Type.Object({
			id: Type.String(),
			text: Type.String(),
		}, { additionalProperties: false }),
		{ minItems: 1, maxItems: MAX_MEMORY_REVIEW_BULLETS },
	),
	requestedScope: Type.Optional(Type.Union([
		Type.Literal("department"),
		Type.Literal("company"),
	], {
		description:
			"Use only when the user explicitly asked for team/department or company memory. Department is bound by the backend to the authenticated active department.",
	})),
}, { additionalProperties: false });

function asRecord(value: unknown): JsonRecord | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as JsonRecord)
		: undefined;
}

function boundedString(value: unknown, field: string, maxLength: number): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`${field} must be a non-empty string`);
	}
	const result = value.trim();
	if (result.length > maxLength) throw new Error(`${field} is too long`);
	return result;
}

function targetKey(target: { scope: MemoryScope; departmentId?: string }): string {
	return `${target.scope}:${target.departmentId ?? ""}`;
}

export function validateMemoryReviewProposal(value: unknown): MemoryReviewProposalV1 {
	const record = asRecord(value);
	if (!record) throw new Error("memory review request must be an object");
	if (record.allowedTargets !== undefined) {
		throw new Error(
			"allowedTargets must not be supplied; the extension obtains them from the backend",
		);
	}
	if (record.departmentId !== undefined) {
		throw new Error(
			"departmentId must not be supplied; the extension uses the authenticated runtime department",
		);
	}
	if (Object.keys(record).some((key) => !["proposalId", "bullets", "requestedScope"].includes(key))) {
		throw new Error("memory review request contains unsupported fields");
	}
	const proposalId = boundedString(record.proposalId, "proposalId", 200);
	const requestedScope = record.requestedScope;
	if (
		requestedScope !== undefined &&
		requestedScope !== "department" &&
		requestedScope !== "company"
	) {
		throw new Error("requestedScope must be department or company");
	}
	if (!Array.isArray(record.bullets) || record.bullets.length < 1 || record.bullets.length > MAX_MEMORY_REVIEW_BULLETS) {
		throw new Error("memory review must contain a bounded bullet list");
	}
	const bulletIds = new Set<string>();
	const bullets = record.bullets.map((value, index) => {
		const bullet = asRecord(value);
		if (!bullet) throw new Error(`bullets[${index}] must be an object`);
		if (Object.keys(bullet).some((key) => !["id", "text"].includes(key))) {
			throw new Error(`bullets[${index}] contains unsupported fields`);
		}
		const id = boundedString(bullet.id, `bullets[${index}].id`, 200);
		if (bulletIds.has(id)) throw new Error("memory bullet ids must be unique");
		bulletIds.add(id);
		return {
			id,
			text: boundedString(
				bullet.text,
				`bullets[${index}].text`,
				MAX_MEMORY_REVIEW_BULLET_LENGTH,
			),
		};
	});

	return {
		proposalId,
		bullets,
		...(requestedScope ? { requestedScope } : {}),
	};
}

function parseCanonicalTargets(value: unknown): MemoryReviewTargetV1[] {
	if (!Array.isArray(value) || value.length < 1 || value.length > 3) {
		throw new Error("memory authority must contain one to three targets");
	}
	const targetKeys = new Set<string>();
	const allowedTargets: MemoryReviewTargetV1[] = [];
	value.forEach((targetValue, index) => {
		const target = asRecord(targetValue);
		if (!target) throw new Error(`allowedTargets[${index}] must be an object`);
		const scope = target.scope;
		if (scope === "personal") return;
		if (scope !== "department" && scope !== "company") {
			throw new Error(`allowedTargets[${index}].scope is unsupported`);
		}
		const departmentId =
			target.departmentId === undefined
				? undefined
				: boundedString(target.departmentId, `allowedTargets[${index}].departmentId`, 200);
		if (scope === "department" && !departmentId) {
			throw new Error("department targets require departmentId");
		}
		if (scope !== "department" && departmentId) {
			throw new Error("only department targets may include departmentId");
		}
		const result: MemoryReviewTargetV1 = {
			scope,
			label: boundedString(target.label, `allowedTargets[${index}].label`, 200),
			...(departmentId ? { departmentId } : {}),
		};
		const key = targetKey(result);
		if (targetKeys.has(key)) throw new Error("memory review targets must be unique");
		targetKeys.add(key);
		allowedTargets.push(result);
	});
	if (allowedTargets.length === 0) {
		throw new Error("no shared memory target is available");
	}
	return allowedTargets;
}

async function buildAuthorizedReviewRequest(
	proposal: MemoryReviewProposalV1,
	config: DivoGatewayConfig,
	execution: GatewayExecutionContext,
	skillId: string,
	dependencies: MemoryReviewDependencies,
	signal?: AbortSignal,
): Promise<MemoryReviewPayloadV1> {
	const authority = await dependencies.callGateway(config, {
		op: "tools.invoke",
		execution,
		payload: {
			skillId,
			toolId: "knowledge",
			args: { operation: "check_targets" },
		},
	}, signal ? { signal } : {});
	if (!authority.body.ok || authority.body.status !== "success") {
		throw new Error(formatGatewayResponse(authority.body).text);
	}
	const data = asRecord(authority.body.data);
	const result = asRecord(data?.result);
	if (result?.operation !== "check_targets") {
		throw new Error("backend returned an invalid memory authority result");
	}
	const allowedTargets = parseCanonicalTargets(result.targets).filter(target => (
		!proposal.requestedScope || target.scope === proposal.requestedScope
	));
	if (allowedTargets.length === 0) {
		throw new Error(`no ${proposal.requestedScope ?? "shared"} memory target is available`);
	}
	return {
		version: 1,
		proposalId: proposal.proposalId,
		bullets: proposal.bullets,
		allowedTargets,
	};
}

export function parseMemoryReviewResponse(
	value: unknown,
	request: MemoryReviewPayloadV1,
): MemoryReviewResponseV1 {
	const record = asRecord(value);
	if (!record || record.version !== 1) {
		throw new Error("unsupported memory review response");
	}
	if (Object.keys(record).some((key) => !["version", "proposalId", "decision", "selectedTarget", "selectedBulletIds", "revision"].includes(key))) {
		throw new Error("memory review response contains unsupported fields");
	}
	if (boundedString(record.proposalId, "proposalId", 200) !== request.proposalId) {
		throw new Error("memory review response does not match its proposal");
	}
	const decision = record.decision;
	if (decision !== "approve" && decision !== "revise" && decision !== "cancel") {
		throw new Error("memory review decision is invalid");
	}
	if (!Array.isArray(record.selectedBulletIds)) {
		throw new Error("selectedBulletIds must be an array");
	}
	const availableBullets = new Set(request.bullets.map((bullet) => bullet.id));
	const selectedBulletIds = record.selectedBulletIds.map((value) =>
		boundedString(value, "selectedBulletIds item", 200),
	);
	if (new Set(selectedBulletIds).size !== selectedBulletIds.length || selectedBulletIds.some((id) => !availableBullets.has(id))) {
		throw new Error("selected bullets are not part of this proposal");
	}

	let selectedTarget: MemoryReviewResponseV1["selectedTarget"] = null;
	if (record.selectedTarget !== null && record.selectedTarget !== undefined) {
		const target = asRecord(record.selectedTarget);
		if (!target) throw new Error("selectedTarget must be an object or null");
		if (Object.keys(target).some((key) => !["scope", "departmentId"].includes(key))) {
			throw new Error("selected target contains unsupported fields");
		}
		const scope = target.scope;
		if (scope !== "department" && scope !== "company") {
			throw new Error("selected target scope is invalid");
		}
		const departmentId =
			target.departmentId === undefined
				? undefined
				: boundedString(target.departmentId, "selectedTarget.departmentId", 200);
		selectedTarget = { scope, ...(departmentId ? { departmentId } : {}) };
		if (!request.allowedTargets.some((allowed) => targetKey(allowed) === targetKey(selectedTarget!))) {
			throw new Error("selected target was not allowed by the backend result");
		}
	}

	const revision =
		record.revision === undefined
			? undefined
			: boundedString(record.revision, "revision", MAX_MEMORY_REVIEW_REVISION_LENGTH);
	if (decision === "approve" && (!selectedTarget || selectedBulletIds.length === 0)) {
		throw new Error("approval requires a target and at least one memory");
	}
	if (decision === "revise" && !revision) {
		throw new Error("revision decision requires revision text");
	}
	return {
		version: 1,
		proposalId: request.proposalId,
		decision,
		selectedTarget,
		selectedBulletIds,
		...(revision ? { revision } : {}),
	};
}

async function presentMemoryReview(
	ctx: Pick<ExtensionContext, "ui">,
	request: MemoryReviewPayloadV1,
	runCorrelation: DivoRunCorrelationV1,
): Promise<MemoryReviewResponseV1> {
	ctx.signal?.throwIfAborted();
	const correlatedRequest: MemoryReviewRequestV1 = {
		...request,
		runCorrelation,
	};
	const raw = await ctx.ui.editor(
		DIVO_MEMORY_REVIEW_PROTOCOL_TITLE,
		JSON.stringify(correlatedRequest),
	);
	ctx.signal?.throwIfAborted();
	if (raw === undefined) {
		return {
			version: 1,
			proposalId: request.proposalId,
			decision: "cancel",
			selectedTarget: null,
			selectedBulletIds: [],
		};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("desktop returned malformed memory review JSON");
	}
	return parseMemoryReviewResponse(parsed, correlatedRequest);
}

async function publishApprovedMemory(
	toolCallId: string,
	request: MemoryReviewPayloadV1,
	response: MemoryReviewResponseV1,
	config: DivoGatewayConfig,
	execution: GatewayExecutionContext,
	skillId: string,
	ctx: Pick<ExtensionContext, "ui" | "signal">,
	dependencies: MemoryReviewDependencies,
): Promise<
	| {
			outcome: "confirmed";
			body: GatewayResponseBody;
			httpStatus: number;
	  }
	| { outcome: "cancelled"; error: string }
	| { outcome: "indeterminate"; intentId: string; error: string }
> {
	const target = response.selectedTarget!;
	const selected = new Set(response.selectedBulletIds);
	const facts = request.bullets
		.filter((bullet) => selected.has(bullet.id))
		.map((bullet) => bullet.text);
	const departmentId = target.scope === "department" ? target.departmentId : undefined;
	const content = { facts };
	const prepared = await dependencies.callGateway(config, {
		op: "tools.prepare",
		execution,
		...(departmentId ? { departmentId } : {}),
		payload: {
			skillId,
			toolId: "knowledge",
			args: {
				operation: "propose",
				kind: "memory",
				action: "publish",
				scope: target.scope,
				...(departmentId ? { departmentId } : {}),
				logicalKey: request.proposalId,
				content,
			},
		},
	}, ctx.signal ? { signal: ctx.signal } : {});
	if (!prepared.body.ok || prepared.body.status !== "success") {
		return { outcome: "confirmed", ...prepared };
	}

	let intentId: string;
	try {
		intentId = await approvePreparedDivoIntent(toolCallId, prepared.body.data, {
			ui: ctx.ui,
			cwd: process.cwd(),
			...(ctx.signal ? { signal: ctx.signal } : {}),
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (/did not approve/i.test(message)) {
			return { outcome: "cancelled", error: message };
		}
		throw error;
	}
	const committed = await dependencies.callGateway(config, {
		op: "tools.commit",
		execution,
		...(departmentId ? { departmentId } : {}),
		payload: { intentId },
	}, ctx.signal ? { signal: ctx.signal } : {});
	if (!committed.body.ok || committed.body.status !== "success") {
		return { outcome: "confirmed", ...committed };
	}
	const proposalEnvelope = asRecord(committed.body.data);
	const proposalResult = asRecord(proposalEnvelope?.result);
	const mutationId = typeof proposalResult?.mutationId === "string"
		? proposalResult.mutationId
		: undefined;
	const contentHash = proposalResult?.contentHash;
	if (!mutationId || (contentHash !== null && typeof contentHash !== "string")) {
		throw new Error("backend did not return a durable memory proposal");
	}
	const reviewed = await dependencies.callGateway(config, {
		op: "knowledge.review.decide",
		execution,
		payload: {
			mutationId,
			contentHash: contentHash ?? null,
			decision: "approve",
		},
	}, ctx.signal ? { signal: ctx.signal } : {});
	if (!reviewed.body.ok || reviewed.body.status !== "success") {
		return { outcome: "confirmed", ...reviewed };
	}
	try {
		const applied = await dependencies.callGateway(config, {
			op: "tools.invoke",
			execution,
			...(departmentId ? { departmentId } : {}),
			payload: {
				skillId,
				toolId: "knowledge",
				args: {
					operation: "apply",
					mutationId,
					contentHash: contentHash ?? null,
					kind: "memory",
					action: "publish",
					scope: target.scope,
					...(departmentId ? { departmentId } : {}),
					content,
				},
			},
		}, ctx.signal ? { signal: ctx.signal } : {});
		return { outcome: "confirmed", ...applied };
	} catch (error) {
		return {
			outcome: "indeterminate",
			intentId: mutationId,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

async function openLarkMemoryReview(
	proposal: MemoryReviewProposalV1,
	config: DivoGatewayConfig,
	execution: GatewayExecutionContext,
	skillId: string,
	dependencies: MemoryReviewDependencies,
	signal?: AbortSignal,
) {
	if (!proposal.requestedScope) {
		throw new Error("Lark shared-memory review requires an explicit department or company scope");
	}
	const opened = await dependencies.callGateway(config, {
		op: "knowledge.review.open",
		execution,
		payload: {
			skillId,
			requestId: proposal.proposalId,
			kind: "memory",
			bullets: proposal.bullets.map((bullet) => bullet.text),
			...(proposal.requestedScope
				? { requestedScope: proposal.requestedScope }
				: {}),
		},
	}, signal ? { signal } : {});
	const formatted = formatGatewayResponse(opened.body);
	const data = asRecord(opened.body.data);
	const message = typeof data?.message === "string" && data.message.trim()
		? data.message.trim()
		: formatted.text;
	return {
		content: [{ type: "text" as const, text: message }],
		details: {
			decision: "pending",
			published: false,
			httpStatus: opened.httpStatus,
			status: opened.body.status,
			data: opened.body.data,
			error: opened.body.error,
		},
		...(!opened.body.ok ? { isError: true as const } : {}),
	};
}

export async function executeMemoryReview(
	toolCallId: string,
	params: unknown,
	ctx: Pick<ExtensionContext, "ui" | "signal">,
	dependencies: MemoryReviewDependencies = DEFAULT_DEPENDENCIES,
) {
	let proposal: MemoryReviewProposalV1;
	try {
		proposal = validateMemoryReviewProposal(params);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: "text" as const, text: `Memory review rejected: ${message}` }],
			details: { decision: "cancel", error: message },
		};
	}
	const resolved = dependencies.resolveConfig();
	if ("error" in resolved) {
		return {
			content: [{ type: "text" as const, text: resolved.error }],
			details: { decision: "cancel", error: resolved.error },
		};
	}

	let runCorrelation: DivoRunCorrelationV1;
	try {
		runCorrelation = await readDivoRunCorrelation();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: "text" as const, text: `Memory review cancelled safely: ${message}` }],
			details: { decision: "cancel", error: message },
		};
	}
	const execution: GatewayExecutionContext = {
		version: 1,
		threadId: runCorrelation.threadId,
		runId: runCorrelation.runId,
		actionId: `memory-review:${randomUUID()}`,
	};
	const skillId = dependencies.resolveSkillId("knowledge", runCorrelation.runId);
	if (!skillId) {
		const message = "The exact Manage Knowledge skill is not loaded in this run.";
		return {
			content: [{ type: "text" as const, text: `Memory review cancelled safely: ${message}` }],
			details: { decision: "cancel", error: message },
		};
	}
	if (runCorrelation.channel === "lark") {
		try {
			return await openLarkMemoryReview(
				proposal,
				resolved,
				execution,
				skillId,
				dependencies,
				ctx.signal,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				content: [{ type: "text" as const, text: `Memory review was not opened: ${message}` }],
				details: { decision: "cancel", error: message },
				isError: true,
			};
		}
	}

	let request: MemoryReviewPayloadV1;
	try {
		request = await buildAuthorizedReviewRequest(
		proposal,
			resolved,
			execution,
			skillId,
			dependencies,
			ctx.signal,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [
				{
					type: "text" as const,
					text: `Memory review could not verify available targets: ${message}`,
				},
			],
			details: { decision: "cancel", error: message },
		};
	}

	let response: MemoryReviewResponseV1;
	try {
		response = await presentMemoryReview(ctx, request, runCorrelation);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: "text" as const, text: `Memory review cancelled safely: ${message}` }],
			details: { decision: "cancel", error: message },
		};
	}
	if (response.decision === "cancel") {
		return {
			content: [{ type: "text" as const, text: "The user cancelled memory sharing. Nothing was saved." }],
			details: response,
		};
	}
	if (response.decision === "revise") {
		return {
			content: [{ type: "text" as const, text: `The user requested a new memory proposal: ${response.revision}` }],
			details: response,
		};
	}

	try {
		const published = await publishApprovedMemory(
			toolCallId,
			request,
			response,
			resolved,
			execution,
			skillId,
			ctx,
			dependencies,
		);
		if (published.outcome === "cancelled") {
			return {
				content: [{ type: "text" as const, text: "The memory change was cancelled. Nothing was saved." }],
				details: { ...response, published: false, outcome: "cancelled" },
			};
		}
		if (published.outcome === "indeterminate") {
			return {
				content: [
					{
						type: "text" as const,
						text: `Memory publishing outcome could not be confirmed after commit was sent. Intent ID: ${published.intentId}. Do not retry automatically; first verify whether the memory was saved.`,
					},
				],
				details: {
					...response,
					outcome: "indeterminate",
					published: null,
					intentId: published.intentId,
					error: published.error,
				},
			};
		}
		const formatted = formatGatewayResponse(published.body);
		return {
			content: [{ type: "text" as const, text: formatted.text }],
			details: {
				...response,
				published: published.body.ok && published.body.status === "success",
				httpStatus: published.httpStatus,
				status: published.body.status,
				data: published.body.data,
				error: published.body.error,
			},
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: "text" as const, text: `Memory was not saved: ${message}` }],
			details: { ...response, published: false, error: message },
		};
	}
}

export function registerMemoryReviewTool(
	pi: ExtensionAPI,
	options: {
		resolveLoadedSkillId?: (toolId: string, runId: string) => string | undefined;
	} = {},
) {
	pi.registerTool({
		name: "divo_memory_review",
		label: "Review shared memory",
		description:
			"Review durable department or company facts against the authenticated runtime department and publish only the exact approved selection. Always pass requestedScope for Lark reviews; Personal is never a shared-memory target. Personal saves use divo_memory and are synchronously confirmed by its verified result.",
		promptSnippet:
			"Use divo_memory_review only for department or company memory after the Manage Knowledge skill checks backend authority.",
		promptGuidelines: [
			"Call only after the Manage Knowledge skill performs its orchestration authority check. Pass proposalId, bounded bullets, and requestedScope only when the user explicitly chose department/team or company. Never pass departmentId or allowed targets.",
			"Do not call the knowledge mutation operations directly; divo_memory_review binds the exact user-approved selection to the backend knowledge state machine.",
			"If the result requests revision, create a new bounded proposal from the revision and call this tool again. If cancelled, save nothing.",
		],
		parameters: MEMORY_REVIEW_PARAMS,
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			return executeMemoryReview(toolCallId, params, ctx, {
				...DEFAULT_DEPENDENCIES,
				resolveSkillId: options.resolveLoadedSkillId ?? DEFAULT_DEPENDENCIES.resolveSkillId,
			});
		},
	});
}
