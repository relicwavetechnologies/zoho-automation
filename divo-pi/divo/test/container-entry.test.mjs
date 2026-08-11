import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	assertPinnedIdentity,
	piOptions,
	recordPendingInterruption,
	validateBootstrap,
} from "../container-entry.mjs";
import {
	buildChildEnvironment,
	buildPiArguments,
	readInterruptedWorkFact,
	resolveSessionPaths,
} from "../runtime.mjs";

const bootstrap = {
	backendUrl: "https://backend.example",
	token: "member-token",
	profile: "abhishek",
	thread: "same-thread",
	runtimeThreadId: "oc_chat:thread:om_root",
	userId: "user-a",
	companyId: "company-1",
};

test("container bootstrap requires an exact pinned identity", () => {
	assert.equal(validateBootstrap(bootstrap), bootstrap);
	assert.doesNotThrow(() =>
		assertPinnedIdentity(
			{ userId: "user-a", companyId: "company-1" },
			bootstrap,
		),
	);
	assert.throws(
		() =>
			assertPinnedIdentity(
				{ userId: "user-b", companyId: "company-1" },
				bootstrap,
			),
		/does not match pinned profile/,
	);
});

test("container bootstrap accepts only pinned trusted session metadata", () => {
	const parsed = validateBootstrap({
		...bootstrap,
		trustedSession: {
			userId: "user-a",
			companyId: "company-1",
			departments: [
				{ id: "department-1", name: "Finance", token: "must-not-leak" },
			],
			email: "user@example.com",
		},
	});

	assert.deepEqual(parsed.trustedSession, {
		userId: "user-a",
		companyId: "company-1",
		departments: [{ id: "department-1", name: "Finance" }],
	});
	assert.doesNotThrow(() =>
		assertPinnedIdentity(parsed.trustedSession, parsed),
	);
	assert.throws(
		() => assertPinnedIdentity(
			{ ...parsed.trustedSession, userId: "user-b" },
			parsed,
		),
		/does not match pinned profile/,
	);
	assert.throws(
		() => validateBootstrap({
			...bootstrap,
			trustedSession: {
				userId: "user-a",
				companyId: "company-1",
				departments: [{ id: "" }],
			},
		}),
		/trusted department id is invalid/,
	);
});

test("container bootstrap rejects unsafe profile and thread values", () => {
	assert.throws(
		() => validateBootstrap({ ...bootstrap, profile: "../other" }),
		/profile is invalid/,
	);
	assert.throws(
		() => validateBootstrap({ ...bootstrap, thread: "../../other" }),
		/thread is invalid/,
	);
	assert.throws(
		() => validateBootstrap({ ...bootstrap, runtimeThreadId: "" }),
		/Runtime thread ID is required/,
	);
	assert.throws(
		() => validateBootstrap({ ...bootstrap, runtimeThreadId: "x".repeat(201) }),
		/Runtime thread ID is too long/,
	);
});

test("RPC mode and durable user install paths are passed to Pi", () => {
	const args = buildPiArguments({
		artifactsDir: "/data/workspace/artifacts",
		mode: "rpc",
		runDir: "/data/workspace/.divo/run",
		sessionDir: "/data/state/data/threads/same-thread",
		sessionPath: "/data/state/data/threads/same-thread/pi-session.jsonl",
		thread: "same-thread",
		workspace: "/data/workspace",
	});
	assert.deepEqual(args.slice(-2), ["--mode", "rpc"]);

	const environment = buildChildEnvironment(
		{ PATH: "/usr/bin", OPENAI_API_KEY: "must-not-leak" },
		{
			agentDir: "/data/state/agent",
			artifactsDir: "/data/workspace/artifacts",
			backendUrl: "https://backend.example",
			dataDir: "/data/state/data",
			homeDir: "/data/state/home",
			internalDir: "/data/workspace/.divo",
			logsDir: "/data/workspace/.divo/logs",
			runContextPath: "/data/state/context/run.json",
			runDir: "/data/workspace/.divo/run",
			runId: "run-1",
			runtimeContextPath: "/data/state/context/runtime.json",
			scratchDir: "/data/workspace/.divo/tmp",
			scriptsDir: "/data/workspace/.divo/scripts",
			token: "member-token",
			workspace: "/data/workspace",
		},
	);
	assert.equal(environment.HOME, "/data/state/home");
	assert.match(environment.PYTHONUSERBASE, /^\/data\/state\/home/);
	assert.equal(environment.PIP_BREAK_SYSTEM_PACKAGES, "1");
	assert.match(environment.npm_config_prefix, /^\/data\/state\/home/);
	assert.equal(environment.OPENAI_API_KEY, undefined);
});

test("container bootstrap accepts only known session scopes", () => {
	// Absent is the durable per-thread session every caller used before shared
	// group threads existed, so an older controller keeps working unchanged.
	assert.equal(validateBootstrap(bootstrap).sessionScope, undefined);
	assert.doesNotThrow(() => validateBootstrap({ ...bootstrap, sessionScope: "thread" }));
	assert.doesNotThrow(() => validateBootstrap({ ...bootstrap, sessionScope: "run" }));
	assert.throws(
		() => validateBootstrap({ ...bootstrap, sessionScope: "forever" }),
		/sessionScope is invalid/,
	);
});

test("a Lark bootstrap requires the backend-issued run identity", () => {
	assert.doesNotThrow(() => validateBootstrap({
		...bootstrap,
		channel: "lark",
		runId: "backend-run-1",
	}));
	assert.throws(
		() => validateBootstrap({ ...bootstrap, channel: "lark" }),
		/runId is required for Lark/,
	);
});

test("a soft abort records interrupted work without stopping the container", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "divo-container-interruption-"));
	const dataDir = path.join(root, "data");
	const interruptionPath = path.join(root, "interruption.json");
	fs.writeFileSync(interruptionPath, JSON.stringify({
		thread: "same-thread",
		task: "Build the export",
	}));

	assert.equal(recordPendingInterruption(interruptionPath, dataDir), true);
	const { threadDir } = resolveSessionPaths({
		dataDir,
		thread: "same-thread",
		runId: "run-1",
	});
	assert.deepEqual(readInterruptedWorkFact(threadDir), {
		task: "Build the export",
		clarificationShown: false,
	});
	assert.equal(fs.existsSync(interruptionPath), false);
	fs.rmSync(root, { recursive: true, force: true });
});

test("the container forwards the session scope it was given to Pi", () => {
	// The one property that keeps a shared group transcript off the user's durable
	// volume. Losing it would be silent: every run would still succeed.
	assert.equal(
		piOptions({ bootstrap: { ...bootstrap, sessionScope: "run" } }).sessionScope,
		"run",
	);
	assert.equal(piOptions({ bootstrap }).sessionScope, "thread");
	assert.equal(piOptions({ bootstrap }).stateRoot, "/data/state");
	assert.equal(piOptions({ bootstrap }).thread, "same-thread");
	assert.equal(
		piOptions({ bootstrap }).runtimeThreadId,
		"oc_chat:thread:om_root",
	);
	assert.equal(
		piOptions({ bootstrap, department: { id: "dep-1" } }).departmentId,
		"dep-1",
	);
});
