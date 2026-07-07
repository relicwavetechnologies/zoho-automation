export interface DivoGatewayConfig {
	backendUrl: string;
	memberToken: string;
	defaultDepartmentId?: string;
}

export interface GatewayRequestBody {
	op: string;
	departmentId?: string;
	payload?: unknown;
}

export interface GatewayErrorBody {
	code?: string;
	message?: string;
}

export interface GatewayApprovalBody {
	approvalId?: string;
	message?: string;
}

export interface GatewayResponseBody {
	ok: boolean;
	status: string;
	data?: unknown;
	error?: GatewayErrorBody;
	approval?: GatewayApprovalBody;
}

export function resolveDivoGatewayConfig(
	env: NodeJS.ProcessEnv = process.env,
): DivoGatewayConfig | { error: string } {
	const backendUrl = env.DIVO_BACKEND_URL?.trim().replace(/\/$/, "");
	const memberToken = env.DIVO_MEMBER_TOKEN?.trim();
	const defaultDepartmentId = env.DIVO_DEPARTMENT_ID?.trim() || undefined;

	if (!backendUrl) {
		return {
			error:
				"Divo gateway is not configured: DIVO_BACKEND_URL is missing. Sign in through Jan/Desktop first.",
		};
	}
	if (!memberToken) {
		return {
			error:
				"Divo gateway is not configured: DIVO_MEMBER_TOKEN is missing. Sign in through Jan/Desktop first.",
		};
	}

	return { backendUrl, memberToken, defaultDepartmentId };
}

export function formatGatewayResponse(body: GatewayResponseBody): {
	text: string;
	isError: boolean;
} {
	if (body.ok && body.status === "success") {
		const dataText =
			body.data === undefined
				? "(no data)"
				: typeof body.data === "string"
					? body.data
					: JSON.stringify(body.data, null, 2);
		return {
			text: `Divo gateway succeeded.\n\n${dataText}`,
			isError: false,
		};
	}

	if (body.status === "permission_denied") {
		const message =
			body.error?.message ??
			"You do not have permission to perform this action.";
		return {
			text: `Divo gateway: permission denied.\n\n${message}\n\nDo not retry or invent results. Ask the user to request access or choose a different action.`,
			isError: true,
		};
	}

	if (body.status === "approval_required") {
		const approvalId = body.approval?.approvalId ?? "unknown";
		const message =
			body.approval?.message ??
			"Manager approval is required before this action can run.";
		return {
			text: `Divo gateway: approval required.\n\nApproval ID: ${approvalId}\n${message}\n\nTell the user approval is pending in Lark. Do not claim the action completed.`,
			isError: true,
		};
	}

	if (body.status === "tool_error" || body.error) {
		const code = body.error?.code ?? body.status;
		const message = body.error?.message ?? "The backend tool returned an error.";
		return {
			text: `Divo gateway: tool error (${code}).\n\n${message}`,
			isError: true,
		};
	}

	return {
		text: `Divo gateway returned status "${body.status}".\n\n${JSON.stringify(body, null, 2)}`,
		isError: true,
	};
}

export async function callDivoGateway(
	config: DivoGatewayConfig,
	request: GatewayRequestBody,
	fetchImpl: typeof fetch = fetch,
): Promise<{ body: GatewayResponseBody; httpStatus: number }> {
	const departmentId = request.departmentId ?? config.defaultDepartmentId;
	const payload: GatewayRequestBody = {
		op: request.op,
		payload: request.payload,
	};
	if (departmentId) {
		payload.departmentId = departmentId;
	}

	const response = await fetchImpl(`${config.backendUrl}/api/gateway`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${config.memberToken}`,
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify(payload),
		signal: AbortSignal.timeout(120_000),
	});

	const raw = await response.text();
	let body: GatewayResponseBody;
	try {
		body = raw ? (JSON.parse(raw) as GatewayResponseBody) : { ok: false, status: "bad_request" };
	} catch {
		body = {
			ok: false,
			status: "tool_error",
			error: {
				code: "invalid_json",
				message: `Backend returned non-JSON (HTTP ${response.status}): ${raw.slice(0, 500)}`,
			},
		};
	}

	if (!response.ok && body.ok !== false) {
		body = {
			ok: false,
			status: response.status === 401 ? "unauthorized" : "tool_error",
			error: {
				code: String(response.status),
				message: body.error?.message ?? `HTTP ${response.status}`,
			},
		};
	}

	return { body, httpStatus: response.status };
}
