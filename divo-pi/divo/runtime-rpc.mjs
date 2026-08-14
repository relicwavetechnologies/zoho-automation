/**
 * The wire between the controller and Pi, and what to do when it stalls.
 *
 * Pi speaks newline-delimited JSON over `docker exec` stdio. That framing is
 * the whole of this module's job: match a reply to the request that asked for
 * it, hand extension prompts to whoever is answering them, and let a caller
 * wait for a named event.
 *
 * The retry policy lives here rather than in the turn plan because it is a
 * property of this transport, not of a turn. A provider that fails mid-stream
 * leaves work already done in the session, so the retry continues that work
 * rather than restarting it — the alternative repeats completed tool calls and
 * their side effects. Waiting for the runtime to go idle first is part of the
 * same rule: sending a second prompt into a session still finishing the first
 * is how a "retry" becomes two runs.
 */
import { spawn } from "node:child_process";
import { buildContainerRunArgs } from "./runtime-docker.mjs";
import {
	classifyDivoRunTerminal,
	isTransientDivoRunFailure,
} from "./run-terminal.mjs";
import {
	collectRunAssistantText,
	completedGatewayFallback,
	gatewayActionState,
	terminalRunError,
} from "./run-result.mjs";
import { emitRuntimeProgress } from "./runtime-progress.mjs";

const RPC_TIMEOUT_MS = 30_000;
const MAX_TRANSIENT_MODEL_RETRIES = 3;
const MODEL_RETRY_IDLE_TIMEOUT_MS = 5_000;
const MODEL_RETRY_PROMPT =
	"The previous model continuation failed because the provider was temporarily unavailable. Continue this same request from the work already present in the session. Do not repeat completed tool calls or side effects. Finish the remaining work and return only the final user-facing answer.";

async function waitForRpcIdle(rpc, {
	timeoutMs = MODEL_RETRY_IDLE_TIMEOUT_MS,
	pollMs = 25,
	sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() <= deadline) {
		const state = await rpc.send(
			{ type: "get_state" },
			Math.min(timeoutMs, RPC_TIMEOUT_MS),
		);
		if (state?.isStreaming !== true && state?.isCompacting !== true) return;
		await sleep(pollMs);
	}
	throw terminalRunError({
		summary: "The model runtime did not become idle after a transient provider failure.",
	});
}

export async function promptWithTransientRetries({
	rpc,
	message,
	maxRetries = MAX_TRANSIENT_MODEL_RETRIES,
	retryDelayMs = 1_000,
	waitForIdle = waitForRpcIdle,
	onRetry,
	signal,
}) {
	rpc.beginRun?.();
	for (let retry = 0; ; retry += 1) {
		signal?.throwIfAborted();
		const completed = rpc.waitFor("agent_end");
		await rpc.send(
			{ type: "prompt", message: retry === 0 ? message : MODEL_RETRY_PROMPT },
			90_000,
		);
		const completion = await completed;
		const terminal = classifyDivoRunTerminal(completion?.messages);
		if (terminal.status === "ok") return completion;
		if (!isTransientDivoRunFailure(completion?.messages) || retry >= maxRetries) {
			throw terminalRunError(terminal, completion?.messages);
		}
		const actionState = gatewayActionState(completion?.messages);
		if (actionState === "mutation_then_read" || actionState === "completed_mutation") {
			return completedGatewayFallback(completion, actionState === "mutation_then_read");
		}
		if (actionState === "unsafe") {
			throw terminalRunError({
				summary:
					"The model provider failed after a company action was issued. Divo stopped instead of retrying and risking a duplicate action.",
			});
		}
		const attempt = retry + 1;
		onRetry?.({ attempt, maxRetries, summary: terminal.summary });
		signal?.throwIfAborted();
		if (retryDelayMs > 0) {
			await new Promise((resolve, reject) => {
				const timer = setTimeout(resolve, retryDelayMs * 2 ** retry);
				if (!signal) return;
				signal.addEventListener("abort", () => {
					clearTimeout(timer);
					reject(signal.reason ?? new Error("request disconnected"));
				}, { once: true });
			});
		}
		await waitForIdle(rpc);
	}
}


