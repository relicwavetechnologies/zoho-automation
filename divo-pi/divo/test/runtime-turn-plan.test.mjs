/**
 * What a turn does, in what order, and how many times.
 *
 * Before the turn plan took its effects as an argument, none of this was
 * assertable: the order of a turn was statement order inside a 300-line body,
 * and the only way to observe it was to run Docker and the backend for real.
 * These tests replace two startup-progress tests and two telemetry-shaper tests
 * — none of which could have caught a turn issuing an extra backend fetch, or
 * issuing its Docker calls in the wrong order. They do *not* replace the argv
 * assertions in `local-rpc-controller.test.mjs`, which cover a different thing:
 * what each Docker command says, rather than which ones a turn issues.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
	defaultTurnEffects,
	promptWithRuntimeLease,
	runRuntimeSessionLifecycle,
} from "../local-rpc-controller.mjs";
import {
	forgetWarmPiProcess,
	getWarmPiProcess,
} from "../runtime-warm-process.mjs";

const PROFILE = "turnplan";

/** What the backend says about a run. Travels in the bootstrap, not a second fetch. */
const RUNTIME_CONTEXT = {
	departmentId: "department-1",
	departmentName: "Finance",
	personaPrompt: "Prefer verified records.",
	version: "2026-08-15T00:00:00.000Z",
	personalMemory: [],
	surface: { key: "lark" },
};
const CONTAINER = `divo-pi-local-${PROFILE}`;
const DIGESTABLE_SKILL = {
	id: "skill-1",
	slug: "expenses",
	name: "Expenses",
	description: "Company expense workflow",
	instructions: "PRIVATE RECIPE: never leave the volume",
	revision: 3,
};

/**
 * Stands in for the live Pi process on the other side of `docker exec`.
 *
 * Answers the two commands a turn sends and then ends the run, so a turn
 * completes without a container, a model, or a network.
 */
function fakeRpc(log) {
	return {
		configure() {},
		beginRun() {},
		// Records the event it was asked for. Ignoring the argument meant the turn
		// could wait on any event at all and every assertion here still passed.
		waitFor(event) {
			log.push(`rpc waitFor ${event}`);
			return Promise.resolve({
				messages: [
					{ role: "user", content: [{ type: "text", text: "hi" }] },
					{
						role: "assistant",
						stopReason: "stop",
						usage: { input: 12, output: 3 },
						content: [{ type: "text", text: "done" }],
					},
				],
			});
		},
		async send(request) {
			log.push(`rpc ${request.type}`);
			if (request.type === "get_state") return { sessionId: "session-1", isStreaming: false };
			return {};
		},
	};
}

/**
 * A recording adapter for every effect that leaves the process.
 *
 * `log` is the assertion surface: one line per effect, in the order the turn
 * issued it.
 */
function recordingEffects({ log, wasRunning = true, created = false } = {}) {
	const rpc = fakeRpc(log);
	return {
		rpc,
		effects: {
			now: (() => {
				let value = 0;
				return () => (value += 10);
			})(),
			// Never throws, because the real sink is `console.error` and never throws.
			// Parsing every `[Pi] ` line as JSON made the plain-text soft-abort
			// failure line blow up inside the abort closure, which silently skipped
			// the entire hard-interrupt fallback and made it look untested-but-fine.
			log: (line) => log.push(
				line.startsWith("[Pi] {") ? `log ${JSON.parse(line.slice(5)).event}` : `log ${line}`,
			),
			logAnswer: (line) => log.push(`answer ${line}`),
			async fetchRunContext() {
				log.push("backend fetchRunContext");
				return {
					runtimeContext: RUNTIME_CONTEXT,
					nativeSkills: { registryRevision: 4, skills: [DIGESTABLE_SKILL] },
				};
			},
			async resolveImageId() {
				log.push("docker image inspect");
				return "sha256:image";
			},
			async activateIdleContainer() {
				log.push("idle activate");
			},
			async ensureRuntime(_profile, options) {
				log.push(`docker container inspect provisioned=${options.provisioned} imageId=${options.imageId}`);
				return {
					resources: {
						container: CONTAINER,
						volume: CONTAINER,
						authVolume: `${CONTAINER}-auth`,
						skillsVolume: `${CONTAINER}-skills`,
					},
					wasRunning,
					created,
				};
			},
			async stageNativeSkills(_volume, _bootstrap, _scope, options) {
				log.push(`docker stage force=${options.force}`);
				return { digest: "a".repeat(64), staged: false };
			},
			async startContainer() {
				log.push("docker start");
			},
			async waitUntilRunning() {
				log.push("docker wait");
			},
			async writeBootstrap() {
				log.push("docker exec writeBootstrap");
			},
			async prepareWarmRuntime() {
				log.push("docker exec prepare");
				return { DIVO_BACKEND_URL: "http://backend" };
			},
			async deleteDurableSession() {
				log.push("docker deleteDurableSession");
			},
			spawnRuntimeRpc() {
				log.push("docker exec run");
				// Modelled on the real `docker exec` child rather than stubbed: it
				// exits when its stdin closes, and not before. A promise that is
				// already resolved makes `rememberWarmPiProcess` drop the entry the
				// instant it is registered, so every warm assertion silently tests a
				// cold turn; one that never resolves hangs every path that waits for
				// the process to close. Only the real rule satisfies both.
				let exit;
				const exited = new Promise((resolve) => {
					exit = resolve;
				});
				const stdin = {
					destroyed: false,
					writableEnded: false,
					end() {
						this.writableEnded = true;
						exit({ code: 0 });
					},
				};
				return { child: { stdin }, exited, rpc };
			},
			async finalizeRuntimeLifecycle() {
				log.push("finalize");
			},
			async abortRuntimeInPlace() {
				log.push("rpc abort (soft)");
				return { protectedDataUsed: false, protectedRefs: [] };
			},
			async stageRuntimeInterruption() {
				log.push("docker exec stageInterruption");
				return true;
			},
			async stopOwnedContainer() {
				log.push("docker stop");
			},
		},
	};
}

