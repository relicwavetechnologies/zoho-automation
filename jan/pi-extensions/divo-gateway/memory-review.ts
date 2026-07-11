import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	callDivoGateway,
	formatGatewayResponse,
	resolveDivoGatewayConfig,
	type DivoGatewayConfig,
	type GatewayResponseBody,
} from "./gateway-client.ts";

export const DIVO_MEMORY_REVIEW_PROTOCOL_TITLE = "divo_memory_review_v1";
export const MAX_MEMORY_REVIEW_BULLETS = 10;
export const MAX_MEMORY_REVIEW_BULLET_LENGTH = 500;
export const MAX_MEMORY_REVIEW_REVISION_LENGTH = 1_000;

type JsonRecord = Record<string, unknown>;
type MemoryScope = "personal" | "department" | "company";

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
}

export interface MemoryReviewProposalV1 {
	proposalId: string;
	bullets: MemoryReviewBulletV1[];
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
	callGateway: (
		config: DivoGatewayConfig,
		request: { op: string; departmentId?: string; payload?: unknown },
	) => Promise<{ body: GatewayResponseBody; httpStatus: number }>;
}

const DEFAULT_DEPENDENCIES: MemoryReviewDependencies = {
	resolveConfig: resolveDivoGatewayConfig,
	callGateway: callDivoGateway,
};

