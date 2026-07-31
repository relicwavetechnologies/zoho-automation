/**
 * Pi-owned subagents for Divo.
 *
 * The parent Pi process owns delegation, parallel scheduling, result synthesis,
 * and abort propagation. This extension only turns the child Pi JSON stream into
 * stable, structured tool updates so the desktop can render the parent chat
 * without confusing events from different runs.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	isRuntimeModel,
	providerForModel,
	thinkingLevelForModel,
} from "../../runtime-models.mjs";
import { DIVO_SUBAGENT_ROLES, getDivoSubagentRole } from "./agents.ts";
import { resolveDivoGatewayConfig } from "../divo-gateway/gateway-client.ts";
import {
	addAssistantOutput,
	addEvent,
	completeChild,
	createChild,
	makeDetails,
	setThinking,
	setToolActivity,
	startChild,
	type SubagentChild,
	type SubagentDetails,
	type SubagentMode,
	truncateText,
} from "./progress.ts";

const DIVO_CHILD_PROVIDER = "deepseek";
const DIVO_CHILD_MODEL = "deepseek-v4-flash";

interface DivoChildModel {
	provider: string;
	model: string;
}

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const MAX_TASK_CHARS = 16_000;
const MAX_STDERR_CHARS = 64 * 1024;
const MAX_STDOUT_BUFFER_CHARS = 1024 * 1024;
const MAX_MODEL_OUTPUT_PER_CHILD = 12_000;
const UPDATE_THROTTLE_MS = 125;

type ToolContent = { type: "text"; text: string };
type ToolUpdate = { content: ToolContent[]; details: SubagentDetails };
type OnUpdate = (update: ToolUpdate) => void;
type RegisterAborter = (abort: () => void) => () => void;

type DelegatedTask = { agent: string; task: string };

const TaskItem = Type.Object({
	agent: Type.String({ description: "Bundled Pi role: scout, planner, reviewer, or worker." }),
	task: Type.String({ description: "Complete, bounded task delegated to that Pi role." }),
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Role for one delegated task." })),
	task: Type.Optional(Type.String({ description: "Task for one delegated role." })),
	tasks: Type.Optional(Type.Array(TaskItem, {
		description: "Independent tasks to run in parallel. At most eight tasks, with four running at once.",
		maxItems: MAX_PARALLEL_TASKS,
	})),
	chain: Type.Optional(Type.Array(TaskItem, {
		description: "Sequential tasks. Use {previous} in a task to insert the preceding role's final result.",
		maxItems: MAX_PARALLEL_TASKS,
	})),
});

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function textFromMessage(message: unknown): string {
	const record = asRecord(message);
	if (!record || record.role !== "assistant" || !Array.isArray(record.content)) return "";
	return record.content
		.flatMap((part) => {
			const item = asRecord(part);
			return item?.type === "text" && typeof item.text === "string" ? [item.text] : [];
		})
		.join("\n")
		.trim();
}

function readUsage(child: SubagentChild, message: unknown): void {
	const record = asRecord(message);
	if (!record || record.role !== "assistant") return;
	const usage = asRecord(record.usage);
	if (usage) {
		child.usage.input += typeof usage.input === "number" ? usage.input : 0;
		child.usage.output += typeof usage.output === "number" ? usage.output : 0;
		child.usage.cacheRead += typeof usage.cacheRead === "number" ? usage.cacheRead : 0;
		child.usage.cacheWrite += typeof usage.cacheWrite === "number" ? usage.cacheWrite : 0;
		const cost = asRecord(usage.cost);
		child.usage.cost += typeof cost?.total === "number" ? cost.total : 0;
		child.usage.contextTokens = typeof usage.totalTokens === "number" ? usage.totalTokens : child.usage.contextTokens;
	}
	child.usage.turns += 1;
	if (!child.model && typeof record.model === "string") child.model = record.model;
	if (typeof record.stopReason === "string") child.stopReason = record.stopReason;
}

function truncateForLog(value: unknown): string {
	if (typeof value === "string") return truncateText(value.replace(/\s+/g, " ").trim(), 140);
	try {
		return truncateText(JSON.stringify(value), 140);
	} catch {
		return "";
	}
}

function formatChildTool(event: Record<string, unknown>): string {
	const name = typeof event.toolName === "string" ? event.toolName : "tool";
	const args = asRecord(event.args);
	const pathValue = args?.file_path ?? args?.path;
	if (typeof pathValue === "string" && pathValue.trim()) return `${name} ${pathValue}`;
	const command = args?.command;
	if (typeof command === "string" && command.trim()) return `${name} ${truncateForLog(command)}`;
	return `${name}${args && Object.keys(args).length ? ` ${truncateForLog(args)}` : ""}`;
}

function readStopReason(event: Record<string, unknown>): string | undefined {
	if (typeof event.stopReason === "string") return event.stopReason;
	const message = asRecord(event.message);
	if (typeof message?.stopReason === "string") return message.stopReason;
	const result = asRecord(event.result);
	return typeof result?.stopReason === "string" ? result.stopReason : undefined;
}

export function applyChildEvent(child: SubagentChild, event: Record<string, unknown>): string | undefined {
	switch (event.type) {
		case "agent_start":
			setThinking(child, "Preparing");
			break;
		case "turn_start":
			setThinking(child, "Thinking");
			break;
		case "tool_execution_start":
			setToolActivity(
				child,
				typeof event.toolCallId === "string" ? event.toolCallId : undefined,
				formatChildTool(event),
				"tool_started"
			);
			break;
		case "tool_execution_update":
			setToolActivity(
				child,
				typeof event.toolCallId === "string" ? event.toolCallId : undefined,
				formatChildTool(event),
				"tool_updated"
			);
			break;
		case "tool_execution_end":
			setToolActivity(
				child,
				typeof event.toolCallId === "string" ? event.toolCallId : undefined,
				formatChildTool(event),
				"tool_completed"
			);
			break;
		case "message_end": {
			const message = event.message;
			readUsage(child, message);
			const assistantOutput = textFromMessage(message);
			addAssistantOutput(child, assistantOutput);
			return assistantOutput || undefined;
		}
		case "agent_end": {
			const stopReason = readStopReason(event);
			if (stopReason) child.stopReason = stopReason;
			break;
		}
		case "extension_ui_request":
			// Child launches deliberately exclude extensions that request desktop
			// input. Keep this visible if an unexpected one slips through instead
			// of pretending the child is still doing useful work.
			child.activity = { kind: "waiting", label: "Waiting for child input" };
			addEvent(child, "thinking", "Waiting for child input");
			break;
	}
}

export function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [...process.execArgv, currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: process.execPath, args };
	return { command: "pi", args };
}

function resolveDivoChildExtensions(): { paths: string[] } | { error: string } {
	const agentDir = process.env.PI_CODING_AGENT_DIR;
	if (!agentDir) return { error: "PI_CODING_AGENT_DIR is missing; Divo cannot launch an authenticated child agent." };
	const paths = ["divo-llm", "divo-gateway"]
		.map((name) => path.join(agentDir, "extensions", name, "index.ts"));
	const missing = paths.filter((extensionPath) => !fs.existsSync(extensionPath));
	return missing.length > 0
		? { error: `Required Divo child extensions are missing: ${missing.map((item) => path.basename(path.dirname(item))).join(", ")}.` }
		: { paths };
}

/**
 * Rehydrate backend member auth only for a Pi child process. The child's
 * divo-llm extension captures it into provider memory and deletes it before
 * any Bash/Python tool can start. Ordinary local tool children therefore
 * continue to inherit the scrubbed parent environment.
 */
