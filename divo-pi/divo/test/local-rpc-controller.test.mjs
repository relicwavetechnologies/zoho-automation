import assert from "node:assert/strict";
import test from "node:test";
import {
	assertExpectedLogin,
	assertPinnedProfile,
	approveHeadlessWorkspaceAction,
	backendUrlForContainer,
	buildBootstrapWriteArgs,
	buildContainerCreateArgs,
	collectProtectedRunMetadata,
	createIdleContainerScheduler,
	deleteProtectedRuntimeSession,
	finalizeRuntimeLifecycle,
	loadToken,
	logCompletedRun,
	RUNTIME_IDLE_TIMEOUT_MS,
	RUNTIME_STOP_RETRY_MS,
	resourcesFor,
	runtimeIdentityNames,
	runtimeContainerNeedsReplacement,
	runtimeStartupProgress,
	settleAll,
	trackRuntimeReclamation,
	validateProfileName,
	validateRuntimeModel,
	validateThread,
} from "../local-rpc-controller.mjs";

test("concurrent runtime probes return their values in order", async () => {
	const order = [];
	const probe = (value, delayMs) => new Promise((resolve) => {
		setTimeout(() => {
			order.push(value);
			resolve(value);
		}, delayMs);
	});
	// Slowest first: the caller destructures positionally, so a result array
	// ordered by completion instead of by argument would hand `ensureRuntime`
	// the container where it expects the network's existence.
	const values = await settleAll([probe("network", 20), probe("container", 1)]);
	assert.deepEqual(values, ["network", "container"]);
	assert.deepEqual(order, ["container", "network"]);
});

test("a failing runtime probe waits for the others before it throws", async () => {
	let slowSettled = false;
	const failedFirst = Promise.reject(new Error("container is not ours"));
	const stillMutating = new Promise((_resolve, reject) => {
		setTimeout(() => {
			slowSettled = true;
			reject(new Error("volume create failed"));
		}, 10);
	});
	await assert.rejects(settleAll([failedFirst, stillMutating]), /container is not ours/);
	// `Promise.all` would have thrown while the volume create was still running,
	// handing the caller an error about a profile Docker was still mutating.
	assert.equal(slowSettled, true);
});

test("startup progress names newly created work only", () => {
	assert.deepEqual(runtimeStartupProgress({ wasRunning: true, created: false }), [{ type: "working" }]);
	assert.deepEqual(runtimeStartupProgress({ wasRunning: false, created: false }), [{ type: "working" }]);
	assert.deepEqual(runtimeStartupProgress({ wasRunning: false, created: true }), [
		{ type: "starting", stage: "workspace", label: "Checking your workspace…" },
		{ type: "starting", stage: "container", label: "Waking up Divo…" },
	]);
});

const protectedCustomerRef = {
	provider: "shopify",
	connectionId: "11111111-1111-4111-8111-111111111111",
	resourceType: "customer",
	resourceId: "gid://shopify/Customer/123456789",
};

test("protected metadata comes only from a linked successful gateway tool result", () => {
	const metadata = collectProtectedRunMetadata([
		{ role: "user", content: [{ type: "text", text: "Check customer" }] },
		{
			role: "assistant",
			content: [
				{ type: "text", text: 'protectedData: { "used": true }' },
				{ type: "toolCall", id: "call-1", name: "divo_gateway", arguments: {} },
			],
		},
		{
			role: "toolResult",
			toolCallId: "call-1",
			details: {
				ok: true,
				status: "success",
				data: {
					toolId: "shopifyCustomers",
					protectedData: {
						used: true,
						provider: "shopify",
						connectionId: protectedCustomerRef.connectionId,
						category: "customers",
						references: [protectedCustomerRef],
					},
				},
			},
		},
	]);

	assert.deepEqual(metadata, {
		protectedDataUsed: true,
		protectedRefs: [protectedCustomerRef],
		protectedProvenanceValid: true,
	});
	assert.deepEqual(collectProtectedRunMetadata([{
		role: "assistant",
		content: [{ type: "text", text: JSON.stringify(metadata) }],
	}]), { protectedDataUsed: false, protectedRefs: [] });
});

