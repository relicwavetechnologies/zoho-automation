import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	RUNTIME_MODEL_IDS,
	VISION_MODELS,
	isRuntimeModel,
	providerForModel,
} from "./runtime-models.mjs";

const divoDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(divoDir, "..");
const defaultStateRoot = path.join(repositoryRoot, ".divo-state");
const manifest = JSON.parse(
	fs.readFileSync(path.join(divoDir, "runtime-manifest.json"), "utf8"),
);

const PROVIDER_ENV_KEYS = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_OAUTH_TOKEN",
	"ANT_LING_API_KEY",
	"AZURE_OPENAI_API_KEY",
	"OPENAI_API_KEY",
	"DEEPSEEK_API_KEY",
	"NVIDIA_API_KEY",
	"GEMINI_API_KEY",
	"MISTRAL_API_KEY",
	"GROQ_API_KEY",
	"CEREBRAS_API_KEY",
	"CLOUDFLARE_API_KEY",
	"CLOUDFLARE_ACCOUNT_ID",
	"CLOUDFLARE_GATEWAY_ID",
	"XAI_API_KEY",
	"OPENROUTER_API_KEY",
	"AI_GATEWAY_API_KEY",
	"ZAI_API_KEY",
	"ZAI_CODING_CN_API_KEY",
	"OPENCODE_API_KEY",
	"HF_TOKEN",
	"FIREWORKS_API_KEY",
	"TOGETHER_API_KEY",
	"KIMI_API_KEY",
	"MINIMAX_API_KEY",
	"MINIMAX_CN_API_KEY",
	"XIAOMI_API_KEY",
];

/**
 * How long an abandoned run-scoped session directory is kept.
 *
 * A run-scoped session is deleted when its Pi process exits, but a container
 * killed mid-run never reaches that. The backend caps a run far below this, so
 * anything older than this cannot belong to a run that is still going.
 */
const ABANDONED_RUN_SESSION_TTL_MS = 6 * 60 * 60_000;

/**
 * What only a direct message may use.
 *
 * Past-chat recall reads the durable sessions on this user's volume — their
 * direct messages with Divo and their own scheduled runs. In a group the person
 * asking has consented to that being read out; the others in the room have not,
 * and they are the ones who see the answer. So the recall tools are withheld
 * there outright rather than left to the model's judgement.
 *
 * The scope is what decides this, and it is a partial signal. Every run-scoped
 * session is a group turn, so recall is correctly withheld from all of them. The
 * converse does not hold: a scheduled workflow is thread-scoped and may still
 * deliver into a group chat, and such a run is given recall today. Closing that
 * needs the caller to say who will read the answer, which the runtime cannot
 * work out for itself.
 */
const DIRECT_MESSAGE_ONLY_TOOLS = ["divo_search_chats", "divo_read_chat"];

/** The extension registering those tools and the skill teaching them share a name. */
const DIRECT_MESSAGE_ONLY_MODULES = ["divo-chat-history"];

/**
 * The manifest as this run may use it.
 *
 * Withheld at the three places that decide what Pi can call — the extension that
 * registers the tools, the skill that teaches them, and the allowlist that
 * admits them. That removes the capability, not the underlying files;
 * `buildChildEnvironment` covers the signpost, and neither is a sandbox.
 */
export function scopedManifest(isRunScoped) {
	if (!isRunScoped) return manifest;
	return {
		...manifest,
		extensions: manifest.extensions.filter(
			(name) => !DIRECT_MESSAGE_ONLY_MODULES.includes(name),
		),
		trustedSkills: manifest.trustedSkills.filter(
			(name) => !DIRECT_MESSAGE_ONLY_MODULES.includes(name),
		),
		toolAllowlist: manifest.toolAllowlist.filter(
			(name) => !DIRECT_MESSAGE_ONLY_TOOLS.includes(name),
		),
	};
}

function ensureDirectory(directory) {
	fs.mkdirSync(directory, { recursive: true });
}

function removeDirectory(directory) {
	try {
		fs.rmSync(directory, { recursive: true, force: true });
	} catch (error) {
		// Reclaiming disk is best-effort. Failing the run over it would trade a
		// delivered answer for a few kilobytes.
		console.error(`[divo-pi] could not remove ${directory}: ${error.message}`);
	}
}

/**
 * Drop run-scoped sessions left behind by containers that were killed.
 *
 * Only siblings of this run are considered, and only ones old enough that no
 * live run could own them — a sweep that raced a running Pi would delete the
 * session it is writing to.
 */