function runtimeRequest() {
	return {
		profile: PROFILE,
		thread: "thread-1",
		backendUrl: "http://backend",
		token: "member-token",
		userId: "user-1",
		companyId: "company-1",
		departmentId: "department-1",
		channel: "lark",
		runId: "run-1",
		trustedSession: { userId: "user-1", companyId: "company-1", departments: [] },
	};
}

test("a cold turn issues each effect once, in order", async () => {
	forgetWarmPiProcess(PROFILE);
	const log = [];
	const { effects } = recordingEffects({ log, wasRunning: false, created: true });
	const result = await promptWithRuntimeLease(runtimeRequest(), "hello", {}, effects);

	assert.equal(result.text, "done");
	assert.deepEqual(log.filter(line => line.startsWith("docker") || line.startsWith("backend")), [
		"docker image inspect",
		"backend fetchRunContext",
		"docker container inspect provisioned=false imageId=sha256:image",
		"docker stage force=true",
		"docker start",
		"docker wait",
		"docker exec writeBootstrap",
		"docker exec run",
	]);
	forgetWarmPiProcess(PROFILE);
});

test("the image inspect is in flight before the skill fetch resolves", async () => {
	forgetWarmPiProcess(PROFILE);
	const log = [];
	const { effects } = recordingEffects({ log });
	// Deliberately no handshake between the two: each simply records when it ran,
	// so re-serialising the pair fails this assertion instead of deadlocking it.
	effects.fetchRunContext = async () => {
		log.push("fetch:start");
		await new Promise((resolve) => setImmediate(resolve));
		log.push("fetch:end");
		return {
			runtimeContext: RUNTIME_CONTEXT,
			nativeSkills: { registryRevision: 4, skills: [DIGESTABLE_SKILL] },
		};
	};
	effects.resolveImageId = async () => {
		log.push("image:done");
		return "sha256:image";
	};
	await promptWithRuntimeLease(runtimeRequest(), "hello", {}, effects);

	// The image inspect finishing before the fetch does is the whole point: it
	// did not wait its turn. Serialising the pair puts a Docker round trip on the
	// critical path of every turn for no reason, and moves `image:done` last.
	assert.ok(
		log.indexOf("image:done") < log.indexOf("fetch:end"),
		`image resolve waited for the skill fetch: ${log.filter(l => l.includes(":")).join(", ")}`,
	);
	forgetWarmPiProcess(PROFILE);
});