test("zero-match protected gateway results still mark the run protected", () => {
	assert.deepEqual(collectProtectedRunMetadata([
		{ role: "user", content: [] },
		{ role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "divo_gateway" }] },
		{
			role: "toolResult",
			toolCallId: "call-1",
			details: {
				ok: true,
				status: "success",
				data: { protectedData: {
					used: true,
					provider: "shopify",
					connectionId: protectedCustomerRef.connectionId,
					category: "customers",
					references: [],
				} },
			},
		},
	]), {
		protectedDataUsed: true,
		protectedRefs: [],
		protectedProvenanceValid: true,
	});
});

test("a protected gateway attempt remains protected when the tool returns an error", () => {
	assert.deepEqual(collectProtectedRunMetadata([
		{ role: "user", content: [] },
		{
			role: "assistant",
			content: [{
				type: "toolCall",
				id: "call-1",
				name: "divo_gateway",
				arguments: {
					op: "tools.invoke",
					payload: { toolId: "shopifyOrders", args: { operation: "list_orders" } },
				},
			}],
		},
		{ role: "toolResult", toolCallId: "call-1", isError: true, details: { status: "permission_denied" } },
	]), {
		protectedDataUsed: true,
		protectedRefs: [],
		protectedProvenanceValid: true,
	});
});

test("protected completion logs never contain final text", () => {
	const lines = [];
	logCompletedRun("private customer answer", { protectedDataUsed: true }, line => lines.push(line));
	logCompletedRun("ordinary answer", { protectedDataUsed: false }, line => lines.push(line));
	assert.deepEqual(lines, [
		"[divo-pi] protected run completed; final text suppressed",
		"ordinary answer",
	]);
});

test("default protected cleanup targets only the signed runtime's owned thread", async () => {
	const calls = [];
	await deleteProtectedRuntimeSession(
		{ profile: "cloud-derived", thread: "thread-current" },
		{
			inspectVolume: async name => ({ Labels: { "dev.divo.profile": "cloud-derived" }, name }),
			removeSession: async (volume, directory) => calls.push({ volume, directory }),
		},
	);
	assert.deepEqual(calls, [{
		volume: "divo-pi-local-cloud-derived",
		directory: "/data/state/data/threads/thread-current",
	}]);
});

test("protected cleanup refuses a volume not owned by the signed runtime", async () => {
	let removed = false;
	await assert.rejects(
		deleteProtectedRuntimeSession(
			{ profile: "cloud-derived", thread: "thread-current" },
			{
				inspectVolume: async () => ({ Labels: { "dev.divo.profile": "another-user" } }),
				removeSession: async () => { removed = true; },
			},
		),
		/unowned runtime volume/,
	);
	assert.equal(removed, false);
});

test("startup progress names cold work only and keeps warm runs generic", () => {
	assert.deepEqual(runtimeStartupProgress({ wasRunning: true, created: false }), [{ type: "working" }]);
	assert.deepEqual(runtimeStartupProgress({ wasRunning: false, created: true }), [
		{ type: "starting", stage: "workspace", label: "Checking your workspace…" },
		{ type: "starting", stage: "container", label: "Waking up Divo…" },
	]);
});

test("two profiles receive distinct Docker resources", () => {
	const abhishek = resourcesFor("abhishek");
	const anish = resourcesFor("anish");
	assert.notEqual(abhishek.container, anish.container);
	assert.notEqual(abhishek.network, anish.network);
	assert.notEqual(abhishek.volume, anish.volume);
	assert.notEqual(abhishek.authVolume, anish.authVolume);
	assert.equal(abhishek.volume, "divo-pi-local-abhishek");
	assert.equal(anish.volume, "divo-pi-local-anish");
});

test("deployments can isolate Docker resources with distinct prefixes", () => {
	assert.equal(resourcesFor("abhishek", "divo-pi-dev").volume, "divo-pi-dev-abhishek");
	assert.equal(resourcesFor("abhishek", "divo-pi-main").volume, "divo-pi-main-abhishek");
});

