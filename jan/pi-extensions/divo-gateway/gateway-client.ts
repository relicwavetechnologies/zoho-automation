import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, extname } from "node:path";

export interface DivoGatewayConfig {
	backendUrl: string;
	memberToken: string;
	defaultDepartmentId?: string;
}

/**
 * Desktop run provenance attached by the extension, never model input. The
 * backend treats it as correlation/idempotency metadata only; member auth and
 * RBAC remain server-authoritative.
 */
export interface GatewayExecutionContext {
	version: 1;
	threadId: string;
	runId: string;
	actionId: string;
}

export interface GatewayRequestBody {
	op: string;
	departmentId?: string;
	payload?: unknown;
	execution?: GatewayExecutionContext;
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

export type GatewayApprovalStatus = "approval_required" | "approval_rejected";

/**
 * These are terminal, backend-owned HITL states. They are errors from the
 * agent's perspective because the requested action did not run, but unlike a
 * transport failure they carry durable approval metadata the desktop can show
 * in the owning tool trace.
 */
export function isGatewayApprovalStatus(status: string): status is GatewayApprovalStatus {
	return status === "approval_required" || status === "approval_rejected";
}

const MAX_INLINE_IMAGE_BYTES = 1_250_000;
// Registry responses are company policy, not a local source of truth. Keep a
// tiny read-through cache only to avoid repeated calls in one agent turn.
const SKILL_CACHE_TTL_MS = 2 * 60 * 1000;

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
	".gif": "image/gif",
	".jpeg": "image/jpeg",
	".jpg": "image/jpeg",
	".png": "image/png",
	".webp": "image/webp",
};

const SUPPORTED_IMAGE_OCR_MIME_TYPES = new Set(Object.values(IMAGE_MIME_BY_EXTENSION));

type CachedGatewayResponse = {
	body: GatewayResponseBody;
	httpStatus: number;
	expiresAt: number;
};

const skillResponseCache = new Map<string, CachedGatewayResponse>();

