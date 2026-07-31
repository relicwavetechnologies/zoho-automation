import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
	buildChildEnvironment,
	buildPiArguments,
	imagePolicyFor,
	resolveRuntimeThreadId,
	prepareSessionDirectories,
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
	model: "deepseek-v4-flash",
	print: true,
	prompt: "hello",
	provider: "deepseek",
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
	it("keeps signed gateway correlation separate from the filesystem thread", () => {
		assert.equal(
			resolveRuntimeThreadId("lark-safe-hash", "oc_chat:thread:om_root"),
			"oc_chat:thread:om_root",
		);
		assert.equal(resolveRuntimeThreadId("lark-safe-hash"), "lark-safe-hash");
		assert.throws(() => resolveRuntimeThreadId("lark-safe-hash", ""), /is required/);
		assert.throws(
			() => resolveRuntimeThreadId("lark-safe-hash", "x".repeat(201)),
			/is too long/,
		);
	});

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

describe("The run launches on the model it was given", () => {
	// Every run used to launch on the manifest's model no matter who sent it, so
	// an admin could grant somebody Pro or Luna and watch nothing change. These
	// two arguments are the whole mechanism by which the grant is now honoured.
	it("passes the selected model and its provider to the agent", () => {
		const args = buildPiArguments({ ...values, model: "gpt-5.6-luna", provider: "openai" });

		assert.equal(args[args.indexOf("--model") + 1], "gpt-5.6-luna");
		assert.equal(args[args.indexOf("--provider") + 1], "openai");
	});

	it("keeps DeepSeek on DeepSeek", () => {
		const args = buildPiArguments(values);

		assert.equal(args[args.indexOf("--model") + 1], "deepseek-v4-flash");
		assert.equal(args[args.indexOf("--provider") + 1], "deepseek");
	});
});

describe("How a run is told to look at a picture", () => {
	// The agent cannot work this out for itself: a text-only model that tries to
	// read an image gets a refusal note back, and a vision model that sends every
	// picture away to be transcribed never actually looks at one. Whichever half
	// of this is wrong for the running model, the failure is quiet.
	it("sends a vision model to the file and a text model to the gateway", () => {
		assert.match(imagePolicyFor("gpt-5.6-luna"), /read tool/);
		assert.doesNotMatch(imagePolicyFor("gpt-5.6-luna"), /media\.image_ocr/);

		assert.match(imagePolicyFor("deepseek-v4-flash"), /media\.image_ocr/);
		assert.match(imagePolicyFor("deepseek-v4-pro"), /media\.image_ocr/);
	});

	it("puts exactly one policy into the prompt the agent is given", () => {
		const args = buildPiArguments({ ...values, model: "gpt-5.6-luna", provider: "openai" });
		const prompt = args[args.indexOf("--append-system-prompt") + 1];

		assert.ok(!prompt.includes("{{image_policy}}"));
		assert.ok(prompt.includes(imagePolicyFor("gpt-5.6-luna")));
		assert.ok(!prompt.includes(imagePolicyFor("deepseek-v4-flash")));
	});
});

describe("Past-chat recall is a direct-message capability", () => {
	const groupValues = { ...values, isRunScoped: true };

	it("withholds the recall tools from a group turn on every route", () => {
		const args = buildPiArguments(groupValues);
		const environment = buildChildEnvironment({}, groupValues);

		// The allowlist that admits the tools, the extension that registers them,
		// and the skill that teaches them. Leaving any one of these in place would
		// let a group turn reach a transcript the room never took part in.
		assert.ok(!args.includes("divo_search_chats,divo_read_chat"));
		const tools = args[args.indexOf("--tools") + 1].split(",");
		assert.ok(!tools.includes("divo_search_chats"));
		assert.ok(!tools.includes("divo_read_chat"));
		assert.ok(!args.some((argument) => argument.includes("divo-chat-history")));
		assert.ok(!environment.DIVO_SKILL_DIRS.includes("divo-chat-history"));
	});

	it("does not tell a group turn where past sessions live", () => {
		// Defence in depth, not a boundary: `bash` is still allowed and `HOME` still
		// names the state root, so this only removes the signpost. Asserted here so
		// that stays deliberate rather than becoming a guarantee someone leans on.
		const args = buildPiArguments(groupValues);
		assert.equal(buildChildEnvironment({}, groupValues).DIVO_CHAT_HISTORY_DIR, undefined);
		assert.ok(args[args.indexOf("--tools") + 1].split(",").includes("bash"));

		assert.equal(buildChildEnvironment({}, values).DIVO_CHAT_HISTORY_DIR, "/tmp/divo-data");
	});

	it("leaves the rest of the runtime untouched for a group turn", () => {
		const args = buildPiArguments(groupValues);
		const tools = args[args.indexOf("--tools") + 1].split(",");
		assert.ok(tools.includes("divo_gateway"));
		assert.ok(args.some((argument) => argument.endsWith("/divo-gateway/index.ts")));
	});

	it("gives a direct message the recall tools, extension, and skill", () => {
		const args = buildPiArguments(values);
		const environment = buildChildEnvironment({}, values);

		const tools = args[args.indexOf("--tools") + 1].split(",");
		assert.ok(tools.includes("divo_search_chats"));
		assert.ok(tools.includes("divo_read_chat"));
		assert.ok(args.some((argument) => argument.endsWith("/divo-chat-history/index.ts")));
		assert.ok(environment.DIVO_SKILL_DIRS.includes("divo-chat-history"));
	});
});

describe("Group residue purge", () => {
	const makeVolume = () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "divo-purge-"));
		const threads = path.join(root, "data", "threads");
		for (const name of ["lark-group", "lark-dm"]) {
			fs.mkdirSync(path.join(threads, name), { recursive: true });
			fs.writeFileSync(path.join(threads, name, "pi-session.jsonl"), "{}\n");
		}
		return { root, threads };
	};

	it("removes the group's own durable session and nothing else", () => {
		const { root, threads } = makeVolume();
		prepareSessionDirectories({
			isRunScoped: true,
			runSessionsRoot: path.join(root, "runs"),
			runId: "run-1",
			threadDir: path.join(threads, "lark-group"),
		});

		assert.equal(fs.existsSync(path.join(threads, "lark-group")), false);
		// The blast radius is one directory: a group turn must never reach the
		// history a direct message depends on.
		assert.ok(fs.existsSync(path.join(threads, "lark-dm", "pi-session.jsonl")));
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("never deletes anything on a thread-scoped turn", () => {
		// The guard on an irreversible recursive delete over the user's durable
		// volume. Losing it would destroy a person's whole history on their next
		// direct message.
		const { root, threads } = makeVolume();
		prepareSessionDirectories({
			isRunScoped: false,
			runSessionsRoot: path.join(root, "runs"),
			runId: "run-1",
			threadDir: path.join(threads, "lark-dm"),
		});

		assert.ok(fs.existsSync(path.join(threads, "lark-dm", "pi-session.jsonl")));
		assert.ok(fs.existsSync(path.join(threads, "lark-group", "pi-session.jsonl")));
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("is a no-op when the room left nothing behind", () => {
		const { root, threads } = makeVolume();
		assert.doesNotThrow(() =>
			prepareSessionDirectories({
				isRunScoped: true,
				runSessionsRoot: path.join(root, "runs"),
				runId: "run-1",
				threadDir: path.join(threads, "lark-never-used"),
			}),
		);
		assert.ok(fs.existsSync(path.join(threads, "lark-dm")));
		fs.rmSync(root, { recursive: true, force: true });
	});
});