test("cloud runtime names are stable, isolated, and safe for Docker", () => {
	const first = runtimeIdentityNames("company-1", "user-1", "lark:chat-1");
	const sameUserOtherThread = runtimeIdentityNames("company-1", "user-1", "lark:chat-2");
	const otherUser = runtimeIdentityNames("company-1", "user-2", "lark:chat-1");

	assert.equal(first.profile, sameUserOtherThread.profile);
	assert.notEqual(first.thread, sameUserOtherThread.thread);
	assert.notEqual(first.profile, otherUser.profile);
	assert.equal(first.runtimeThreadId, "lark:chat-1");
	assert.notEqual(first.thread, first.runtimeThreadId);
	assert.equal(validateProfileName(first.profile), first.profile);
	assert.equal(validateThread(first.thread), first.thread);
});

test("shared runtimes receive a unique disposable profile instead of the private user profile", () => {
	const privateRuntime = runtimeIdentityNames("company-1", "user-1", "lark:chat-1");
	const firstShared = runtimeIdentityNames(
		"company-1",
		"user-1",
		"lark:chat-1",
		{ contextAudience: "shared", runId: "run-1" },
	);
	const secondShared = runtimeIdentityNames(
		"company-1",
		"user-1",
		"lark:chat-1",
		{ contextAudience: "shared", runId: "run-2" },
	);

	assert.equal(privateRuntime.ephemeral, false);
	assert.equal(firstShared.ephemeral, true);
	assert.match(firstShared.profile, /^shared-[a-f0-9]{20}$/);
	assert.notEqual(firstShared.profile, privateRuntime.profile);
	assert.notEqual(firstShared.profile, secondShared.profile);
	assert.throws(
		() => runtimeIdentityNames("company-1", "user-1", "lark:chat-1", { contextAudience: "shared" }),
		/shared runtime requires a run identity/i,
	);
});

test("headless mode allows isolated workspace work but not company mutations", () => {
	assert.equal(approveHeadlessWorkspaceAction(
		"divo_approval_v1",
		JSON.stringify({ source: "bash", presentation: { command: "python report.py" } }),
	), true);
	assert.equal(approveHeadlessWorkspaceAction(
		"divo_approval_v1",
		JSON.stringify({ source: "write", presentation: { path: "report.md" } }),
	), true);
	assert.equal(approveHeadlessWorkspaceAction(
		"divo_approval_v1",
		JSON.stringify({ source: "divo", intentId: "server-bound-intent" }),
	), false);
	assert.equal(approveHeadlessWorkspaceAction("other", "{}"), false);
	assert.equal(approveHeadlessWorkspaceAction("divo_approval_v1", "not-json"), false);
});

test("container creation is hardened and contains no member secret", () => {
	const args = buildContainerCreateArgs("abhishek", "divo-pi:test");
	const serialized = args.join(" ");
	assert.match(serialized, /--interactive/);
	assert.match(serialized, /--read-only/);
	assert.match(serialized, /--cap-drop ALL/);
	assert.match(serialized, /no-new-privileges:true/);
	assert.match(serialized, /type=volume,src=divo-pi-local-abhishek,dst=\/data/);
	assert.match(
		serialized,
		/type=volume,src=divo-pi-local-abhishek-auth,dst=\/run\/divo-auth/,
	);
	assert.match(serialized, /--network divo-pi-local-abhishek/);
	assert.match(serialized, /--add-host host\.docker\.internal:host-gateway/);
	assert.match(serialized, /dev\.divo\.runtime-mode=exec-v1/);
	assert.match(serialized, /divo-pi:test sleep infinity$/);
	assert.doesNotMatch(serialized, /token|password|secret/i);
});

test("a running owned container receives bootstrap through docker exec", () => {
	assert.deepEqual(
		buildBootstrapWriteArgs("divo-pi-local-abhishek"),
		[
			"exec",
			"--interactive",
			"--user",
			"10001:10001",
			"divo-pi-local-abhishek",
			"/bin/sh",
			"-c",
			"umask 077; cat > /run/divo-auth/bootstrap.json",
		],
	);
});