export function sweepAbandonedRunSessions(
	runsRoot,
	currentRunId,
	now = Date.now(),
	ttlMs = ABANDONED_RUN_SESSION_TTL_MS,
) {
	let entries;
	try {
		entries = fs.readdirSync(runsRoot, { withFileTypes: true });
	} catch {
		return [];
	}

	const removed = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name === currentRunId) continue;
		const directory = path.join(runsRoot, entry.name);
		try {
			if (now - fs.statSync(directory).mtimeMs < ttlMs) continue;
		} catch {
			continue;
		}
		removeDirectory(directory);
		removed.push(entry.name);
	}
	return removed;
}

/**
 * Ready the volume for a group turn.
 *
 * Group turns kept a durable session in `threadDir` until run-scoped sessions
 * shipped, and those transcripts are still on the volumes of everyone who used a
 * group before that deploy — inside the corpus past-chat recall reads. A
 * run-scoped turn never writes there, so removing it can only discard that
 * residue, and each room clears its own the next time it runs.
 *
 * The blast radius is one directory. A direct message and a group thread can
 * never hash to the same name, because their conversation keys differ, so this
 * cannot reach a person's own history.
 */
export function prepareSessionDirectories({
	isRunScoped,
	runSessionsRoot,
	runId,
	threadDir,
}) {
	// The guard lives here rather than at the call site so that both outcomes are
	// reachable from a test: this deletes a directory on the user's durable volume
	// and nothing warns you when it deletes the wrong one.
	if (!isRunScoped) return;
	sweepAbandonedRunSessions(runSessionsRoot, runId);
	removeDirectory(threadDir);
}

function ensureExtensionLink(agentDir, extensionName) {
	const target = path.join(divoDir, "extensions", extensionName);
	const link = path.join(agentDir, "extensions", extensionName);
	if (!fs.existsSync(path.join(target, "index.ts"))) {
		throw new Error(`Required Divo extension is missing: ${extensionName}`);
	}
	if (fs.existsSync(link)) return;
	ensureDirectory(path.dirname(link));
	fs.symlinkSync(target, link, "dir");
}

/**
 * The one sentence that decides how this run looks at a picture.
 *
 * Which of the two is correct depends entirely on the model the run launched
 * on, and the agent cannot work that out for itself: a text-only model asked to
 * `read` an image gets a note saying it cannot see it, and a vision model told
 * to send every picture to the OCR service loses the ability to actually look
 * at one. So the launcher, which is the only thing that knows the model,
 * settles it here rather than leaving the agent to discover it a call at a time.
 */
export function imagePolicyFor(model) {
	return VISION_MODELS.has(model)
		? "To understand a picture, open it with the read tool. This model sees images directly, so read the file itself rather than sending it anywhere to be transcribed."
		: "To understand a picture, call divo_gateway with op \"media.image_ocr\" and payload { filePath }. This model cannot see images, so reading the file yourself returns nothing usable; the gateway returns the text, a description of what is shown, and the interface elements in it.";
}

function renderWorkspacePrompt(values) {
	let prompt = fs.readFileSync(
		path.join(divoDir, "prompts", "company-workspace.md"),
		"utf8",
	);
	for (const [key, value] of Object.entries(values)) {
		prompt = prompt.replaceAll(`{{${key}}}`, value);
	}
	return prompt;
}

export function buildChildEnvironment(baseEnvironment, values) {
	const environment = { ...baseEnvironment };
	for (const key of PROVIDER_ENV_KEYS) delete environment[key];
	return {
		...environment,
		DIVO_BACKEND_URL: values.backendUrl,
		DIVO_MEMBER_TOKEN: values.token,
		...(values.departmentId ? { DIVO_DEPARTMENT_ID: values.departmentId } : {}),
		DIVO_RUNTIME_CONTEXT_PATH: values.runtimeContextPath,
		DIVO_RUN_CONTEXT_PATH: values.runContextPath,
		DIVO_SKILL_DIRS: scopedManifest(values.isRunScoped)
			.trustedSkills.map((name) => path.join(divoDir, "skills", name))
			.join(path.delimiter),
		DIVO_BUNDLED_SKILLS_DIR: path.join(divoDir, "skills"),
		DIVO_WORKSPACE_DIR: values.workspace,
		DIVO_INTERNAL_DIR: values.internalDir,
		DIVO_RUN_ID: values.runId,
		DIVO_RUN_DIR: values.runDir,
		DIVO_SCRATCH_DIR: values.scratchDir,
		DIVO_SCRIPTS_DIR: values.scriptsDir,
		DIVO_ARTIFACTS_DIR: values.artifactsDir,
		DIVO_LOGS_DIR: values.logsDir,
		// A group turn is not told where past sessions live. This removes the
		// signpost, not the path: `read` and `bash` stay available, `HOME` still
		// names the state root the transcripts sit under, and everything in the
		// container runs as one uid. Containing this properly needs a process
		// boundary — a second uid or a mount namespace hiding the durable session
		// tree — which is not something the runtime can do to itself.
		...(values.isRunScoped ? {} : { DIVO_CHAT_HISTORY_DIR: values.dataDir }),
		DIVO_HOME: values.homeDir,
		HOME: values.homeDir,
		XDG_CACHE_HOME: path.join(values.homeDir, ".cache"),
		PYTHONUSERBASE: path.join(values.homeDir, ".local"),
		PIP_BREAK_SYSTEM_PACKAGES: "1",
		PIP_CACHE_DIR: path.join(values.homeDir, ".cache", "pip"),
		npm_config_cache: path.join(values.homeDir, ".cache", "npm"),
		npm_config_prefix: path.join(values.homeDir, ".npm"),
		PI_CODING_AGENT_DIR: values.agentDir,
	};
}