test("a warm turn skips the container start, the bootstrap write and the handshake", async () => {
	forgetWarmPiProcess(PROFILE);
	const log = [];
	const { effects, rpc } = recordingEffects({ log });
	// Prime the warm entry the way a completed previous turn leaves it. The
	// binding has to match what this turn computes or the process is discarded.
	await promptWithRuntimeLease(runtimeRequest(), "first", {}, effects);
	const warmed = log.length;
	await promptWithRuntimeLease(runtimeRequest(), "second", {}, effects);
	const second = log.slice(warmed);

	assert.deepEqual(second.filter(line => line.startsWith("docker") || line.startsWith("rpc")), [
		"docker image inspect",
		"docker container inspect provisioned=true imageId=sha256:image",
		"docker stage force=false",
		"docker exec prepare",
		"rpc set_environment",
		"rpc waitFor agent_end",
		"rpc prompt",
	]);
	assert.equal(second.includes("docker exec run"), false, "a warm turn must not spawn a second Pi");
	assert.equal(second.includes("rpc get_state"), false, "a warm turn already knows its session");
	assert.ok(rpc);
	forgetWarmPiProcess(PROFILE);
});

test("a turn makes exactly one backend fetch before the model is prompted", async () => {
	forgetWarmPiProcess(PROFILE);
	const log = [];
	const { effects } = recordingEffects({ log });
	await promptWithRuntimeLease(runtimeRequest(), "hello", {}, effects);
	const beforePrompt = log.slice(0, log.indexOf("rpc prompt"));
	assert.equal(beforePrompt.filter(line => line.startsWith("backend")).length, 1);
	forgetWarmPiProcess(PROFILE);
});

test("the turn record reports every phase, including the model and the teardown", async () => {
	forgetWarmPiProcess(PROFILE);
	const lines = [];
	const log = [];
	const { effects } = recordingEffects({ log });
	effects.log = (line) => lines.push(line);
	effects.logAnswer = (line) => lines.push(line);
	await promptWithRuntimeLease(runtimeRequest(), "hello", {}, effects);

	const turn = JSON.parse(
		lines.find(line => line.includes('"pi_runtime.turn"')).slice("[Pi] ".length),
	);
	assert.equal(turn.outcome, "completed");
	assert.equal(turn.sessionScope, "thread");
	// The two phases that dominate a real turn, and that nothing measured before.
	assert.ok(Object.hasOwn(turn.phases, "model"), "the model phase must be measured");
	assert.ok(Object.hasOwn(turn.phases, "finalize"), "the teardown must be measured");
	assert.deepEqual(
		Object.keys(turn.phases).filter(name => ["image", "skills", "runtime", "stage"].includes(name)),
		["image", "skills", "runtime", "stage"],
	);
	forgetWarmPiProcess(PROFILE);
});

test("the ready event states cold and warm turns field for field", async () => {
	forgetWarmPiProcess(PROFILE);
	const lines = [];
	const log = [];
	const { effects } = recordingEffects({ log, wasRunning: false, created: true });
	effects.log = (line) => lines.push(line);
	effects.logAnswer = (line) => lines.push(line);

	const readyEvent = () => JSON.parse(
		lines.filter(line => line.includes('"pi_runtime.ready"')).at(-1).slice("[Pi] ".length),
	);
	// The clock advances 10ms per read, so every duration below is exact rather
	// than merely plausible. Asserting the whole object is deliberate: this event
	// is the only machine-readable account of why a turn was cold or warm, and
	// each field has been wrong at least once.
	await promptWithRuntimeLease(runtimeRequest(), "first", {}, effects);
	assert.deepEqual(readyEvent(), {
		event: "pi_runtime.ready",
		mode: "cold",
		replacementReason: "no_cached_process",
		readyMs: 30,
		// A cold turn reused no process, so there was no prepare to time. Naming
		// the cold bootstrap write "prepare" reclassifies every cold turn for
		// anyone grouping on this field.
		prepareMs: 0,
		nativeSkillDigest: readyEvent().nativeSkillDigest,
		audience: "private",
		sessionScope: "thread",
	});
	// Truncated, because the digest is derived from the company's skill bodies.
	assert.equal(readyEvent().nativeSkillDigest.length, 12);

	await promptWithRuntimeLease(runtimeRequest(), "second", {}, effects);
	const warm = readyEvent();
	assert.equal(warm.mode, "warm");
	assert.equal(warm.replacementReason, "none");
	assert.ok(warm.prepareMs > 0, "a warm turn reports the prepare it actually paid for");
	assert.ok(warm.readyMs >= warm.prepareMs);
	forgetWarmPiProcess(PROFILE);
});

