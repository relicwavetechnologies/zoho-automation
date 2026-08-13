import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, resolve, sep } from "node:path";
import { Type } from "typebox";
import {
	callDivoGateway,
	formatGatewayResponse,
	resolveDivoGatewayConfig,
	type DivoGatewayConfig,
	type GatewayExecutionContext,
	type GatewayRequestBody,
	type GatewayResponseBody,
} from "./gateway-client.ts";
import { approvePreparedDivoIntent } from "./approval-gate.ts";
import { readDivoRunCorrelation } from "./run-correlation.ts";

type JsonRecord = Record<string, unknown>;
type KnowledgeScope = "personal" | "department" | "company";
type ReviewedKind = "skill" | "file";

const SkillContent = Type.Object({
	name: Type.String({ minLength: 1, maxLength: 120 }),
	slug: Type.String({ minLength: 1, maxLength: 120 }),
	summary: Type.String({ maxLength: 1024 }),
	markdown: Type.String({ minLength: 1, maxLength: 200_000 }),
	toolIds: Type.Array(Type.String({ minLength: 1, maxLength: 120 }), { maxItems: 50 }),
	tags: Type.Array(Type.String({ minLength: 1, maxLength: 60 }), { maxItems: 20 }),
}, { additionalProperties: false });

const FileContent = Type.Object({
	localPath: Type.String({ minLength: 1, maxLength: 4_096 }),
}, { additionalProperties: false });

// OpenAI-compatible providers (including DeepSeek) require every function's
// parameter schema to be a top-level JSON Schema object. A top-level union is
// emitted as `anyOf` without `type: "object"` and makes the provider reject the
// entire request before it can choose any tool. Runtime validation below still
// enforces the kind-specific content contract and action/version invariants.
const KnowledgeReviewParams = Type.Object({
	kind: Type.Union([Type.Literal("skill"), Type.Literal("file")]),
	action: Type.Union([
		Type.Literal("create"),
		Type.Literal("update"),
		Type.Literal("publish"),
		Type.Literal("delete"),
	]),
	scope: Type.Union([Type.Literal("personal"), Type.Literal("department"), Type.Literal("company")]),
	logicalKey: Type.String({ minLength: 1, maxLength: 240 }),
	baseVersion: Type.Optional(Type.Number({ minimum: 1 })),
	content: Type.Optional(Type.Union([SkillContent, FileContent])),
}, { additionalProperties: false });

export interface KnowledgeReviewDependencies {
	resolveConfig: () => DivoGatewayConfig | { error: string };
	callGateway: (
		config: DivoGatewayConfig,
		request: GatewayRequestBody,
	) => Promise<{ body: GatewayResponseBody; httpStatus: number }>;
	prepareFile?: (localPath: string) => Promise<PreparedLocalFile>;
	stageFile?: (config: DivoGatewayConfig, file: PreparedLocalFile) => Promise<JsonRecord>;
}

interface PreparedLocalFile {
	readonly buffer: Buffer;
	readonly fileName: string;
	readonly mimeType: string;
	readonly sizeBytes: number;
	readonly sha256: string;
}

const DEFAULT_DEPENDENCIES: KnowledgeReviewDependencies = {
	resolveConfig: resolveDivoGatewayConfig,
	callGateway: callDivoGateway,
};

function asRecord(value: unknown): JsonRecord | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as JsonRecord
		: undefined;
}

