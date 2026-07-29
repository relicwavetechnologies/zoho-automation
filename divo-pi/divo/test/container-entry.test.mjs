import assert from "node:assert/strict";
import test from "node:test";
import {
	assertPinnedIdentity,
	validateBootstrap,
} from "../container-entry.mjs";
import {
	buildChildEnvironment,
	buildPiArguments,
} from "../runtime.mjs";

const bootstrap = {
	backendUrl: "https://backend.example",
	token: "member-token",
	profile: "abhishek",
	thread: "same-thread",
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

test("container bootstrap rejects unsafe profile and thread values", () => {
	assert.throws(
		() => validateBootstrap({ ...bootstrap, profile: "../other" }),
		/profile is invalid/,
	);
	assert.throws(
		() => validateBootstrap({ ...bootstrap, thread: "../../other" }),
		/thread is invalid/,
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
