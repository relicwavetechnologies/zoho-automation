import type { WorkBootstrap } from "./work-bootstrap.ts";
import {
	formatGatewayResponse,
	isGatewayApprovalStatus,
	resolveDivoGatewayConfig,
} from "./gateway-client.ts";
import { executeGatewayRequest } from "./gateway-execution.ts";
import { readDivoRunCorrelation } from "./run-correlation.ts";
import { parseWorkBootstrap } from "./work-bootstrap.ts";

/** Mirrors Pi's AgentToolResult while keeping structured details for renderers. */
export interface TypedToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: unknown;
	isError?: boolean;
}

/** Executes one backend-governed business-tool call. */
export type TypedToolInvoker = (
	input: { toolId: string; args: Record<string, unknown>; toolCallId: string },
	ctx: unknown,
) => Promise<TypedToolResult>;

export interface TypedToolHost {
	registerTool(definition: {
		name: string;
		label: string;
		description: string;
		promptSnippet?: string;
		promptGuidelines?: string[];
		parameters: Record<string, unknown>;
		executionMode?: "parallel" | "sequential";
		execute(
			toolCallId: string,
			params: Record<string, unknown>,
			signal: AbortSignal | undefined,
			onUpdate: unknown,
			ctx: unknown,
		): Promise<TypedToolResult>;
	}): void;
}

/** Backend `tools.list` accepts at most 2,000 characters of prompt context. */
const NATIVE_CONTRACT_QUERY_MAX_CHARS = 2_000;

/**
 * Keep contract discovery useful without letting an ordinary long user prompt
 * invalidate the entire provider-schema bootstrap request.
 */
export function nativeContractQuery(query: string): string | undefined {
	const bounded = query.trim().slice(0, NATIVE_CONTRACT_QUERY_MAX_CHARS);
	return bounded.length >= 3 ? bounded : undefined;
}

export interface NativeContractBootstrapOptions {
	readonly contractMode?: "suggested" | "complete" | "complete_cached";
}

/** Speculative preload warms durable schemas but never blocks a turn on an external catalogue. */
export const SPECULATIVE_NATIVE_CONTRACT_MODE = "complete_cached" as const;

/**
 * Fetch prompt-relevant provider-native input schemas and run account context.
 *
 * Outer Pi tool definitions are compiled into the container and never come
 * from this response. Google Workspace and Airtable are backed by versioned
 * external MCP servers, so the exact nested input schema remains provider-owned
 * and is safely merged into the permanent Pi wrapper when available.
 */
export async function fetchNativeContractBootstrap(
	toolIds: string[],
	toolCallId: string,
	query: string,
	options: NativeContractBootstrapOptions = {},
): Promise<{ bootstrap?: WorkBootstrap; failed: Array<{ toolId: string; reason: string }> }> {
	const resolved = resolveDivoGatewayConfig();
	if ("error" in resolved) {
		return { failed: toolIds.map(toolId => ({ toolId, reason: resolved.error })) };
	}
	const correlation = await readDivoRunCorrelation();
	const boundedQuery = nativeContractQuery(query);
	try {
		const { body } = await executeGatewayRequest(
			resolved,
			{
				op: "tools.list",
				...(correlation.departmentId ? { departmentId: correlation.departmentId } : {}),
				payload: {
					toolIds,
					...(boundedQuery ? { query: boundedQuery } : {}),
					...(options.contractMode ? { contractMode: options.contractMode } : {}),
				},
				execution: {
					version: 1,
					threadId: correlation.threadId,
					runId: correlation.runId,
					actionId: toolCallId,
				},
			},
			toolCallId,
			{ ...(correlation.channel ? { runtimeChannel: correlation.channel } : {}) } as never,
		);
		if (!body.ok) {
			const reason = body.error?.message ?? body.status;
			return { failed: toolIds.map(toolId => ({ toolId, reason })) };
		}
		const bootstrap = parseWorkBootstrap((body.data as { bootstrap?: unknown } | undefined)?.bootstrap);
		if (!bootstrap) {
			return { failed: toolIds.map(toolId => ({ toolId, reason: "response carried no valid bootstrap" })) };
		}
		const returned = new Set(bootstrap.tools.map(tool => tool.id));
		return {
			bootstrap,
			failed: toolIds.filter(toolId => !returned.has(toolId)).map(toolId => ({
				toolId,
				reason: "response omitted this capability context",
			})),
		};
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return { failed: toolIds.map(toolId => ({ toolId, reason })) };
	}
}

/** One authenticated backend operation with shared trace and approval handling. */
export async function runGatewayOperation(
	op: string,
	payload: Record<string, unknown>,
	toolCallId: string,
	ctx: unknown,
	label: Record<string, unknown> = {},
): Promise<TypedToolResult> {
	const correlation = await readDivoRunCorrelation();
	const resolved = resolveDivoGatewayConfig();
	if ("error" in resolved) throw new Error(resolved.error);

	const { body, httpStatus } = await executeGatewayRequest(
		resolved,
		{
			op,
			...(correlation.departmentId ? { departmentId: correlation.departmentId } : {}),
			payload,
			execution: {
				version: 1,
				threadId: correlation.threadId,
				runId: correlation.runId,
				actionId: toolCallId,
			},
		},
		toolCallId,
		{
			...(ctx as Record<string, unknown>),
			...(correlation.channel ? { runtimeChannel: correlation.channel } : {}),
		} as never,
	);

	const formatted = formatGatewayResponse(body);
	const details = {
		configured: true,
		httpStatus,
		status: body.status,
		ok: body.ok,
		approval: body.approval,
		error: body.error,
		data: body.data,
		...label,
	};

	if (isGatewayApprovalStatus(body.status)) {
		return { content: [{ type: "text", text: formatted.text }], details, isError: true };
	}
	if (formatted.isError) throw new Error(formatted.text);
	return { content: [{ type: "text", text: formatted.text }], details };
}

export function createGatewayTypedToolInvoker(): TypedToolInvoker {
	return ({ toolId, args, toolCallId }, ctx) =>
		runGatewayOperation("tools.invoke", { toolId, args }, toolCallId, ctx, { nativeTool: toolId });
}

/** Platform operations that are not a governed business-tool invocation. */
export function createGatewayPlatformInvoker() {
	return ({ op, payload, toolCallId }: { op: string; payload: Record<string, unknown>; toolCallId: string }, ctx: unknown) =>
		runGatewayOperation(op, payload, toolCallId, ctx, { platformOp: op });
}
