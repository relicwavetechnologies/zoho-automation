import {
	approvePreparedDivoIntent,
	awaitConnectionAsk,
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
	awaitConnection?: typeof awaitConnectionAsk;
}

const DEFAULT_DEPENDENCIES: GatewayExecutionDependencies = {
	callGateway: callDivoGateway,
	approveIntent: approvePreparedDivoIntent,
	awaitConnection: awaitConnectionAsk,
};

/** The backend has sent a Connect ask and is holding this call open. */
const CONNECTION_PENDING_STATUS = "connection_pending";

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
	/*
	 * Checked before the runtime-channel guard below, and that ordering is the
	 * point of this whole flow.
	 *
	 * Requester confirmation is skipped on backend-driven channels because those
	 * channels render their own approval and the run is expected to end. A
	 * connect ask is the opposite: the card is already on its way to the member,
	 * and what the run must do is wait for it. Falling through to the guard here
	 * would end the run and put us back to rebuilding it afterwards.
	 */
	if (result.body.status === CONNECTION_PENDING_STATUS) {
		const outcome = await (dependencies.awaitConnection ?? awaitConnectionAsk)(
			result.body.data,
			ctx,
		);
		if (ctx.signal?.aborted) throw new DOMException("The Divo action was cancelled.", "AbortError");
		if (!outcome.granted) return result;
		return dependencies.callGateway(config, {
			op: "connections.resume",
			departmentId: request.departmentId,
			payload: { askId: outcome.askId },
			// Carried, not omitted. Under a Pi runtime lease the backend checks
			// every call's execution against the signed run and thread, so a
			// resume without it is refused as provenance that does not match —
			// after the member has already connected, which is the worst moment
			// to lose the run.
			...(request.execution ? { execution: request.execution } : {}),
		}, fetch, { signal: ctx.signal });
	}

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