test("a cold container tells the member it is waking up; a warm one does not", async () => {
	forgetWarmPiProcess(PROFILE);
	const cold = [];
	await promptWithRuntimeLease(
		runtimeRequest(),
		"hello",
		{ onProgress: (event) => cold.push(event) },
		recordingEffects({ log: [], wasRunning: false, created: true }).effects,
	);
	// A cold start is a ten-second wait. Collapsing this to the generic "working"
	// event leaves the member watching nothing happen, and no assertion on the
	// ready event would notice.
	assert.deepEqual(cold.filter(event => event.type === "starting"), [
		{ type: "starting", stage: "workspace", label: "Checking your workspace…" },
		{ type: "starting", stage: "container", label: "Waking up Divo…" },
	]);

	forgetWarmPiProcess(PROFILE);
	const warm = [];
	await promptWithRuntimeLease(
		runtimeRequest(),
		"hello",
		{ onProgress: (event) => warm.push(event) },
		recordingEffects({ log: [], wasRunning: true, created: false }).effects,
	);
	assert.deepEqual(warm.filter(event => event.type === "starting"), []);
	assert.equal(warm.filter(event => event.type === "working").length, 1);

	// The third case, and the one a reader is most likely to simplify away: the
	// member's own container still exists but the idle scheduler stopped it. This
	// turn pays `startContainer` and `waitUntilRunning` and is deliberately still
	// generic, because the container is theirs and was not rebuilt. Reducing the
	// condition to `wasRunning` alone flips exactly this branch.
	forgetWarmPiProcess(PROFILE);
	const restarted = [];
	await promptWithRuntimeLease(
		runtimeRequest(),
		"hello",
		{ onProgress: (event) => restarted.push(event) },
		recordingEffects({ log: [], wasRunning: false, created: false }).effects,
	);
	assert.deepEqual(restarted.filter(event => event.type === "starting"), []);
	assert.equal(restarted.filter(event => event.type === "working").length, 1);
	forgetWarmPiProcess(PROFILE);
});

test("a failing image inspect never becomes an unhandled rejection", async () => {
	forgetWarmPiProcess(PROFILE);
	const unhandled = [];
	const capture = (reason) => unhandled.push(reason);
	process.on("unhandledRejection", capture);
	try {
		const log = [];
		const { effects } = recordingEffects({ log });
		// The image inspect is started before the run and awaited inside it. When
		// the skill fetch throws first, nothing ever awaits the inspect — and an
		// unhandled rejection takes down the controller process, and with it every
		// other run admitted into the same container.
		effects.resolveImageId = async () => {
			throw new Error("image inspect blew up");
		};
		effects.fetchRunContext = async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
			throw new Error("member session expired");
		};
		await assert.rejects(
			promptWithRuntimeLease(runtimeRequest(), "hello", {}, effects),
			// The fetch is awaited first, so the fetch is the failure a member is
			// told about. The image failure must not overtake it.
			/member session expired/,
		);
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.deepEqual(unhandled, []);
	} finally {
		process.off("unhandledRejection", capture);
		forgetWarmPiProcess(PROFILE);
	}
});

test("a bad image still fails from inside the run, with its teardown and its record", async () => {
	forgetWarmPiProcess(PROFILE);
	const lines = [];
	const log = [];
	const { effects } = recordingEffects({ log });
	effects.log = (line) => lines.push(line);
	effects.logAnswer = (line) => lines.push(line);
	effects.resolveImageId = async () => {
		throw new Error("image inspect blew up");
	};
	await assert.rejects(
		promptWithRuntimeLease(runtimeRequest(), "hello", {}, effects),
		/image inspect blew up/,
	);
	// Resolving the image used to happen inside `ensureRuntime`, so a bad image
	// got the teardown and the phase record that any in-run failure gets. Hoisting
	// the inspect out must not have moved that failure in front of them.
	assert.ok(log.includes("finalize"), "teardown still runs for a bad image");
	assert.ok(lines.some(line => line.includes('"pi_runtime.turn"')));
	assert.equal(log.includes("docker container inspect provisioned=false imageId=undefined"), false);
	forgetWarmPiProcess(PROFILE);
});