function asText(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseRequest(value: unknown): {
	kind: ReviewedKind;
	action: "create" | "update" | "publish" | "delete";
	scope: KnowledgeScope;
	logicalKey: string;
	baseVersion?: number;
	content?: JsonRecord;
} {
	const record = asRecord(value);
	if (!record) throw new Error("knowledge review request must be an object");
	const allowed = new Set(["kind", "action", "scope", "logicalKey", "baseVersion", "content"]);
	if (Object.keys(record).some((key) => !allowed.has(key))) {
		throw new Error("knowledge review request contains unsupported fields");
	}
	if (record.kind !== "skill" && record.kind !== "file") {
		throw new Error("knowledge review supports only skills and governed files");
	}
	if (!(["create", "update", "publish", "delete"] as unknown[]).includes(record.action)) {
		throw new Error("knowledge review action is invalid");
	}
	if (record.scope !== "personal" && record.scope !== "department" && record.scope !== "company") {
		throw new Error("knowledge review requires a personal, department, or company scope");
	}
	const logicalKey = asText(record.logicalKey);
	if (!logicalKey || logicalKey.length > 240) throw new Error("logicalKey is invalid");
	const baseVersion = record.baseVersion;
	if (record.action === "create" && baseVersion !== undefined) {
		throw new Error("create must not include baseVersion");
	}
	if (
		record.action !== "create"
		&& record.action !== "publish"
		&& (!Number.isInteger(baseVersion) || Number(baseVersion) < 1)
	) {
		throw new Error(`${String(record.action)} requires a positive baseVersion`);
	}
	if (record.action === "delete") {
		if (record.content !== undefined) throw new Error("delete must not include content");
	} else if (!asRecord(record.content)) {
		throw new Error(`${String(record.action)} requires exact content`);
	}
	const content = record.content === undefined ? undefined : validateContent(record.kind, record.content);
	return {
		kind: record.kind,
		action: record.action as "create" | "update" | "publish" | "delete",
		scope: record.scope,
		logicalKey,
		...(baseVersion === undefined ? {} : { baseVersion: Number(baseVersion) }),
		...(content ? { content } : {}),
	};
}

function validateContent(kind: ReviewedKind, value: unknown): JsonRecord {
	const content = asRecord(value);
	if (!content) throw new Error(`${kind} content must be an object`);
	if (kind === "skill") {
		const expected = new Set(["name", "slug", "summary", "markdown", "toolIds", "tags"]);
		if (Object.keys(content).some((key) => !expected.has(key))) throw new Error("skill content contains unsupported fields");
		for (const key of ["name", "slug", "markdown"] as const) {
			if (!asText(content[key])) throw new Error(`skill ${key} is required`);
		}
		if (typeof content.summary !== "string") throw new Error("skill summary is required");
		if (!Array.isArray(content.toolIds) || !content.toolIds.every((item) => Boolean(asText(item)))) {
			throw new Error("skill toolIds must be strings");
		}
		if (!Array.isArray(content.tags) || !content.tags.every((item) => Boolean(asText(item)))) {
			throw new Error("skill tags must be strings");
		}
		if (String(content.name).length > 120 || String(content.slug).length > 120) throw new Error("skill name or slug is too long");
		if (String(content.summary).length > 1_024 || String(content.markdown).length > 200_000) throw new Error("skill content is too long");
		if (content.toolIds.length > 50 || content.tags.length > 20) throw new Error("skill lists are too long");
		return JSON.parse(JSON.stringify(content)) as JsonRecord;
	}
	const expected = new Set(["localPath"]);
	if (Object.keys(content).some((key) => !expected.has(key))) throw new Error("file content contains unsupported fields");
	const localPath = asText(content.localPath);
	if (!localPath || localPath.length > 4_096) throw new Error("file localPath is invalid");
	return { localPath };
}

async function resolveTarget(
	request: ReturnType<typeof parseRequest>,
	config: DivoGatewayConfig,
	execution: GatewayExecutionContext,
	deps: KnowledgeReviewDependencies,
): Promise<{ label: string; departmentId?: string }> {
	const response = await deps.callGateway(config, {
		op: "tools.invoke",
		execution,
		payload: { toolId: "knowledge", args: { operation: "check_targets" } },
	});
	if (!response.body.ok || response.body.status !== "success") {
		throw new Error(formatGatewayResponse(response.body).text);
	}
	const result = asRecord(asRecord(response.body.data)?.result);
	const targets = Array.isArray(result?.targets) ? result.targets : [];
	const selected = targets.map(asRecord).find((target) => target?.scope === request.scope);
	if (!selected || !asText(selected.label)) throw new Error(`The ${request.scope} target is not available`);
	const departmentId = request.scope === "department" ? asText(selected.departmentId) : undefined;
	if (request.scope === "department" && !departmentId) throw new Error("The department target is incomplete");
	return { label: asText(selected.label)!, ...(departmentId ? { departmentId } : {}) };
}

const MIME_BY_EXTENSION: Record<string, string> = {
	".csv": "text/csv",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".gif": "image/gif",
	".jpeg": "image/jpeg",
	".jpg": "image/jpeg",
	".json": "application/json",
	".md": "text/markdown",
	".pdf": "application/pdf",
	".png": "image/png",
	".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	".txt": "text/plain",
	".webp": "image/webp",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

async function prepareLocalFile(localPath: string): Promise<PreparedLocalFile> {
	const root = await realpath(process.cwd());
	const candidate = isAbsolute(localPath) ? resolve(localPath) : resolve(root, localPath);
	const real = await realpath(candidate);
	const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;
	if (real !== root && !real.startsWith(rootPrefix)) throw new Error("file must be inside the current workspace");
	const info = await stat(real);
	if (!info.isFile()) throw new Error("file must be a regular workspace file");
	const mimeType = MIME_BY_EXTENSION[extname(real).toLowerCase()];
	if (!mimeType) throw new Error("file type is not supported for governed knowledge");
	const buffer = await readFile(real);
	return {
		buffer,
		fileName: basename(real),
		mimeType,
		sizeBytes: buffer.length,
		sha256: createHash("sha256").update(buffer).digest("hex"),
	};
}

async function stagePreparedFile(config: DivoGatewayConfig, file: PreparedLocalFile): Promise<JsonRecord> {
	const form = new FormData();
	form.append("file", new Blob([new Uint8Array(file.buffer)], { type: file.mimeType }), file.fileName);
	const response = await fetch(`${config.backendUrl}/api/knowledge/files`, {
		method: "POST",
		headers: { Authorization: `Bearer ${config.memberToken}` },
		body: form,
		signal: AbortSignal.timeout(60_000),
	});
	const payload = await response.json().catch(() => null) as unknown;
	const record = asRecord(payload);
	const asset = asRecord(record?.asset);
	if (!response.ok || record?.ok !== true || !asset) {
		throw new Error(asText(record?.message) ?? `private file staging failed (${response.status})`);
	}
	const descriptor = {
		assetId: asText(asset.assetId),
		fileName: asText(asset.fileName),
		mimeType: asText(asset.mimeType),
		sizeBytes: asset.sizeBytes,
		sha256: asText(asset.sha256),
	};
	if (
		!descriptor.assetId
		|| descriptor.fileName !== file.fileName
		|| descriptor.mimeType !== file.mimeType
		|| descriptor.sizeBytes !== file.sizeBytes
		|| descriptor.sha256 !== file.sha256
	) {
		throw new Error("backend file descriptor does not match the reviewed local file");
	}
	return descriptor as JsonRecord;
}

export async function executeKnowledgeReview(
	toolCallId: string,
	params: unknown,
	ctx: Pick<ExtensionContext, "ui" | "signal">,
	deps: KnowledgeReviewDependencies = DEFAULT_DEPENDENCIES,
) {
	let request: ReturnType<typeof parseRequest>;
	try {
		request = parseRequest(params);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: "text" as const, text: `Knowledge review rejected: ${message}` }],
			details: { status: "invalid_request", error: message },
			isError: true as const,
		};
	}
	const config = deps.resolveConfig();
	if ("error" in config) {
		return {
			content: [{ type: "text" as const, text: config.error }],
			details: { status: "unconfigured", error: config.error },
			isError: true as const,
		};
	}
	try {
		const correlation = await readDivoRunCorrelation();
		const execution: GatewayExecutionContext = {
			version: 1,
			threadId: correlation.threadId,
			runId: correlation.runId,
			actionId: `knowledge-review:${randomUUID()}`,
		};
		const target = await resolveTarget(request, config, execution, deps);
		const preparedFile = request.kind === "file" && request.action !== "delete"
			? await (deps.prepareFile ?? prepareLocalFile)(asText(request.content?.localPath)!)
			: undefined;
		const reviewedContent = preparedFile
			? await (deps.stageFile ?? stagePreparedFile)(config, preparedFile)
			: request.content;
		// The backend owns the review UI on every channel it drives; only a
		// desktop-local run has to render one itself.
		if (correlation.channel) {
			const requestId = `knowledge:${createHash("sha256").update(JSON.stringify({
				kind: request.kind,
				action: request.action,
				scope: request.scope,
				logicalKey: request.logicalKey,
				baseVersion: request.baseVersion ?? null,
				content: reviewedContent ?? null,
			})).digest("hex").slice(0, 48)}`;
			const opened = await deps.callGateway(config, {
				op: "knowledge.review.open",
				execution,
				...(target.departmentId ? { departmentId: target.departmentId } : {}),
				payload: {
					requestId,
					kind: request.kind,
					action: request.action,
					scope: request.scope,
					logicalKey: request.logicalKey,
					...(request.baseVersion ? { baseVersion: request.baseVersion } : {}),
					...(reviewedContent ? { content: reviewedContent } : {}),
				},
			});
			const formatted = formatGatewayResponse(opened.body);
			return {
				content: [{ type: "text" as const, text: formatted.text }],
				details: { requestId, status: opened.body.status, data: opened.body.data },
				...(!opened.body.ok ? { isError: true as const } : {}),
			};
		}
		const args = {
			operation: "propose",
			kind: request.kind,
			action: request.action,
			scope: request.scope,
			...(target.departmentId ? { departmentId: target.departmentId } : {}),
			logicalKey: request.logicalKey,
			...(request.baseVersion ? { baseVersion: request.baseVersion } : {}),
			...(reviewedContent ? { content: reviewedContent } : {}),
		};
		const prepared = await deps.callGateway(config, {
			op: "tools.prepare",
			execution,
			...(target.departmentId ? { departmentId: target.departmentId } : {}),
			payload: { toolId: "knowledge", args },
		});
		if (!prepared.body.ok || prepared.body.status !== "success") {
			return {
				content: [{ type: "text" as const, text: formatGatewayResponse(prepared.body).text }],
				details: { status: prepared.body.status, error: prepared.body.error },
				isError: true as const,
			};
		}
		let intentId: string;
		try {
			intentId = await approvePreparedDivoIntent(toolCallId, prepared.body.data, {
				ui: ctx.ui,
				cwd: process.cwd(),
				signal: ctx.signal,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (/did not approve/i.test(message)) {
				return {
					content: [{ type: "text" as const, text: "The knowledge change was cancelled. Nothing was saved." }],
					details: { status: "cancelled" },
				};
			}
			throw error;
		}
		const proposed = await deps.callGateway(config, {
			op: "tools.commit",
			execution,
			...(target.departmentId ? { departmentId: target.departmentId } : {}),
			payload: { intentId },
		});
		if (!proposed.body.ok || proposed.body.status !== "success") {
			return {
				content: [{ type: "text" as const, text: formatGatewayResponse(proposed.body).text }],
				details: { status: proposed.body.status, error: proposed.body.error },
				isError: true as const,
			};
		}
		const result = asRecord(asRecord(proposed.body.data)?.result);
		const mutationId = asText(result?.mutationId);
		const contentHash = result?.contentHash;
		if (!mutationId || (contentHash !== null && typeof contentHash !== "string")) {
			throw new Error("The backend did not return a durable knowledge proposal.");
		}
		const reviewed = await deps.callGateway(config, {
			op: "knowledge.review.decide",
			execution,
			payload: { mutationId, contentHash: contentHash ?? null, decision: "approve" },
		});
		if (!reviewed.body.ok || reviewed.body.status !== "success") {
			return {
				content: [{ type: "text" as const, text: formatGatewayResponse(reviewed.body).text }],
				details: { status: reviewed.body.status, error: reviewed.body.error },
				isError: true as const,
			};
		}
		const applied = await deps.callGateway(config, {
			op: "tools.invoke",
			execution,
			...(target.departmentId ? { departmentId: target.departmentId } : {}),
			payload: {
				toolId: "knowledge",
				args: {
					operation: "apply",
					mutationId,
					contentHash: contentHash ?? null,
					kind: request.kind,
					action: request.action,
					scope: request.scope,
					...(target.departmentId ? { departmentId: target.departmentId } : {}),
					...(reviewedContent ? { content: reviewedContent } : {}),
				},
			},
		});
		const formatted = formatGatewayResponse(applied.body);
		const awaitingAuthority = applied.body.status === "approval_required";
		return {
			content: [{ type: "text" as const, text: formatted.text }],
			details: { mutationId, contentHash: contentHash ?? null, status: applied.body.status, data: applied.body.data },
			...(!applied.body.ok && !awaitingAuthority ? { isError: true as const } : {}),
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: "text" as const, text: `Knowledge review failed safely: ${message}` }],
			details: { status: "failed", error: message },
			isError: true as const,
		};
	}
}

