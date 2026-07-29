import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_BACKEND_URL = "http://localhost:8000";
const DEFAULT_POLL_INTERVAL_MS = 1_500;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1_000;

export function normalizeBackendUrl(value = DEFAULT_BACKEND_URL) {
	const trimmed = value.trim().replace(/\/+$/, "");
	if (!trimmed) return DEFAULT_BACKEND_URL;
	const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
	return new URL(withProtocol).toString().replace(/\/+$/, "");
}

async function requestJson(url, init = {}) {
	const response = await fetch(url, {
		...init,
		headers: {
			Accept: "application/json",
			...(init.body ? { "Content-Type": "application/json" } : {}),
			...init.headers,
		},
	});
	const body = await response.json().catch(() => null);
	if (!response.ok) {
		const message =
			body && typeof body === "object" && typeof body.message === "string"
				? body.message
				: `HTTP ${response.status}`;
		throw new Error(message);
	}
	if (!body) throw new Error("Divo backend returned an empty response");
	return body;
}

export function readSessionEnvironment(filePath) {
	const resolvedPath = path.resolve(filePath);
	const stat = fs.statSync(resolvedPath);
	if (!stat.isFile()) throw new Error(`Session environment is not a file: ${resolvedPath}`);
	const values = {};
	const allowedKeys = new Set([
		"DIVO_BACKEND_URL",
		"DIVO_MEMBER_TOKEN",
		"DIVO_DEPARTMENT_ID",
		"DIVO_RUNTIME_CONTEXT_PATH",
	]);
	for (const rawLine of fs.readFileSync(resolvedPath, "utf8").split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
		if (!match || !allowedKeys.has(match[1])) continue;
		if (Object.hasOwn(values, match[1])) {
			throw new Error(`Duplicate ${match[1]} in session environment`);
		}
		values[match[1]] = match[2];
	}
	if (!values.DIVO_BACKEND_URL || !values.DIVO_MEMBER_TOKEN) {
		throw new Error("Session environment must contain DIVO_BACKEND_URL and DIVO_MEMBER_TOKEN");
	}
	return {
		backendUrl: normalizeBackendUrl(values.DIVO_BACKEND_URL),
		token: values.DIVO_MEMBER_TOKEN,
		departmentId: values.DIVO_DEPARTMENT_ID,
		filePath: resolvedPath,
		mode: stat.mode & 0o777,
	};
}

export async function fetchMemberSession({ backendUrl, token }) {
	const response = await requestJson(`${normalizeBackendUrl(backendUrl)}/api/desktop/auth/me`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	if (!response.success || !response.data?.userId || !response.data.companyId) {
		throw new Error(response.message ?? "Failed to validate the existing Divo member session");
	}
	return response.data;
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function openBrowser(url, platform = process.platform) {
	const command =
		platform === "darwin"
			? { file: "open", args: [url] }
			: platform === "win32"
				? { file: "rundll32", args: ["url.dll,FileProtocolHandler", url] }
				: { file: "xdg-open", args: [url] };
	return new Promise((resolve) => {
		const child = spawn(command.file, command.args, {
			detached: true,
			stdio: "ignore",
		});
		child.once("error", () => resolve(false));
		child.once("spawn", () => {
			child.unref();
			resolve(true);
		});
	});
}

export async function signInWithLark({
	backendUrl,
	launchBrowser = true,
	pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
	timeoutMs = DEFAULT_TIMEOUT_MS,
	onAuthorizeUrl = () => {},
}) {
	const normalizedBackendUrl = normalizeBackendUrl(backendUrl);
	const authorize = await requestJson(
		`${normalizedBackendUrl}/api/desktop/auth/lark/authorize-url`,
	);
	if (!authorize.success || !authorize.data?.authorizeUrl || !authorize.data.nonce) {
		throw new Error(authorize.message ?? "Failed to start Lark sign-in");
	}

	onAuthorizeUrl(authorize.data.authorizeUrl);
	if (launchBrowser) await openBrowser(authorize.data.authorizeUrl);

	const deadline = Date.now() + timeoutMs;
	let callback;
	while (Date.now() < deadline) {
		const polled = await requestJson(
			`${normalizedBackendUrl}/api/desktop/auth/lark/poll?nonce=${encodeURIComponent(authorize.data.nonce)}`,
		);
		if (polled.success && polled.data?.code && polled.data.state) {
			callback = polled.data;
			break;
		}
		if (!polled.pending && polled.message) throw new Error(polled.message);
		await sleep(pollIntervalMs);
	}
	if (!callback) throw new Error("Lark sign-in timed out");

	const exchanged = await requestJson(
		`${normalizedBackendUrl}/api/desktop/auth/lark/exchange`,
		{
			method: "POST",
			body: JSON.stringify(callback),
		},
	);
	if (!exchanged.success || !exchanged.data?.token || !exchanged.data.session) {
		throw new Error(exchanged.message ?? "Failed to exchange Lark session");
	}
	return {
		backendUrl: normalizedBackendUrl,
		token: exchanged.data.token,
		session: exchanged.data.session,
	};
}

export function selectDepartment(departments = [], selector) {
	if (departments.length === 0) return undefined;
	if (!selector) return departments[0];
	const normalized = selector.trim().toLowerCase();
	const selected = departments.find(
		(department) =>
			department.id === selector || department.name?.trim().toLowerCase() === normalized,
	);
	if (!selected) {
		throw new Error(
			`Department "${selector}" is unavailable. Choose one of: ${departments
				.map((department) => `${department.name} (${department.id})`)
				.join(", ")}`,
		);
	}
	return selected;
}

export async function fetchRuntimeContext({
	backendUrl,
	token,
	department,
	departments = [],
}) {
	const query = new URLSearchParams({ capabilityVersion: "3" });
	if (department?.id) query.set("departmentId", department.id);
	const response = await requestJson(
		`${normalizeBackendUrl(backendUrl)}/api/desktop/auth/runtime-context?${query}`,
		{ headers: { Authorization: `Bearer ${token}` } },
	);
	if (!response.success || !response.data) {
		throw new Error(response.message ?? "Failed to load Divo runtime context");
	}
	return {
		...response.data,
		departments: departments
			.map((candidate) => candidate.name?.trim())
			.filter(Boolean),
	};
}
