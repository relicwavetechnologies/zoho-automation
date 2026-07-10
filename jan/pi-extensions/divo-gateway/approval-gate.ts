import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import {
	callDivoGateway,
	resolveDivoGatewayConfig,
	type DivoGatewayConfig,
	type GatewayResponseBody,
} from "./gateway-client.ts";

export const DIVO_APPROVAL_PROTOCOL_TITLE = "divo_approval_v1";

type JsonRecord = Record<string, unknown>;

export interface ApprovalPresentationV1 {
	version: 1;
	toolCallId: string;
	source: "divo" | "bash" | "edit" | "write";
	kind: string;
	action: string;
	title: string;
	intentId?: string;
	presentation: unknown;
	expiresAt?: string;
}

type ApprovalContext = Pick<ExtensionContext, "cwd" | "signal"> & {
	ui: Pick<ExtensionContext["ui"], "confirm">;
};

export interface ApprovalGateDependencies {
	resolveConfig: () => DivoGatewayConfig | { error: string };
	callGateway: (
		config: DivoGatewayConfig,
		request: {
			op: string;
			departmentId?: string;
			payload?: unknown;
		},
	) => Promise<{ body: GatewayResponseBody; httpStatus: number }>;
}

const DEFAULT_DEPENDENCIES: ApprovalGateDependencies = {
	resolveConfig: resolveDivoGatewayConfig,
	callGateway: callDivoGateway,
};

function asRecord(value: unknown): JsonRecord | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as JsonRecord)
		: undefined;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function approvalBlock(reason: string): ToolCallEventResult {
	return { block: true, reason };
}

async function askForApproval(
	ctx: ApprovalContext,
	request: ApprovalPresentationV1,
): Promise<ToolCallEventResult | undefined> {
	let confirmed = false;
	try {
		confirmed = await ctx.ui.confirm(
			DIVO_APPROVAL_PROTOCOL_TITLE,
			JSON.stringify(request),
			ctx.signal ? { signal: ctx.signal } : undefined,
		);
	} catch {
		return approvalBlock("Approval UI failed; the action was not executed.");
	}

	return confirmed
		? undefined
		: approvalBlock("The user did not approve this action.");
}

function localApprovalRequest(
	event: ToolCallEvent,
	ctx: ApprovalContext,
): ApprovalPresentationV1 | undefined {
	const input = event.input as JsonRecord;
	if (event.toolName === "bash") {
		return {
			version: 1,
			toolCallId: event.toolCallId,
			source: "bash",
			kind: "bash.execute",
			action: "execute",
			title: "Run terminal command",
			presentation: {
				kind: "bash.execute",
				command: input.command,
				cwd: ctx.cwd,
				...(input.timeout === undefined ? {} : { timeout: input.timeout }),
			},
		};
	}
	if (event.toolName === "edit") {
		return {
			version: 1,
			toolCallId: event.toolCallId,
			source: "edit",
			kind: "file.edit",
			action: "update",
			title: "Edit local file",
			presentation: {
				kind: "file.edit",
				cwd: ctx.cwd,
				path: input.path,
				edits: input.edits,
			},
		};
	}
	if (event.toolName === "write") {
		return {
			version: 1,
			toolCallId: event.toolCallId,
			source: "write",
			kind: "file.write",
			action: "write",
			title: "Write local file",
			presentation: {
				kind: "file.write",
				cwd: ctx.cwd,
				path: input.path,
				content: input.content,
			},
		};
	}
	return undefined;
}

async function gateDivoInvocation(
	event: ToolCallEvent,
	ctx: ApprovalContext,
	dependencies: ApprovalGateDependencies,
): Promise<ToolCallEventResult | undefined> {
	const input = event.input as JsonRecord;
	const op = nonEmptyString(input.op);
	if (op === "tools.commit") {
		return approvalBlock(
			"Direct tools.commit calls are not allowed; a prepared action must be approved first.",
		);
	}
	if (op !== "tools.invoke") return undefined;

	const payload = asRecord(input.payload);
	const toolId = nonEmptyString(payload?.toolId);
	if (!payload || !toolId || !("args" in payload)) {
		return approvalBlock(
			"The Divo tool request was malformed and could not be safely prepared.",
		);
	}

	const resolved = dependencies.resolveConfig();
	if ("error" in resolved) {
		return approvalBlock(resolved.error);
	}

	let body: GatewayResponseBody;
	try {
		({ body } = await dependencies.callGateway(resolved, {
			op: "tools.prepare",
			...(nonEmptyString(input.departmentId)
				? { departmentId: nonEmptyString(input.departmentId) }
				: {}),
			payload: { toolId, args: payload.args },
		}));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return approvalBlock(
			`The action could not be prepared safely: ${message}`,
		);
	}

	if (!body.ok || body.status !== "success") {
		return approvalBlock(
			body.error?.message ??
				`The action could not be prepared safely (${body.status}).`,
		);
	}

	const data = asRecord(body.data);
	if (!data || typeof data.requiresApproval !== "boolean") {
		return approvalBlock(
			"The backend returned an invalid approval classification; the action was not executed.",
		);
	}
	if (!data.requiresApproval) return undefined;

	const intentId = nonEmptyString(data.intentId);
	if (!intentId || !("presentation" in data)) {
		return approvalBlock(
			"The backend did not return a complete approval intent; the action was not executed.",
		);
	}

	const presentationRecord = asRecord(data.presentation);
	const request: ApprovalPresentationV1 = {
		version: 1,
		toolCallId: event.toolCallId,
		source: "divo",
		kind:
			nonEmptyString(data.kind) ??
			nonEmptyString(presentationRecord?.kind) ??
			"divo.write",
		action:
			nonEmptyString(data.action) ??
			nonEmptyString(presentationRecord?.action) ??
			"write",
		title:
			nonEmptyString(data.title) ??
			nonEmptyString(presentationRecord?.title) ??
			"Review action",
		intentId,
		presentation: data.presentation,
		...(nonEmptyString(data.expiresAt)
			? { expiresAt: nonEmptyString(data.expiresAt) }
			: {}),
	};

	const blocked = await askForApproval(ctx, request);
	if (blocked) return blocked;

	// Mutating the intercepted call is supported by Pi's tool_call contract. The
	// backend binds intentId to the already validated args, user, and department.
	const departmentId = nonEmptyString(input.departmentId);
	for (const key of Object.keys(input)) delete input[key];
	input.op = "tools.commit";
	if (departmentId) input.departmentId = departmentId;
	input.payload = { intentId };
	return undefined;
}

export async function handleApprovalToolCall(
	event: ToolCallEvent,
	ctx: ApprovalContext,
	dependencies: ApprovalGateDependencies = DEFAULT_DEPENDENCIES,
): Promise<ToolCallEventResult | undefined> {
	const local = localApprovalRequest(event, ctx);
	if (local) return askForApproval(ctx, local);

	if (event.toolName === "divo_gateway") {
		return gateDivoInvocation(event, ctx, dependencies);
	}
	return undefined;
}

export function registerApprovalGate(pi: ExtensionAPI): void {
	pi.on("tool_call", (event, ctx) => handleApprovalToolCall(event, ctx));
}
