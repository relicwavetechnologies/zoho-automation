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
import type { DivoRuntimeChannel } from "./run-correlation.ts";

export interface GatewayExecutionDependencies {
	callGateway: typeof callDivoGateway;
	approveIntent?: typeof approvePreparedDivoIntent;
}

const DEFAULT_DEPENDENCIES: GatewayExecutionDependencies = {
	callGateway: callDivoGateway,
	approveIntent: approvePreparedDivoIntent,
};

export interface GatewayExecutionContext extends ApprovalContext {
	runtimeChannel?: DivoRuntimeChannel;
	resultMode?: "local-file";
}

/**
 * Execute one model-requested gateway operation. An installed Desktop client
 * renders requester confirmation locally. Backend-driven channels return the
 * same durable action to their own adapter; they must never open Desktop UI.
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
	const requesterConfirmation = result.body.status === "requester_confirmation_required"
		|| result.body.status === "local_approval_required";
	if (!requesterConfirmation || ctx.runtimeChannel) {
		return result;
	}
	if (request.op !== "tools.invoke") {
		throw new Error(
			"The backend requested requester confirmation for an unsupported gateway operation.",
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