export function clearDivoGatewaySkillCache(): void {
	skillResponseCache.clear();
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
		const automationPlan = readAutomationPlan(body.data);
		if (automationPlan) {
			const lines = [
				`Automation batch: ${automationPlan.title ?? "Untitled batch"}`,
				`Status: ${automationPlan.status}`,
				...(automationPlan.planId ? [`Plan ID: ${automationPlan.planId}`] : []),
				...(automationPlan.invocationCount !== undefined ? [`Exact calls: ${automationPlan.invocationCount}`] : []),
			];
			if (automationPlan.status === "waiting_for_manager_approval") {
				lines.push("The exact batch is waiting in the department manager's Lark DM. Do not claim it ran and do not retry its individual writes. Check automation.plan.status later using this plan ID.");
			}
			if (automationPlan.status === "completed") {
				lines.push("The backend completed the manager-approved exact batch.");
			}
			if (automationPlan.status === "failed") {
				lines.push("The batch paused or failed. Inspect execution details before proposing any correction; changed or new actions require a new plan and approval.");
			}
			return { text: lines.join("\n"), isError: false };
		}
		const plan = readGooglePlan(body.data);
		if (plan) {
			const first = plan.phases[0];
			return {
				text: [
					"Google workflow plan succeeded.",
					"",
					"Parent execution guidance:",
					plan.parentInstructions,
					"",
					...plan.phases.map((phase, index) => `${index + 1}. ${phase.name} — skillId ${phase.skillId}`),
					"",
					plan.connectionMessage,
					"The first phase recipe is already loaded below. Do not call skills.get for it. Load each later exact skillId immediately before its phase.",
					...(first?.instructions ? ["", `First specialist recipe (${first.name}):`, first.instructions] : []),
				].join("\n"),
				isError: false,
			};
		}
		const dataText =
			body.data === undefined
				? "(no data)"
				: typeof body.data === "string"
					? body.data
					: JSON.stringify(body.data, null, 2);
		return {
			text: `Request succeeded.\n\n${dataText}`,
			isError: false,
		};
	}

	if (body.status === "unauthorized") {
		const message =
			body.error?.message ??
			"Your desktop session is invalid or expired.";
		return {
			text: `Request unauthorized.\n\n${message}\n\nAsk the user to sign in again through Jan/Desktop. Do not retry with guessed credentials.`,
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
			text: `Request rejected (${code}).\n\n${message}\n\nFor work routing, re-check the unified work.resolve result. For execution, inspect tools.list or the returned skill recipe before retrying.`,
			isError: true,
		};
	}

	if (body.status === "permission_denied") {
		const message =
			body.error?.message ??
			"You do not have permission to perform this action.";
		return {
			text: `Permission denied.\n\n${message}\n\nDo not retry or invent results. Ask the user to request access or choose a different action.`,
			isError: true,
		};
	}

	if (body.status === "approval_required") {
		const approvalId = body.approval?.approvalId ?? "unknown";
		const message =
			body.approval?.message ??
			"Manager approval is required before this action can run.";
		return {
			text: `Approval required.\n\nApproval ID: ${approvalId}\n${message}\n\nTell the user approval is pending in Lark. Do not claim the action completed. After the manager approves, retry the exact same divo_gateway tools.invoke request with the same departmentId, toolId, and args. Do not change or enrich the args; changed args require a fresh approval.`,
			isError: true,
		};
	}

	if (body.status === "approval_rejected") {
		const approvalId = body.approval?.approvalId ?? "unknown";
		const message =
			body.approval?.message ??
			body.error?.message ??
			"The manager rejected this action.";
		return {
			text: `Approval rejected.\n\nApproval ID: ${approvalId}\n${message}\n\nTell the user the manager rejected this exact action. Do not retry the same args; ask what they want to change before trying again.`,
			isError: true,
		};
	}

	if (body.status === "approval_misconfigured") {
		const message =
			body.error?.message ??
			"Manager approval is required, but the approver configuration is incomplete.";
		return {
			text: `Approval misconfigured.\n\n${message}\n\nDo not claim the action completed. Ask the user to contact an admin.`,
			isError: true,
		};
	}

	if (body.status === "tool_error" || body.error) {
		const code = body.error?.code ?? body.status;
		const message = body.error?.message ?? "The backend tool returned an error.";
		return {
			text: `Tool error (${code}).\n\n${message}`,
			isError: true,
		};
	}

	return {
		text: `Request returned status "${body.status}".\n\n${JSON.stringify(body, null, 2)}`,
		isError: true,
	};
}

function readAutomationPlan(value: unknown): {
	planId?: string;
	status: string;
	title?: string;
	invocationCount?: number;
} | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	const isPlanStatus = typeof record.status === "string" && (
		record.status.includes("approval")
		|| ["approved", "executing", "completed", "rejected", "failed", "expired"].includes(record.status)
	);
	if (!isPlanStatus) return null;
	return {
		status: record.status,
		...(typeof record.planId === "string" ? { planId: record.planId } : {}),
		...(typeof record.title === "string" ? { title: record.title } : {}),
		...(typeof record.invocationCount === "number" ? { invocationCount: record.invocationCount } : {}),
	};
}

