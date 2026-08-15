/**
 * Every conversation this controller has with the Docker CLI.
 *
 * Resource naming, ownership checks, the create/replace/reconcile lifecycle and
 * the exec argv used to talk to a running container all live here, so no other
 * module has to assemble a command line. Two rules hold throughout:
 *
 * - a profile name is validated before it reaches a resource name, so a name
 *   can never widen into another member's container, volume or network;
 * - an object is only ever stopped, removed or written to after an inspect has
 *   confirmed our own ownership labels on it.
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { normalizeBackendUrl } from "./auth.mjs";
import {
	NATIVE_SKILLS_ROOT,
	stageNativeSkillBootstrap as stageNativeSkillBootstrapCore,
} from "./native-skills.mjs";
import { isRuntimeChannel } from "./runtime-channels.mjs";
import { validateProfileName, validateThread } from "./runtime-identity.mjs";

const execFileAsync = promisify(execFile);

export const IMAGE = process.env.DIVO_PI_IMAGE ?? "divo-pi-local:phase0";
export const RESOURCE_PREFIX = process.env.DIVO_PI_RESOURCE_PREFIX ?? "divo-pi-local";
const RUNTIME_CONTAINER_MODE = "exec-v2";

/** The unprivileged workspace user every container process runs as. */
export const WORKSPACE_UID_GID = "10001:10001";

/** An `Error` carrying the code and HTTP status the runtime API should report. */
export function codedError(code, message, statusCode = 400) {
	return Object.assign(new Error(message), { code, statusCode });
}

export function shellQuote(value) {
	if (/'/.test(value)) throw new Error("Refusing an unsafe attachment path");
	return `'${value}'`;
}

export function resourcesFor(profileName, resourcePrefix = RESOURCE_PREFIX) {
	const profile = validateProfileName(profileName);
	const prefix = validateProfileName(resourcePrefix);
	return {
		authVolume: `${prefix}-${profile}-auth`,
		container: `${prefix}-${profile}`,
		network: `${prefix}-${profile}`,
		skillsVolume: `${prefix}-${profile}-skills`,
		volume: `${prefix}-${profile}`,
	};
}

export function buildContainerCreateArgs(
	profileName,
	image = IMAGE,
	{
		addHostGateway = process.env.DIVO_PI_ADD_HOST_GATEWAY !== "false",
		ephemeral = false,
	} = {},
) {
	const profile = validateProfileName(profileName);
	const resources = resourcesFor(profile);
	return [
		"create",
		"--interactive",
		"--name",
		resources.container,
		"--label",
		`dev.divo.profile=${profile}`,
		"--label",
		`dev.divo.volume=${resources.volume}`,
		"--label",
		`dev.divo.runtime-mode=${RUNTIME_CONTAINER_MODE}`,
		"--label",
		`dev.divo.ephemeral=${ephemeral ? "true" : "false"}`,
		"--network",
		resources.network,
		...(addHostGateway
			? ["--add-host", "host.docker.internal:host-gateway"]
			: []),
		"--mount",
		`type=volume,src=${resources.volume},dst=/data`,
		"--mount",
		`type=volume,src=${resources.authVolume},dst=/run/divo-auth`,
		"--mount",
		`type=volume,src=${resources.skillsVolume},dst=${NATIVE_SKILLS_ROOT},readonly`,
		"--read-only",
		"--tmpfs",
		"/tmp:rw,noexec,nosuid,nodev,size=256m,mode=1777",
		"--cap-drop",
		"ALL",
		"--security-opt",
		"no-new-privileges:true",
		"--pids-limit",
		"256",
		"--memory",
		"2g",
		"--cpus",
		"2",
		"--stop-timeout",
		"15",
		image,
		"sleep",
		"infinity",
	];
}

export function backendUrlForContainer(value) {
	const url = new URL(normalizeBackendUrl(value));
	if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
		url.hostname = "host.docker.internal";
	}
	return url.toString().replace(/\/+$/, "");
}