/**
 * Where this run's Pi session lives, given the scope it was started with.
 *
 * A thread-scoped session is the durable notebook for that thread, and belongs
 * on the user's volume: a DM is one person's conversation and resuming it is the
 * continuity.
 *
 * A run-scoped session is deliberately kept **off** that volume. The container
 * mounts the volume read-write and is otherwise read-only apart from a tmpfs, so
 * putting a shared group transcript on the tmpfs means it cannot reach the
 * user's disk even if the container is killed before cleanup runs — the tmpfs
 * dies with the container. Deleting it on exit stays as hygiene inside the warm
 * window, but it is no longer what guarantees the transcript is not kept.
 */
export function resolveSessionPaths({
	dataDir,
	thread,
	runId,
	sessionScope = "thread",
	ephemeralRoot = path.join(os.tmpdir(), "divo-sessions"),
}) {
	const threadDir = path.join(dataDir, "threads", thread);
	const isRunScoped = sessionScope === "run";
	const runSessionsRoot = path.join(ephemeralRoot, "threads", thread, "runs");
	const sessionDir = isRunScoped ? path.join(runSessionsRoot, runId) : threadDir;
	return {
		isRunScoped,
		runSessionsRoot,
		sessionDir,
		sessionPath: path.join(sessionDir, "pi-session.jsonl"),
		threadDir,
	};
}

export function resolveRuntimeThreadId(thread, runtimeThreadId = thread) {
	if (typeof runtimeThreadId !== "string" || !runtimeThreadId.trim()) {
		throw new Error("Runtime thread ID is required");
	}
	const value = runtimeThreadId.trim();
	if (value.length > 200) {
		throw new Error("Runtime thread ID is too long");
	}
	return value;
}

export function buildPiArguments(values) {
	const allowed = scopedManifest(values.isRunScoped);
	const extensionArguments = allowed.extensions.flatMap((name) => [
		"--extension",
		path.join(divoDir, "extensions", name, "index.ts"),
	]);
	const skillArguments = allowed.trustedSkills.flatMap((name) => [
		"--skill",
		path.join(divoDir, "skills", name),
	]);
	const args = [
		"--tsconfig",
		path.join(repositoryRoot, "tsconfig.json"),
		path.join(repositoryRoot, "packages", "coding-agent", "src", "cli.ts"),
		"--session",
		values.sessionPath,
		"--session-dir",
		values.sessionDir,
		"--provider",
		values.provider,
		"--model",
		values.model,
		"--thinking",
		manifest.thinkingLevel,
		"--append-system-prompt",
		renderWorkspacePrompt({
			workspace: values.workspace,
			image_policy: imagePolicyFor(values.model),
			thread_id: values.thread,
			run_dir: values.runDir,
			artifacts_dir: values.artifactsDir,
		}),
		"--no-skills",
		"--no-extensions",
		"--no-prompt-templates",
		"--no-context-files",
		"--tools",
		allowed.toolAllowlist.join(","),
		...extensionArguments,
		...skillArguments,
	];
	if (values.mode === "rpc") args.push("--mode", "rpc");
	if (values.print) args.push("--print");
	if (values.prompt) args.push(values.prompt);
	return args;
}

