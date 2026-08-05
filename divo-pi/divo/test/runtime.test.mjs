import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
	acknowledgeInterruptedWorkFact,
	buildAgentConfiguration,
	buildChildEnvironment,
	buildPiArguments,
	buildRunCorrelationContext,
	deleteDurablePiSession,
	imagePolicyFor,
	resolveRuntimeThreadId,
	prepareSessionDirectories,
	readInterruptedWorkFact,
	recordInterruptedWorkFact,
	removePreviousRunDirectories,
	resolveSessionPaths,
	runtimeContextForSession,
	sweepAbandonedRunSessions,
	sweepExpiredPendingAttachments,
} from "../runtime.mjs";
import { thinkingLevelForModel } from "../runtime-models.mjs";

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
	it("caps DeepSeek context before compaction and output become unbounded", () => {
		const configuration = buildAgentConfiguration({
			provider: "deepseek",
			model: "deepseek-v4-pro",
			thinkingLevel: "high",
		});

		assert.deepEqual(configuration.settings.compaction, {
			enabled: true,
			reserveTokens: 24_576,
			keepRecentTokens: 20_000,
		});
		assert.deepEqual(
			configuration.models.providers.deepseek.modelOverrides["deepseek-v4-pro"],
			{ contextWindow: 150_000, maxTokens: 32_768 },
		);
		assert.deepEqual(
			configuration.models.providers.deepseek.modelOverrides["deepseek-v4-flash"],
			{ contextWindow: 150_000, maxTokens: 32_768 },
		);
	});

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

	it("keeps the backend-issued Lark run identity in every gateway tool call", () => {
		assert.deepEqual(buildRunCorrelationContext({
			threadId: "oc_chat:thread:om_root",
			runId: "backend-run-1",
			channel: "lark",
			departmentId: "department-1",
		}), {
			version: 1,
			threadId: "oc_chat:thread:om_root",
			runId: "backend-run-1",
			channel: "lark",
			departmentId: "department-1",
		});
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
		assert.ok(!args.some((argument) => argument.endsWith("/divo-artifact/index.ts")));
		const toolAllowlist = args[args.indexOf("--tools") + 1];
		assert.ok(!toolAllowlist.split(",").includes("divo_artifact"));
		const systemPrompt = args[args.indexOf("--append-system-prompt") + 1];
		assert.match(systemPrompt, /complete user-facing result in chat/i);
		assert.doesNotMatch(systemPrompt, /DIVO_ARTIFACTS_DIR|divo_artifact/i);
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

	it("injects an interrupted DM fact instead of implicitly resuming its work", () => {
		const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "divo-interrupted-work-"));
		const fact = recordInterruptedWorkFact({
			dataDir,
			thread: "lark-abc",
			task: "  Prepare   the monthly report  ",
		});
		const { threadDir } = resolveSessionPaths({ ...base, dataDir });
		assert.deepEqual(readInterruptedWorkFact(threadDir), {
			task: fact.task,
			clarificationShown: false,
		});

		const args = buildPiArguments({ ...values, interruptedWork: fact });
		const prompt = args[args.indexOf("--append-system-prompt") + 1];
		assert.match(prompt, /Never resume, retry, or continue it/i);
		assert.match(prompt, /ask one brief question/i);
		assert.match(prompt, /Prepare the monthly report/);

		acknowledgeInterruptedWorkFact(threadDir, fact);
		const acknowledged = readInterruptedWorkFact(threadDir);
		assert.deepEqual(acknowledged, {
			task: fact.task,
			clarificationShown: true,
		});
		const acknowledgedArgs = buildPiArguments({
			...values,
			interruptedWork: acknowledged,
		});
		const acknowledgedPrompt = acknowledgedArgs[
			acknowledgedArgs.indexOf("--append-system-prompt") + 1
		];
		assert.match(acknowledgedPrompt, /respond normally without mentioning or resuming/i);
		assert.match(acknowledgedPrompt, /Never resume, retry, or continue it/i);
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

	it("removes prior Lark scratch runs without touching the current run", () => {
		const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "divo-lark-runs-"));
		fs.mkdirSync(path.join(runsRoot, "old-run-a"));
		fs.mkdirSync(path.join(runsRoot, "old-run-b"));
		fs.mkdirSync(path.join(runsRoot, "current-run"));

		assert.deepEqual(
			removePreviousRunDirectories(runsRoot, "current-run").sort(),
			["old-run-a", "old-run-b"],
		);
		assert.deepEqual(fs.readdirSync(runsRoot), ["current-run"]);
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

describe("Protected durable session cleanup", () => {
	it("deletes exactly the requested thread and preserves its siblings", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "divo-protected-session-"));
		const dataDir = path.join(root, "data");
		const target = path.join(dataDir, "threads", "lark-protected");
		const sibling = path.join(dataDir, "threads", "lark-normal");
		for (const directory of [target, sibling]) {
			fs.mkdirSync(directory, { recursive: true });
			fs.writeFileSync(path.join(directory, "pi-session.jsonl"), "private\n");
		}

		assert.equal(deleteDurablePiSession({ dataDir, thread: "lark-protected" }), true);
		assert.equal(fs.existsSync(target), false);
		assert.equal(fs.existsSync(path.join(sibling, "pi-session.jsonl")), true);
		assert.equal(deleteDurablePiSession({ dataDir, thread: "lark-protected" }), false);
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("rejects a path-like thread before deleting anything", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "divo-protected-session-"));
		const dataDir = path.join(root, "data");
		const sibling = path.join(dataDir, "threads", "lark-normal");
		fs.mkdirSync(sibling, { recursive: true });
		fs.writeFileSync(path.join(sibling, "pi-session.jsonl"), "private\n");

		assert.throws(
			() => deleteDurablePiSession({ dataDir, thread: "../lark-normal" }),
			/is invalid/,
		);
		assert.equal(fs.existsSync(path.join(sibling, "pi-session.jsonl")), true);
		fs.rmSync(root, { recursive: true, force: true });
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

describe("Pending attachment sweep", () => {
	it("keeps a recent upload and removes an abandoned private inbox entry", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "divo-inbox-sweep-"));
		const makeEntry = (name, ageMs) => {
			const directory = path.join(root, name);
			fs.mkdirSync(directory, { recursive: true });
			fs.writeFileSync(path.join(directory, "attachment.txt"), "private");
			const stamp = new Date(Date.now() - ageMs);
			fs.utimesSync(directory, stamp, stamp);
			return directory;
		};
		const stale = makeEntry("request-old", 25 * 60 * 60_000);
		const recent = makeEntry("request-new", 60_000);

		assert.deepEqual(sweepExpiredPendingAttachments(root), ["request-old"]);
		assert.equal(fs.existsSync(stale), false);
		assert.equal(fs.existsSync(recent), true);
		fs.rmSync(root, { recursive: true, force: true });
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
		assert.equal(args[args.indexOf("--thinking") + 1], "high");
	});

	it("keeps DeepSeek on DeepSeek", () => {
		const args = buildPiArguments(values);

		assert.equal(args[args.indexOf("--model") + 1], "deepseek-v4-flash");
		assert.equal(args[args.indexOf("--provider") + 1], "deepseek");
		assert.equal(args[args.indexOf("--thinking") + 1], "high");
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

	it("runs V4 Flash at the provider's upgraded high reasoning level", () => {
		assert.equal(thinkingLevelForModel("deepseek-v4-flash"), "high");
		assert.equal(thinkingLevelForModel("gpt-5.6-luna"), "high");
		assert.equal(thinkingLevelForModel("deepseek-v4-pro", "medium"), "high");
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
		// The controller boundary gives a shared run an empty per-run volume. This
		// runtime filter independently removes the private-history signpost.
		const args = buildPiArguments(groupValues);
		assert.equal(buildChildEnvironment({}, groupValues).DIVO_CHAT_HISTORY_DIR, undefined);
		assert.ok(args[args.indexOf("--tools") + 1].split(",").includes("bash"));

		assert.equal(buildChildEnvironment({}, values).DIVO_CHAT_HISTORY_DIR, "/tmp/divo-data");
	});

	it("leaves the rest of the runtime untouched for a group turn", () => {
		const args = buildPiArguments(groupValues);
		const tools = args[args.indexOf("--tools") + 1].split(",");
		assert.ok(tools.includes("divo_gateway"));
		assert.ok(!tools.includes("divo_memory_recall"));
		assert.ok(!tools.includes("divo_memory"));
		assert.ok(args.some((argument) => argument.endsWith("/divo-gateway/index.ts")));
	});

	it("gives a direct message the recall tools, extension, and skill", () => {
		const args = buildPiArguments(values);
		const environment = buildChildEnvironment({}, values);

		const tools = args[args.indexOf("--tools") + 1].split(",");
		assert.ok(tools.includes("divo_memory_recall"));
		assert.ok(tools.includes("divo_memory"));
		assert.ok(tools.includes("divo_search_chats"));
		assert.ok(tools.includes("divo_read_chat"));
		assert.ok(args.some((argument) => argument.endsWith("/divo-chat-history/index.ts")));
		assert.ok(environment.DIVO_SKILL_DIRS.includes("divo-chat-history"));
	});

	it("removes private memory from the runtime context written for a group", () => {
		const context = {
			departmentName: "Tech Testing",
			personalMemory: ["Private report preference"],
			capabilityBootstrap: { version: 3 },
		};
		assert.deepEqual(runtimeContextForSession(context, true), {
			departmentName: "Tech Testing",
			personalMemory: [],
			capabilityBootstrap: { version: 3 },
		});
		assert.equal(runtimeContextForSession(context, false), context);
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
