import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	MAX_RUNTIME_ATTACHMENTS,
	MAX_RUNTIME_ATTACHMENT_BYTES,
	MAX_RUNTIME_REQUEST_BYTES,
	decodeAttachmentFileName,
	prompt,
	promptWithRuntimeLease,
	reconcileOwnedContainers,
	resolveRuntimeLease,
	resolveStagedAttachments,
	shutdownWarmContainers,
	stageRuntimeFile,
	validateAttachmentFileId,
	validateAttachmentRequestId,
	validateProfileName,
	validateThread,
} from "./local-rpc-controller.mjs";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4317;
const DEFAULT_MAX_ACTIVE_RUNS = 2;
const MAX_BODY_BYTES = 64 * 1024;
const RETRY_AFTER_SECONDS = 60;
const UPLOAD_BUDGET_TTL_MS = 15 * 60_000;

export const CAPACITY_MESSAGE =
	"Divo is a little busy right now—everyone’s agents are hard at work. Your request hasn’t started, and your workspace is safe. Please try again in about a minute.";

function positiveInteger(value, fallback, name) {
	if (value === undefined) return fallback;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1) {
		throw new Error(`${name} must be a positive integer`);
	}
	return parsed;
}

function admissionError(statusCode, code, message, retryAfterSeconds) {
	return Object.assign(new Error(message), {
		code,
		retryAfterSeconds,
		statusCode,
	});
}

export function createAdmissionController({
	execute = prompt,
	executeRuntime = promptWithRuntimeLease,
	resolveLease = resolveRuntimeLease,
	maxActiveRuns = DEFAULT_MAX_ACTIVE_RUNS,
} = {}) {
	const limit = positiveInteger(maxActiveRuns, DEFAULT_MAX_ACTIVE_RUNS, "maxActiveRuns");
	const activeProfiles = new Set();

	const admit = async (profile, task) => {
		if (activeProfiles.has(profile)) {
			throw admissionError(
				409,
				"user_busy",
				"Your Divo agent is already working on another request. Please let it finish, then try again.",
			);
		}
		if (activeProfiles.size >= limit) {
			throw admissionError(
				429,
				"capacity_full",
				CAPACITY_MESSAGE,
				RETRY_AFTER_SECONDS,
			);
		}
		activeProfiles.add(profile);
		try {
			return await task();
		} finally {
			activeProfiles.delete(profile);
		}
	};

	const validateMessage = (message) => {
		if (typeof message !== "string" || !message.trim()) {
			throw admissionError(400, "invalid_request", "message must be a non-empty string");
		}
		return message.trim();
	};

	return {
		get activeCount() {
			return activeProfiles.size;
		},
		get maxActiveRuns() {
			return limit;
		},
		get activeProfileNames() {
			return [...activeProfiles];
		},
		async run({ profile: profileName, message, thread, approve = false }) {
			const profile = validateProfileName(profileName);
			const normalizedMessage = validateMessage(message);
			if (thread !== undefined) validateThread(thread);
			return admit(profile, () => execute(profile, normalizedMessage, { thread, approve }));
		},
		async runRuntime({ backendUrl, runtimeLease, message, attachments, signal, onProgress }) {
			const normalizedMessage = validateMessage(message);
			// Descriptors are re-derived, not trusted: `resolveStagedAttachments`
			// recomputes every path from validated parts and ignores whatever the
			// caller claimed the path was.
			let stagedAttachments;
			try {
				stagedAttachments = resolveStagedAttachments(attachments);
			} catch (error) {
				throw admissionError(400, "invalid_attachments", error.message);
			}
			const runtime = await resolveLease({ backendUrl, lease: runtimeLease });
			return admit(runtime.profile, () =>
				executeRuntime(runtime, normalizedMessage, {
					signal,
					...(stagedAttachments.length > 0 ? { attachments: stagedAttachments } : {}),
					...(onProgress ? { onProgress } : {}),
				}),
			);
		},
	};
}

async function readJson(request) {
	let body = "";
	for await (const chunk of request) {
		body += chunk;
		if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
			throw admissionError(413, "request_too_large", "Request body is too large");
		}
	}
	try {
		return JSON.parse(body);
	} catch {
		throw admissionError(400, "invalid_json", "Request body must be valid JSON");
	}
}

