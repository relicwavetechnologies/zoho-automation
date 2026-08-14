import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	abortRuntimeInPlace,
	approveHeadlessWorkspaceAction,
	collectProtectedRunMetadata,
	loadToken,
	logCompletedRun,
} from "../local-rpc-controller.mjs";
import {
	buildNativeSkillStagingArgs,
	fetchRunContext,
	nativeSkillBootstrapDigest,
	renderNativeSkillFiles,
	validateNativeSkillBootstrap,
} from "../native-skills.mjs";
import {
	assistantThinkingText,
	governedOperation,
	projectRuntimeAnswerDelta,
	projectRuntimeProgress,
} from "../runtime-progress.mjs";
import {
	backendUrlForContainer,
	ensureRuntime,
	buildBootstrapWriteArgs,
	buildContainerCreateArgs,
	buildContainerPrepareArgs,
	buildContainerRecordInterruptionArgs,
	buildContainerRunArgs,
	buildInterruptionWriteArgs,
	deleteProtectedRuntimeSession,
	resourcesFor,
	runtimeContainerNeedsReplacement,
	settleAll,
	stageNativeSkillBootstrap,
} from "../runtime-docker.mjs";
import {
	assertExpectedLogin,
	assertPinnedProfile,
	runtimeIdentityNames,
	trustedRuntimeSession,
	validateProfileName,
	validateRuntimeModel,
	validateThread,
} from "../runtime-identity.mjs";
import {
	RUNTIME_IDLE_TIMEOUT_MS,
	RUNTIME_STOP_RETRY_MS,
	canReusePiProcess,
	createIdleContainerScheduler,
	finalizeRuntimeLifecycle,
	piProcessBindingMatches,
	piProcessBindingMismatchReason,
	trackRuntimeReclamation,
} from "../runtime-warm-process.mjs";

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
				{ type: "toolCall", id: "call-1", name: "divo_zoho_books", arguments: {} },
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
		{ role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "divo_zoho_books" }] },
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
				name: "divo_zoho_books",
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

