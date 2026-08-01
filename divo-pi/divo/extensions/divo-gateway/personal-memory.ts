import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
	callDivoGateway,
	resolveDivoGatewayConfig,
	type DivoGatewayConfig,
	type GatewayExecutionContext,
	type GatewayRequestBody,
	type GatewayResponseBody,
} from "./gateway-client.ts";
import { readDivoRunCorrelation } from "./run-correlation.ts";

export const MAX_PERSONAL_MEMORY_FACTS = 100;
export const MAX_PERSONAL_MEMORY_FACT_LENGTH = 500;
export const MAX_PERSONAL_MEMORY_LOGICAL_KEY_LENGTH = 240;
export const MAX_PERSONAL_MEMORY_SUBJECT_LENGTH = 500;

type PersonalMemoryCommand =
	| { action: "set"; subject: string; logicalKey: string; facts: string[] }
	| { action: "delete"; subject: string; logicalKey: string };

export interface PersonalMemoryResult {
	status: "applied";
	scope: "personal";
	action: "created" | "updated" | "unchanged" | "deleted";
	logicalKey: string;
	resourceId: string;
	version: number;
	projection: "completed" | "queued";
}

export interface PersonalMemoryDependencies {
	resolveConfig: () => DivoGatewayConfig | { error: string };
	readRunCorrelation: () => Promise<{ threadId: string; runId: string }>;
	callGateway: (
		config: DivoGatewayConfig,
		request: GatewayRequestBody,
	) => Promise<{ body: GatewayResponseBody; httpStatus: number }>;
}

const DEFAULT_DEPENDENCIES: PersonalMemoryDependencies = {
	resolveConfig: resolveDivoGatewayConfig,
	readRunCorrelation: readDivoRunCorrelation,
	callGateway: callDivoGateway,
};

const PERSONAL_MEMORY_PARAMS = Type.Object({
	action: StringEnum(["set", "delete"] as const, {
		description: "Set the complete current value, or delete the exact personal-memory subject.",
	}),
	subject: Type.String({
		description: "Short neutral topic being remembered, without the new desired value, for example weekly report format.",
		minLength: 1,
		maxLength: MAX_PERSONAL_MEMORY_SUBJECT_LENGTH,
	}),
	logicalKey: Type.String({
		description: "Stable dotted semantic subject, reused for later corrections, for example communication.answers.detail.",
		minLength: 1,
		maxLength: MAX_PERSONAL_MEMORY_LOGICAL_KEY_LENGTH,
	}),
	facts: Type.Optional(Type.Array(Type.String({
		description: "Complete current personal facts for this subject. Required for set and forbidden for delete.",
		minLength: 1,
		maxLength: MAX_PERSONAL_MEMORY_FACT_LENGTH,
	}), { minItems: 1, maxItems: MAX_PERSONAL_MEMORY_FACTS })),
}, { additionalProperties: false });

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

export function validatePersonalMemoryCommand(value: unknown): PersonalMemoryCommand {
	const record = asRecord(value);
	if (!record || (record.action !== "set" && record.action !== "delete")) {
		throw new Error("personal memory action must be set or delete");
	}
	if (typeof record.subject !== "string" || !record.subject.trim()) {
		throw new Error("subject must be a non-empty neutral topic");
	}
	const subject = record.subject.trim();
	if (subject.length > MAX_PERSONAL_MEMORY_SUBJECT_LENGTH) {
		throw new Error("subject is too long");
	}
	if (typeof record.logicalKey !== "string" || !record.logicalKey.trim()) {
		throw new Error("logicalKey must be a non-empty stable semantic subject");
	}
	const logicalKey = record.logicalKey.trim();
	if (logicalKey.length > MAX_PERSONAL_MEMORY_LOGICAL_KEY_LENGTH) {
		throw new Error("logicalKey is too long");
	}
	if (record.action === "delete") {
		if (Object.keys(record).some(key => !["action", "subject", "logicalKey"].includes(key))) {
			throw new Error("delete accepts only action, subject, and logicalKey");
		}
		return { action: "delete", subject, logicalKey };
	}
	if (Object.keys(record).some(key => !["action", "subject", "logicalKey", "facts"].includes(key))) {
		throw new Error("set accepts only action, subject, logicalKey, and facts");
	}
	if (!Array.isArray(record.facts) || record.facts.length === 0 || record.facts.length > MAX_PERSONAL_MEMORY_FACTS) {
		throw new Error("facts must be a non-empty bounded array");
	}
	const facts = record.facts.map((fact, index) => {
		if (typeof fact !== "string" || !fact.trim()) throw new Error(`facts[${index}] must be non-empty`);
		if (fact.length > MAX_PERSONAL_MEMORY_FACT_LENGTH) throw new Error(`facts[${index}] is too long`);
		return fact.trim();
	});
	return { action: "set", subject, logicalKey, facts };
}