test("a replaced process says why, and a shared run says it is shared", async () => {
	forgetWarmPiProcess(PROFILE);
	const lines = [];
	const log = [];
	const { effects } = recordingEffects({ log });
	effects.log = (line) => lines.push(line);
	effects.logAnswer = (line) => lines.push(line);
	const eventNamed = (name) => JSON.parse(
		lines.filter(line => line.includes(`"${name}"`)).at(-1).slice("[Pi] ".length),
	);

	await promptWithRuntimeLease(runtimeRequest(), "first", {}, effects);
	// A different catalogue is a different binding, so the warm process cannot be
	// reused. `replacementReason` is the only account of why, and it is now built
	// from an object literal in the middle of the turn rather than by a function
	// with its own test.
	effects.fetchRunContext = async () => ({
		runtimeContext: RUNTIME_CONTEXT,
		nativeSkills: { registryRevision: 9, skills: [DIGESTABLE_SKILL] },
	});
	await promptWithRuntimeLease(runtimeRequest(), "second", {}, effects);
	assert.equal(eventNamed("pi_runtime.ready").mode, "restarted");
	assert.equal(eventNamed("pi_runtime.ready").replacementReason, "native_skill_digest_changed");

	forgetWarmPiProcess(PROFILE);
	const shared = [];
	const sharedEffects = recordingEffects({ log: [] }).effects;
	sharedEffects.log = (line) => shared.push(line);
	sharedEffects.logAnswer = (line) => shared.push(line);
	await promptWithRuntimeLease(
		{ ...runtimeRequest(), profile: "shared-run1", ephemeral: true },
		"hello",
		{ sessionScope: "run" },
		sharedEffects,
	);
	for (const name of ["pi_runtime.ready", "native_skills.ready", "pi_runtime.turn"]) {
		const event = JSON.parse(
			shared.filter(line => line.includes(`"${name}"`)).at(-1).slice("[Pi] ".length),
		);
		assert.equal(event.audience, "shared", `${name} must mark a shared run shared`);
		assert.equal(event.sessionScope, "run");
	}
	forgetWarmPiProcess("shared-run1");
	forgetWarmPiProcess(PROFILE);
});

test("a member pressing stop is recorded as interrupted, not failed", async () => {
	forgetWarmPiProcess(PROFILE);
	const lines = [];
	const log = [];
	const { effects } = recordingEffects({ log });
	effects.log = (line) => lines.push(line);
	effects.logAnswer = (line) => lines.push(line);
	const controller = new AbortController();
	// Warm the profile first so the soft-interrupt path is the one taken: it needs
	// a reusable process, which is what a member stopping a follow-up turn has.
	await promptWithRuntimeLease(runtimeRequest(), "first", {}, effects);

	const { effects: second } = recordingEffects({ log });
	second.log = effects.log;
	second.logAnswer = effects.logAnswer;
	second.abortRuntimeInPlace = effects.abortRuntimeInPlace;
	second.stageRuntimeInterruption = effects.stageRuntimeInterruption;
	second.stopOwnedContainer = effects.stopOwnedContainer;
	second.prepareWarmRuntime = async () => {
		controller.abort();
		await new Promise((resolve) => setImmediate(resolve));
		throw new Error("request disconnected");
	};
	await assert.rejects(promptWithRuntimeLease(
		runtimeRequest(),
		"second",
		{ signal: controller.signal },
		second,
	));

	const turn = JSON.parse(
		lines.filter(line => line.includes('"pi_runtime.turn"')).at(-1).slice("[Pi] ".length),
	);
	// Counting a stop as a failure makes every failure-rate view built on this
	// event wrong from its first day.
	assert.equal(turn.outcome, "interrupted");
	// The interrupt path reaches Docker exactly as the ordered turn does, and is
	// now visible to the same recorder.
	assert.ok(
		lines.some(line => line.includes('"pi_runtime.interrupted"')),
		"the interrupt itself is reported through the same sink",
	);
	forgetWarmPiProcess(PROFILE);
});

test("a turn that never reached the run is still recorded", async () => {
	forgetWarmPiProcess(PROFILE);
	const lines = [];
	const log = [];
	const { effects } = recordingEffects({ log });
	effects.log = (line) => lines.push(line);
	effects.logAnswer = (line) => lines.push(line);
	// An expired member token or a backend 5xx on the skill bootstrap fails the
	// turn before any container work begins. A record emitted from the teardown
	// never covers this, so a failure-rate view reads zero for exactly the outage
	// class an operator most needs to see.
	effects.fetchRunContext = async () => {
		const error = new Error("member session expired");
		error.status = 401;
		throw error;
	};
	await assert.rejects(
		promptWithRuntimeLease(runtimeRequest(), "hello", {}, effects),
		/member session expired/,
	);
	const turn = JSON.parse(
		lines.find(line => line.includes('"pi_runtime.turn"')).slice("[Pi] ".length),
	);
	assert.equal(turn.outcome, "failed");
	assert.equal(turn.sessionScope, "thread");
	assert.ok(Object.hasOwn(turn.phases, "skills"), "the phase that failed is still reported");
	assert.equal(log.includes("finalize"), false, "no teardown runs for a turn that never started");
	forgetWarmPiProcess(PROFILE);
});

