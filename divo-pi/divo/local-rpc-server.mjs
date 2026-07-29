import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	prompt,
	promptWithRuntimeLease,
	reconcileOwnedContainers,
	resolveRuntimeLease,
	validateProfileName,
	validateThread,
} from "./local-rpc-controller.mjs";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4317;
const DEFAULT_MAX_ACTIVE_RUNS = 2;
const MAX_BODY_BYTES = 64 * 1024;
const RETRY_AFTER_SECONDS = 60;

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
		async runRuntime({ backendUrl, runtimeLease, message, signal }) {
			const normalizedMessage = validateMessage(message);
			const runtime = await resolveLease({ backendUrl, lease: runtimeLease });
			return admit(runtime.profile, () => executeRuntime(runtime, normalizedMessage, { signal }));
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

function sendJson(response, statusCode, value, headers = {}) {
	response.writeHead(statusCode, {
		"content-type": "application/json; charset=utf-8",
		...headers,
	});
	response.end(`${JSON.stringify(value)}\n`);
}

export function createControllerServer(options = {}) {
	const admission =
		options.admission ??
		createAdmissionController({
			execute: options.execute,
			maxActiveRuns: options.maxActiveRuns,
		});
	const server = http.createServer(async (request, response) => {
		if (request.method === "GET" && request.url === "/health") {
			sendJson(response, 200, {
				status: "ok",
				activeRuns: admission.activeCount,
				maxActiveRuns: admission.maxActiveRuns,
			});
			return;
		}
		const isManualRun = request.method === "POST" && request.url === "/v1/runs";
		const isLarkRun = request.method === "POST" && request.url === "/v1/lark-runs";
		if (!isManualRun && !isLarkRun) {
			sendJson(response, 404, {
				error: { code: "not_found", message: "Route not found" },
			});
			return;
		}
		try {
			const body = await readJson(request);
			const controller = new AbortController();
			request.once("aborted", () => controller.abort());
			response.once("close", () => {
				if (!response.writableEnded) controller.abort();
			});
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
	const close = () => server.close();
	process.once("SIGINT", close);
	process.once("SIGTERM", close);
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
