import fs from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
	fetchMemberSession,
	fetchRuntimeContext,
	selectDepartment,
} from "./auth.mjs";
import {
	buildRuntimeEnvironmentPatch,
	prepareDivoPiRun,
	recordInterruptedWorkFact,
	resolveRuntimeThreadId,
	startDivoPi,
} from "./runtime.mjs";

const DEFAULT_BOOTSTRAP_PATH = "/run/divo-auth/bootstrap.json";
const DEFAULT_INTERRUPTION_PATH = "/run/divo-auth/interruption.json";
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
	if (
		value.channel === "lark"
		&& (typeof value.runId !== "string" || !value.runId.trim())
	) {
		throw new Error("Bootstrap runId is required for Lark");
	}
	resolveRuntimeThreadId(value.thread, value.runtimeThreadId);
	// Absent means the durable per-thread session, which is what every caller
	// asked for before shared group threads existed.
	if (
		value.sessionScope !== undefined
		&& value.sessionScope !== "thread"
		&& value.sessionScope !== "run"
	) {
		throw new Error("Bootstrap sessionScope is invalid");
	}
	if (
		value.interruptionTask !== undefined
		&& (typeof value.interruptionTask !== "string" || value.interruptionTask.length > 8_000)
	) {
		throw new Error("Bootstrap interruptionTask is invalid");
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

function validateInterruption(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Interruption record must be an object");
	}
	if (!/^[A-Za-z0-9._-]+$/.test(value.thread)) {
		throw new Error("Interruption thread is invalid");
	}
	if (typeof value.task !== "string" || value.task.length > 8_000) {
		throw new Error("Interruption task is invalid");
	}
	return value;
}

function recordPendingInterruption(
	filePath = process.env.DIVO_INTERRUPTION_PATH ?? DEFAULT_INTERRUPTION_PATH,
) {
	if (!fs.existsSync(filePath)) return false;
	const raw = fs.readFileSync(filePath, "utf8");
	fs.unlinkSync(filePath);
	const interruption = validateInterruption(JSON.parse(raw));
	recordInterruptedWorkFact({
		dataDir: "/data/state/data",
		thread: interruption.thread,
		task: interruption.task,
	});
	return true;
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
		runtimeThreadId: resolveRuntimeThreadId(
			bootstrap.thread,
			bootstrap.runtimeThreadId,
		),
		runtimeContext,
		sessionScope: bootstrap.sessionScope ?? "thread",
		stateRoot: "/data/state",
		workspace: "/data/workspace",
	};
}

async function resolvePiOptions() {
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
	return {
		bootstrap,
		options: piOptions({ bootstrap, department, runtimeContext }),
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
	const { bootstrap, options } = await resolvePiOptions();
	const child = startDivoPi(options);
	let interruptionRecorded = false;
	for (const signal of ["SIGINT", "SIGTERM"]) {
		process.once(signal, () => {
			if (!interruptionRecorded && bootstrap.channel === "lark") {
				interruptionRecorded = true;
				try {
					recordPendingInterruption();
				} catch (error) {
					console.error(`[divo-container] could not record interrupted work: ${error.message}`);
				}
			}
			child.kill(signal);
		});
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

export async function prepareContainerRun() {
	const { options } = await resolvePiOptions();
	const prepared = prepareDivoPiRun(options);
	return {
		environment: buildRuntimeEnvironmentPatch(prepared.values),
	};
}

const isMain =
	process.argv[1] &&
	path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
	const command = process.argv[2];
	const work = command === "prepare"
		? prepareContainerRun().then((result) => {
			process.stdout.write(`${JSON.stringify(result)}\n`);
		})
		: runContainer();
	work.catch((error) => {
		console.error(`[divo-container] ${error.message}`);
		process.exitCode = 1;
	});
}