test("a failed turn still reports where its time went", async () => {
	forgetWarmPiProcess(PROFILE);
	const lines = [];
	const log = [];
	const { effects } = recordingEffects({ log });
	effects.log = (line) => lines.push(line);
	effects.logAnswer = (line) => lines.push(line);
	effects.ensureRuntime = async () => {
		throw new Error("image is missing");
	};
	await assert.rejects(
		promptWithRuntimeLease(runtimeRequest(), "hello", {}, effects),
		/image is missing/,
	);
	const turn = JSON.parse(
		lines.find(line => line.includes('"pi_runtime.turn"')).slice("[Pi] ".length),
	);
	assert.equal(turn.outcome, "failed");
	assert.ok(turn.phases.skills > 0, "the phases that did run are still reported");
	forgetWarmPiProcess(PROFILE);
});

test("skill telemetry carries counts and timing, never skill content", async () => {
	forgetWarmPiProcess(PROFILE);
	const lines = [];
	const log = [];
	const { effects } = recordingEffects({ log });
	effects.log = (line) => lines.push(line);
	effects.logAnswer = (line) => lines.push(line);
	await promptWithRuntimeLease(runtimeRequest(), "hello", {}, effects);

	const ready = lines.find(line => line.includes('"native_skills.ready"'));
	const event = JSON.parse(ready.slice("[Pi] ".length));
	assert.equal(event.registryRevision, 4);
	assert.equal(event.skillCount, 1);
	assert.equal(event.digest.length, 12);
	assert.equal(typeof event.fetchMs, "number");
	assert.equal(typeof event.stageMs, "number");
	// The instructions are the company's private procedure. They reach the volume
	// and nothing else. `lines` has to cover the answer sink as well as the log
	// one, or this reads as a guarantee about every line the turn wrote while
	// only inspecting some of them.
	assert.ok(lines.some(line => line === "done"), "the answer sink is part of what is inspected");
	assert.doesNotMatch(lines.join("\n"), /PRIVATE RECIPE/);
	forgetWarmPiProcess(PROFILE);
});

test("the warm entry a turn leaves behind carries its session id", async () => {
	forgetWarmPiProcess(PROFILE);
	const log = [];
	const { effects } = recordingEffects({ log });
	await promptWithRuntimeLease(runtimeRequest(), "hello", {}, effects);
	// An entry remembered without its session id logged `session undefined` on
	// every later turn that reused it, and nothing failed when it happened.
	assert.equal(getWarmPiProcess(PROFILE)?.sessionId, "session-1");
	forgetWarmPiProcess(PROFILE);
});

test("a soft interrupt that fails falls back to staging the work and stopping the container", async () => {
	forgetWarmPiProcess(PROFILE);
	const log = [];
	const { effects } = recordingEffects({ log });
	await promptWithRuntimeLease(runtimeRequest(), "first", {}, effects);

	const controller = new AbortController();
	const { effects: second } = recordingEffects({ log });
	for (const key of ["log", "logAnswer", "stageRuntimeInterruption", "stopOwnedContainer"]) {
		second[key] = effects[key];
	}
	// The soft path is the one that keeps the member's session. When it fails, the
	// run has to still record what it was doing and stop the container — otherwise
	// a stop leaves a live Pi holding the member's token.
	second.abortRuntimeInPlace = async () => {
		log.push("rpc abort (soft)");
		throw new Error("Pi did not become idle after abort");
	};
	second.prepareWarmRuntime = async () => {
		controller.abort();
		await new Promise((resolve) => setImmediate(resolve));
		throw new Error("request disconnected");
	};
	const before = log.length;
	await assert.rejects(promptWithRuntimeLease(
		runtimeRequest(),
		"second",
		{ signal: controller.signal },
		second,
	));
	const after = log.slice(before);
	assert.ok(after.includes("rpc abort (soft)"), "the soft path is tried first");
	assert.ok(after.includes("docker exec stageInterruption"), "interrupted work is staged");
	assert.ok(after.includes("docker stop"), "the container is stopped");
	forgetWarmPiProcess(PROFILE);
});

test("a session lifecycle operation deletes the session and never prompts the model", async () => {
	for (const [lifecycle, expected] of [["delete", 1], ["reset", 1]]) {
		forgetWarmPiProcess(PROFILE);
		const log = [];
		const { effects } = recordingEffects({ log });
		await runRuntimeSessionLifecycle(runtimeRequest(), lifecycle, {}, effects);
		assert.equal(
			log.filter(line => line === "docker deleteDurableSession").length,
			expected,
			`${lifecycle} must delete the durable session exactly once`,
		);
		assert.equal(
			log.includes("rpc prompt"),
			false,
			`${lifecycle} must not send the model a prompt`,
		);
		forgetWarmPiProcess(PROFILE);
	}
});