export function buildDivoSubagentEnvironment(
	baseEnv: NodeJS.ProcessEnv = process.env,
): { env: NodeJS.ProcessEnv } | { error: string } {
	const config = resolveDivoGatewayConfig();
	if ("error" in config) {
		return { error: `Divo child authentication is unavailable: ${config.error}` };
	}
	return {
		env: {
			...baseEnv,
			DIVO_BACKEND_URL: config.backendUrl,
			DIVO_MEMBER_TOKEN: config.memberToken,
			...(config.defaultDepartmentId ? { DIVO_DEPARTMENT_ID: config.defaultDepartmentId } : {}),
			DIVO_SUBAGENT_CHILD: "1",
		},
	};
}

/**
 * A child inherits the supported model that launched its parent. This keeps a
 * Luna-only member on the same authorized backend-proxied route; the Flash
 * fallback applies only when Pi has no recognized active parent model.
 */
export function resolveDivoChildModel(parent?: { id?: unknown; provider?: unknown }): DivoChildModel {
	const model = typeof parent?.id === "string" ? parent.id : "";
	const provider = typeof parent?.provider === "string" ? parent.provider : "";
	return isRuntimeModel(model) && providerForModel(model) === provider
		? { model, provider }
		: { model: DIVO_CHILD_MODEL, provider: DIVO_CHILD_PROVIDER };
}