test("default protected cleanup accepts the admission cleanup request", async () => {
	const calls = [];
	await deleteProtectedRuntimeSession(
		{ runtime: { profile: "cloud-derived", thread: "thread-current" } },
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

test("two profiles receive distinct Docker resources", () => {
	const abhishek = resourcesFor("abhishek");
	const anish = resourcesFor("anish");
	assert.notEqual(abhishek.container, anish.container);
	assert.notEqual(abhishek.network, anish.network);
	assert.notEqual(abhishek.volume, anish.volume);
	assert.notEqual(abhishek.authVolume, anish.authVolume);
	assert.notEqual(abhishek.skillsVolume, anish.skillsVolume);
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

test("trusted runtime session keeps only container bootstrap identity metadata", () => {
	assert.deepEqual(
		trustedRuntimeSession({
			userId: "user-a",
			companyId: "company-1",
			email: "user@example.com",
			token: "must-not-leak",
			departments: [
				{ id: "department-1", name: "Finance", token: "must-not-leak" },
				{ id: "", name: "Ignored" },
				{ id: "department-2", name: "" },
			],
		}),
		{
			userId: "user-a",
			companyId: "company-1",
			departments: [
				{ id: "department-1", name: "Finance" },
				{ id: "department-2" },
			],
		},
	);
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
	assert.notEqual(
		resourcesFor(firstShared.profile).skillsVolume,
		resourcesFor(secondShared.profile).skillsVolume,
	);
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
	assert.match(
		serialized,
		/type=volume,src=divo-pi-local-abhishek-skills,dst=\/run\/divo-skills,readonly/,
	);
	assert.match(serialized, /--network divo-pi-local-abhishek/);
	assert.match(serialized, /--add-host host\.docker\.internal:host-gateway/);
	assert.match(serialized, /dev\.divo\.runtime-mode=exec-v2/);
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
	assert.deepEqual(
		buildInterruptionWriteArgs("divo-pi-local-abhishek"),
		[
			"exec",
			"--interactive",
			"--user",
			"10001:10001",
			"divo-pi-local-abhishek",
			"/bin/sh",
			"-c",
			"umask 077; cat > /run/divo-auth/interruption.json",
		],
	);
});

test("a warm runtime can prepare the cached Pi process through docker exec", () => {
	assert.deepEqual(
		buildContainerPrepareArgs("divo-pi-local-abhishek"),
		[
			"exec",
			"--interactive",
			"--user",
			"10001:10001",
			"divo-pi-local-abhishek",
			"node",
			"divo/container-entry.mjs",
			"prepare",
		],
	);
	assert.deepEqual(
		buildContainerRunArgs("divo-pi-local-abhishek"),
		[
			"exec",
			"--interactive",
			"divo-pi-local-abhishek",
			"node",
			"divo/container-entry.mjs",
		],
	);
});

test("a warm runtime can persist interruption state without stopping", () => {
	assert.deepEqual(
		buildContainerRecordInterruptionArgs("divo-pi-local-abhishek"),
		[
			"exec",
			"--interactive",
			"--user",
			"10001:10001",
			"divo-pi-local-abhishek",
			"node",
			"divo/container-entry.mjs",
			"record-interruption",
		],
	);
});

test("soft abort waits for Pi to become idle and records interrupted work", async () => {
	const calls = [];
	const rpc = {
		send: async (command, timeoutMs) => {
			calls.push({ command, timeoutMs });
			return command.type === "get_state"
				? { isStreaming: false, isCompacting: false }
				: command.type === "get_messages"
					? { messages: [] }
				: undefined;
		},
	};
	await abortRuntimeInPlace({
		rpc,
		container: "divo-pi-local-abhishek",
		bootstrap: { channel: "lark", thread: "thread-1", interruptionTask: "Export orders" },
	}, {
		stageInterruptionFn: async (container, bootstrap) => {
			calls.push({ stage: container, task: bootstrap.interruptionTask });
			return true;
		},
		recordInterruptionFn: async (container) => calls.push({ record: container }),
		timeoutMs: 321,
	});

	assert.deepEqual(calls, [
		{ stage: "divo-pi-local-abhishek", task: "Export orders" },
		{ command: { type: "abort" }, timeoutMs: 321 },
		{ command: { type: "get_state" }, timeoutMs: 321 },
		{ record: "divo-pi-local-abhishek" },
		{ command: { type: "get_messages" }, timeoutMs: 321 },
	]);
});

test("soft abort refuses to retain a runtime that is still active", async () => {
	await assert.rejects(
		abortRuntimeInPlace({
			rpc: {
				send: async (command) => command.type === "get_state"
					? { isStreaming: true, isCompacting: false }
					: undefined,
			},
			container: "divo-pi-local-abhishek",
			bootstrap: {},
		}, {
			stageInterruptionFn: async () => false,
		}),
		/did not become idle/,
	);
});

test("Pi process reuse is limited to compatible private thread runs", () => {
	assert.equal(canReusePiProcess({ sessionScope: "thread" }), false);
	assert.equal(canReusePiProcess({
		sessionScope: "thread",
		nativeSkillDigest: "a".repeat(64),
	}), true);
	assert.equal(canReusePiProcess({ sessionScope: "run" }), false);
	assert.equal(canReusePiProcess({ sessionScope: "thread", ephemeral: true }), false);
	assert.equal(canReusePiProcess({ sessionScope: "thread", lifecycle: "reset" }), false);
	assert.equal(canReusePiProcess({ sessionScope: "thread", enabled: false }), false);

	const binding = {
		profile: "cloud-1",
		thread: "lark-1",
		backendUrl: "http://host.docker.internal:3000",
		departmentId: "dep-1",
		provider: "deepseek",
		model: "deepseek-v4-flash",
		nativeSkillDigest: "a".repeat(64),
	};
	assert.equal(piProcessBindingMatches(binding, { ...binding }), true);
	assert.equal(piProcessBindingMatches(binding, { ...binding, thread: "lark-2" }), false);
	assert.equal(piProcessBindingMatches(binding, { ...binding, departmentId: "dep-2" }), false);
	assert.equal(piProcessBindingMatches(binding, { ...binding, model: "gpt-5.6-luna" }), false);
	assert.equal(piProcessBindingMatches(binding, {
		...binding,
		nativeSkillDigest: "b".repeat(64),
	}), false);
	assert.equal(piProcessBindingMismatchReason(undefined, binding), "no_cached_process");
	assert.equal(piProcessBindingMismatchReason(binding, { ...binding }), "none");
	assert.equal(
		piProcessBindingMismatchReason(binding, { ...binding, thread: "lark-2" }),
		"thread_changed",
	);
	assert.equal(
		piProcessBindingMismatchReason(binding, {
			...binding,
			nativeSkillDigest: "b".repeat(64),
		}),
		"native_skill_digest_changed",
	);
});

test("native DB skill bootstrap accepts a valid governed catalogue", () => {
	const bootstrap = validateNativeSkillBootstrap({
		registryRevision: 7,
		skills: [{
			id: "skill-1",
			slug: "google-sheets",
			name: "Google Sheets",
			description: "Edit sheets safely: read, then write.",
			instructions: "# Google Sheets\n\nUse governed tools.",
			revision: 3,
		}],
	});
	assert.deepEqual(renderNativeSkillFiles(bootstrap), [{
		slug: "google-sheets",
		content: [
			"---",
			"name: google-sheets",
			'description: "Edit sheets safely: read, then write."',
			"---",
			"",
			"# Google Sheets",
			"",
			"Use governed tools.",
			"",
		].join("\n"),
	}]);
});

test("native DB skill bootstrap rejects unsafe or ambiguous resources", () => {
	const skill = {
		id: "skill-1",
		slug: "safe-skill",
		name: "Safe skill",
		description: "Safe description",
		instructions: "Use governed tools.",
		revision: 1,
	};
	assert.throws(
		() => validateNativeSkillBootstrap({ registryRevision: 1, skills: [{ ...skill, slug: "../escape" }] }),
		/slug is invalid/,
	);
	assert.throws(
		() => validateNativeSkillBootstrap({ registryRevision: 1, skills: [skill, { ...skill, id: "skill-2" }] }),
		/Duplicate native skill slug/,
	);
	assert.throws(
		() => validateNativeSkillBootstrap({
			registryRevision: 1,
			skills: [{ ...skill, slug: "divo-gateway" }],
		}),
		/slug is reserved by the runtime/,
	);
	assert.throws(
		() => validateNativeSkillBootstrap({
			registryRevision: 1,
			skills: [{ ...skill, instructions: "x".repeat(100_001) }],
		}),
		/instructions are invalid/,
	);
});

test("a run's context and its skills arrive together, in one authenticated request", async () => {
	const requests = [];
	const result = await fetchRunContext({
		backendUrl: "https://divo.example.com/",
		token: "member-token",
		departmentId: "department-1",
		fetchImpl: async (url, options) => {
			requests.push({ url, options });
			return {
				ok: true,
				status: 200,
				json: async () => ({ success: true, data: {
					departmentId: "department-1",
					departmentName: "Finance",
					personaPrompt: "Prefer verified records.",
					nativeSkillBootstrap: {
						registryRevision: 1,
						skills: [{
							id: "skill-1",
							slug: "safe-skill",
							name: "Safe skill",
							description: "Safe description",
							instructions: "Use governed tools.",
							revision: 1,
						}],
					},
				} }),
			};
		},
	});
	assert.equal(result.nativeSkills.skills[0].slug, "safe-skill");
	assert.equal(result.runtimeContext.personaPrompt, "Prefer verified records.");
	// One. The container used to make the second one for itself, per turn.
	assert.equal(requests.length, 1);
	assert.match(requests[0].url, /nativeSkills=1/);
	assert.match(requests[0].url, /departmentId=department-1/);
	assert.deepEqual(requests[0].options.headers, { Authorization: "Bearer member-token" });
});

test("a catalogue that will not answer costs the skills, not the turn", async () => {
	const originalError = console.error;
	console.error = () => {};
	const requests = [];
	try {
		const result = await fetchRunContext({
			backendUrl: "https://divo.example.com/",
			token: "member-token",
			departmentId: "department-1",
			fetchImpl: async (url) => {
				requests.push(url);
				// `nativeSkills=1` runs code the plain request does not, so it can
				// fail on its own. Before both fetches became one, that cost bundled
				// skills and nothing else — the container still got its context from
				// its own call. Asking again without it is what keeps that true.
				if (url.includes("nativeSkills=1")) {
					return { ok: false, status: 503, json: async () => ({ success: false, message: "catalogue unavailable" }) };
				}
				return {
					ok: true,
					status: 200,
					json: async () => ({ success: true, data: { departmentId: "department-1", personaPrompt: "Prefer verified records." } }),
				};
			},
		});
		assert.deepEqual(result.nativeSkills, { registryRevision: 0, skills: [] });
		assert.equal(result.runtimeContext.personaPrompt, "Prefer verified records.");
		assert.equal(requests.length, 2);
	} finally {
		console.error = originalError;
	}
});

test("a refusal is fatal and is never retried into a weaker answer", async () => {
	const requests = [];
	await assert.rejects(fetchRunContext({
		backendUrl: "https://divo.example.com/",
		token: "member-token",
		departmentId: "department-1",
		fetchImpl: async (url) => {
			requests.push(url);
			return { ok: false, status: 403, json: async () => ({ success: false, message: "department denied" }) };
		},
	}), /department denied/);
	// Asking again without the skills would turn "you may not use this
	// department" into a turn that runs with capabilities it was denied.
	assert.equal(requests.length, 1);
});

test("a run with no department asks once, and asks the answerable question", async () => {
	const requests = [];
	const result = await fetchRunContext({
		backendUrl: "https://divo.example.com/",
		token: "member-token",
		fetchImpl: async (url) => {
			requests.push(url);
			return {
				ok: true,
				status: 200,
				json: async () => ({ success: true, data: { departmentId: null, personaPrompt: "" } }),
			};
		},
	});
	assert.deepEqual(result.nativeSkills, { registryRevision: 0, skills: [] });
	assert.equal(requests.length, 1);
	assert.doesNotMatch(requests[0], /nativeSkills/);
	assert.doesNotMatch(requests[0], /departmentId/);
});

test("native DB skills are staged by an isolated root helper", () => {
	const args = buildNativeSkillStagingArgs("divo-pi-local-abhishek-skills", "divo-pi:test");
	const serialized = args.join(" ");
	assert.match(serialized, /--network none/);
	assert.match(serialized, /--user 0:0/);
	assert.match(serialized, /--read-only/);
	assert.match(serialized, /type=volume,src=divo-pi-local-abhishek-skills,dst=\/run\/divo-skills/);
	assert.doesNotMatch(serialized, /member-token|password|secret/i);
});

test("native DB skill staging swaps atomically and preserves current on failure", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "divo-native-staging-"));
	const current = path.join(root, "current", "old-skill");
	fs.mkdirSync(current, { recursive: true });
	fs.writeFileSync(path.join(current, "SKILL.md"), "old", { mode: 0o444 });
	const script = buildNativeSkillStagingArgs("unused", "unused").at(-1);
	const run = (files, digest = "a".repeat(64)) => spawnSync(process.execPath, ["-e", script], {
		encoding: "utf8",
		env: { ...process.env, DIVO_NATIVE_SKILLS_ROOT: root },
		input: JSON.stringify({ digest, files }),
	});

	const failed = run([
		{ slug: "new-skill", content: "new" },
		{ slug: "../escape", content: "unsafe" },
	]);
	assert.notEqual(failed.status, 0);
	assert.equal(fs.readFileSync(path.join(current, "SKILL.md"), "utf8"), "old");

	const succeeded = run([{ slug: "new-skill", content: "new" }]);
	assert.equal(succeeded.status, 0, succeeded.stderr);
	assert.equal(succeeded.stdout.trim(), "staged");
	const staged = path.join(root, "current", "new-skill", "SKILL.md");
	assert.equal(fs.readFileSync(staged, "utf8"), "new");
	assert.equal(fs.statSync(staged).mode & 0o777, 0o444);
	assert.equal(fs.existsSync(path.join(root, ".previous")), false);
	assert.equal(fs.existsSync(path.join(root, "current", "old-skill")), false);
	assert.deepEqual(
		JSON.parse(fs.readFileSync(path.join(root, "current", ".bootstrap.json"), "utf8")),
		{ digest: "a".repeat(64) },
	);
	const unchanged = run([{ slug: "new-skill", content: "must-not-replace" }]);
	assert.equal(unchanged.status, 0, unchanged.stderr);
	assert.equal(unchanged.stdout.trim(), "unchanged");
	assert.equal(fs.readFileSync(staged, "utf8"), "new");
	fs.rmSync(root, { recursive: true, force: true });
});

test("native DB skill staging skips only an identical scoped catalogue", async () => {
	const bootstrap = {
		registryRevision: 7,
		skills: [{
			id: "skill-1",
			slug: "safe-skill",
			name: "Safe Skill",
			description: "Safe description",
			instructions: "Use governed tools.",
			revision: 1,
		}],
	};
	const scope = {
		companyId: "company-1",
		userId: "user-1",
		departmentId: "department-1",
		channel: "lark",
	};
	const calls = [];
	const runStaging = async (...args) => {
		calls.push(args);
		return { stdout: "staged\n", stderr: "" };
	};
	const volume = `test-skills-${Date.now()}`;

	const first = await stageNativeSkillBootstrap(volume, bootstrap, scope, { runStaging });
	const unchanged = await stageNativeSkillBootstrap(volume, bootstrap, scope, { runStaging });
	const changedScope = await stageNativeSkillBootstrap(
		volume,
		bootstrap,
		{ ...scope, departmentId: "department-2" },
		{ runStaging },
	);
	const changedCatalogue = await stageNativeSkillBootstrap(
		volume,
		{
			...bootstrap,
			skills: [{ ...bootstrap.skills[0], instructions: "Use the revised governed recipe." }],
		},
		scope,
		{ runStaging },
	);
	const persistedUnchanged = await stageNativeSkillBootstrap(
		volume,
		bootstrap,
		scope,
		{
			force: true,
			runStaging: async (...args) => {
				calls.push(args);
				return { stdout: "unchanged\n", stderr: "" };
			},
		},
	);

	assert.equal(first.staged, true);
	assert.equal(unchanged.staged, false);
	assert.equal(changedScope.staged, true);
	assert.equal(changedCatalogue.staged, true);
	assert.equal(persistedUnchanged.staged, false);
	assert.equal(calls.length, 4);
	assert.notEqual(first.digest, changedScope.digest);
	assert.equal(first.digest, nativeSkillBootstrapDigest(bootstrap, scope));
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
			Labels: { "dev.divo.runtime-mode": "exec-v2" },
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

test("a safely interrupted private run keeps its Pi process and container warm", async () => {
	const calls = [];
	await finalizeRuntimeLifecycle({
		profile: "abhishek",
		resources: { authVolume: "auth-volume" },
		bootstrapAttempted: true,
		completedSuccessfully: false,
		retainRuntimeProcess: true,
		runError: new Error("request disconnected"),
		abortStop: Promise.resolve(undefined),
	}, {
		clearBootstrapFn: async () => calls.push("clear"),
		scheduler: {
			keepWarm: () => calls.push("warm"),
			stopNow: async () => calls.push("stop"),
		},
	});
	assert.deepEqual(calls, ["clear", "warm"]);
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

// Every governed Gmail step in a real run reached the reader captioned "call",
// beside a row that had already said Gmail. `op` is the plumbing in the
// MCP-backed families; the operation a person would recognise is the native
// tool the call names.
test("a governed step is named by the operation, not by the call", () => {
	assert.equal(
		governedOperation({ op: "call", nativeTool: "search_gmail_messages", input: {} }),
		"search_gmail_messages",
	);
	assert.equal(
		governedOperation({ op: "call_resolved_sheet", nativeTool: "append_sheet_values" }),
		"append_sheet_values",
	);
});

// The flat families have no native tool: their operation is what `op` holds.
test("a flat family keeps the operation it was called with", () => {
	assert.equal(governedOperation({ op: "list_invoices" }), "list_invoices");
	assert.equal(governedOperation({ operation: "apply" }), "apply");
	assert.equal(governedOperation({}), undefined);
});

// Asking a tool for its schema is not performing the operation described. A row
// that borrowed the native tool's name here would report work that never ran.
test("a schema lookup is not reported as the operation it describes", () => {
	assert.equal(
		governedOperation({ op: "describe", nativeTool: "send_gmail_message" }),
		"describe",
	);
});

/*
 * Reasoning used to stop here. The rule was "reasoning stays inside the
 * container", because a Lark status card is read by everyone in the chat —
 * true of a card, and enforced one layer too early: it also withheld the
 * reasoning from the web thread, which is one person reading their own
 * conversation. It now leaves as its own kind, and the card drops it.
 */
test("reasoning leaves the container as its own kind", () => {
	const thinking = (text) => ({
		type: "message_update",
		assistantMessageEvent: {
			type: "thinking_delta",
			contentIndex: 1,
			partial: { content: [{ type: "text", text: "hi" }, { type: "thinking", thinking: text }] },
		},
	});

	assert.deepEqual(projectRuntimeProgress(thinking("Unpaid means overdue. Now the")), {
		type: "thought",
		index: 1,
		text: "Unpaid means overdue.",
	});

	// Nothing finished yet is not a thought, only evidence of thinking.
	assert.deepEqual(projectRuntimeProgress(thinking("Let me work out what")), { type: "thinking" });
});

/* Talking and thinking must not be read out of each other's blocks: a thought
   printed as narration would put the model's private working in the thread as
   though it had been said to the reader. */
test("reasoning is read only from a reasoning block", () => {
	const said = {
		type: "message_update",
		assistantMessageEvent: {
			type: "thinking_delta",
			contentIndex: 0,
			partial: { content: [{ type: "text", text: "I checked the invoices." }] },
		},
	};
	assert.deepEqual(projectRuntimeProgress(said), { type: "thinking" });
	assert.equal(assistantThinkingText(said.assistantMessageEvent), undefined);
});

/* Reasoning is accumulated from the start and truncated from the front, so a
   bound meant for a one-line `say` would freeze a thought at its first two
   sentences and never move again — a window built to let you watch the model
   think, showing two static lines for the length of the run. */
test("a long thought keeps growing past a sentence's worth", () => {
	const sentence = "The invoice ledger is the one to check here. ";
	const thinking = (text) => projectRuntimeProgress({
		type: "message_update",
		assistantMessageEvent: {
			type: "thinking_delta",
			contentIndex: 0,
			partial: { content: [{ type: "thinking", thinking: text }] },
		},
	});

	const short = thinking(sentence.repeat(4));
	const long = thinking(sentence.repeat(12));
	assert.equal(short.type, "thought");
	assert.equal(long.type, "thought");
	assert.ok(long.text.length > short.text.length, "a longer thought must say more");
	assert.ok(long.text.length > 200, "200 is a say's bound, not a thought's");
});

test("the provider's exact answer delta leaves on a separate live stream", () => {
	const event = {
		type: "message_update",
		assistantMessageEvent: {
			type: "text_delta",
			contentIndex: 2,
			delta: "| 48 |\n",
			partial: { content: [{ type: "text", text: "ignored" }] },
		},
	};
	assert.deepEqual(projectRuntimeAnswerDelta(event), {
		type: "answer_delta",
		index: 2,
		delta: "| 48 |\n",
	});
	// The card-oriented projection remains independent and sentence-sized.
	assert.deepEqual(projectRuntimeProgress(event), { type: "writing" });
});

/* Redacted reasoning has had its content removed by the provider; what is left
   is an opaque payload kept only so the conversation can continue. A row drawn
   from it would say nothing. */
test("redacted reasoning is not forwarded", () => {
	const event = {
		type: "thinking_delta",
		contentIndex: 0,
		partial: { content: [{ type: "thinking", thinking: "Ada ordered twice.", redacted: true }] },
	};
	assert.equal(assistantThinkingText(event), undefined);
	assert.deepEqual(
		projectRuntimeProgress({ type: "message_update", assistantMessageEvent: event }),
		{ type: "thinking" },
	);
});

test("ensureRuntime tells a forgetful caller apart from a missing image", async () => {
	// Both used to produce "Image … is missing. Build it with: docker build …",
	// which sends whoever dropped the argument off to rebuild an image that is
	// already there.
	await assert.rejects(ensureRuntime("someprofile", {}), /requires an imageId/);
	await assert.rejects(ensureRuntime("someprofile", { imageId: null }), /is missing\. Build it with/);
});
