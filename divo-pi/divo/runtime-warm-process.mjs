/**
 * Whether the next turn reuses the process and container the last one left
 * behind, and when either is finally let go.
 *
 * One question decides everything here: is the runtime a caller is about to use
 * bound to the *same* profile, thread, backend, department, model and skill
 * catalogue as the one already running? If any of those moved, the cached
 * process is discarded rather than reused, because reuse would silently run the
 * turn under the previous binding's authority.
 *
 * The rest is teardown timing: a finished thread runtime is kept warm for a
 * while because stopping it makes the *next* turn pay a cold boot, a shared run
 * is destroyed outright, and a failed run never keeps anything.
 */
import {
	clearBootstrap,
	destroyEphemeralRuntime,
	stopOwnedContainer,
} from "./runtime-docker.mjs";

/**
 * How long a finished DM runtime stays running before it is stopped.
 *
 * Stopping is what makes the *next* turn cold: it discards the tmpfs holding the
 * transpile cache, so the following run pays the full boot again. An idle
 * container is `sleep infinity` under cgroup limits — it holds no CPU and only
 * the few megabytes its tmpfs already contains — so a short window buys almost
 * nothing back and charges the user for it on their next message.
 */
export const RUNTIME_IDLE_TIMEOUT_MS = 45 * 60_000;
export const RUNTIME_STOP_RETRY_MS = 30_000;
const WARM_PI_EXIT_TIMEOUT_MS = 5_000;

const warmPiProcesses = new Map();

export function canReusePiProcess({
	enabled = process.env.DIVO_PI_KEEPALIVE !== "false",
	ephemeral = false,
	nativeSkillDigest = "",
	sessionScope = "thread",
	lifecycle,
} = {}) {
	return enabled && !ephemeral && /^[a-f0-9]{64}$/.test(nativeSkillDigest)
		&& sessionScope === "thread" && lifecycle === undefined;
}

/**
 * Everything fixed at the moment Pi is launched.
 *
 * A warm process may serve the next turn only when every one of these is
 * unchanged, because none of them can be changed afterwards — the extension
 * list, the tool allowlist, the skill directories and the model are all command
 * line arguments, decided once and then frozen for the life of the process.
 *
 * So the rule for adding a field is exactly that: **if it is an input to how Pi
 * is launched, it belongs here.** `channel` was added to `scopedManifest` and not
 * to this record, and the result was a container launched for one surface
 * serving another surface's turns with the first one's tools — silently, because
 * a missing tool is not an error, it is an absence the model works around.
 */
export function piProcessBinding({
	profile,
	thread,
	backendUrl,
	departmentId,
	selectedModel,
	nativeSkillDigest,
	channel,
}) {
	return {
		profile,
		thread,
		backendUrl,
		departmentId: departmentId ?? "",
		provider: selectedModel?.provider ?? "",
		model: selectedModel?.model ?? "",
		nativeSkillDigest: nativeSkillDigest ?? "",
		channel: channel ?? "",
	};
}

export function piProcessBindingMatches(current, next) {
	return Boolean(current && next)
		&& current.profile === next.profile
		&& current.thread === next.thread
		&& current.backendUrl === next.backendUrl
		&& current.departmentId === next.departmentId
		&& current.provider === next.provider
		&& current.model === next.model
		&& current.nativeSkillDigest === next.nativeSkillDigest
		&& current.channel === next.channel;
}

export function piProcessBindingMismatchReason(current, next) {
	if (!current) return "no_cached_process";
	if (!next) return "invalid_next_binding";
	if (current.profile !== next.profile) return "profile_changed";
	if (current.thread !== next.thread) return "thread_changed";
	if (current.backendUrl !== next.backendUrl) return "backend_changed";
	if (current.departmentId !== next.departmentId) return "department_changed";
	if (current.provider !== next.provider) return "provider_changed";
	if (current.model !== next.model) return "model_changed";
	if (current.nativeSkillDigest !== next.nativeSkillDigest) return "native_skill_digest_changed";
	if (current.channel !== next.channel) return "channel_changed";
	return "none";
}