export function buildDivoSubagentArgs(
	role: NonNullable<ReturnType<typeof getDivoSubagentRole>>,
	promptPath: string,
	extensionPaths: string[],
	delegatedTask: string,
	childModel: DivoChildModel = { model: DIVO_CHILD_MODEL, provider: DIVO_CHILD_PROVIDER },
): string[] {
	const args = [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--no-skills",
		"--no-extensions",
		"--no-prompt-templates",
		"--no-context-files",
		"--provider",
		childModel.provider,
		"--model",
		childModel.model,
		"--thinking",
		thinkingLevelForModel(childModel.model),
		"--tools",
		role.tools.join(","),
		"--append-system-prompt",
		promptPath,
	];
	for (const extensionPath of extensionPaths) {
		args.push("--extension", extensionPath);
	}
	args.push(`Task: ${delegatedTask}`);
	return args;
}

async function writePromptToTempFile(role: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "divo-pi-subagent-"));
	const filePath = path.join(dir, `prompt-${role}.md`);
	await fs.promises.writeFile(filePath, prompt, { encoding: "utf8", mode: 0o600 });
	return { dir, filePath };
}

function appendCapped(current: string, next: string, cap: number): string {
	if (current.length >= cap) return current;
	return `${current}${next}`.slice(0, cap);
}

function isFailed(child: SubagentChild): boolean {
	return child.state === "failed" || child.state === "cancelled";
}

function resultText(child: SubagentChild): string {
	return child.finalOutput || child.error || child.outputPreview || "(no output)";
}

function makeLiveText(details: SubagentDetails): string {
	const { summary } = details;
	const active = summary.running + summary.queued;
	return `Subagents: ${summary.completed}/${summary.total} completed, ${active} active${summary.failed ? `, ${summary.failed} failed` : ""}`;
}

function createUpdateEmitter(
	onUpdate: OnUpdate | undefined,
	parentToolCallId: string,
	mode: SubagentMode,
	children: SubagentChild[]
): { emit: (immediate?: boolean) => void; flush: () => void } {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let lastEmittedAt = 0;

	const flush = () => {
		if (timer) {
			clearTimeout(timer);
			timer = undefined;
		}
		if (!onUpdate) return;
		lastEmittedAt = Date.now();
		const details = makeDetails(parentToolCallId, mode, children);
		onUpdate({ content: [{ type: "text", text: makeLiveText(details) }], details });
	};

	const emit = (immediate = false) => {
		if (!onUpdate) return;
		if (immediate || Date.now() - lastEmittedAt >= UPDATE_THROTTLE_MS) {
			flush();
			return;
		}
		if (!timer) timer = setTimeout(flush, UPDATE_THROTTLE_MS);
	};

	return { emit, flush };
}

