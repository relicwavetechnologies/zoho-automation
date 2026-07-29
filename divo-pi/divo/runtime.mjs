import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

function ensureDirectory(directory) {
	fs.mkdirSync(directory, { recursive: true });
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
		DIVO_SKILL_DIRS: manifest.trustedSkills
			.map((name) => path.join(divoDir, "skills", name))
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
		DIVO_CHAT_HISTORY_DIR: values.dataDir,
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

export function buildPiArguments(values) {
	const extensionArguments = manifest.extensions.flatMap((name) => [
		"--extension",
		path.join(divoDir, "extensions", name, "index.ts"),
	]);
	const skillArguments = manifest.trustedSkills.flatMap((name) => [
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
		manifest.provider,
		"--model",
		manifest.model,
		"--thinking",
		manifest.thinkingLevel,
		"--append-system-prompt",
		renderWorkspacePrompt({
			workspace: values.workspace,
			thread_id: values.thread,
			run_dir: values.runDir,
			artifacts_dir: values.artifactsDir,
		}),
		"--no-skills",
		"--no-extensions",
		"--no-prompt-templates",
		"--no-context-files",
		"--tools",
		manifest.toolAllowlist.join(","),
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
	mode = "tui",
	print = false,
	prompt,
}) {
	if (!backendUrl || !token) {
		throw new Error("Divo authentication is required before Pi can start");
	}
	if (!/^[A-Za-z0-9._-]+$/.test(thread)) {
		throw new Error("Thread must contain only letters, numbers, dot, underscore, or dash");
	}
	if (!["tui", "rpc"].includes(mode)) {
		throw new Error('Mode must be either "tui" or "rpc"');
	}
	const tsx = path.join(repositoryRoot, "node_modules", ".bin", "tsx");
	if (!fs.existsSync(tsx)) {
		throw new Error("Divo Pi dependencies are missing. Run npm ci --ignore-scripts first.");
	}

	const runId = randomUUID();
	const agentDir = path.join(stateRoot, "agent");
	const dataDir = path.join(stateRoot, "data");
	const homeDir = path.join(stateRoot, "home");
	const sessionDir = path.join(dataDir, "threads", thread);
	const sessionPath = path.join(sessionDir, "pi-session.jsonl");
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
	for (const extensionName of manifest.extensions) {
		ensureExtensionLink(agentDir, extensionName);
	}
	fs.writeFileSync(
		path.join(agentDir, "settings.json"),
		`${JSON.stringify(
			{
				packages: [],
				defaultProvider: manifest.provider,
				defaultModel: manifest.model,
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
				threadId: thread,
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
		logsDir,
		mode,
		print,
		prompt,
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
		process.exitCode = code ?? 1;
	});
	return child;
}

export const defaults = {
	repositoryRoot,
	stateRoot: defaultStateRoot,
	workspace: path.join(defaultStateRoot, "workspace"),
};