export function endRuntimeInput(child) {
	if (child && !child.stdin.destroyed && !child.stdin.writableEnded) {
		child.stdin.end();
	}
}

async function waitForWarmPiExit(entry) {
	const waitOrTimeout = () => new Promise((resolve) => {
		const timer = setTimeout(() => resolve({ timedOut: true }), WARM_PI_EXIT_TIMEOUT_MS);
		timer.unref?.();
	});
	const first = await Promise.race([entry.exited, waitOrTimeout()]);
	if (!first?.timedOut) return first;
	entry.child.kill("SIGTERM");
	return await Promise.race([entry.exited, waitOrTimeout()]);
}

export async function assertRuntimeExit(outcome) {
	if (outcome?.timedOut) {
		throw new Error("Divo runtime did not exit after stdin closed");
	}
	if (outcome?.error) throw outcome.error;
	if (outcome?.code !== 0) {
		throw new Error(
			`Divo runtime exited ${outcome?.terminationSignal ? `with ${outcome.terminationSignal}` : `with code ${outcome?.code}`}`,
		);
	}
}

export async function waitForClosedRuntime(child, exited) {
	endRuntimeInput(child);
	const outcome = await exited;
	await assertRuntimeExit(outcome);
}

export function getWarmPiProcess(profile) {
	return warmPiProcesses.get(profile);
}

export function hasWarmPiProcess(profile) {
	return warmPiProcesses.has(profile);
}

export async function discardWarmPiProcess(profile) {
	const entry = warmPiProcesses.get(profile);
	if (!entry) return undefined;
	if (warmPiProcesses.get(profile) === entry) warmPiProcesses.delete(profile);
	endRuntimeInput(entry.child);
	return await waitForWarmPiExit(entry);
}

export function forgetWarmPiProcess(profile) {
	warmPiProcesses.delete(profile);
}

async function stopWarmRuntime(profile) {
	await discardWarmPiProcess(profile);
	await stopOwnedContainer(profile);
}

export function rememberWarmPiProcess(profile, entry) {
	warmPiProcesses.set(profile, entry);
	void entry.exited.finally(() => {
		if (warmPiProcesses.get(profile) === entry) warmPiProcesses.delete(profile);
	});
}

export function createIdleContainerScheduler({
	stop,
	idleTimeoutMs = RUNTIME_IDLE_TIMEOUT_MS,
	retryDelayMs = RUNTIME_STOP_RETRY_MS,
	setTimer = setTimeout,
	clearTimer = clearTimeout,
	onError = (error) => console.error(`[Pi] Failed to stop idle container: ${error.message}`),
}) {
	const timers = new Map();
	const stopping = new Map();
	const trackedProfiles = new Set();
	let shuttingDown = false;

	const schedule = (profile, delay) => {
		if (shuttingDown) return;
		const previous = timers.get(profile);
		if (previous) clearTimer(previous);
		const timer = setTimer(() => stopAfterIdle(profile), delay);
		timer.unref?.();
		timers.set(profile, timer);
		trackedProfiles.add(profile);
	};

	const stopAfterIdle = (profile) => {
		timers.delete(profile);
		const work = Promise.resolve().then(() => stop(profile));
		stopping.set(profile, work);
		void work.then(
			() => {
				if (stopping.get(profile) === work) stopping.delete(profile);
				trackedProfiles.delete(profile);
			},
			(error) => {
				if (stopping.get(profile) === work) stopping.delete(profile);
				onError(error);
				schedule(profile, retryDelayMs);
			},
		);
	};

	const cancel = async (profile) => {
		while (true) {
			const timer = timers.get(profile);
			if (timer) {
				clearTimer(timer);
				timers.delete(profile);
			}
			const work = stopping.get(profile);
			if (!work) break;
			await work.catch(() => {});
		}
		trackedProfiles.delete(profile);
	};

	return {
		async activate(profile) {
			await cancel(profile);
		},
		keepWarm(profile) {
			schedule(profile, idleTimeoutMs);
		},
		async stopNow(profile) {
			await cancel(profile);
			try {
				await stop(profile);
			} catch (error) {
				onError(error);
				schedule(profile, retryDelayMs);
				throw error;
			}
		},
		async shutdown() {
			shuttingDown = true;
			const profiles = [...trackedProfiles];
			for (const timer of timers.values()) clearTimer(timer);
			timers.clear();
			await Promise.allSettled(stopping.values());
			await Promise.all(profiles.map(profile => stop(profile)));
			trackedProfiles.clear();
		},
	};
}