test("a shared container mounts only its run-specific disposable volumes", () => {
	const shared = runtimeIdentityNames(
		"company-1",
		"user-1",
		"lark:chat-1",
		{ contextAudience: "shared", runId: "run-1" },
	);
	const privateRuntime = runtimeIdentityNames("company-1", "user-1", "lark:chat-1");
	const serialized = buildContainerCreateArgs(shared.profile, "divo-pi:test", { ephemeral: true }).join(" ");

	assert.match(serialized, /dev\.divo\.ephemeral=true/);
	assert.match(serialized, new RegExp(`src=${resourcesFor(shared.profile).volume},dst=/data`));
	assert.doesNotMatch(serialized, new RegExp(resourcesFor(privateRuntime.profile).volume));
});

test("cloud container creation can remove the host gateway route", () => {
	const args = buildContainerCreateArgs("abhishek", "divo-pi:test", {
		addHostGateway: false,
	});
	assert.doesNotMatch(args.join(" "), /host\.docker\.internal|host-gateway/);
});

test("a runtime container is replaced only when its image changes", () => {
	const container = {
		Image: "sha256:old-image",
		Config: {
			Image: "ghcr.io/relicwavetechnologies/divo-pi:dev-old",
			Labels: { "dev.divo.runtime-mode": "exec-v1" },
		},
	};
	assert.equal(
		runtimeContainerNeedsReplacement(
			container,
			"ghcr.io/relicwavetechnologies/divo-pi:dev-new",
		),
		true,
	);
	assert.equal(
		runtimeContainerNeedsReplacement(
			container,
			"ghcr.io/relicwavetechnologies/divo-pi:dev-old",
			"sha256:old-image",
		),
		false,
	);
	assert.equal(
		runtimeContainerNeedsReplacement(
			container,
			"ghcr.io/relicwavetechnologies/divo-pi:dev-old",
			"sha256:new-image",
		),
		true,
	);
	assert.equal(
		runtimeContainerNeedsReplacement({
			Config: {
				Image: "ghcr.io/relicwavetechnologies/divo-pi:dev-old",
				Labels: {},
			},
		}, "ghcr.io/relicwavetechnologies/divo-pi:dev-old"),
		true,
	);
});

test("a successful runtime stays warm for ten minutes and cancellation wins the race", async () => {
	let scheduled;
	let releaseStop;
	const stopped = [];
	const scheduler = createIdleContainerScheduler({
		stop: async (profile) => {
			stopped.push(profile);
			await new Promise((resolve) => {
				releaseStop = resolve;
			});
		},
		setTimer: (callback, delay) => {
			scheduled = { callback, delay, cancelled: false, unref() {} };
			return scheduled;
		},
		clearTimer: (timer) => {
			timer.cancelled = true;
		},
	});

	scheduler.keepWarm("abhishek");
	assert.equal(scheduled.delay, RUNTIME_IDLE_TIMEOUT_MS);
	await scheduler.activate("abhishek");
	assert.equal(scheduled.cancelled, true);
	assert.deepEqual(stopped, []);

	scheduler.keepWarm("abhishek");
	scheduled.callback();
	const activated = scheduler.activate("abhishek");
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(stopped, ["abhishek"]);
	releaseStop();
	await activated;
});

test("a failed idle stop remains tracked and retries", async () => {
	const scheduled = [];
	let attempts = 0;
	const scheduler = createIdleContainerScheduler({
		stop: async () => {
			attempts += 1;
			if (attempts === 1) throw new Error("docker unavailable");
		},
		setTimer: (callback, delay) => {
			const timer = { callback, delay, unref() {} };
			scheduled.push(timer);
			return timer;
		},
		clearTimer: () => {},
		onError: () => {},
	});

	scheduler.keepWarm("abhishek");
	scheduled[0].callback();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(attempts, 1);
	assert.equal(scheduled[1].delay, RUNTIME_STOP_RETRY_MS);

	scheduled[1].callback();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(attempts, 2);
	await scheduler.shutdown();
	assert.equal(attempts, 2);
});

test("credential cleanup failure stops the container instead of keeping it warm", async () => {
	const calls = [];
	const scheduler = {
		keepWarm: () => calls.push("warm"),
		stopNow: async () => calls.push("stop"),
	};

	await assert.rejects(
		finalizeRuntimeLifecycle({
			profile: "abhishek",
			resources: { authVolume: "auth-volume" },
			bootstrapAttempted: true,
			completedSuccessfully: false,
		}, {
			clearBootstrapFn: async () => {
				calls.push("clear");
				throw new Error("clear failed");
			},
			scheduler,
		}),
		AggregateError,
	);
	assert.deepEqual(calls, ["clear", "stop"]);
});

