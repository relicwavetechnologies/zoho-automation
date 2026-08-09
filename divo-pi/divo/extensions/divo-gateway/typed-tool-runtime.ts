import type { WorkBootstrap } from "./work-bootstrap.ts";
import { buildTypedTools, type TypedToolDefinition } from "./typed-tools.ts";
import {
	formatGatewayResponse,
	isGatewayApprovalStatus,
	resolveDivoGatewayConfig,
} from "./gateway-client.ts";
import { executeGatewayRequest } from "./gateway-execution.ts";
import { readDivoRunCorrelation } from "./run-correlation.ts";

/**
 * Turns typed tool definitions into live Pi tools.
 *
 * Registration happens at the moment the run bootstrap arrives — the same
 * moment `formatWorkBootstrap` currently stringifies these schemas into the
 * prompt. Same tools, same timing, same payload; the difference is that Pi can
 * now validate a call against the contract instead of asking the model to copy
 * it out of prose.
 *
 * Pi validates. The backend still authorizes: a tool the member may not use is
 * registered anyway, described as denied, and its call still goes to the
 * gateway so the backend returns its own permission decision. Nothing here
 * grants or refuses access.
 */

/** Mirrors Pi's `AgentToolResult`, where `details` is required so the desktop always has a structured row to render. */
export interface TypedToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: unknown;
	isError?: boolean;
}

/** Executes one governed call. Supplied by the extension so the gateway keeps its single execute, approval, and audit path. */
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
		execute(
			toolCallId: string,
			params: Record<string, unknown>,
			signal: AbortSignal | undefined,
			onUpdate: unknown,
			ctx: unknown,
		): Promise<TypedToolResult>;
	}): void;
}

export interface TypedToolRegistrationResult {
	registered: string[];
	/** Already live from an earlier bootstrap in the same session. */
	skipped: string[];
	rejected: Array<{ toolId: string; reason: string }>;
}

function promptSnippetFor(tool: TypedToolDefinition): string {
	return tool.denied
		? `${tool.name} is not permitted for you; report the permission decision instead of routing around it.`
		: `Use ${tool.name} for governed ${tool.family} work (${tool.allowedActions.join(", ")}).`;
}

/**
 * Registers every typed tool the bootstrap describes.
 *
 * A run may resolve work more than once, and Pi keys tools by name, so
 * re-registering would silently replace a live tool mid-run. Names already
 * registered in this session are skipped instead.
 */
export function registerTypedTools(
	host: TypedToolHost,
	bootstrap: WorkBootstrap,
	invoke: TypedToolInvoker,
	registry: Set<string>,
): TypedToolRegistrationResult {
	const { tools, rejected } = buildTypedTools(bootstrap);
	const registered: string[] = [];
	const skipped: string[] = [];

	for (const tool of tools) {
		if (registry.has(tool.name)) {
			skipped.push(tool.name);
			continue;
		}
		registry.add(tool.name);
		registered.push(tool.name);
		host.registerTool({
			name: tool.name,
			label: tool.label,
			description: tool.description,
			promptSnippet: promptSnippetFor(tool),
			promptGuidelines: tool.promptGuidelines,
			parameters: tool.parameters,
			execute: (toolCallId, params, _signal, _onUpdate, ctx) =>
				invoke({ toolId: tool.toolId, args: params, toolCallId }, ctx),
		});
	}

	return { registered, skipped, rejected };
}

/**
 * The production invoker: one governed `tools.invoke` through the same client,
 * approval handling, and trace path `divo_gateway` already uses.
 *
 * Arguments arrive already validated against the backend's own schema, so the
 * envelope-repair step the mega-tool needs has nothing left to repair.
 */
export function createGatewayTypedToolInvoker(): TypedToolInvoker {
	return async ({ toolId, args, toolCallId }, ctx) => {
		const correlation = await readDivoRunCorrelation();
		const resolved = resolveDivoGatewayConfig();
		if ("error" in resolved) {
			throw new Error(resolved.error);
		}

		const { body, httpStatus } = await executeGatewayRequest(
			resolved,
			{
				op: "tools.invoke",
				...(correlation.departmentId ? { departmentId: correlation.departmentId } : {}),
				payload: { toolId, args },
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
			typedTool: toolId,
		};

		// A held approval is not a failed action. Keeping the structured details
		// on an errored result is what lets the desktop render its status in this
		// exact trace row without a second local approval path.
		if (isGatewayApprovalStatus(body.status)) {
			return { content: [{ type: "text", text: formatted.text }], details, isError: true };
		}
		if (formatted.isError) {
			throw new Error(formatted.text);
		}
		return { content: [{ type: "text", text: formatted.text }], details };
	};
}