export function startDivoPi({
	backendUrl,
	token,
	departmentId,
	runtimeContext,
	stateRoot = defaultStateRoot,
	workspace = path.join(stateRoot, "workspace"),
	thread = "terminal-phase-0",
	runtimeThreadId,
	mode = "tui",
	sessionScope = "thread",
	// The model the run was launched for. The backend picks it from the member's
	// grant; the manifest supplies it when nothing else does, which is what a
	// terminal launch and every run before per-member selection existed use.
	model = manifest.model,
	provider = manifest.provider,
	print = false,
	prompt,
}) {
	if (!backendUrl || !token) {
		throw new Error("Divo authentication is required before Pi can start");
	}
	if (!isRuntimeModel(model)) {
		throw new Error(`Model must be one of: ${RUNTIME_MODEL_IDS.join(", ")}`);
	}
	if (providerForModel(model) !== provider) {
		throw new Error(`Model ${model} is served by ${providerForModel(model)}, not ${provider}`);
	}
	if (!/^[A-Za-z0-9._-]+$/.test(thread)) {
		throw new Error("Thread must contain only letters, numbers, dot, underscore, or dash");
	}
	const executionThreadId = resolveRuntimeThreadId(thread, runtimeThreadId);
	if (!["tui", "rpc"].includes(mode)) {
		throw new Error('Mode must be either "tui" or "rpc"');
	}
	if (!["thread", "run"].includes(sessionScope)) {
		throw new Error('Session scope must be either "thread" or "run"');
	}
	const tsx = path.join(repositoryRoot, "node_modules", ".bin", "tsx");
	if (!fs.existsSync(tsx)) {
		throw new Error("Divo Pi dependencies are missing. Run npm ci --ignore-scripts first.");
	}

	const runId = randomUUID();
	const agentDir = path.join(stateRoot, "agent");
	const dataDir = path.join(stateRoot, "data");
	const homeDir = path.join(stateRoot, "home");
	// A run-scoped session lives on the container's tmpfs and is removed when this
	// process exits: the conversation it needs was sent in with the request, so a
	// private copy would only duplicate it once per turn — and a shared group
	// transcript has no business on one participant's durable volume.
	const {
		isRunScoped,
		runSessionsRoot,
		sessionDir,
		sessionPath,
		threadDir,
	} = resolveSessionPaths({
		dataDir,
		thread,
		runId,
		sessionScope,
	});
	const internalDir = path.join(workspace, ".divo");
	const runDir = path.join(internalDir, "threads", thread, "runs", runId);
	const scratchDir = path.join(runDir, "tmp");
	const scriptsDir = path.join(runDir, "scripts");
	const logsDir = path.join(runDir, "logs");
	const artifactsDir = path.join(workspace, "artifacts");
	const contextDir = path.join(stateRoot, "context");
	const runtimeContextPath = path.join(contextDir, "runtime.json");
	const runContextPath = path.join(contextDir, `${thread}.json`);

	for (const directory of [
		agentDir,
		dataDir,
		homeDir,
		workspace,
		sessionDir,
		runDir,
		scratchDir,
		scriptsDir,
		logsDir,
		artifactsDir,
		contextDir,
	]) {
		ensureDirectory(directory);
	}
	prepareSessionDirectories({ isRunScoped, runSessionsRoot, runId, threadDir });
	for (const extensionName of manifest.extensions) {
		ensureExtensionLink(agentDir, extensionName);
	}
	fs.writeFileSync(
		path.join(agentDir, "settings.json"),
		`${JSON.stringify(
			{
				packages: [],
				defaultProvider: provider,
				defaultModel: model,
				defaultThinkingLevel: manifest.thinkingLevel,
			},
			null,
			2,
		)}\n`,
	);
	fs.writeFileSync(runtimeContextPath, `${JSON.stringify(runtimeContext, null, 2)}\n`, {
		mode: 0o600,
	});
	fs.writeFileSync(
		runContextPath,
		`${JSON.stringify(
			{
				version: 1,
				threadId: executionThreadId,
				runId,
				...(departmentId ? { departmentId } : {}),
			},
			null,
			2,
		)}\n`,
		{ mode: 0o600 },
	);

	const values = {
		agentDir,
		artifactsDir,
		backendUrl,
		dataDir,
		departmentId,
		homeDir,
		internalDir,
		isRunScoped,
		logsDir,
		mode,
		model,
		print,
		prompt,
		provider,
		runContextPath,
		runDir,
		runId,
		runtimeContextPath,
		scratchDir,
		scriptsDir,
		sessionDir,
		sessionPath,
		thread,
		token,
		workspace: path.resolve(workspace),
	};
	const child = spawn(tsx, buildPiArguments(values), {
		cwd: values.workspace,
		env: buildChildEnvironment(process.env, values),
		stdio: "inherit",
	});
	child.once("error", (error) => {
		console.error(`[divo-pi] failed to start: ${error.message}`);
		process.exitCode = 1;
	});
	child.once("exit", (code, signal) => {
		if (signal) console.error(`[divo-pi] exited by signal ${signal}`);
		// Removed on every outcome, not only success: a failed or interrupted run
		// leaves a partial transcript that the next turn must not resume, since
		// the authoritative conversation is sent in with the request.
		if (isRunScoped) removeDirectory(sessionDir);
		process.exitCode = code ?? 1;
	});
	return child;
}

export const defaults = {
	repositoryRoot,
	stateRoot: defaultStateRoot,
	workspace: path.join(defaultStateRoot, "workspace"),
};