export class JsonlRpc {
	constructor(child, answerRequest, onProgress) {
		this.child = child;
		this.answerRequest = answerRequest;
		this.onProgress = onProgress;
		this.writingStarted = false;
		this.nextId = 0;
		this.pending = new Map();
		this.waiters = new Map();
		this.reader = readline.createInterface({ input: child.stdout });
		this.reader.on("line", (line) => this.handleLine(line));
		child.once("exit", (code, signal) => {
			const error = new Error(
				`Docker attach exited ${signal ? `with ${signal}` : `with code ${code}`}`,
			);
			this.rejectAll(error);
		});
		child.once("error", (error) => this.rejectAll(error));
	}

	handleLine(line) {
		let value;
		try {
			value = JSON.parse(line);
		} catch {
			this.rejectAll(new Error(`Pi emitted invalid JSONL: ${line.slice(0, 160)}`));
			return;
		}
		if (value.type === "response" && value.id && this.pending.has(value.id)) {
			const pending = this.pending.get(value.id);
			this.pending.delete(value.id);
			clearTimeout(pending.timeout);
			if (value.success) pending.resolve(value.data);
			else pending.reject(new Error(value.error || `${value.command} failed`));
			return;
		}
		const waiters = this.waiters.get(value.type) ?? [];
		this.waiters.delete(value.type);
		for (const waiter of waiters) waiter.resolve(value);
		// Preserve the provider's real answer stream before projecting the same
		// Pi event into sentence-sized status updates. These are intentionally two
		// events: collapsing either one into the other makes one of the web answer
		// or the Lark card behave badly.
		const answerDelta = projectRuntimeAnswerDelta(value);
		if (answerDelta) emitRuntimeProgress(this.onProgress, answerDelta);
		const progress = projectRuntimeProgress(value);
		if (progress && !(progress.type === "writing" && this.writingStarted)) {
			if (progress.type === "writing") this.writingStarted = true;
			emitRuntimeProgress(this.onProgress, progress);
		}
		if (value.type === "extension_ui_request") {
			void this.answerRequest(value, (response) => this.write(response));
		}
	}

	rejectAll(error) {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timeout);
			pending.reject(error);
		}
		this.pending.clear();
		for (const waiters of this.waiters.values()) {
			for (const waiter of waiters) waiter.reject(error);
		}
		this.waiters.clear();
	}

	write(value) {
		this.child.stdin.write(`${JSON.stringify(value)}\n`);
	}

	beginRun() {
		this.writingStarted = false;
	}

	configure({ answerRequest, onProgress }) {
		this.answerRequest = answerRequest;
		this.onProgress = onProgress;
	}

	send(command, timeoutMs = RPC_TIMEOUT_MS) {
		const id = `controller-${++this.nextId}`;
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`RPC ${command.type} timed out`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timeout });
			this.write({ ...command, id });
		});
	}

	waitFor(type) {
		return new Promise((resolve, reject) => {
			const waiters = this.waiters.get(type) ?? [];
			waiters.push({ resolve, reject });
			this.waiters.set(type, waiters);
		});
	}
}

function runtimeExitPromise(child) {
	return new Promise((resolve) => {
		child.once("error", (error) => resolve({ error }));
		child.once("exit", (code, terminationSignal) => resolve({ code, terminationSignal }));
	});
}

export function spawnRuntimeRpc(container, answerRequest, onProgress) {
	const child = spawn("docker", buildContainerRunArgs(container), {
		stdio: ["pipe", "pipe", "pipe"],
	});
	child.stderr.pipe(process.stderr);
	const exited = runtimeExitPromise(child);
	const rpc = new JsonlRpc(child, answerRequest, onProgress);
	return { child, exited, rpc };
}
