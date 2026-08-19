import fs from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { selectDepartment } from "./auth.mjs";
import {
	buildRuntimeEnvironmentPatch,
	prepareDivoPiRun,
	recordInterruptedWorkFact,
	resolveRuntimeThreadId,
	startDivoPi,
} from "./runtime.mjs";
import { isRuntimeChannel } from "./runtime-channels.mjs";

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
		value.channel !== undefined
		&& !isRuntimeChannel(value.channel)
	) {
		throw new Error("Bootstrap channel is invalid");
	}
	// A backend-driven run is identified from outside; a desktop-local one is not.
	if (
		isRuntimeChannel(value.channel)
		&& (typeof value.runId !== "string" || !value.runId.trim())
	) {
		throw new Error("Bootstrap runId is required for a backend-driven run");
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
	if (value.nativeSkills !== undefined && value.nativeSkills !== true) {
		throw new Error("Bootstrap nativeSkills is invalid");
	}
	if (
		value.interruptionTask !== undefined
		&& (typeof value.interruptionTask !== "string" || value.interruptionTask.length > 8_000)
	) {
		throw new Error("Bootstrap interruptionTask is invalid");
	}
	// Required, not optional. The controller has already resolved who this run
	// belongs to — it had to, to pick the profile and the container — and every
	// path that writes a bootstrap passes the answer along. Treating it as
	// optional left a fallback that asked the backend the same question a second
	// time from inside the container, over a route a container is no longer
	// allowed to call. A missing one is a controller bug, and should read as one.
	value.trustedSession = validateTrustedSession(value.trustedSession);
	// Same reasoning, same author: the controller fetched this from the backend
	// for this turn, so a container that did not receive it has nowhere left to
	// get one and would otherwise run with no persona and no capabilities while
	// looking like it worked.
	if (
		!value.runtimeContext
		|| typeof value.runtimeContext !== "object"
		|| Array.isArray(value.runtimeContext)
	) {
		throw new Error("Bootstrap runtime context is invalid");
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

function validateTrustedDepartment(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Bootstrap trusted department is invalid");
	}
	if (typeof value.id !== "string" || !value.id.trim()) {
		throw new Error("Bootstrap trusted department id is invalid");
	}
	if (value.name !== undefined && typeof value.name !== "string") {
		throw new Error("Bootstrap trusted department name is invalid");
	}
	return {
		id: value.id,
		...(value.name ? { name: value.name } : {}),
	};
}

function validateTrustedSession(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Bootstrap trusted session is invalid");
	}
	if (typeof value.userId !== "string" || !value.userId.trim()) {
		throw new Error("Bootstrap trusted session userId is invalid");
	}
	if (typeof value.companyId !== "string" || !value.companyId.trim()) {
		throw new Error("Bootstrap trusted session companyId is invalid");
	}
	const departments = value.departments === undefined ? [] : value.departments;
	if (!Array.isArray(departments)) {
		throw new Error("Bootstrap trusted session departments are invalid");
	}
	return {
		userId: value.userId,
		companyId: value.companyId,
		departments: departments.map(validateTrustedDepartment),
	};
}

export function recordPendingInterruption(
	filePath = process.env.DIVO_INTERRUPTION_PATH ?? DEFAULT_INTERRUPTION_PATH,
	dataDir = "/data/state/data",
) {
	if (!fs.existsSync(filePath)) return false;
	const raw = fs.readFileSync(filePath, "utf8");
	fs.unlinkSync(filePath);
	const interruption = validateInterruption(JSON.parse(raw));
	recordInterruptedWorkFact({
		dataDir,
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
	const session = bootstrap.trustedSession;
	assertPinnedIdentity(session, bootstrap);
	const department = selectDepartment(
		session.departments,
		bootstrap.departmentId,
	);
	// Already answered. The controller fetched this before it chose the image and
	// staged the skills, and re-stages it with every turn's bootstrap, so asking
	// the backend again from in here bought nothing but a round trip.
	const runtimeContext = {
		...bootstrap.runtimeContext,
		departments: session.departments
			.map((candidate) => candidate.name?.trim())
			.filter(Boolean),
	};
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
			if (!interruptionRecorded && isRuntimeChannel(bootstrap.channel)) {
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

/**
 * Read a bootstrap the controller sent on stdin, if it sent one.
 *
 * A warm turn used to need two `docker exec` calls: one shell to `cat` the
 * bootstrap onto the volume, then this one to read it back. Both cross the
 * daemon, and the member waits for both. Accepting the bytes directly collapses
 * that to one, and the file is still written — `readBootstrap` consumes and
 * unlinks it exactly as before, so nothing downstream can tell the difference.
 */
async function readStdinBootstrap() {
	if (process.stdin.isTTY) return "";
	let raw = "";
	process.stdin.setEncoding("utf8");
	for await (const chunk of process.stdin) raw += chunk;
	return raw.trim();
}

/**
 * Put the controller's bootstrap on the volume, exactly as the shell used to.
 *
 * The mode is applied by removing any existing file first, because `writeFile`'s
 * `mode` is only honoured when it creates the file — an existing one keeps
 * whatever permissions it already had. Writing a member token through that would
 * be a silent downgrade of the very thing `umask 077` was there to guarantee.
 */
export function stageControllerBootstrap(
	bootstrapJson,
	target = process.env.DIVO_BOOTSTRAP_PATH ?? DEFAULT_BOOTSTRAP_PATH,
) {
	if (!bootstrapJson) {
		throw new Error("Divo runtime prepare requires a bootstrap on stdin");
	}
	fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
	fs.rmSync(target, { force: true });
	fs.writeFileSync(target, `${bootstrapJson}\n`, { mode: 0o600 });
	return target;
}

export async function prepareContainerRun(bootstrapJson) {
	stageControllerBootstrap(bootstrapJson);
	const { options } = await resolvePiOptions();
	const prepared = prepareDivoPiRun(options);
	return {
		// The controller passes rollout controls on this prepare exec. Include
		// them in the patch so an already-running Pi changes on its next turn.
		environment: buildRuntimeEnvironmentPatch(prepared.values, process.env),
	};
}

const isMain =
	process.argv[1] &&
	path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
	const command = process.argv[2];
	const work = command === "prepare"
		? readStdinBootstrap().then(prepareContainerRun).then((result) => {
			process.stdout.write(`${JSON.stringify(result)}\n`);
		})
		: command === "record-interruption"
			? Promise.resolve(recordPendingInterruption()).then((recorded) => {
				process.stdout.write(`${JSON.stringify({ recorded })}\n`);
			})
		: runContainer();
	work.catch((error) => {
		console.error(`[divo-container] ${error.message}`);
		process.exitCode = 1;
	});
}