async function runChild(
	child: SubagentChild,
	delegatedTask: string,
	childModel: DivoChildModel,
	signal: AbortSignal | undefined,
	emit: () => void,
	registerAborter: RegisterAborter
): Promise<SubagentChild> {
	const role = getDivoSubagentRole(child.role);
	if (!role) {
		completeChild(
			child,
			`Unknown subagent role "${child.role}". Available roles: ${DIVO_SUBAGENT_ROLES.map((item) => item.name).join(", ")}.`,
			1,
			"error"
		);
		emit();
		return child;
	}

	startChild(child);
	emit();
	let promptDir: string | undefined;
	let promptPath: string | undefined;
	let stderr = "";
	let finalAssistantOutput = "";
	let wasAborted = false;

	try {
		const childExtensions = resolveDivoChildExtensions();
		if ("error" in childExtensions) throw new Error(childExtensions.error);
		const childEnvironment = buildDivoSubagentEnvironment();
		if ("error" in childEnvironment) throw new Error(childEnvironment.error);
		const prompt = await writePromptToTempFile(role.name, role.systemPrompt);
		promptDir = prompt.dir;
		promptPath = prompt.filePath;
		const args = buildDivoSubagentArgs(
			role,
			promptPath,
			childExtensions.paths,
			delegatedTask,
			childModel,
		);

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: process.cwd(),
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: childEnvironment.env,
			});
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: unknown;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}
				const record = asRecord(event);
				if (!record) return;
				const assistantOutput = applyChildEvent(child, record);
				if (assistantOutput) finalAssistantOutput = assistantOutput;
				emit();
			};

			proc.stdout.on("data", (data: Buffer) => {
				buffer += data.toString();
				if (buffer.length > MAX_STDOUT_BUFFER_CHARS) {
					buffer = "";
					setThinking(child, "Skipping oversized child event");
					emit();
					return;
				}
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});
			proc.stderr.on("data", (data: Buffer) => {
				stderr = appendCapped(stderr, data.toString(), MAX_STDERR_CHARS);
			});
			let terminationTimer: ReturnType<typeof setTimeout> | undefined;
			const abort = () => {
				if (wasAborted) return;
				wasAborted = true;
				proc.kill("SIGTERM");
				terminationTimer = setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 5_000);
			};
			const unregisterAborter = registerAborter(abort);
			const abortListener = () => abort();
			if (signal?.aborted) abort();
			else signal?.addEventListener("abort", abortListener, { once: true });
			const cleanup = () => {
				unregisterAborter();
				if (terminationTimer) clearTimeout(terminationTimer);
				signal?.removeEventListener("abort", abortListener);
			};

			proc.on("close", (code) => {
				cleanup();
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});
			proc.on("error", (error) => {
				cleanup();
				stderr = appendCapped(stderr, error.message, MAX_STDERR_CHARS);
				resolve(1);
			});
		});

		// `outputPreview` is intentionally capped for live UI updates. Persist the
		// full final assistant message instead so the parent and completed card do
		// not lose the rest of a successful child report.
		const output = finalAssistantOutput || child.outputPreview || stderr || "(no output)";
		completeChild(child, output, exitCode, wasAborted ? "aborted" : child.stopReason);
		emit();
		return child;
	} catch (error) {
		completeChild(child, error instanceof Error ? error.message : String(error), 1, wasAborted ? "aborted" : "error");
		emit();
		return child;
	} finally {
		if (promptPath) await fs.promises.unlink(promptPath).catch(() => undefined);
		if (promptDir) await fs.promises.rmdir(promptDir).catch(() => undefined);
	}
}