test("a stop that lands before the run starts is still a stop", async () => {
	forgetWarmPiProcess(PROFILE);
	const lines = [];
	const log = [];
	const { effects } = recordingEffects({ log });
	effects.log = (line) => lines.push(line);
	effects.logAnswer = (line) => lines.push(line);
	const controller = new AbortController();
	// A web client that disconnects during lease resolution aborts before the
	// turn's own abort listener exists, so nothing classifies it. Without the
	// wrapper's fallback the member's own stop is filed as a failure.
	controller.abort();
	await assert.rejects(
		promptWithRuntimeLease(runtimeRequest(), "hello", { signal: controller.signal }, effects),
		/interrupted before container start/,
	);
	const turn = JSON.parse(
		lines.find(line => line.includes('"pi_runtime.turn"')).slice("[Pi] ".length),
	);
	assert.equal(turn.outcome, "interrupted");
	assert.deepEqual(turn.phases, {}, "no phase ran, and none is invented");
	forgetWarmPiProcess(PROFILE);
});

test("a lifecycle operation is recorded like any other turn", async () => {
	forgetWarmPiProcess(PROFILE);
	const lines = [];
	const log = [];
	const { effects } = recordingEffects({ log });
	effects.log = (line) => lines.push(line);
	effects.logAnswer = (line) => lines.push(line);
	await runRuntimeSessionLifecycle(runtimeRequest(), "reset", {}, effects);
	const turn = JSON.parse(
		lines.find(line => line.includes('"pi_runtime.turn"')).slice("[Pi] ".length),
	);
	assert.equal(turn.outcome, "completed");
	assert.equal(turn.sessionScope, "thread");
	forgetWarmPiProcess(PROFILE);
});

test("a turn whose teardown fails is not recorded as completed", async () => {
	forgetWarmPiProcess(PROFILE);
	const lines = [];
	const log = [];
	const { effects } = recordingEffects({ log });
	effects.log = (line) => lines.push(line);
	effects.logAnswer = (line) => lines.push(line);
	// The run reaches its answer and sets `completedSuccessfully`, then cleanup
	// throws and the member gets an error. Reading the outcome off the run alone
	// files that turn as a success.
	effects.finalizeRuntimeLifecycle = async () => {
		throw new Error("Divo runtime cleanup failed");
	};
	await assert.rejects(
		promptWithRuntimeLease(runtimeRequest(), "hello", {}, effects),
		/cleanup failed/,
	);
	const turn = JSON.parse(
		lines.find(line => line.includes('"pi_runtime.turn"')).slice("[Pi] ".length),
	);
	assert.equal(turn.outcome, "failed");
	forgetWarmPiProcess(PROFILE);
});

test("a shared run rejected by validation is still recorded as shared", async () => {
	const lines = [];
	const { effects } = recordingEffects({ log: [] });
	effects.log = (line) => lines.push(line);
	effects.logAnswer = (line) => lines.push(line);
	await assert.rejects(
		promptWithRuntimeLease(
			{ ...runtimeRequest(), profile: "shared-run2", ephemeral: true },
			"hello",
			{ sessionScope: "thread" },
			effects,
		),
		/shared runtime must use a run-scoped session/,
	);
	const turn = JSON.parse(
		lines.find(line => line.includes('"pi_runtime.turn"')).slice("[Pi] ".length),
	);
	assert.equal(turn.audience, "shared");
	assert.equal(turn.outcome, "failed");
});

test("a stop that arrives while a failed turn is being torn down is not a stop", async () => {
	forgetWarmPiProcess(PROFILE);
	const lines = [];
	const log = [];
	const { effects } = recordingEffects({ log });
	effects.log = (line) => lines.push(line);
	effects.logAnswer = (line) => lines.push(line);
	const controller = new AbortController();
	// Warm first, so the failure lands where teardown has real work to do — that
	// is the window a late abort arrives in.
	await promptWithRuntimeLease(runtimeRequest(), "first", {}, effects);
	// The run then fails for its own reason, and the member's browser gives up
	// while the warm Pi is still draining. Reading abort state at log time would
	// file a backend failure as a member stop — the mirror of the miscount this
	// field exists to prevent.
	effects.prepareWarmRuntime = async () => {
		throw new Error("prepare exploded");
	};
	effects.finalizeRuntimeLifecycle = async () => {
		controller.abort();
		await new Promise((resolve) => setImmediate(resolve));
	};
	await assert.rejects(
		promptWithRuntimeLease(runtimeRequest(), "second", { signal: controller.signal }, effects),
		/prepare exploded/,
	);
	const turn = JSON.parse(
		lines.filter(line => line.includes('"pi_runtime.turn"')).at(-1).slice("[Pi] ".length),
	);
	assert.equal(turn.outcome, "failed");
	forgetWarmPiProcess(PROFILE);
});