/**
 * Per-request upload budget.
 *
 * The per-file cap alone lets four maximum-size files through, so the run
 * total is tracked separately. Keyed by profile as well as request id: two
 * users cannot collide, and a caller cannot spend someone else's budget by
 * guessing their request id.
 */
export function createUploadBudget({ now = () => Date.now() } = {}) {
	const spent = new Map();

	const sweep = () => {
		const cutoff = now();
		for (const [key, entry] of spent) {
			if (entry.expiresAt <= cutoff) spent.delete(key);
		}
	};

	return {
		reserve(profile, requestId, bytes) {
			sweep();
			const key = `${profile}:${requestId}`;
			const entry = spent.get(key) ?? { bytes: 0, files: 0, expiresAt: 0 };
			if (entry.files >= MAX_RUNTIME_ATTACHMENTS) {
				throw admissionError(
					413,
					"too_many_attachments",
					`At most ${MAX_RUNTIME_ATTACHMENTS} files can be sent in one request.`,
				);
			}
			if (entry.bytes + bytes > MAX_RUNTIME_REQUEST_BYTES) {
				throw admissionError(
					413,
					"request_too_large",
					`These files exceed the ${Math.floor(MAX_RUNTIME_REQUEST_BYTES / (1024 * 1024))} MB total limit for one request.`,
				);
			}
			return {
				remainingBytes: MAX_RUNTIME_REQUEST_BYTES - entry.bytes,
				commit: (actualBytes) => {
					spent.set(key, {
						bytes: entry.bytes + actualBytes,
						files: entry.files + 1,
						expiresAt: now() + UPLOAD_BUDGET_TTL_MS,
					});
				},
			};
		},
	};
}

function bearerRuntimeLease(headers) {
	const match = /^Bearer\s+(\S.*)$/i.exec(String(headers.authorization ?? "").trim());
	if (!match) {
		throw admissionError(
			401,
			"missing_runtime_lease",
			"Authorization must carry a Bearer runtime lease",
		);
	}
	return match[1].trim();
}

function declaredContentLength(headers) {
	const raw = headers["content-length"];
	if (raw === undefined) return undefined;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < 0) {
		throw admissionError(400, "invalid_request", "content-length is invalid");
	}
	return value;
}

async function handleRuntimeFileUpload(request, response, { resolveLease, stageFile, budget }) {
	const lease = bearerRuntimeLease(request.headers);
	let requestId;
	let fileId;
	let fileName;
	try {
		requestId = validateAttachmentRequestId(request.headers["x-divo-request-id"]);
		fileId = validateAttachmentFileId(request.headers["x-divo-file-id"]);
		fileName = decodeAttachmentFileName(request.headers["x-divo-file-name"]);
	} catch (error) {
		throw admissionError(400, "invalid_attachment_metadata", error.message);
	}
	const kind = request.headers["x-divo-file-kind"] === "image" ? "image" : "file";

	const declared = declaredContentLength(request.headers);
	if (declared !== undefined && declared > MAX_RUNTIME_ATTACHMENT_BYTES) {
		throw admissionError(
			413,
			"attachment_too_large",
			`"${fileName}" is larger than the ${Math.floor(MAX_RUNTIME_ATTACHMENT_BYTES / (1024 * 1024))} MB limit.`,
		);
	}

	// The lease is resolved before a single byte is written: the profile it
	// yields is the only thing that decides which volume gets touched.
	let runtime;
	try {
		runtime = await resolveLease({
			backendUrl: request.headers["x-divo-backend-url"],
			lease,
		});
	} catch (error) {
		throw admissionError(401, "invalid_runtime_lease", error.message);
	}
	const reservation = budget.reserve(runtime.profile, requestId, declared ?? 0);

	const controller = new AbortController();
	request.once("aborted", () => controller.abort());

	const attachment = await stageFile({
		profile: runtime.profile,
		requestId,
		fileId,
		fileName,
		mimeType: request.headers["content-type"],
		kind,
		stream: request,
		maxBytes: Math.min(MAX_RUNTIME_ATTACHMENT_BYTES, reservation.remainingBytes),
		signal: controller.signal,
	});
	reservation.commit(attachment.bytes);

	sendJson(response, 200, { attachment });
}

function sendJson(response, statusCode, value, headers = {}) {
	response.writeHead(statusCode, {
		"content-type": "application/json; charset=utf-8",
		...headers,
	});
	response.end(`${JSON.stringify(value)}\n`);
}

