function record(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value
		: undefined;
}

/**
 * `divo-local call`, `describe`, and legacy `invoke` are programming
 * interfaces, so they expose the native operation result directly instead of
 * making generated Python understand the gateway executor's internal
 * `{ toolId, action, result }` envelope.
 *
 * Discovery through `divo-local request` remains raw for diagnostics and
 * backwards compatibility.
 */
export function normalizeLocalInvokeResponse(response) {
	const envelope = record(response);
	if (!envelope || envelope.ok !== true || envelope.status !== "success") return response;

	const gatewayData = record(envelope.data);
	if (!gatewayData || !Object.hasOwn(gatewayData, "result")) return response;
	const executionResult = record(gatewayData.result);

	if (executionResult?.success === false) {
		const executionData = record(executionResult.data);
		return {
			...envelope,
			ok: false,
			status: "tool_error",
			data: executionResult.data,
			error: {
				code: "tool_error",
				message: typeof executionResult.message === "string" && executionResult.message.trim()
					? executionResult.message
					: typeof executionData?.code === "string"
						? executionData.code
						: "The governed tool did not complete.",
			},
			meta: invocationMeta(gatewayData, executionResult),
		};
	}

	const data = executionResult?.success === true && Object.hasOwn(executionResult, "data")
		? executionResult.data
		: gatewayData.result;
	return {
		...envelope,
		data,
		meta: invocationMeta(gatewayData, executionResult),
	};
}

function invocationMeta(gatewayData, executionResult) {
	return {
		...(typeof gatewayData.toolId === "string" ? { toolId: gatewayData.toolId } : {}),
		...(typeof gatewayData.action === "string" ? { action: gatewayData.action } : {}),
		...(typeof executionResult?.nativeTool === "string"
			? { nativeTool: executionResult.nativeTool }
			: {}),
		...(typeof executionResult?.message === "string"
			? { message: executionResult.message }
			: {}),
	};
}
