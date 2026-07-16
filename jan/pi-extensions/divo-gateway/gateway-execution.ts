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
	approveIntent: typeof approvePreparedDivoIntent;
}

const DEFAULT_DEPENDENCIES: GatewayExecutionDependencies = {
	callGateway: callDivoGateway,
	approveIntent: approvePreparedDivoIntent,
};

/**
 * Execute one model-requested gateway operation. Read operations complete in
 * the first request. A write response carries a backend-bound approval intent;
 * after local confirmation only that opaque intent is committed.
 */
export async function executeGatewayRequest(
	config: DivoGatewayConfig,
	request: GatewayRequestBody,
	toolCallId: string,
	ctx: ApprovalContext,
	dependencies: GatewayExecutionDependencies = DEFAULT_DEPENDENCIES,
): Promise<{ body: GatewayResponseBody; httpStatus: number }> {
	let result = await dependencies.callGateway(config, request);
	if (result.body.status !== "local_approval_required") return result;

	if (request.op !== "tools.invoke") {
		throw new Error(
			"The backend requested local approval for an unsupported gateway operation.",
		);
	}

	const intentId = await dependencies.approveIntent(
		toolCallId,
		result.body.data,
		ctx,
	);
	result = await dependencies.callGateway(config, {
		op: "tools.commit",
		departmentId: request.departmentId,
		payload: { intentId },
	});
	return result;
}
