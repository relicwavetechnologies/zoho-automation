import {
	callDivoGateway,
	type DivoGatewayConfig,
	type GatewayRequestBody,
	type GatewayResponseBody,
} from "./gateway-client.ts";

export interface GatewayExecutionDependencies {
	callGateway: typeof callDivoGateway;
}

const DEFAULT_DEPENDENCIES: GatewayExecutionDependencies = {
	callGateway: callDivoGateway,
};

/**
 * Execute one cloud model-requested gateway operation. Lark never opens the
 * desktop-local confirmation protocol; backend RBAC and HITL remain authoritative.
 */
export async function executeGatewayRequest(
	config: DivoGatewayConfig,
	request: GatewayRequestBody,
	_toolCallId: string,
	ctx: { signal?: AbortSignal },
	dependencies: GatewayExecutionDependencies = DEFAULT_DEPENDENCIES,
): Promise<{ body: GatewayResponseBody; httpStatus: number }> {
	if (ctx.signal?.aborted) throw new DOMException("The Divo action was cancelled.", "AbortError");
	return dependencies.callGateway(config, request, fetch, { signal: ctx.signal });
}