export const idleContainers = createIdleContainerScheduler({ stop: stopWarmRuntime });

/**
 * Teardown that a reply is no longer waiting on.
 *
 * Removing a shared run's container, its two volumes and its network costs a
 * third of a second of Docker round trips, and it used to sit between the
 * model's last token and the reply reaching Lark — the room waited on work done
 * purely to reclaim resources.
 *
 * Leaking is not the price: `reconcileOwnedContainers` destroys every stray
 * `shared-` profile at controller startup, so backgrounding trades a removal
 * guaranteed *now* for one guaranteed by the next start. Shutdown drains this
 * set so an orderly stop still finishes what it began.
 */
const reclaiming = new Set();

export function trackRuntimeReclamation(
	profile,
	work,
	onError = (error) => console.error(`[Pi] ${error.message}`),
) {
	let settled;
	settled = work.then(
		() => undefined,
		(error) => onError(
			new Error(`Divo runtime reclamation failed for profile "${profile}": ${error.message}`),
		),
	).finally(() => {
		reclaiming.delete(settled);
	});
	reclaiming.add(settled);
	return settled;
}

export async function shutdownWarmContainers() {
	await Promise.allSettled([...warmPiProcesses.keys()].map(profile => discardWarmPiProcess(profile)));
	await idleContainers.shutdown();
	await Promise.allSettled([...reclaiming]);
}

export async function finalizeRuntimeLifecycle({
	profile,
	resources,
	bootstrapAttempted,
	completedSuccessfully,
	runError,
	abortStop,
	retainRuntimeProcess = false,
	ephemeral = false,
}, {
	clearBootstrapFn = clearBootstrap,
	scheduler = idleContainers,
	destroyRuntimeFn = destroyEphemeralRuntime,
	reclaimFn = trackRuntimeReclamation,
	onCleanupError = (error) => console.error(
		`[Pi] ${error.message}: ${error.errors.map(String).join("; ")}`,
	),
} = {}) {
	const cleanupErrors = [];
	// Only a run that failed can still be holding the token. Reaching completion
	// means container-entry read the bootstrap, and it unlinks the file the moment
	// it does, so clearing again spends a throwaway container deleting nothing.
	// A run that died earlier may never have read it, and that one still needs it.
	if (bootstrapAttempted && !completedSuccessfully) {
		try {
			await clearBootstrapFn(resources.authVolume);
		} catch (error) {
			cleanupErrors.push(error);
		}
	}
	const abortError = await abortStop;
	if (abortError) cleanupErrors.push(abortError);
	if (ephemeral) {
		// A run that produced an answer has nothing left to decide, so its
		// teardown is reclamation and the room should not wait for it. A run that
		// failed still tears down synchronously: nobody is waiting on a reply
		// there, and a cleanup failure has to stay able to surface.
		if (completedSuccessfully && cleanupErrors.length === 0) {
			reclaimFn(profile, destroyRuntimeFn(profile));
		} else {
			try {
				await destroyRuntimeFn(profile);
			} catch (error) {
				cleanupErrors.push(error);
			}
		}
	} else if ((completedSuccessfully || retainRuntimeProcess) && cleanupErrors.length === 0) {
		scheduler.keepWarm(profile);
	} else {
		try {
			await scheduler.stopNow(profile);
		} catch (error) {
			cleanupErrors.push(error);
		}
	}
	if (cleanupErrors.length === 0) return;
	const cleanupError = new AggregateError(
		cleanupErrors,
		`Divo runtime cleanup failed for profile "${profile}"`,
	);
	if (runError) onCleanupError(cleanupError);
	else throw cleanupError;
}