export function runtimeContainerNeedsReplacement(container, image = IMAGE, imageId) {
	return (
		container?.Config?.Image !== image ||
		(typeof imageId === "string" && container?.Image !== imageId) ||
		container?.Config?.Labels?.["dev.divo.runtime-mode"] !== RUNTIME_CONTAINER_MODE
	);
}

/** Run a command to completion, turning a non-zero exit into a readable error. */
export async function runProcess(file, args, options = {}) {
	try {
		return await execFileAsync(file, args, {
			encoding: "utf8",
			maxBuffer: 10 * 1024 * 1024,
			...options,
		});
	} catch (error) {
		const detail = error.stderr?.trim() || error.stdout?.trim() || error.message;
		throw new Error(`${file} ${args[0]} failed: ${detail}`);
	}
}

export async function runWithInput(file, args, input) {
	return new Promise((resolve, reject) => {
		const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code === 0) resolve({ stdout, stderr });
			else reject(new Error(`${file} ${args[0]} failed: ${stderr.trim() || stdout.trim()}`));
		});
		child.stdin.end(input);
	});
}

async function docker(args, options) {
	return runProcess("docker", args, options);
}

async function dockerObjectExists(kind, name) {
	try {
		await docker([kind, "inspect", name]);
		return true;
	} catch {
		return false;
	}
}

/**
 * The image's immutable ID, or `null` when the tag names nothing.
 *
 * Existence and identity come from one `docker image inspect` because they
 * always used to come from two: a `dockerObjectExists` probe that threw its
 * output away, followed by the inspect that re-fetched it. Every Docker CLI
 * call is a process spawn on a path that runs before every single turn.
 */
export async function resolveImageId(image = IMAGE) {
	let result;
	try {
		result = await docker(["image", "inspect", image]);
	} catch {
		return null;
	}
	const [metadata] = JSON.parse(result.stdout);
	if (typeof metadata?.Id !== "string" || !metadata.Id) {
		throw new Error(`Docker image ${image} has no resolved image ID`);
	}
	return metadata.Id;
}

/**
 * Run independent Docker probes concurrently, and do not return until every one
 * of them has finished.
 *
 * Deliberately not `Promise.all`, which rejects the moment the first task fails
 * and leaves the rest running. Here that would mean throwing out of
 * `ensureRuntime` while a `docker volume create` is still in flight, so the
 * caller starts cleaning up — or retrying — against a profile that is still
 * being mutated. Waiting costs nothing on the failure path and makes "this
 * function threw" mean "nothing it started is still running".
 *
 * The first task to fail by argument order is the one thrown, so the reported
 * error does not depend on which probe happened to lose the race.
 */
export async function settleAll(tasks) {
	const results = await Promise.allSettled(tasks);
	const failure = results.find(result => result.status === "rejected");
	if (failure) throw failure.reason;
	return results.map(result => result.value);
}

/**
 * The profile's container, or `null` when it does not exist.
 *
 * Absence returns null; a container that exists but is *not* ours still throws.
 * Collapsing "does it exist" and "is it ours" into one inspect keeps the
 * ownership check on every path that previously ran the two separately, without
 * paying for the same inspect twice.
 */
export async function findOwnedContainer(profile) {
	const resources = resourcesFor(profile);
	let result;
	try {
		result = await docker(["container", "inspect", resources.container]);
	} catch {
		return null;
	}
	const [container] = JSON.parse(result.stdout);
	if (
		container?.Config?.Labels?.["dev.divo.profile"] !== profile ||
		container?.Config?.Labels?.["dev.divo.volume"] !== resources.volume
	) {
		throw new Error(
			`Refusing unowned or mismatched Docker container: ${resources.container}`,
		);
	}
	return container;
}

async function inspectOwnedContainer(profile) {
	const container = await findOwnedContainer(profile);
	if (!container) {
		throw new Error(
			`Docker container is missing: ${resourcesFor(profile).container}`,
		);
	}
	return container;
}

async function ensureVolume(profile, name) {
	if (await dockerObjectExists("volume", name)) return name;
	await docker([
		"volume",
		"create",
		"--label",
		`dev.divo.profile=${profile}`,
		name,
	]);
	return name;
}

