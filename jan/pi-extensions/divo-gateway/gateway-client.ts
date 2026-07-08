import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

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

const MAX_INLINE_IMAGE_BYTES = 1_250_000;

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
	".gif": "image/gif",
	".jpeg": "image/jpeg",
	".jpg": "image/jpeg",
	".png": "image/png",
	".webp": "image/webp",
};

const SUPPORTED_IMAGE_OCR_MIME_TYPES = new Set(Object.values(IMAGE_MIME_BY_EXTENSION));

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

	if (body.status === "unauthorized") {
		const message =
			body.error?.message ??
			"Your desktop session is invalid or expired.";
		return {
			text: `Divo gateway: unauthorized.\n\n${message}\n\nAsk the user to sign in again through Jan/Desktop. Do not retry with guessed credentials.`,
			isError: true,
		};
	}

	if (
		body.status === "bad_request" ||
		body.status === "unknown_op" ||
		body.status === "unknown_tool" ||
		body.status === "invalid_args"
	) {
		const code = body.error?.code ?? body.status;
		const message =
			body.error?.message ??
			"The gateway rejected the request shape or target.";
		return {
			text: `Divo gateway: request rejected (${code}).\n\n${message}\n\nCheck the request against skills.search, skills.get, tools.list, or the returned skill recipe before retrying.`,
			isError: true,
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

	if (body.status === "approval_misconfigured") {
		const message =
			body.error?.message ??
			"Manager approval is required, but the approver configuration is incomplete.";
		return {
			text: `Divo gateway: approval misconfigured.\n\n${message}\n\nDo not claim the action completed. Ask the user to contact an admin.`,
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
	const preparedRequest = await prepareDivoGatewayRequest(request);
	const departmentId = request.departmentId ?? config.defaultDepartmentId;
	const payload: GatewayRequestBody = {
		op: preparedRequest.op,
		payload: preparedRequest.payload,
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

export async function prepareDivoGatewayRequest(
	request: GatewayRequestBody,
): Promise<GatewayRequestBody> {
	if (request.op !== "media.image_ocr") return request;

	const payload = asRecord(request.payload);
	if (!payload) {
		throw new Error(
			"media.image_ocr requires payload { filePath, mimeType?, fileName? } or { imageBase64, mimeType, fileName? }",
		);
	}

	if (typeof payload.imageBase64 === "string" && typeof payload.mimeType === "string") {
		assertSupportedImageOcrMimeType(payload.mimeType);
		return request;
	}

	const filePath = getString(payload.filePath) ?? getString(payload.path);
	if (!filePath) {
		throw new Error(
			"media.image_ocr requires a local filePath for attached images when imageBase64 is not provided",
		);
	}

	const bytes = await readFile(filePath);
	if (bytes.byteLength > MAX_INLINE_IMAGE_BYTES) {
		throw new Error(
			`media.image_ocr image is too large (${bytes.byteLength} bytes; max ${MAX_INLINE_IMAGE_BYTES})`,
		);
	}

	const mimeType = getString(payload.mimeType) ?? inferImageMimeType(filePath);
	if (!mimeType) {
		throw new Error(
			"media.image_ocr supports PNG, JPEG, WebP, or GIF. Could not infer MIME type; convert the image to PNG first or pass mimeType such as image/png or image/jpeg.",
		);
	}
	assertSupportedImageOcrMimeType(mimeType);

	return {
		...request,
		payload: {
			imageBase64: Buffer.from(bytes).toString("base64"),
			mimeType,
			fileName: getString(payload.fileName) ?? basename(filePath),
		},
	};
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

function getString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function inferImageMimeType(filePath: string): string | undefined {
	return IMAGE_MIME_BY_EXTENSION[extname(filePath).toLowerCase()];
}

function assertSupportedImageOcrMimeType(mimeType: string): void {
	if (SUPPORTED_IMAGE_OCR_MIME_TYPES.has(mimeType.toLowerCase())) return;
	throw new Error(
		`media.image_ocr supports PNG, JPEG, WebP, or GIF only. Convert this image to PNG first, then call media.image_ocr with mimeType image/png. Received ${mimeType}.`,
	);
}
