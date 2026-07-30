import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
	buildChildEnvironment,
	buildPiArguments,
	resolveSessionPaths,
	sweepAbandonedRunSessions,
} from "../runtime.mjs";

const values = {
	agentDir: "/tmp/divo-agent",
	artifactsDir: "/tmp/workspace/artifacts",
	backendUrl: "https://divo.example.com",
	dataDir: "/tmp/divo-data",
	departmentId: "department-1",
	homeDir: "/tmp/divo-home",
	internalDir: "/tmp/workspace/.divo",
	logsDir: "/tmp/run/logs",
	print: true,
	prompt: "hello",
	runContextPath: "/tmp/run-context.json",
	runDir: "/tmp/run",
	runId: "run-1",
	runtimeContextPath: "/tmp/runtime-context.json",
	scratchDir: "/tmp/run/tmp",
	scriptsDir: "/tmp/run/scripts",
	sessionDir: "/tmp/sessions",
	sessionPath: "/tmp/sessions/pi-session.jsonl",
	thread: "thread-1",
	token: "member-token",
	workspace: "/tmp/workspace",
};

describe("Divo Pi runtime boundary", () => {
	it("removes direct provider keys and injects only Divo authentication", () => {
		const environment = buildChildEnvironment(
			{
				OPENAI_API_KEY: "openai-secret",
				DEEPSEEK_API_KEY: "deepseek-secret",
				PATH: "/usr/bin",
			},
			values,
		);
		assert.equal(environment.OPENAI_API_KEY, undefined);
		assert.equal(environment.DEEPSEEK_API_KEY, undefined);
		assert.equal(environment.DIVO_MEMBER_TOKEN, "member-token");
		assert.equal(environment.DIVO_BACKEND_URL, "https://divo.example.com");
		assert.equal(environment.PATH, "/usr/bin");
	});

	it("pins Divo provider, model, extensions, skills, tools, and session", () => {
		const args = buildPiArguments(values);
		assert.deepEqual(args.slice(args.indexOf("--provider"), args.indexOf("--provider") + 4), [
			"--provider",
			"deepseek",
			"--model",
			"deepseek-v4-flash",
		]);
		assert.ok(args.includes("--no-extensions"));
		assert.ok(args.includes("--no-skills"));
		assert.ok(args.includes("/tmp/sessions/pi-session.jsonl"));
		assert.ok(args.some((argument) => argument.endsWith("/divo-llm/index.ts")));
		assert.ok(args.some((argument) => argument.endsWith("/divo-gateway/index.ts")));
	});
});

describe("Pi session scope", () => {
	const base = {
		dataDir: "/data/state/data",
		thread: "lark-abc",
		runId: "run-9",
		ephemeralRoot: "/tmp/divo-sessions",
	};

	it("keeps a thread-scoped session on the durable per-thread path", () => {
		const paths = resolveSessionPaths(base);
		assert.equal(paths.isRunScoped, false);
		assert.equal(paths.sessionDir, "/data/state/data/threads/lark-abc");
		assert.equal(
			paths.sessionPath,
			"/data/state/data/threads/lark-abc/pi-session.jsonl",
		);
	});

	it("defaults to the thread scope when the caller says nothing", () => {
		assert.deepEqual(resolveSessionPaths(base), resolveSessionPaths({
			...base,
			sessionScope: "thread",
		}));
	});

	it("keeps a run-scoped session off the user's durable volume entirely", () => {
		const paths = resolveSessionPaths({ ...base, sessionScope: "run" });
		assert.equal(paths.isRunScoped, true);
		assert.equal(paths.sessionDir, "/tmp/divo-sessions/threads/lark-abc/runs/run-9");
		// The container mounts the volume at /data and is otherwise read-only apart
		// from the tmpfs, so a shared group transcript written here cannot survive
		// the container even if cleanup never runs.
		assert.ok(!paths.sessionPath.startsWith("/data"));
		assert.equal(paths.threadDir, "/data/state/data/threads/lark-abc");
	});

	it("gives two runs of one thread separate sessions", () => {
		assert.notEqual(
			resolveSessionPaths({ ...base, sessionScope: "run" }).sessionPath,
			resolveSessionPaths({ ...base, runId: "run-10", sessionScope: "run" }).sessionPath,
		);
	});

	it("defaults its ephemeral root to the system temporary directory", () => {
		const paths = resolveSessionPaths({
			dataDir: "/data/state/data",
			thread: "lark-abc",
			runId: "run-9",
			sessionScope: "run",
		});
		assert.ok(paths.sessionPath.startsWith(path.join(os.tmpdir(), "divo-sessions")));
	});
});

describe("Abandoned run session sweep", () => {
	const makeRun = (root, name, ageMs) => {
		const directory = path.join(root, name);
		fs.mkdirSync(directory, { recursive: true });
		fs.writeFileSync(path.join(directory, "pi-session.jsonl"), "{}\n");
		const stamp = new Date(Date.now() - ageMs);
		fs.utimesSync(directory, stamp, stamp);
		return directory;
	};

	it("removes only sessions too old to belong to a live run", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "divo-sweep-"));
		const stale = makeRun(root, "run-old", 7 * 60 * 60_000);
		const fresh = makeRun(root, "run-new", 60_000);
		const current = makeRun(root, "run-current", 7 * 60 * 60_000);

		const removed = sweepAbandonedRunSessions(root, "run-current");

		assert.deepEqual(removed, ["run-old"]);
		assert.equal(fs.existsSync(stale), false);
		// A container killed mid-run reclaims its disk later; a run still going
		// keeps the session it is writing to.
		assert.equal(fs.existsSync(fresh), true);
		assert.equal(fs.existsSync(current), true);

		fs.rmSync(root, { recursive: true, force: true });
	});

	it("is a no-op when no run sessions were ever written", () => {
		assert.deepEqual(sweepAbandonedRunSessions("/nonexistent/divo/runs", "run-1"), []);
	});
});
