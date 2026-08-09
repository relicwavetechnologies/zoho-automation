import type { WorkBootstrap } from "./work-bootstrap.ts";
import { buildTypedTools, typedToolName as typedToolNameFor, type TypedToolDefinition } from "./typed-tools.ts";
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
 * Fetches the contract for each reachable tool.
 *
 * The run context already names every tool the member can reach
 * (`capabilityBootstrap.availableTools`), but carries no schema. The gateway
 * only returns a contract for an exact `toolId`, so this asks once per tool and
 * in parallel — one round trip of latency for the whole set.
 *
 * Folding these contracts into the runtime-context response would remove even
 * that round trip. It needs the tool registry wired into the desktop route, so
 * it stays an optimization to make once the cost has been measured.
 */
export async function fetchTypedToolContracts(
	toolIds: string[],
	toolCallId: string,
): Promise<{ tools: WorkBootstrap["tools"]; failed: Array<{ toolId: string; reason: string }> }> {
	const resolved = resolveDivoGatewayConfig();
	if ("error" in resolved) {
		return { tools: [], failed: toolIds.map((toolId) => ({ toolId, reason: resolved.error })) };
	}
	const correlation = await readDivoRunCorrelation();

	type ContractFetch =
		| { tool: WorkBootstrap["tools"][number] }
		| { toolId: string; reason: string };

	const settled: ContractFetch[] = await Promise.all(toolIds.map(async (toolId): Promise<ContractFetch> => {
		try {
			const { body } = await executeGatewayRequest(
				resolved,
				{
					op: "tools.list",
					...(correlation.departmentId ? { departmentId: correlation.departmentId } : {}),
					payload: { toolId },
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
				return { toolId, reason: body.error?.message ?? body.status };
			}
			const data = body.data as { tools?: unknown } | undefined;
			const entry = Array.isArray(data?.tools) ? data.tools[0] as Record<string, unknown> : undefined;
			if (!entry || typeof entry.argsSchema !== "object" || entry.argsSchema === null) {
				return { toolId, reason: "response carried no args schema" };
			}
			return {
				tool: {
					id: String(entry.id ?? toolId),
					family: String(entry.family ?? "unknown"),
					description: String(entry.description ?? ""),
					parameterDocs: String(entry.parameterDocs ?? ""),
					allowedActions: Array.isArray(entry.allowedActions)
						? entry.allowedActions.filter((action): action is string => typeof action === "string")
						: [],
					argsSchema: entry.argsSchema,
				} satisfies WorkBootstrap["tools"][number],
			};
		} catch (error) {
			return { toolId, reason: error instanceof Error ? error.message : String(error) };
		}
	}));

	return {
		tools: settled.flatMap((entry) => ("tool" in entry ? [entry.tool] : [])),
		failed: settled.flatMap((entry) => ("tool" in entry ? [] : [entry])),
	};
}

/**
 * Registers typed tools for every reachable tool before the agent starts.
 *
 * Work resolution is deliberately not called on most runs, so registering only
 * from its bootstrap would leave an ordinary request with no governed tools at
 * all. This makes the typed surface present from the first turn.
 *
 * A failure here is reported and swallowed: an incomplete typed surface is
 * recoverable, a run that cannot start is not.
 */
export async function registerEagerTypedTools(
	host: TypedToolHost,
	toolIds: string[],
	invoke: TypedToolInvoker,
	registry: Set<string>,
	fetchContracts: typeof fetchTypedToolContracts = fetchTypedToolContracts,
): Promise<TypedToolRegistrationResult & { failed: Array<{ toolId: string; reason: string }> }> {
	const pending = toolIds.filter((toolId) => !registry.has(typedToolNameFor(toolId)));
	if (pending.length === 0) {
		return { registered: [], skipped: [], rejected: [], failed: [] };
	}
	const { tools, failed } = await fetchContracts(pending, "typed-tools-eager");
	const result = registerTypedTools(
		host,
		{
			version: 1,
			scope: "run",
			registryRevision: 0,
			tools,
			nativeContracts: [],
			connections: [],
			advisories: [],
		},
		invoke,
		registry,
	);
	return { ...result, failed };
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