/**
 * Shaped like `ensureVolume` so the network can be established inside the same
 * concurrent batch. Probing the network, then creating it only once the volumes
 * had finished, put its create alone on the critical path — and a `network
 * create` is the most expensive object a group run makes.
 */
async function ensureNetwork(profile, name) {
	if (await dockerObjectExists("network", name)) return name;
	await docker([
		"network",
		"create",
		"--driver",
		"bridge",
		"--label",
		`dev.divo.profile=${profile}`,
		name,
	]);
	return name;
}

/**
 * Create the workspace volume without touching the container or network.
 *
 * Attachments are staged *before* the run starts, so this is often the first
 * thing that ever exists for a new user. Doing the full `ensureRuntime` here
 * would pull an image and create a container for a request that may still be
 * rejected.
 */
export async function ensureProfileVolume(profileName) {
	const profile = validateProfileName(profileName);
	// The staging writer runs from the Pi image. Checking here turns a raw
	// `docker run` failure mid-upload into a clear refusal before any bytes move.
	if (!(await resolveImageId(IMAGE))) {
		throw codedError(
			"runtime_image_missing",
			`Image ${IMAGE} is missing, so attachments cannot be staged.`,
			503,
		);
	}
	return ensureVolume(profile, resourcesFor(profile).volume);
}

/**
 * Make one profile's runtime exist, and report what had to be done.
 *
 * `provisioned` is the caller saying it still holds a live Pi process for this
 * profile. What makes that safe to trust is inductive rather than anything about
 * container state: a warm entry can only exist because an earlier turn in this
 * same controller process already ran this function with `provisioned` false and
 * created the network and all three volumes. The first turn for any profile
 * always takes the full path. So the four probes skipped here re-answer a
 * question this process has already answered once, every turn, forever.
 *
 * The container itself is still inspected every time, because it answers a
 * question the warm process cannot: whether it still carries our ownership
 * labels.
 *
 * `imageId` is resolved by the caller rather than here. It answers the other
 * question a warm process cannot — whether a deploy moved the tag out from
 * under it — and it depends on nothing else the turn has computed, so making it
 * an argument lets the caller overlap that Docker round trip with work this
 * function must wait for anyway. Passing a falsy id means the tag names
 * nothing, which refuses the run before any object is created.
 */
export async function ensureRuntime(profile, { ephemeral = false, provisioned = false, imageId } = {}) {
	const resources = resourcesFor(profile);
	let wasRunning = false;
	let created = false;
	// Told apart from a missing image on purpose. A caller that forgot the
	// argument would otherwise be sent to rebuild an image that is already there.
	if (imageId === undefined) {
		throw new Error("ensureRuntime requires an imageId resolved by the caller");
	}
	if (!imageId) {
		throw new Error(
			`Image ${IMAGE} is missing. Build it with: docker build -t ${IMAGE} .`,
		);
	}
	// The network, both volumes and the container are four unrelated Docker
	// objects. Probing them one after another spent four sequential CLI round
	// trips before every turn to learn what a warm profile already satisfies —
	// and on a group run, which starts from nothing every time, four creates.
	const [existing] = provisioned
		? [await findOwnedContainer(profile)]
		: await settleAll([
			findOwnedContainer(profile),
			ensureNetwork(profile, resources.network),
			ensureVolume(profile, resources.volume),
			ensureVolume(profile, resources.authVolume),
			ensureVolume(profile, resources.skillsVolume),
		]);
	let container = existing;
	if (container) {
		if (runtimeContainerNeedsReplacement(container, IMAGE, imageId)) {
			if (container.State.Running) await docker(["stop", resources.container]);
			await docker(["rm", resources.container]);
			container = undefined;
		} else {
			wasRunning = container.State.Running;
		}
	}
	if (!container) {
		await docker(buildContainerCreateArgs(profile, IMAGE, { ephemeral }));
		container = await inspectOwnedContainer(profile);
		created = true;
	}
	return { resources, wasRunning, created };
}

/**
 * Remove one run-scoped runtime and both of its empty per-run volumes.
 *
 * The profile is derived from a signed lease and every Docker object is
 * inspected through the existing ownership check before removal. A shared run
 * never becomes warm state and therefore cannot leave a later room any bytes.
 */