export function registerKnowledgeReviewTool(
	pi: ExtensionAPI,
): void {
	pi.registerTool<typeof KnowledgeReviewParams, unknown>({
		name: "divo_knowledge_review",
		label: "Review knowledge change",
		description: "Review an exact personal/department/company skill or governed-file change, then submit it to backend policy and RBAC.",
		promptSnippet: "Use divo_knowledge_review for personal or shared skill and governed-file mutations. Shared memory uses divo_memory_review.",
		promptGuidelines: [
			"Use after the user asks to save, update, publish, or delete a personal, department, or company procedure/file, or clearly finishes teaching a reusable procedure for later use. The review itself is the user's consent.",
			"For file create/update/publish, pass only content { localPath } for the exact workspace file. The tool stages it privately and verifies its backend descriptor after requester confirmation.",
			"Never provide departmentId. Choose only personal, department, or company; the backend supplies the authenticated target.",
			"The content must be the complete replacement version the user should review. Never summarize away decision rules or silently add facts.",
			"Personal changes apply after owner review. Shared changes remain pending until the backend confirms distinct manager/admin approval.",
		],
		parameters: KnowledgeReviewParams,
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			return executeKnowledgeReview(toolCallId, params, ctx, DEFAULT_DEPENDENCIES);
		},
	});
}