test("every effect the turn calls is one production actually supplies", async () => {
	// The binding between what `runTurn` calls and what production wires up used
	// to be import resolution, which failed at load time when a name was wrong.
	// It is now an object-literal key lookup, and every test supplies its own
	// table — so a renamed or forgotten key is invisible to the whole suite and
	// shows up as a TypeError on the first real turn. Derived from the source for
	// the same reason `controller-image-packaging.test.mjs` derives the Dockerfile
	// allowlist from the real import graph: a second hand-written list is the bug.
	const source = await readFile(
		new URL("../local-rpc-controller.mjs", import.meta.url),
		"utf8",
	);
	const called = new Set(
		[...source.matchAll(/\beffects\.([A-Za-z][A-Za-z0-9]*)/g)].map(match => match[1]),
	);
	assert.ok(called.size > 10, `expected to find the effect call sites, found ${called.size}`);

	const supplied = new Set(Object.keys(defaultTurnEffects));
	const missing = [...called].filter(name => !supplied.has(name)).sort();
	assert.deepEqual(missing, [], "the turn calls effects production does not supply");

	const unread = [...supplied].filter(name => !called.has(name)).sort();
	assert.deepEqual(unread, [], "production supplies effects the turn never calls");

	for (const name of supplied) {
		assert.equal(
			typeof defaultTurnEffects[name],
			"function",
			`${name} must be callable`,
		);
	}
});

test("a stop during the model phase is recorded as a stop", async () => {
	forgetWarmPiProcess(PROFILE);
	const lines = [];
	const log = [];
	const { effects } = recordingEffects({ log });
	effects.log = (line) => lines.push(line);
	effects.logAnswer = (line) => lines.push(line);
	await promptWithRuntimeLease(runtimeRequest(), "first", {}, effects);

	const controller = new AbortController();
	// The commonest real interrupt: the member is watching the answer arrive and
	// presses stop. The other interrupt tests abort during prepare, a different
	// branch — and this second turn is warm, so the stop has to be driven through
	// the process the first turn left behind rather than through a fresh spawn.
	const warm = getWarmPiProcess(PROFILE);
	const send = warm.rpc.send.bind(warm.rpc);
	warm.rpc.send = async (request) => {
		if (request.type !== "prompt") return send(request);
		controller.abort();
		await new Promise((resolve) => setImmediate(resolve));
		throw new Error("request disconnected");
	};
	await assert.rejects(promptWithRuntimeLease(
		runtimeRequest(),
		"second",
		{ signal: controller.signal },
		effects,
	));
	const turn = JSON.parse(
		lines.filter(line => line.includes('"pi_runtime.turn"')).at(-1).slice("[Pi] ".length),
	);
	assert.equal(turn.outcome, "interrupted");
	forgetWarmPiProcess(PROFILE);
});

test("a turn thrown away mid-inspect does not claim the inspect was instant", async () => {
	forgetWarmPiProcess(PROFILE);
	const lines = [];
	const log = [];
	const { effects } = recordingEffects({ log });
	effects.log = (line) => lines.push(line);
	effects.logAnswer = (line) => lines.push(line);
	// The image inspect is deliberately left running when the skill fetch throws.
	// Reporting it as 0 would tell an operator a Docker round trip was instant.
	effects.resolveImageId = () => new Promise(() => {});
	effects.fetchRunContext = async () => {
		throw new Error("member session expired");
	};
	await assert.rejects(
		promptWithRuntimeLease(runtimeRequest(), "hello", {}, effects),
		/member session expired/,
	);
	const turn = JSON.parse(
		lines.find(line => line.includes('"pi_runtime.turn"')).slice("[Pi] ".length),
	);
	assert.equal(turn.phases.image, null);
	assert.equal(typeof turn.phases.skills, "number");
	forgetWarmPiProcess(PROFILE);
});