export async function destroyEphemeralRuntime(profileName) {
	const profile = validateProfileName(profileName);
	if (!profile.startsWith("shared-")) {
		throw new Error(`Refusing to destroy a non-ephemeral runtime: ${profile}`);
	}
	const resources = resourcesFor(profile);
	const container = await findOwnedContainer(profile);
	if (container) {
		if (container.State.Running) await docker(["stop", resources.container]);
		await docker(["rm", resources.container]);
	}
	for (const volume of [resources.authVolume, resources.skillsVolume, resources.volume]) {
		if (await dockerObjectExists("volume", volume)) await docker(["volume", "rm", volume]);
	}
	if (await dockerObjectExists("network", resources.network)) {
		await docker(["network", "rm", resources.network]);
	}
}

export async function startContainer(container) {
	await docker(["start", container]);
}

export async function waitUntilRunning(container, timeoutMs = 10_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const result = await docker([
			"container",
			"inspect",
			"--format",
			"{{.State.Running}}",
			container,
		]);
		if (result.stdout.trim() === "true") return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`Container did not start: ${container}`);
}

async function runVolumeCommand(volume, script, input = "", destination = "/run/divo-auth") {
	return new Promise((resolve, reject) => {
		const child = spawn(
			"docker",
			[
				"run",
				"--rm",
				"--interactive",
				"--mount",
				`type=volume,src=${volume},dst=${destination}`,
				"--entrypoint",
				"/bin/sh",
				IMAGE,
				"-c",
				script,
			],
			{ stdio: ["pipe", "pipe", "pipe"] },
		);
		let stderr = "";
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`Bootstrap volume command failed: ${stderr.trim()}`));
		});
		child.stdin.end(input);
	});
}

export async function deleteDurableSession(volume, thread) {
	const safeThread = validateThread(thread);
	await runVolumeCommand(
		volume,
		`rm -rf -- ${shellQuote(`/data/state/data/threads/${safeThread}`)}`,
		"",
		"/data",
	);
}

export async function deleteProtectedRuntimeSession(runtimeRequest, dependencies = {}) {
	const runtime = runtimeRequest?.runtime ?? runtimeRequest;
	const profile = validateProfileName(runtime?.profile);
	const thread = validateThread(runtime?.thread);
	const volume = resourcesFor(profile).volume;
	const inspectVolume = dependencies.inspectVolume ?? (async (name) => {
		const result = await docker(["volume", "inspect", name]);
		return JSON.parse(result.stdout)?.[0];
	});
	const metadata = await inspectVolume(volume);
	if (metadata?.Labels?.["dev.divo.profile"] !== profile) {
		throw new Error("Refusing protected cleanup for an unowned runtime volume");
	}
	const sessionDir = `/data/state/data/threads/${thread}`;
	const removeSession = dependencies.removeSession ?? (async (name, directory) => {
		await runVolumeCommand(
			name,
			`rm -rf -- ${shellQuote(directory)}\ntest ! -e ${shellQuote(directory)}`,
			"",
			"/data",
		);
	});
	await removeSession(volume, sessionDir);
}

export async function stageNativeSkillBootstrap(
	volume,
	bootstrap,
	scope,
	{ force = false, runStaging = runWithInput, image = IMAGE } = {},
) {
	return stageNativeSkillBootstrapCore(volume, bootstrap, scope, { force, runStaging, image });
}

export function buildBootstrapWriteArgs(container) {
	return [
		"exec",
		"--interactive",
		"--user",
		WORKSPACE_UID_GID,
		container,
		"/bin/sh",
		"-c",
		"umask 077; cat > /run/divo-auth/bootstrap.json",
	];
}

export function buildInterruptionWriteArgs(container) {
	return [
		"exec",
		"--interactive",
		"--user",
		WORKSPACE_UID_GID,
		container,
		"/bin/sh",
		"-c",
		"umask 077; cat > /run/divo-auth/interruption.json",
	];
}