const MEMORY_REVIEW_PARAMS = Type.Object({
	proposalId: Type.String({
		description: "Unique identifier for this exact memory proposal.",
	}),
	bullets: Type.Array(
		Type.Object({
			id: Type.String(),
			text: Type.String(),
		}),
		{ maxItems: MAX_MEMORY_REVIEW_BULLETS },
	),
});

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
			"departmentId must not be supplied; the extension uses the desktop-selected department",
		);
	}
	const proposalId = boundedString(record.proposalId, "proposalId", 200);
	if (!Array.isArray(record.bullets) || record.bullets.length > MAX_MEMORY_REVIEW_BULLETS) {
		throw new Error("memory review must contain a bounded bullet list");
	}
	const bulletIds = new Set<string>();
	const bullets = record.bullets.map((value, index) => {
		const bullet = asRecord(value);
		if (!bullet) throw new Error(`bullets[${index}] must be an object`);
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

	return { proposalId, bullets };
}

function parseCanonicalTargets(value: unknown): MemoryReviewTargetV1[] {
	if (!Array.isArray(value) || value.length < 1 || value.length > 3) {
		throw new Error("memory review must contain one to three allowed targets");
	}
	const targetKeys = new Set<string>();
	const allowedTargets = value.map((targetValue, index) => {
		const target = asRecord(targetValue);
		if (!target) throw new Error(`allowedTargets[${index}] must be an object`);
		const scope = target.scope;
		if (scope !== "personal" && scope !== "department" && scope !== "company") {
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
		return result;
	});
	return allowedTargets;
}

async function buildAuthorizedReviewRequest(
	proposal: MemoryReviewProposalV1,
	config: DivoGatewayConfig,
	dependencies: MemoryReviewDependencies,
): Promise<MemoryReviewRequestV1> {
	const authority = await dependencies.callGateway(config, {
		op: "tools.invoke",
		payload: {
			toolId: "memoryPublishing",
			args: { operation: "check_authority" },
		},
	});
	if (!authority.body.ok || authority.body.status !== "success") {
		throw new Error(formatGatewayResponse(authority.body).text);
	}
	const data = asRecord(authority.body.data);
	const result = asRecord(data?.result);
	if (result?.operation !== "check_authority") {
		throw new Error("backend returned an invalid memory authority result");
	}
	if (result.availability === "storage_unavailable") {
		throw new Error("backend memory storage is unavailable");
	}
	if (result.availability !== "available") {
		throw new Error("backend returned an invalid memory availability result");
	}
	return {
		version: 1,
		proposalId: proposal.proposalId,
		bullets: proposal.bullets,
		allowedTargets: parseCanonicalTargets(result.targets),
	};
}

export function parseMemoryReviewResponse(
	value: unknown,
	request: MemoryReviewRequestV1,
): MemoryReviewResponseV1 {
	const record = asRecord(value);
	if (!record || record.version !== 1) {
		throw new Error("unsupported memory review response");
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
		const scope = target.scope;
		if (scope !== "personal" && scope !== "department" && scope !== "company") {
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
	request: MemoryReviewRequestV1,
): Promise<MemoryReviewResponseV1> {
	const raw = await ctx.ui.editor(
		DIVO_MEMORY_REVIEW_PROTOCOL_TITLE,
		JSON.stringify(request),
	);
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
	return parseMemoryReviewResponse(parsed, request);
}

async function publishApprovedMemory(
	request: MemoryReviewRequestV1,
	response: MemoryReviewResponseV1,
	config: DivoGatewayConfig,
	dependencies: MemoryReviewDependencies,
): Promise<
	| {
			outcome: "confirmed";
			body: GatewayResponseBody;
			httpStatus: number;
	  }
	| { outcome: "indeterminate"; intentId: string; error: string }
> {
	const target = response.selectedTarget!;
	const selected = new Set(response.selectedBulletIds);
	const facts = request.bullets
		.filter((bullet) => selected.has(bullet.id))
		.map((bullet) => bullet.text);
	const departmentId = target.scope === "department" ? target.departmentId : undefined;
	const prepared = await dependencies.callGateway(config, {
		op: "tools.prepare",
		...(departmentId ? { departmentId } : {}),
		payload: {
			toolId: "memoryPublishing",
			args: {
				operation: "publish",
				scope: target.scope,
				...(departmentId ? { departmentId } : {}),
				facts,
			},
		},
	});
	if (!prepared.body.ok || prepared.body.status !== "success") {
		return { outcome: "confirmed", ...prepared };
	}
	const preparedData = asRecord(prepared.body.data);
	const intentId = preparedData && typeof preparedData.intentId === "string" && preparedData.intentId.trim()
		? preparedData.intentId.trim()
		: undefined;
	if (!intentId) throw new Error("backend did not bind the approved memory payload");
	try {
		const committed = await dependencies.callGateway(config, {
			op: "tools.commit",
			...(departmentId ? { departmentId } : {}),
			payload: { intentId },
		});
		return { outcome: "confirmed", ...committed };
	} catch (error) {
		return {
			outcome: "indeterminate",
			intentId,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function executeMemoryReview(
	params: unknown,
	ctx: Pick<ExtensionContext, "ui">,
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

	let request: MemoryReviewRequestV1;
	try {
		request = await buildAuthorizedReviewRequest(
			proposal,
			resolved,
			dependencies,
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
		response = await presentMemoryReview(ctx, request);
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
			request,
			response,
			resolved,
			dependencies,
		);
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

export function registerMemoryReviewTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: "divo_memory_review",
		label: "Review shared memory",
		description:
			"Recheck backend memory authority using the desktop-selected department, show the review card for durable proposed facts, and publish only the exact approved selection. Pass only proposalId and bullets; this tool fetches canonical targets itself.",
		promptSnippet:
			"Use divo_memory_review only after the Share Memory skill checks backend authority; it owns review and final exact publish.",
		promptGuidelines: [
			"Call only after the Share Memory skill performs its orchestration authority check. Pass only proposalId and bounded bullets; never pass departmentId or allowed targets.",
			"Do not call memoryPublishing.publish directly; divo_memory_review prepares and commits the exact user-approved selection.",
			"If the result requests revision, create a new bounded proposal from the revision and call this tool again. If cancelled, save nothing.",
		],
		parameters: MEMORY_REVIEW_PARAMS,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return executeMemoryReview(params, ctx);
		},
	});
}
