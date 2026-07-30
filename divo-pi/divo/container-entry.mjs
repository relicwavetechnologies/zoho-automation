import fs from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
	fetchMemberSession,
	fetchRuntimeContext,
	selectDepartment,
} from "./auth.mjs";
import { startDivoPi } from "./runtime.mjs";

const DEFAULT_BOOTSTRAP_PATH = "/run/divo-auth/bootstrap.json";
const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 30_000;

export function validateBootstrap(value) {
	if (!value || typeof value !== "object") throw new Error("Bootstrap must be a JSON object");
	for (const key of ["backendUrl", "token", "profile", "thread", "userId", "companyId"]) {
		if (typeof value[key] !== "string" || !value[key].trim()) {
			throw new Error(`Bootstrap ${key} is required`);
		}
	}
	if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(value.profile)) {
		throw new Error("Bootstrap profile is invalid");
	}
	if (!/^[A-Za-z0-9._-]+$/.test(value.thread)) {
		throw new Error("Bootstrap thread is invalid");
	}
	// Absent means the durable per-thread session, which is what every caller
	// asked for before shared group threads existed.
	if (
		value.sessionScope !== undefined
		&& value.sessionScope !== "thread"
		&& value.sessionScope !== "run"
	) {
		throw new Error("Bootstrap sessionScope is invalid");
	}
	return value;
}

export function assertPinnedIdentity(session, bootstrap) {
	if (
		session.userId !== bootstrap.userId ||
		session.companyId !== bootstrap.companyId
	) {
		throw new Error(
			`Authenticated identity does not match pinned profile "${bootstrap.profile}"`,
		);
	}
}

/**
 * What the container hands Pi, derived from what the controller sent.
 *
 * Pure and exported so the forwarding itself is covered: `sessionScope` is the
 * one property keeping a shared group transcript off the user's durable volume,
 * and losing it here would be silent — every run would still succeed, and every
 * group turn would write that transcript to disk.
 */
export function piOptions({ bootstrap, department, runtimeContext }) {
	return {
		...bootstrap,
		departmentId: department?.id,
		mode: "rpc",
		runtimeContext,
		sessionScope: bootstrap.sessionScope ?? "thread",
		stateRoot: "/data/state",
		workspace: "/data/workspace",
	};
}

async function readBootstrap(
	filePath = DEFAULT_BOOTSTRAP_PATH,
	timeoutMs = DEFAULT_BOOTSTRAP_TIMEOUT_MS,
) {
	const deadline = Date.now() + timeoutMs;
	while (!fs.existsSync(filePath)) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for controller bootstrap");
		await sleep(100);
	}
	const raw = fs.readFileSync(filePath, "utf8");
	fs.unlinkSync(filePath);
	return validateBootstrap(JSON.parse(raw));
}

export async function runContainer() {
	const bootstrap = await readBootstrap(
		process.env.DIVO_BOOTSTRAP_PATH ?? DEFAULT_BOOTSTRAP_PATH,
	);
	const session = await fetchMemberSession(bootstrap);
	assertPinnedIdentity(session, bootstrap);
	const department = selectDepartment(
		session.departments,
		bootstrap.departmentId,
	);
	const runtimeContext = await fetchRuntimeContext({
		...bootstrap,
		department,
		departments: session.departments,
	});
	const child = startDivoPi(piOptions({ bootstrap, department, runtimeContext }));
	for (const signal of ["SIGINT", "SIGTERM"]) {
		process.once(signal, () => child.kill(signal));
	}
	await new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if ((signal && signal !== "SIGTERM") || ![0, 143].includes(code)) {
				reject(new Error(`Pi exited ${signal ? `with ${signal}` : `with code ${code}`}`));
				return;
			}
			resolve();
		});
	});
}

const isMain =
	process.argv[1] &&
	path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
	runContainer().catch((error) => {
		console.error(`[divo-container] ${error.message}`);
		process.exitCode = 1;
	});
}