export async function callDivoGateway(
	config: DivoGatewayConfig,
	request: GatewayRequestBody,
	fetchImpl: typeof fetch = fetch,
): Promise<{ body: GatewayResponseBody; httpStatus: number }> {
	const preparedRequest = await prepareDivoGatewayRequest(request);
	const departmentId = request.departmentId ?? config.defaultDepartmentId;
	const cacheKey = skillCacheKey(config, preparedRequest, departmentId);
	if (cacheKey) {
		const cached = readSkillResponseCache(cacheKey);
		if (cached) return cached;
	}

	const payload: GatewayRequestBody = {
		op: preparedRequest.op,
		payload: preparedRequest.payload,
	};
	if (departmentId) {
		payload.departmentId = departmentId;
	}
	if (request.execution) {
		payload.execution = request.execution;
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

	if (cacheKey && body.ok && body.status === "success") {
		writeSkillResponseCache(cacheKey, { body, httpStatus: response.status });
	}

	return { body, httpStatus: response.status };
}

function readSkillResponseCache(
	key: string,
	now = Date.now(),
): { body: GatewayResponseBody; httpStatus: number } | null {
	const cached = skillResponseCache.get(key);
	if (!cached) return null;
	if (cached.expiresAt <= now) {
		skillResponseCache.delete(key);
		return null;
	}
	return { body: cached.body, httpStatus: cached.httpStatus };
}

function writeSkillResponseCache(
	key: string,
	value: { body: GatewayResponseBody; httpStatus: number },
	now = Date.now(),
): void {
	skillResponseCache.set(key, {
		...value,
		expiresAt: now + SKILL_CACHE_TTL_MS,
	});
}

function skillCacheKey(
	config: DivoGatewayConfig,
	request: GatewayRequestBody,
	departmentId: string | undefined,
): string | null {
	if (request.op === "skills.list") {
		return [
			"skills.list",
			config.backendUrl,
			tokenCacheKey(config.memberToken),
			departmentId ?? "",
		].join("|");
	}

	if (request.op === "skills.get") {
		const payload = asRecord(request.payload);
		const skillId = getString(payload?.skillId);
		if (!skillId) return null;
		return [
			"skills.get",
			config.backendUrl,
			tokenCacheKey(config.memberToken),
			departmentId ?? "",
			skillId,
		].join("|");
	}

	if (request.op === "skills.search") {
		const payload = asRecord(request.payload);
		const query = getString(payload?.query);
		if (!query) return null;
		return [
			"skills.search",
			config.backendUrl,
			tokenCacheKey(config.memberToken),
			departmentId ?? "",
			query,
			String(payload?.limit ?? ""),
		].join("|");
	}

	if (request.op === "work.resolve") {
		const payload = asRecord(request.payload);
		const query = getString(payload?.query);
		if (!query) return null;
		return [
			"work.resolve",
			config.backendUrl,
			tokenCacheKey(config.memberToken),
			departmentId ?? "",
			query,
			Array.isArray(payload?.variants) ? payload.variants.join("\u001f") : "",
			String(payload?.limit ?? ""),
		].join("|");
	}

	if (request.op === "google.plan") {
		const payload = asRecord(request.payload);
		if (payload?.workflow !== "vendor_onboarding") return null;
		return [
			"google.plan",
			config.backendUrl,
			tokenCacheKey(config.memberToken),
			departmentId ?? "",
			String(payload.connectionId ?? ""),
			Array.isArray(payload.phaseIds) ? payload.phaseIds.join(",") : "",
		].join("|");
	}

	return null;
}

function tokenCacheKey(token: string): string {
	return createHash("sha256").update(token).digest("hex").slice(0, 16);
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

function readGooglePlan(data: unknown): {
	parentInstructions: string;
	connectionMessage: string;
	phases: Array<{ name: string; skillId: string; instructions?: string }>;
} | null {
	const plan = asRecord(data);
	if (plan?.workflow !== "vendor_onboarding" || !Array.isArray(plan.phases)) return null;
	const parent = asRecord(plan.parent);
	const parentInstructions = getString(parent?.instructions);
	if (!parentInstructions) return null;
	const phases = plan.phases.flatMap((phase) => {
		const record = asRecord(phase);
		const name = getString(record?.name);
		const skillId = getString(record?.skillId);
		const skill = asRecord(record?.skill);
		const instructions = getString(skill?.instructions);
		return name && skillId ? [{ name, skillId, ...(instructions ? { instructions } : {}) }] : [];
	});
	if (!phases.length) return null;
	const connection = asRecord(plan.connection);
	return {
		parentInstructions,
		phases,
		connectionMessage: getString(connection?.message) ?? "Connection selection will be handled by the backend at execution time.",
	};
}