test("a finished group run stops waiting on its own teardown", async () => {
	let destroyed = false;
	// A teardown that finishes on its own, so a version that waits for it fails
	// the assertion below instead of deadlocking the suite.
	const destroying = new Promise((resolve) => setTimeout(resolve, 20));
	const backgrounded = [];
	let reclamation;
	await finalizeRuntimeLifecycle({
		profile: "shared-8f2c",
		resources: { authVolume: "shared-8f2c-auth" },
		bootstrapAttempted: true,
		completedSuccessfully: true,
		ephemeral: true,
	}, {
		destroyRuntimeFn: async () => {
			await destroying;
			destroyed = true;
		},
		reclaimFn: (profile, work) => {
			backgrounded.push(profile);
			reclamation = work;
			return work;
		},
		scheduler: { keepWarm: () => {}, stopNow: async () => {} },
	});
	// The room has its answer while Docker is still removing the container,
	// its two volumes and its network — a third of a second the reply used to
	// wait through.
	assert.equal(destroyed, false);
	assert.deepEqual(backgrounded, ["shared-8f2c"]);
	await reclamation;
	assert.equal(destroyed, true);
});

test("a failed group run tears down before it reports, and the failure still surfaces", async () => {
	const calls = [];
	await assert.rejects(
		finalizeRuntimeLifecycle({
			profile: "shared-8f2c",
			resources: { authVolume: "shared-8f2c-auth" },
			bootstrapAttempted: false,
			completedSuccessfully: false,
			ephemeral: true,
		}, {
			destroyRuntimeFn: async () => {
				calls.push("destroy");
				throw new Error("network rm failed");
			},
			reclaimFn: () => calls.push("backgrounded"),
			scheduler: { keepWarm: () => {}, stopNow: async () => {} },
		}),
		AggregateError,
	);
	// Nobody is waiting on a reply here, so the teardown stays synchronous and
	// its failure stays reportable. The absent "backgrounded" is the point.
	assert.deepEqual(calls, ["destroy"]);
});

test("background reclamation reports its failure instead of rejecting", async () => {
	const reported = [];
	await trackRuntimeReclamation(
		"shared-8f2c",
		Promise.reject(new Error("network rm failed")),
		(error) => reported.push(error.message),
	);
	assert.equal(reported.length, 1);
	assert.match(reported[0], /shared-8f2c.*network rm failed/);
});

test("a completed run is kept warm without spending a container to clear the bootstrap", async () => {
	const calls = [];
	await finalizeRuntimeLifecycle({
		profile: "abhishek",
		resources: { authVolume: "auth-volume" },
		bootstrapAttempted: true,
		completedSuccessfully: true,
	}, {
		clearBootstrapFn: async () => calls.push("clear"),
		scheduler: {
			keepWarm: () => calls.push("warm"),
			stopNow: async () => calls.push("stop"),
		},
	});
	// container-entry already unlinked it; the absent "clear" is the point.
	assert.deepEqual(calls, ["warm"]);
});

test("a startup failure stops the container even before bootstrap is written", async () => {
	const calls = [];
	const runError = new Error("docker start failed");
	await finalizeRuntimeLifecycle({
		profile: "abhishek",
		resources: { authVolume: "auth-volume" },
		bootstrapAttempted: false,
		completedSuccessfully: false,
		runError,
	}, {
		clearBootstrapFn: async () => calls.push("clear"),
		scheduler: {
			keepWarm: () => calls.push("warm"),
			stopNow: async () => calls.push("stop"),
		},
		onCleanupError: () => calls.push("cleanup-error"),
	});
	assert.deepEqual(calls, ["stop"]);
});