function sendNdjson(response, value) {
	if (response.destroyed || response.writableEnded) return;
	response.write(`${JSON.stringify(value)}\n`);
}

export function createControllerServer(options = {}) {
	const resolveLease = options.resolveLease ?? resolveRuntimeLease;
	const admission =
		options.admission ??
		createAdmissionController({
			execute: options.execute,
			resolveLease,
			maxActiveRuns: options.maxActiveRuns,
		});
	const stageFile = options.stageFile ?? stageRuntimeFile;
	const budget = options.uploadBudget ?? createUploadBudget();
	const server = http.createServer(async (request, response) => {
		if (request.method === "GET" && request.url === "/health") {
			sendJson(response, 200, {
				status: "ok",
				activeRuns: admission.activeCount,
				maxActiveRuns: admission.maxActiveRuns,
			});
			return;
		}
		const isFileUpload = request.method === "PUT" && request.url === "/v1/runtime-files";
		const isManualRun = request.method === "POST" && request.url === "/v1/runs";
		const isLarkRun = request.method === "POST" && request.url === "/v1/lark-runs";
		if (!isFileUpload && !isManualRun && !isLarkRun) {
			sendJson(response, 404, {
				error: { code: "not_found", message: "Route not found" },
			});
			return;
		}
		let streaming = false;
		try {
			if (isFileUpload) {
				await handleRuntimeFileUpload(request, response, {
					resolveLease,
					stageFile,
					budget,
				});
				return;
			}
			const body = await readJson(request);
			const controller = new AbortController();
			request.once("aborted", () => controller.abort());
			response.once("close", () => {
				if (!response.writableEnded) controller.abort();
			});
			if (
				isLarkRun
				&& String(request.headers.accept ?? "").includes("application/x-ndjson")
			) {
				streaming = true;
				response.writeHead(200, {
					"content-type": "application/x-ndjson; charset=utf-8",
					"cache-control": "no-store",
					connection: "keep-alive",
				});
				const result = await admission.runRuntime({
					...body,
					signal: controller.signal,
					onProgress: (progress) =>
						sendNdjson(response, { type: "progress", progress }),
				});
				sendNdjson(response, { type: "result", text: result.text });
				response.end();
				return;
			}
			const result = isLarkRun
				? await admission.runRuntime({ ...body, signal: controller.signal })
				: await admission.run(body);
			sendJson(response, 200, result);
		} catch (error) {
			const statusCode = error.statusCode ?? 500;
			const payload = {
				error: {
					code: error.code ?? "run_failed",
					message: error.message,
				},
			};
			if (error.retryAfterSeconds) {
				payload.error.retryAfterSeconds = error.retryAfterSeconds;
			}
			if (streaming) {
				sendNdjson(response, { type: "error", ...payload });
				response.end();
				return;
			}
			sendJson(
				response,
				statusCode,
				payload,
				error.retryAfterSeconds
					? { "retry-after": String(error.retryAfterSeconds) }
					: {},
			);
		}
	});
	return { admission, server };
}

export async function main() {
	const host = process.env.DIVO_CONTROLLER_HOST ?? DEFAULT_HOST;
	const port = positiveInteger(
		process.env.DIVO_CONTROLLER_PORT,
		DEFAULT_PORT,
		"DIVO_CONTROLLER_PORT",
	);
	const maxActiveRuns = positiveInteger(
		process.env.MAX_ACTIVE_RUNS,
		DEFAULT_MAX_ACTIVE_RUNS,
		"MAX_ACTIVE_RUNS",
	);
	const reconciled = await reconcileOwnedContainers();
	const { server } = createControllerServer({ maxActiveRuns });
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, resolve);
	});
	console.error(
		`Divo controller listening on http://${host}:${port} (capacity ${maxActiveRuns}, reconciled ${reconciled.length})`,
	);
	let closing = false;
	const close = async () => {
		if (closing) return;
		closing = true;
		await new Promise((resolve) => server.close(resolve));
		await shutdownWarmContainers();
	};
	const requestClose = () => {
		void close().catch((error) => {
			console.error(`[divo-controller-server] shutdown failed: ${error.message}`);
			process.exitCode = 1;
		});
	};
	process.once("SIGINT", requestClose);
	process.once("SIGTERM", requestClose);
}

const isMain =
	process.argv[1] &&
	path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
	main().catch((error) => {
		console.error(`[divo-controller-server] ${error.message}`);
		process.exitCode = 1;
	});
}
