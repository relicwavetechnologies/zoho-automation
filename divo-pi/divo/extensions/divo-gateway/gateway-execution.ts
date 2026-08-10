import {
	approvePreparedDivoIntent,
	type ApprovalContext,
} from "./approval-gate.ts";
import {
	callDivoGateway,
	type DivoGatewayConfig,
	type GatewayRequestBody,
	type GatewayResponseBody,
} from "./gateway-client.ts";

export interface GatewayExecutionDependencies {
	callGateway: typeof callDivoGateway;
	approveIntent?: typeof approvePreparedDivoIntent;
}

const DEFAULT_DEPENDENCIES: GatewayExecutionDependencies = {
	callGateway: callDivoGateway,
	approveIntent: approvePreparedDivoIntent,
};

export interface GatewayExecutionContext extends ApprovalContext {
	runtimeChannel?: "lark";
	resultMode?: "local-file";
}

/**
 * Execute one model-requested gateway operation. Desktop writes use the
 * backend-bound prepared-intent confirmation protocol. Lark skips that local
 * UI step because backend RBAC and HITL are the sole authority for cloud runs.
 */
export async function executeGatewayRequest(
	config: DivoGatewayConfig,
	request: GatewayRequestBody,
	toolCallId: string,
	ctx: GatewayExecutionContext,
	dependencies: GatewayExecutionDependencies = DEFAULT_DEPENDENCIES,
): Promise<{ body: GatewayResponseBody; httpStatus: number }> {
	if (ctx.signal?.aborted) throw new DOMException("The Divo action was cancelled.", "AbortError");
	let result = await dependencies.callGateway(config, request, fetch, {
		signal: ctx.signal,
		...(ctx.resultMode ? { resultMode: ctx.resultMode } : {}),
	});
	if (result.body.status !== "local_approval_required" || ctx.runtimeChannel === "lark") {
		return result;
	}
	if (request.op !== "tools.invoke") {
		throw new Error(
			"The backend requested local approval for an unsupported gateway operation.",
		);
	}

	const intentId = await (dependencies.approveIntent ?? approvePreparedDivoIntent)(
		toolCallId,
		result.body.data,
		ctx,
	);
	if (ctx.signal?.aborted) throw new DOMException("The Divo action was cancelled.", "AbortError");
	result = await dependencies.callGateway(config, {
		op: "tools.commit",
		departmentId: request.departmentId,
		payload: { intentId },
		...(request.execution ? { execution: request.execution } : {}),
	}, fetch, { signal: ctx.signal });
	return result;
}