function parsePersonalMemoryResult(value: unknown): PersonalMemoryResult {
	const data = asRecord(value);
	if (
		!data
		|| data.status !== "applied"
		|| data.scope !== "personal"
		|| !["created", "updated", "unchanged", "deleted"].includes(String(data.action))
		|| typeof data.logicalKey !== "string"
		|| typeof data.resourceId !== "string"
		|| !Number.isInteger(data.version)
		|| Number(data.version) < 1
		|| (data.projection !== "completed" && data.projection !== "queued")
	) {
		throw new Error("backend returned an invalid personal-memory receipt");
	}
	return data as unknown as PersonalMemoryResult;
}

function formatSuccess(result: PersonalMemoryResult): string {
	const state = result.action === "unchanged"
		? "already matched durable personal memory"
		: `was ${result.action} in durable personal memory`;
	return [
		`The requested personal memory ${state}.`,
		`Canonical subject: ${result.logicalKey}`,
		`Version: ${result.version}`,
		result.projection === "queued"
			? "The canonical write is complete; semantic recall projection is queued."
			: "The canonical write and semantic recall projection are complete.",
		"You may now truthfully acknowledge the personal memory result. Do not describe it as department or company memory.",
	].join("\n");
}

function failure(message: string, details: Record<string, unknown>) {
	return {
		content: [{ type: "text" as const, text: `Personal memory was not verified: ${message}` }],
		details,
	};
}

export async function executePersonalMemory(
	params: unknown,
	dependencies: PersonalMemoryDependencies = DEFAULT_DEPENDENCIES,
	actionId = "personal-memory",
) {
	let command: PersonalMemoryCommand;
	try {
		command = validatePersonalMemoryCommand(params);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return failure(message, { outcome: "invalid_request", error: message });
	}
	const config = dependencies.resolveConfig();
	if ("error" in config) return failure(config.error, { outcome: "unconfigured", error: config.error });

	try {
		const correlation = await dependencies.readRunCorrelation();
		const execution: GatewayExecutionContext = {
			version: 1,
			threadId: correlation.threadId,
			runId: correlation.runId,
			actionId,
		};
		const response = await dependencies.callGateway(config, {
			op: "memory.personal.mutate",
			execution,
			payload: command,
		});
		if (!response.body.ok || response.body.status !== "success") {
			const message = response.body.error?.message ?? response.body.status;
			return failure(message, {
				outcome: "gateway_error",
				httpStatus: response.httpStatus,
				status: response.body.status,
				error: response.body.error,
			});
		}
		const result = parsePersonalMemoryResult(response.body.data);
		return {
			content: [{ type: "text" as const, text: formatSuccess(result) }],
			details: { outcome: "success", httpStatus: response.httpStatus, ...result },
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return failure(message, { outcome: "error", error: message });
	}
}

export function registerPersonalMemoryTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: "divo_memory",
		label: "Remember personal preference",
		description: "Synchronously set, correct, or delete the authenticated user's own durable personal memory. Shared department/company knowledge always uses review instead.",
		promptSnippet: "When the user explicitly asks you to remember, save, correct, or forget a personal preference or personal fact, use divo_memory and report success only from its verified result.",
		promptGuidelines: [
			"This tool is personal-only. It cannot select a user, department, company, or scope; the backend derives the owner from the authenticated session.",
			"Use set for a new fact or correction. subject is a short neutral topic, not the desired value; the backend uses it to resolve existing memory safely. logicalKey is a stable dotted proposal only—the backend owns the final identity. facts is the complete replacement state for that subject.",
			"Use delete only when the user explicitly asks to forget an existing personal subject.",
			"Do not call this merely because a personal detail appears in conversation without a save/correct/forget request; implicit learning is separate.",
			"Never use this for team, department, company, policy, procedure, uploaded-file, or other shared knowledge. Use divo_memory_review for shared memory.",
			"Claim remembered, updated, or deleted only when this tool returns outcome success. On any error, do not imply persistence.",
			"Do not expose logical keys, resource IDs, versions, projections, gateway details, or internal architecture in the user-facing answer.",
		],
		parameters: PERSONAL_MEMORY_PARAMS,
		async execute(toolCallId, params) {
			return executePersonalMemory(params, DEFAULT_DEPENDENCIES, toolCallId);
		},
	});
}