test("a shared runtime is destroyed immediately and is never kept warm", async () => {
	const calls = [];
	await finalizeRuntimeLifecycle({
		profile: "shared-0123456789abcdef0123",
		resources: { authVolume: "shared-auth-volume" },
		bootstrapAttempted: true,
		completedSuccessfully: true,
		ephemeral: true,
	}, {
		clearBootstrapFn: async () => calls.push("clear"),
		destroyRuntimeFn: async () => calls.push("destroy"),
		scheduler: {
			keepWarm: () => calls.push("warm"),
			stopNow: async () => calls.push("stop"),
		},
	});
	// A successful container-entry already unlinked its bootstrap. Destroying the
	// disposable container and volumes is the remaining isolation boundary.
	assert.deepEqual(calls, ["destroy"]);
});

test("loopback backend URLs are translated only for the container", () => {
	assert.equal(
		backendUrlForContainer("http://127.0.0.1:8000"),
		"http://host.docker.internal:8000",
	);
	assert.equal(
		backendUrlForContainer("https://backend.example"),
		"https://backend.example",
	);
});

test("profile and thread names cannot escape controller-owned resources", () => {
	assert.equal(validateProfileName("Abhishek"), "abhishek");
	assert.equal(validateThread("lark.oc_123"), "lark.oc_123");
	assert.throws(() => validateProfileName("../anish"), /Profile must use/);
	assert.throws(() => validateThread("../../anish"), /Thread must contain/);
});

test("controller rejects an authenticated identity swapped between profiles", () => {
	assert.doesNotThrow(() =>
		assertPinnedProfile(
			{ profile: "abhishek", userId: "user-a", companyId: "company-1" },
			{ userId: "user-a", companyId: "company-1" },
		),
	);
	assert.throws(
		() =>
			assertPinnedProfile(
				{ profile: "abhishek", userId: "user-a", companyId: "company-1" },
				{ userId: "user-b", companyId: "company-1" },
			),
		/does not match pinned profile/,
	);
});

test("login fails closed when the browser authenticates the wrong expected email", () => {
	assert.doesNotThrow(() =>
		assertExpectedLogin(
			{ email: "anishsuman2305@gmail.com" },
			{},
			"AnishSuman2305@gmail.com",
		),
	);
	assert.throws(
		() =>
			assertExpectedLogin(
				{ email: "abhishek@emiactech.com" },
				{},
				"anishsuman2305@gmail.com",
			),
		/Authenticated as .* expected/,
	);
});

test("credential reads are serialized and time out", async () => {
	let releaseFirst;
	let releaseSecond;
	const started = [];
	const readToken = (profile) => {
		started.push(profile);
		return new Promise((resolve) => {
			if (profile === "abhishek") releaseFirst = () => resolve("token-a");
			else releaseSecond = () => resolve("token-b");
		});
	};
	const first = loadToken("abhishek", readToken, 1_000);
	const second = loadToken("anish", readToken, 1_000);
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(started, ["abhishek"]);
	releaseFirst();
	assert.equal(await first, "token-a");
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(started, ["abhishek", "anish"]);
	releaseSecond();
	assert.equal(await second, "token-b");
	await assert.rejects(
		loadToken("stuck", () => new Promise(() => {}), 10),
		/Keychain read timed out/,
	);
});

// The backend names the member's model on the run request. Saying nothing must
// leave the manifest's default in place, because that is what a terminal launch
// and every pre-selection caller sends.
test("an unnamed model leaves the runtime on its default", () => {
	assert.equal(validateRuntimeModel(undefined), undefined);
	assert.equal(validateRuntimeModel(""), undefined);
});

test("a named model carries the provider that serves it", () => {
	assert.deepEqual(validateRuntimeModel("gpt-5.6-luna"), {
		model: "gpt-5.6-luna",
		provider: "openai",
	});
	assert.deepEqual(validateRuntimeModel("deepseek-v4-pro"), {
		model: "deepseek-v4-pro",
		provider: "deepseek",
	});
});

// Rejected rather than passed through: the value becomes a command-line argument
// to the agent, and an unknown one fails the run where the user sees only silence.
test("a model this runtime does not carry is refused by name", () => {
	assert.throws(() => validateRuntimeModel("gpt-4o"), /must be one of/);
	assert.throws(() => validateRuntimeModel({ model: "gpt-5.6-luna" }), /must be one of/);
});