export function buildContainerPrepareArgs(container) {
	return [
		"exec",
		"--interactive",
		"--user",
		WORKSPACE_UID_GID,
		container,
		"node",
		"divo/container-entry.mjs",
		"prepare",
	];
}

export function buildContainerRecordInterruptionArgs(container) {
	return [
		"exec",
		"--interactive",
		"--user",
		WORKSPACE_UID_GID,
		container,
		"node",
		"divo/container-entry.mjs",
		"record-interruption",
	];
}

export function buildContainerRunArgs(container) {
	return [
		"exec",
		"--interactive",
		container,
		"node",
		"divo/container-entry.mjs",
	];
}

export async function writeBootstrap(container, bootstrap) {
	await runWithInput("docker", buildBootstrapWriteArgs(container), JSON.stringify(bootstrap));
}

export async function stageRuntimeInterruption(container, bootstrap) {
	if (
		!isRuntimeChannel(bootstrap.channel)
		|| typeof bootstrap.interruptionTask !== "string"
		|| !bootstrap.interruptionTask
	) {
		return false;
	}
	await runWithInput("docker", buildInterruptionWriteArgs(container), JSON.stringify({
		thread: bootstrap.thread,
		task: bootstrap.interruptionTask,
	}));
	return true;
}

export async function recordRuntimeInterruption(container) {
	const result = await runWithInput("docker", buildContainerRecordInterruptionArgs(container), "");
	let parsed;
	try {
		parsed = JSON.parse(result.stdout);
	} catch {
		throw new Error(`Divo interruption recorder returned invalid JSON: ${result.stdout.slice(0, 160)}`);
	}
	if (parsed?.recorded !== true) {
		throw new Error("Divo interruption recorder did not persist the interrupted work");
	}
}

/**
 * Prepare one warm container for the next turn, handing it the bootstrap.
 *
 * The bootstrap travels on the same stdin the prepare already opened, so a warm
 * turn crosses the Docker daemon once instead of twice.
 */
export async function prepareWarmRuntime(container, bootstrap) {
	const result = await runWithInput(
		"docker",
		buildContainerPrepareArgs(container),
		JSON.stringify(bootstrap),
	);
	let parsed;
	try {
		parsed = JSON.parse(result.stdout);
	} catch {
		throw new Error(`Divo runtime prepare returned invalid JSON: ${result.stdout.slice(0, 160)}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Divo runtime prepare returned an invalid response");
	}
	const environment = parsed.environment;
	if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
		throw new Error("Divo runtime prepare returned an invalid environment patch");
	}
	return environment;
}

export async function clearBootstrap(volume) {
	await runVolumeCommand(volume, "rm -f /run/divo-auth/bootstrap.json");
}

export async function stopOwnedContainer(profile) {
	const resources = resourcesFor(profile);
	const container = await findOwnedContainer(profile);
	if (!container) return;
	if (container.State.Running) await docker(["stop", resources.container]);
}

export async function reconcileOwnedContainers() {
	const results = await Promise.all([
		docker([
			"ps",
			"--all",
			"--filter",
			"label=dev.divo.profile",
			"--format",
			'{{.Label "dev.divo.profile"}}',
		]),
		docker([
			"volume",
			"ls",
			"--filter",
			"label=dev.divo.profile",
			"--format",
			'{{.Label "dev.divo.profile"}}',
		]),
		docker([
			"network",
			"ls",
			"--filter",
			"label=dev.divo.profile",
			"--format",
			'{{.Label "dev.divo.profile"}}',
		]),
	]);
	const profiles = [...new Set(
		results.flatMap(result => result.stdout.split("\n").filter(Boolean)),
	)];
	for (const profileName of profiles) {
		const profile = validateProfileName(profileName);
		if (profile.startsWith("shared-")) {
			// Normal completion removes every shared object immediately. Reaching
			// startup means the controller crashed mid-run; remove the exact
			// signed-run profile before new work is admitted.
			await destroyEphemeralRuntime(profile);
			continue;
		}
		const resources = resourcesFor(profile);
		await stopOwnedContainer(profile);
		if (await dockerObjectExists("volume", resources.authVolume)) {
			await clearBootstrap(resources.authVolume);
		}
	}
	return profiles;
}