async function mapWithConcurrency<T>(
	items: T[],
	concurrency: number,
	fn: (item: T) => Promise<void>
): Promise<void> {
	let next = 0;
	const worker = async () => {
		while (true) {
			const index = next++;
			if (index >= items.length) return;
			await fn(items[index]);
		}
	};
	await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

function validateTask(task: DelegatedTask): string | undefined {
	if (!task.agent.trim()) return "Every subagent task needs a role.";
	if (!task.task.trim()) return "Every subagent task needs a task.";
	if (task.task.length > MAX_TASK_CHARS) return `Each subagent task is limited to ${MAX_TASK_CHARS} characters.`;
	return undefined;
}

function finalParallelContent(children: SubagentChild[]): string {
	const succeeded = children.filter((child) => child.state === "completed").length;
	const blocks = children.map((child) => {
		const status = isFailed(child) ? child.state : "completed";
		return `### [${child.role}] ${status}\n\n${truncateText(resultText(child), MAX_MODEL_OUTPUT_PER_CHILD)}`;
	});
	return `Parallel subagents: ${succeeded}/${children.length} completed\n\n${blocks.join("\n\n---\n\n")}`;
}

export default function divoSubagentsExtension(pi: ExtensionAPI) {
	const activeChildAborters = new Set<() => void>();
	const registerAborter: RegisterAborter = (abort) => {
		activeChildAborters.add(abort);
		return () => activeChildAborters.delete(abort);
	};
	pi.on("session_shutdown", () => {
		for (const abort of activeChildAborters) abort();
		activeChildAborters.clear();
	});

	pi.registerTool({
		name: "divo_subagents",
		label: "Divo subagents",
		description: "Delegate bounded company research, retrieval, analysis, planning, preparation, or verification to isolated Pi child agents. Supports a single task, independent parallel tasks, or a sequential chain. The primary agent owns coordination, validation, and synthesis.",
		promptSnippet: "Use divo_subagents selectively when substantial independent company workstreams can proceed in parallel, when a focused investigation protects the main context, or when an independent review materially improves reliability.",
		promptGuidelines: [
			"Roles: scout for rapid source and system reconnaissance, planner for business workflows, reviewer for independent quality checks, and worker for detailed read-only analysis or preparation.",
			"Each child starts in an isolated context and does not receive the parent conversation. Make every task self-contained with its objective, relevant context, scope, exclusions, sources, permitted actions, deliverable, acceptance criteria, required evidence, and the decision its result must support.",
			"Child agents have divo_gateway and divo_skill_resolve plus read-only local tools. They may research, inspect, analyze, compare, plan, draft, or review; do not delegate approvals, external mutations, messages, schedule activation, Teach writes, or irreversible actions.",
			"Use tasks for substantial independent work only, normally with two to four non-overlapping assignments. Do not delegate simple requests or duplicate work unless independent verification is intentional.",
			"Every child returns the shared final handoff: verdict, key findings, evidence, gaps and confidence, and exactly one recommended next step. Do not ask a child for an open-ended essay or a user-facing final answer.",
			"Use chain for dependent steps and {previous} only where the next role genuinely needs the prior final result.",
			"The parent remains responsible for user interaction, permissions and approvals, checking evidence, reconciling conflicts, taking final actions, and giving the user one synthesized answer.",
		],
		parameters: SubagentParams,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const single = params.agent && params.task ? [{ agent: params.agent, task: params.task }] : undefined;
			const parallel = params.tasks?.length ? params.tasks : undefined;
			const chain = params.chain?.length ? params.chain : undefined;
			const modes = Number(Boolean(single)) + Number(Boolean(parallel)) + Number(Boolean(chain));
			if (modes !== 1) {
				return {
					content: [{ type: "text", text: "Provide exactly one subagent mode: agent + task, tasks, or chain." }],
					details: makeDetails(toolCallId, "single", []),
					isError: true,
				};
			}

			const mode: SubagentMode = parallel ? "parallel" : chain ? "chain" : "single";
			const requested = (parallel ?? chain ?? single ?? []) as DelegatedTask[];
			if (requested.length > MAX_PARALLEL_TASKS) {
				return {
					content: [{ type: "text", text: `Too many subagent tasks (${requested.length}). Maximum is ${MAX_PARALLEL_TASKS}.` }],
					details: makeDetails(toolCallId, mode, []),
					isError: true,
				};
			}
			for (const task of requested) {
				const error = validateTask(task);
				if (error) {
					return {
						content: [{ type: "text", text: error }],
						details: makeDetails(toolCallId, mode, []),
						isError: true,
					};
				}
			}

			const children = requested.map((task, index) => createChild(index, task.agent.trim(), task.task.trim()));
			const childModel = resolveDivoChildModel(ctx.model);
			const emitter = createUpdateEmitter(onUpdate, toolCallId, mode, children);
			emitter.emit(true);

			if (mode === "parallel") {
				await mapWithConcurrency(children, MAX_CONCURRENCY, async (child) => {
					await runChild(child, child.task, childModel, signal, () => emitter.emit(), registerAborter);
				});
				emitter.flush();
				const details = makeDetails(toolCallId, mode, children);
				return {
					content: [{ type: "text", text: finalParallelContent(children) }],
					details,
					isError: children.every(isFailed),
				};
			}

			let previousOutput = "";
			for (const child of children) {
				const delegatedTask =
					mode === "chain" ? child.task.replaceAll("{previous}", previousOutput) : child.task;
				await runChild(child, delegatedTask, childModel, signal, () => emitter.emit(), registerAborter);
				if (isFailed(child)) {
					emitter.flush();
					return {
						content: [{ type: "text", text: `Subagent ${child.role} ${child.state}: ${resultText(child)}` }],
						details: makeDetails(toolCallId, mode, children),
						isError: true,
					};
				}
				previousOutput = truncateText(resultText(child), MAX_MODEL_OUTPUT_PER_CHILD);
			}

			emitter.flush();
			const result = children[children.length - 1];
			return {
				content: [{ type: "text", text: resultText(result) }],
				details: makeDetails(toolCallId, mode, children),
			};
		},
	});
}
