/**
 * Coordination for one Cloud-Pi run.
 *
 * This module decides the *order* of a turn: resolve the lease, make the
 * runtime exist, stage the skill catalogue, hand the model its message, and
 * settle what happens to the process and container afterwards. The policies it
 * coordinates each have their own owner:
 *
 * - `runtime-identity.mjs` — who a run is, and what it may be called;
 * - `runtime-docker.mjs` — every Docker resource, ownership check and exec argv;
 * - `runtime-warm-process.mjs` — process reuse, idle teardown, reclamation;
 * - `runtime-turn-phases.mjs` — how long each phase of a turn took;
 * - `native-skills.mjs`, `runtime-progress.mjs`, `run-terminal.mjs` — the
 *   catalogue, the projections a turn streams, and what counts as finished.
 *
 * Each of those is imported directly by whoever needs it. This module used to
 * re-export their surfaces verbatim, which made it look like their owner and
 * sent every reader here first.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import {
	fetchMemberSession,
	fetchRuntimeSession,
	normalizeBackendUrl,
	signInWithLark,
} from "./auth.mjs";
import {
	fetchRunContext,
	nativeSkillBootstrapDigest,
} from "./native-skills.mjs";
import {
	attachmentManifestBlock,
} from "./runtime-attachments.mjs";
import {
	buildContainerRunArgs,
	deleteDurableSession,
	ensureRuntime,
	findOwnedContainer,
	prepareWarmRuntime,
	recordRuntimeInterruption,
	resolveImageId,
	resourcesFor,
	runProcess,
	runWithInput,
	stageNativeSkillBootstrap,
	startContainer,
	stageRuntimeInterruption,
	stopOwnedContainer,
	waitUntilRunning,
	writeBootstrap,
	backendUrlForContainer,
} from "./runtime-docker.mjs";
import { createTurnPhases } from "./runtime-turn-phases.mjs";
import {
	assertExpectedLogin,
	assertPinnedProfile,
	trustedRuntimeSession,
	validateProfileName,
	validateRuntimeModel,
	validateSessionLifecycleOperation,
	validateSessionScope,
	validateThread,
	runtimeIdentityNames,
} from "./runtime-identity.mjs";
import {
	assertRuntimeExit,
	canReusePiProcess,
	discardWarmPiProcess,
	endRuntimeInput,
	finalizeRuntimeLifecycle,
	forgetWarmPiProcess,
	getWarmPiProcess,
	hasWarmPiProcess,
	idleContainers,
	piProcessBinding,
	piProcessBindingMatches,
	piProcessBindingMismatchReason,
	rememberWarmPiProcess,
	waitForClosedRuntime,
} from "./runtime-warm-process.mjs";
import {
	classifyDivoRunTerminal,
	isTransientDivoRunFailure,
} from "./run-terminal.mjs";
import { isRuntimeChannel } from "./runtime-channels.mjs";
import {
	isGovernedDivoTool,
	projectRuntimeAnswerDelta,
	projectRuntimeProgress,
} from "./runtime-progress.mjs";

const KEYCHAIN_SERVICE = "dev.divo-pi.local";
const PROFILE_ROOT = path.join(os.homedir(), ".divo-pi", "profiles");
const RPC_TIMEOUT_MS = 30_000;
const KEYCHAIN_TIMEOUT_MS = 15_000;
const MAX_TRANSIENT_MODEL_RETRIES = 3;
const MODEL_RETRY_IDLE_TIMEOUT_MS = 5_000;
const SOFT_ABORT_TIMEOUT_MS = 15_000;
const MODEL_RETRY_PROMPT =
	"The previous model continuation failed because the provider was temporarily unavailable. Continue this same request from the work already present in the session. Do not repeat completed tool calls or side effects. Finish the remaining work and return only the final user-facing answer.";
let tokenReadTail = Promise.resolve();

function profilePath(profile) {
	return path.join(PROFILE_ROOT, `${validateProfileName(profile)}.json`);
}

function writeProfile(metadata) {
	fs.mkdirSync(PROFILE_ROOT, { recursive: true, mode: 0o700 });
	fs.chmodSync(PROFILE_ROOT, 0o700);
	fs.writeFileSync(profilePath(metadata.profile), `${JSON.stringify(metadata, null, 2)}\n`, {
		mode: 0o600,
	});
}

function readProfile(profile) {
	const filePath = profilePath(profile);
	if (!fs.existsSync(filePath)) {
		throw new Error(
			`Profile "${profile}" is not logged in. Run: node divo/local-rpc-controller.mjs login ${profile} --backend <url>`,
		);
	}
	const metadata = JSON.parse(fs.readFileSync(filePath, "utf8"));
	if (
		metadata.profile !== validateProfileName(profile) ||
		!metadata.userId ||
		!metadata.companyId ||
		!metadata.backendUrl
	) {
		throw new Error(`Profile metadata is invalid: ${filePath}`);
	}
	return metadata;
}

async function storeToken(profile, token) {
	if (process.platform !== "darwin") {
		throw new Error("Phase-0 credential storage currently requires macOS Keychain");
	}
	const source = `
import Foundation
import Security

let account = CommandLine.arguments[1]
let service = CommandLine.arguments[2]
guard let password = readLine(strippingNewline: true)?.data(using: .utf8) else {
	fputs("Missing token on stdin\\n", stderr)
	exit(1)
}
let query: [String: Any] = [
	kSecClass as String: kSecClassGenericPassword,
	kSecAttrAccount as String: account,
	kSecAttrService as String: service,
]
let attributes: [String: Any] = [kSecValueData as String: password]
var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
if status == errSecItemNotFound {
	status = SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil)
}
if status != errSecSuccess {
	let message = SecCopyErrorMessageString(status, nil) as String? ?? "OSStatus \\(status)"
	fputs("\\(message)\\n", stderr)
	exit(1)
}
`;
	await runWithInput(
		"xcrun",
		[
			"swift",
			"-e",
			source,
			validateProfileName(profile),
			KEYCHAIN_SERVICE,
		],
		`${token}\n`,
	);
}

async function readKeychainToken(profile) {
	if (process.platform !== "darwin") {
		throw new Error("Phase-0 credential storage currently requires macOS Keychain");
	}
	const source = `
import Foundation
import Security

let account = CommandLine.arguments[1]
let service = CommandLine.arguments[2]
let query: [String: Any] = [
	kSecClass as String: kSecClassGenericPassword,
	kSecAttrAccount as String: account,
	kSecAttrService as String: service,
	kSecReturnData as String: true,
	kSecMatchLimit as String: kSecMatchLimitOne,
]
var item: CFTypeRef?
let status = SecItemCopyMatching(query as CFDictionary, &item)
if status != errSecSuccess {
	let message = SecCopyErrorMessageString(status, nil) as String? ?? "OSStatus \\(status)"
	fputs("\\(message)\\n", stderr)
	exit(1)
}
guard let password = item as? Data, let token = String(data: password, encoding: .utf8) else {
	fputs("Credential is not valid UTF-8\\n", stderr)
	exit(1)
}
print(token)
`;
	const result = await runProcess(
		"xcrun",
		[
			"swift",
			"-e",
			source,
			validateProfileName(profile),
			KEYCHAIN_SERVICE,
		],
		{ timeout: KEYCHAIN_TIMEOUT_MS },
	);
	return result.stdout;
}

export async function loadToken(
	profileName,
	readToken = readKeychainToken,
	timeoutMs = KEYCHAIN_TIMEOUT_MS,
) {
	const profile = validateProfileName(profileName);
	const reading = tokenReadTail.then(
		() =>
			new Promise((resolve, reject) => {
				const timeout = setTimeout(
					() => reject(new Error(`Keychain read timed out for profile "${profile}"`)),
					timeoutMs,
				);
				Promise.resolve()
					.then(() => readToken(profile))
					.then(resolve, reject)
					.finally(() => {
						clearTimeout(timeout);
					});
			}),
	);
	tokenReadTail = reading.catch(() => {});
	const token = (await reading).trim();
	if (!token) throw new Error(`Keychain token is empty for profile "${profile}"`);
	return token;
}

async function login(profileName, options) {
	const profile = validateProfileName(profileName);
	if (!options.backend) throw new Error("login requires --backend <url>");
	const backendUrl = normalizeBackendUrl(options.backend);
	let previous;
	try {
		previous = readProfile(profile);
	} catch {
		previous = undefined;
	}
	const authenticated = await signInWithLark({
		backendUrl,
		launchBrowser: options.browser !== false,
		onAuthorizeUrl: (url) => {
			console.error(`Open this URL as ${profile}:\n${url}`);
		},
	});
	const session = await fetchMemberSession(authenticated);
	assertExpectedLogin(session, authenticated.session, options.expectEmail);
	if (
		previous &&
		(previous.userId !== session.userId || previous.companyId !== session.companyId) &&
		!options.replaceProfile
	) {
		throw new Error(
			`Profile "${profile}" is pinned to another identity; pass --replace-profile only if intentional`,
		);
	}
	await storeToken(profile, authenticated.token);
	writeProfile({
		schemaVersion: 1,
		profile,
		backendUrl,
		userId: session.userId,
		companyId: session.companyId,
		name: session.name ?? session.user?.name ?? authenticated.session?.name,
		email: session.email ?? session.user?.email ?? authenticated.session?.email,
		departmentId: options.department,
		updatedAt: new Date().toISOString(),
	});
	console.log(
		`Logged in ${profile}: ${session.name ?? session.userId} (${session.companyId})`,
	);
}

export async function abortRuntimeInPlace({ rpc, container, bootstrap }, {
	stageInterruptionFn = stageRuntimeInterruption,
	recordInterruptionFn = recordRuntimeInterruption,
	timeoutMs = SOFT_ABORT_TIMEOUT_MS,
} = {}) {
	const interruptionStaged = await stageInterruptionFn(container, bootstrap);
	await rpc.send({ type: "abort" }, timeoutMs);
	const state = await rpc.send({ type: "get_state" }, timeoutMs);
	if (state?.isStreaming === true || state?.isCompacting === true) {
		throw new Error("Pi did not become idle after abort");
	}
	if (interruptionStaged) await recordInterruptionFn(container);
	const messageState = await rpc.send({ type: "get_messages" }, timeoutMs);
	return collectProtectedRunMetadata(messageState?.messages);
}

export function collectRunAssistantText(messages) {
	if (!Array.isArray(messages)) return "";
	const lastUserIndex = messages.findLastIndex((message) => message?.role === "user");
	const candidates = messages.slice(lastUserIndex + 1).filter(
		(message) =>
			message?.role === "assistant" &&
			Array.isArray(message.content) &&
			message.content.some((content) => content?.type === "text" && content.text?.trim()),
	);
	const finalMessage = candidates.findLast((message) => message.stopReason === "stop")
		?? candidates.at(-1);
	if (!finalMessage) return "";
	const chunks = finalMessage.content.flatMap((content) => {
		if (content?.type !== "text" || typeof content.text !== "string") return [];
		const text = content.text.trim();
		return text ? [text] : [];
	});
	return chunks.join("\n\n");
}

const PROTECTED_SHOPIFY_TOOLS = new Set(["shopifyOrders", "shopifyCustomers"]);

function gatewayToolId(call, result) {
	if (call?.name === "divo_shopify_orders") return "shopifyOrders";
	if (call?.name === "divo_shopify_customers") return "shopifyCustomers";
	const payloadToolId = call?.arguments?.payload?.toolId;
	if (typeof payloadToolId === "string") return payloadToolId;
	const dataToolId = result?.details?.data?.toolId;
	return typeof dataToolId === "string" ? dataToolId : undefined;
}

export function collectProtectedRunMetadata(messages) {
	if (!Array.isArray(messages)) {
		return { protectedDataUsed: false, protectedRefs: [] };
	}
	const lastUserIndex = messages.findLastIndex((message) => message?.role === "user");
	const currentRun = messages.slice(lastUserIndex + 1);
	const gatewayCalls = currentRun.flatMap((message) =>
		message?.role === "assistant" && Array.isArray(message.content)
			? message.content.filter((content) =>
				content?.type === "toolCall" && isGovernedDivoTool(content.name))
			: [],
	);
	if (gatewayCalls.length === 0) {
		return { protectedDataUsed: false, protectedRefs: [] };
	}

	let protectedDataUsed = false;
	let protectedRefs = [];
	let protectedProvenanceValid = true;

	for (const call of gatewayCalls) {
		const result = currentRun.find((message) =>
			message?.role === "toolResult" && message.toolCallId === call.id);
		const toolId = gatewayToolId(call, result);
		if (toolId && PROTECTED_SHOPIFY_TOOLS.has(toolId)) {
			protectedDataUsed = true;
		}

		const protectedData = result?.details?.data?.protectedData;
		if (protectedData?.used === true) {
			protectedDataUsed = true;
			if (result?.isError !== true) {
				const refs = protectedData.references;
				if (Array.isArray(refs)) {
					protectedRefs = refs;
				} else if (refs !== undefined) {
					protectedProvenanceValid = false;
				}
			}
		}
	}

	if (!protectedDataUsed) {
		return { protectedDataUsed: false, protectedRefs: [] };
	}

	return {
		protectedDataUsed: true,
		protectedRefs,
		protectedProvenanceValid,
	};
}

export function logCompletedRun(text, metadata, logger) {
	if (metadata?.protectedDataUsed === true) {
		logger("[divo-pi] protected run completed; final text suppressed");
		return;
	}
	logger(text);
}

function terminalRunError(terminal, messages) {
	const error = new Error(terminal.summary ?? "The model continuation did not complete.");
	error.code = "model_continuation_failed";
	error.statusCode = 502;
	const metadata = messages ? collectProtectedRunMetadata(messages) : undefined;
	if (metadata?.protectedDataUsed) {
		error.protectedDataUsed = true;
		error.protectedRefs = metadata.protectedRefs;
		if (!metadata.protectedProvenanceValid) {
			error.protectedProvenanceValid = false;
		}
	}
	return error;
}

const MUTATING_GATEWAY_ACTIONS = new Set(["create", "update", "delete", "send", "execute"]);
const KNOWN_GATEWAY_ACTIONS = new Set(["read", ...MUTATING_GATEWAY_ACTIONS]);

function gatewayActionState(messages) {
	if (!Array.isArray(messages)) return "none";
	const lastUserIndex = messages.findLastIndex((message) => message?.role === "user");
	const currentRun = messages.slice(lastUserIndex + 1);
	const calls = currentRun.flatMap((message) =>
		message?.role === "assistant" && Array.isArray(message.content)
			? message.content.filter((content) =>
				content?.type === "toolCall"
				&& isGovernedDivoTool(content.name))
			: [],
	);
	if (calls.length === 0) return "none";
	const actions = [];
	for (const call of calls) {
		const result = currentRun.find((message) =>
			message?.role === "toolResult"
			&& message.toolCallId === call.id
			&& isGovernedDivoTool(message.toolName),
		);
		const action = result?.details?.data?.action;
		if (
			result?.isError !== false
			|| typeof action !== "string"
			|| !KNOWN_GATEWAY_ACTIONS.has(action)
		) return "unsafe";
		actions.push(action);
	}
	if (!actions.some((action) => MUTATING_GATEWAY_ACTIONS.has(action))) return "read_only";
	return actions.at(-1) === "read" ? "mutation_then_read" : "completed_mutation";
}

function completedGatewayFallback(completion, readAfterMutation) {
	const text = readAfterMutation
		? "Divo completed the requested company action, and a subsequent read also succeeded. The final summary was interrupted, so Divo did not repeat the action."
		: "Divo completed the requested company action. The final summary was interrupted, so Divo did not repeat the action.";
	return {
		...completion,
		messages: [
			...(Array.isArray(completion?.messages) ? completion.messages : []),
			{
				role: "assistant",
				stopReason: "stop",
				usage: { input: 0, output: 1 },
				content: [{ type: "text", text }],
			},
		],
	};
}

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

function emitRuntimeProgress(onProgress, event) {
	if (!onProgress) return;
	try {
		const result = onProgress(event);
		if (result && typeof result.catch === "function") {
			void result.catch(() => {});
		}
	} catch {
		// Status delivery must never interrupt the agent run.
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

async function ask(question) {
	const terminal = readline.createInterface({
		input: process.stdin,
		output: process.stderr,
	});
	try {
		return await new Promise((resolve) => terminal.question(question, resolve));
	} finally {
		terminal.close();
	}
}

function createExtensionResponder(autoApprove) {
	return async (request, respond) => {
		if (
			["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"].includes(
				request.method,
			)
		) {
			if (request.message) console.error(`[Pi] ${request.message}`);
			return;
		}
		if (request.method === "confirm") {
			const answer = autoApprove
				? "y"
				: await ask(`${request.title}: ${request.message} [y/N] `);
			respond({
				type: "extension_ui_response",
				id: request.id,
				confirmed: /^y(es)?$/i.test(answer.trim()),
			});
			return;
		}
		if (request.method === "select") {
			console.error(request.options.map((value, index) => `${index + 1}. ${value}`).join("\n"));
			const answer = await ask(`${request.title} (number, blank cancels): `);
			const selected = request.options[Number(answer) - 1];
			respond(
				selected
					? { type: "extension_ui_response", id: request.id, value: selected }
					: { type: "extension_ui_response", id: request.id, cancelled: true },
			);
			return;
		}
		const answer = await ask(`${request.title} (blank cancels): `);
		respond(
			answer
				? { type: "extension_ui_response", id: request.id, value: answer }
				: { type: "extension_ui_response", id: request.id, cancelled: true },
		);
	};
}

export function approveHeadlessWorkspaceAction(title, message) {
	if (title !== "divo_approval_v1" || typeof message !== "string") return false;
	try {
		const request = JSON.parse(message);
		return ["bash", "edit", "write"].includes(request?.source);
	} catch {
		return false;
	}
}

export function createHeadlessExtensionResponder() {
	return async (request, respond) => {
		if (
			["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"].includes(
				request.method,
			)
		) {
			if (request.message) console.error(`[Pi] ${request.message}`);
			return;
		}
		if (request.method === "confirm") {
			respond({
				type: "extension_ui_response",
				id: request.id,
				confirmed: approveHeadlessWorkspaceAction(request.title, request.message),
			});
			return;
		}
		respond({ type: "extension_ui_response", id: request.id, cancelled: true });
	};
}

function runtimeExitPromise(child) {
	return new Promise((resolve) => {
		child.once("error", (error) => resolve({ error }));
		child.once("exit", (code, terminationSignal) => resolve({ code, terminationSignal }));
	});
}

function spawnRuntimeRpc(container, answerRequest, onProgress) {
	const child = spawn("docker", buildContainerRunArgs(container), {
		stdio: ["pipe", "pipe", "pipe"],
	});
	child.stderr.pipe(process.stderr);
	const exited = runtimeExitPromise(child);
	const rpc = new JsonlRpc(child, answerRequest, onProgress);
	return { child, exited, rpc };
}

/**
 * Everything a turn does that leaves this process.
 *
 * The turn plan below decides the *order* of a turn; these are the effects that
 * order is made of. They are an argument rather than a set of imports because
 * the plan's most important property — which effects a turn issues, how many,
 * and in what order — was previously assertable only by running Docker and the
 * backend for real, which meant it was asserted nowhere.
 *
 * The line drawn here is "crosses a process boundary". That includes the
 * interrupt path: stopping a run reaches Docker exactly as starting one does,
 * and a member pressing stop is the branchiest thing a turn can do, so leaving
 * it outside meant the branch most likely to break was the one nothing could
 * exercise.
 *
 * In-process state such as the warm-process map is not injected: a test drives
 * it directly, and faking it would only restate its behaviour less accurately.
 * `discardWarmPiProcess` closes and can signal the child without passing through
 * here, but it acts on the handle `spawnRuntimeRpc` returned, so it stays
 * observable to whoever supplied that handle.
 */
export const defaultTurnEffects = {
	fetchRunContext,
	resolveImageId,
	activateIdleContainer: (profile) => idleContainers.activate(profile),
	ensureRuntime,
	stageNativeSkills: stageNativeSkillBootstrap,
	startContainer,
	waitUntilRunning,
	writeBootstrap,
	prepareWarmRuntime,
	deleteDurableSession,
	spawnRuntimeRpc,
	finalizeRuntimeLifecycle,
	abortRuntimeInPlace,
	stageRuntimeInterruption,
	stopOwnedContainer,
	now: Date.now,
	log: (line) => console.error(line),
	// A second sink, not a second style. The completed answer is this process's
	// stdout contract for a terminal run; routing it through `log` would move it
	// to stderr. Injected all the same, so a test that claims a turn never logged
	// a skill's instructions is looking at every line the turn wrote.
	logAnswer: (line) => console.log(line),
};

async function runTurn({
	profile,
	thread,
	message,
	backendUrl,
	token,
	userId,
	companyId,
	departmentId,
	trustedSession,
	runId,
	runtimeThreadId,
	channel,
	answerRequest,
	attachments,
	sessionScope,
	model,
	signal,
	onProgress,
	ephemeral = false,
	lifecycle,
}, effects, phases, record) {
	// Before validation, because a request rejected by it still had a scope and an
	// audience, and the record should describe the request rather than its verdict.
	record.audience = ephemeral ? "shared" : "private";
	record.sessionScope = sessionScope ?? "thread";
	const normalizedSessionScope = validateSessionScope(sessionScope);
	if (lifecycle !== undefined) validateSessionLifecycleOperation(lifecycle);
	if (lifecycle !== undefined && normalizedSessionScope !== "thread") {
		throw new Error("Session lifecycle operations require a thread-scoped session");
	}
	if (ephemeral && normalizedSessionScope !== "run") {
		throw new Error("A shared runtime must use a run-scoped session");
	}
	record.sessionScope = normalizedSessionScope;
	if (signal?.aborted) throw new Error("Pi run was interrupted before container start");
	let resources = resourcesFor(profile);
	const selectedModel = validateRuntimeModel(model);
	// Nothing this turn computes decides the image ID, and `ensureRuntime` cannot
	// begin without it, so it is resolved alongside the skill fetch instead of
	// after it — one Docker round trip leaves the critical path of every turn.
	//
	// It is started here and awaited inside the run, which is not fussiness:
	// resolving the image used to happen inside `ensureRuntime`, so a bad image
	// failed the turn from inside the run and got the discard, the teardown and
	// the phase record that a run failure gets. Awaiting it out here would move
	// that failure in front of all three. The skill fetch keeps failing out here,
	// where it always has. Leaving the inspect in flight when the fetch throws is
	// safe because resolving an image ID only reads.
	const imageIdReady = phases.measure("image", () => effects.resolveImageId());
	// Handled so an image failure during a fetch that throws first is not an
	// unhandled rejection. The real rejection still surfaces at the await below.
	imageIdReady.catch(() => {});
	const { runtimeContext, nativeSkills: nativeSkillBootstrap } = await phases.measure(
		"skills",
		() => effects.fetchRunContext({ backendUrl, token, departmentId }),
	);
	const nativeSkillScope = { companyId, userId, departmentId, channel };
	const nativeSkillDigest = nativeSkillBootstrapDigest(nativeSkillBootstrap, nativeSkillScope);
	const piKeepAlive = canReusePiProcess({
		ephemeral,
		nativeSkillDigest,
		sessionScope: normalizedSessionScope,
		lifecycle,
	});
	const bootstrap = {
		backendUrl: backendUrlForContainer(backendUrl),
		token,
		profile,
		thread,
		...(runtimeThreadId ? { runtimeThreadId } : {}),
		userId,
		companyId,
		...(trustedSession ? { trustedSession } : {}),
		...(runId ? { runId } : {}),
		departmentId,
		// The container used to fetch this for itself, once at startup and again
		// on every warm turn. It is re-staged per turn exactly as the rest of the
		// bootstrap is, so the persona and capabilities a turn runs under are as
		// fresh as they were — one HTTP round trip and a handler's worth of
		// queries earlier.
		runtimeContext,
		sessionScope: normalizedSessionScope,
		...(channel ? { channel } : {}),
		nativeSkills: true,
		...(isRuntimeChannel(channel) ? { interruptionTask: message } : {}),
		...(selectedModel ?? {}),
	};
	const binding = piProcessBinding({
		profile,
		thread,
		backendUrl: bootstrap.backendUrl,
		departmentId,
		selectedModel,
		nativeSkillDigest,
	});
	if (!ephemeral) await phases.measure("idle", () => effects.activateIdleContainer(profile));
	const cachedRuntime = getWarmPiProcess(profile);
	const cachedBinding = cachedRuntime?.binding;
	let processMode = cachedRuntime ? "warm" : "cold";
	let replacementReason = cachedRuntime ? "none" : "no_cached_process";
	if (!piKeepAlive) {
		if (cachedRuntime) {
			processMode = "restarted";
			replacementReason = "reuse_disabled";
		}
		await discardWarmPiProcess(profile);
	} else if (cachedRuntime && !piProcessBindingMatches(cachedBinding, binding)) {
		processMode = "restarted";
		replacementReason = piProcessBindingMismatchReason(cachedBinding, binding);
		await discardWarmPiProcess(profile);
	}
	let abortStop;
	let bootstrapAttempted = false;
	let child;
	let exited;
	let rpc;
	// Declared out here because the soft-interrupt path in `catch` re-remembers
	// the warm entry, and an entry without its session id logs `session undefined`
	// on every later turn that reuses it.
	let sessionId;
	let retainRuntimeProcess = false;
	let softInterrupted = false;
	let softInterruptMetadata;
	let completedSuccessfully = false;
	let interruptedBeforeFailure = false;
	let runError;
	const abort = () => {
		if (abortStop) return;
		abortStop = (async () => {
			const warmEntry = getWarmPiProcess(profile);
			const activeRpc = rpc ?? warmEntry?.rpc;
			if (piKeepAlive && lifecycle === undefined && activeRpc) {
				try {
					softInterruptMetadata = await effects.abortRuntimeInPlace({
						rpc: activeRpc,
						container: resources.container,
						bootstrap,
					});
					softInterrupted = true;
					effects.log(`[Pi] ${JSON.stringify({
						event: "pi_runtime.interrupted",
						mode: "soft",
						sessionScope: normalizedSessionScope,
					})}`);
					return;
				} catch (error) {
					effects.log(`[Pi] Soft abort failed; stopping runtime: ${error.message}`);
				}
			}
			await effects.stageRuntimeInterruption(resources.container, bootstrap).catch((error) => {
				effects.log(`[Pi] Failed to stage interrupted work: ${error.message}`);
			});
			forgetWarmPiProcess(profile);
			await effects.stopOwnedContainer(profile);
			effects.log(`[Pi] ${JSON.stringify({
				event: "pi_runtime.interrupted",
				mode: "hard",
				sessionScope: normalizedSessionScope,
			})}`);
		})().then(
			() => undefined,
			(error) => error,
		);
	};
	signal?.addEventListener("abort", abort, { once: true });
	if (signal?.aborted) abort();
	try {
		// A surviving warm entry at this point means its binding matched, so the
		// container it is attached to is this turn's container. Its network and
		// volumes cannot have gone missing underneath a process that is running
		// inside it, so they are not re-probed.
		const imageId = await imageIdReady;
		const runtime = await phases.measure("runtime", () => effects.ensureRuntime(profile, {
			ephemeral,
			provisioned: piKeepAlive && hasWarmPiProcess(profile),
			imageId,
		}));
		resources = runtime.resources;
		const stage = await phases.measure("stage", () => effects.stageNativeSkills(
			resources.skillsVolume,
			nativeSkillBootstrap,
			nativeSkillScope,
			{ force: runtime.created },
		));
		effects.log(`[Pi] ${JSON.stringify({
			event: "native_skills.ready",
			registryRevision: nativeSkillBootstrap.registryRevision,
			skillCount: nativeSkillBootstrap.skills.length,
			digest: stage.digest.slice(0, 12),
			staged: stage.staged,
			fetchMs: phases.ms("skills"),
			stageMs: phases.ms("stage"),
			audience: ephemeral ? "shared" : "private",
			sessionScope: normalizedSessionScope,
		})}`);
		// A container that was already running has nothing to announce; one that
		// had to be created is a wait the member should see a reason for.
		for (const progress of runtime.wasRunning || !runtime.created
			? [{ type: "working" }]
			: [
				{ type: "starting", stage: "workspace", label: "Checking your workspace…" },
				{ type: "starting", stage: "container", label: "Waking up Divo…" },
			]) {
			emitRuntimeProgress(onProgress, progress);
		}
		if (signal?.aborted) throw new Error("Pi run was interrupted before container start");
		if (lifecycle === "delete") {
			await effects.deleteDurableSession(resources.volume, thread);
			completedSuccessfully = true;
			return { profile, thread };
		}
		if (lifecycle === "reset") {
			await effects.deleteDurableSession(resources.volume, thread);
		}
		// `ensureRuntime` just inspected this container and verified it is ours,
		// so its running state is already known here. Polling is only meaningful
		// when we actually issued the start: a container already reported running
		// has nothing to wait for, and if it died in the moment since, `docker
		// exec` reports that immediately rather than after ten seconds spent
		// waiting for a transition nobody triggered.
		if (!runtime.wasRunning) {
			await phases.measure("start", async () => {
				await effects.startContainer(resources.container);
				await effects.waitUntilRunning(resources.container);
			});
		}
		bootstrapAttempted = true;
		let piProcessReused = false;
		const reusable = piKeepAlive ? getWarmPiProcess(profile) : undefined;
		// A cold Pi reads the bootstrap itself as it boots, so the file has to be on
		// the volume before that process starts. A warm one is already running and
		// only needs the prepare, which now carries the bootstrap on its own stdin
		// rather than making the member wait for a second exec.
		if (reusable) {
			const environment = await phases.measure(
				"prepare",
				() => effects.prepareWarmRuntime(resources.container, bootstrap),
			);
			reusable.rpc.configure({ answerRequest, onProgress });
			await phases.measure(
				"attach",
				() => reusable.rpc.send({ type: "set_environment", values: environment }),
			);
			child = reusable.child;
			exited = reusable.exited;
			rpc = reusable.rpc;
			piProcessReused = true;
		} else {
			// Deliberately not the "prepare" phase. `prepareMs` is how a reader
			// tells a cold turn from a warm one — it has always been zero when no
			// warm process was reused — so the cold bootstrap write gets its own
			// name rather than quietly reclassifying every cold turn as prepared.
			await phases.measure(
				"bootstrap",
				() => effects.writeBootstrap(resources.container, bootstrap),
			);
			if (processMode === "warm") {
				processMode = "restarted";
				replacementReason = "cached_process_exited";
			}
			({ child, exited, rpc } = effects.spawnRuntimeRpc(
				resources.container,
				answerRequest,
				onProgress,
			));
		}
		// A freshly spawned Pi is not necessarily listening yet, and `get_state`
		// is the knock that waits for it — hence the long timeout. A reused one
		// answered `set_environment` a few lines ago, so knocking again asks a
		// live process a question we already have the answer to, and makes the
		// member wait for the reply. The session belongs to the process, so it
		// is remembered with it rather than re-fetched every turn.
		sessionId = piProcessReused
			? reusable.sessionId
			: (await phases.measure(
				"handshake",
				() => rpc.send({ type: "get_state" }, 90_000),
			)).sessionId;
		if (piKeepAlive && !piProcessReused) {
			rememberWarmPiProcess(profile, {
				profile,
				binding,
				sessionId,
				child,
				exited,
				rpc,
			});
		}
		// The sum of the named ready phases, not a wall span: the gaps between them
		// and the synchronous `spawnRuntimeRpc` are excluded. Reading it off the
		// phase record rather than a second stopwatch is what keeps it from
		// drifting from the phases it claims to add up.
		const readyMs = phases.spanMs("start", "bootstrap", "prepare", "attach", "handshake");
		effects.log(
			`Ready ${profile}/${thread} in ${readyMs}ms (session ${sessionId}; piProcessReused=${piProcessReused}; prepareMs=${phases.ms("prepare")})`,
		);
		effects.log(`[Pi] ${JSON.stringify({
			event: "pi_runtime.ready",
			mode: piProcessReused ? "warm" : processMode,
			replacementReason: piProcessReused ? "none" : replacementReason,
			readyMs,
			prepareMs: phases.ms("prepare"),
			nativeSkillDigest: nativeSkillDigest.slice(0, 12),
			audience: ephemeral ? "shared" : "private",
			sessionScope: normalizedSessionScope,
		})}`);
		emitRuntimeProgress(onProgress, { type: "ready" });
		if (lifecycle !== undefined) {
			await waitForClosedRuntime(child, exited);
			completedSuccessfully = true;
			return { profile, thread, sessionId };
		}
		const completion = await phases.measure("model", () => promptWithTransientRetries({
			rpc,
			message: `${attachmentManifestBlock(attachments)}${message}`,
			signal,
			onRetry: ({ attempt, maxRetries, summary }) => {
				effects.log(
					`Transient model failure; retrying continuation ${attempt}/${maxRetries}: ${summary}`,
				);
				// Any prose emitted by the failed provider stream is not part of the
				// continuation that will eventually be returned. A live web reader may
				// already have seen it, so retract that prefix before the retry starts.
				emitRuntimeProgress(onProgress, { type: "answer_reset" });
				emitRuntimeProgress(onProgress, { type: "thinking" });
			},
		}));
		const text = collectRunAssistantText(completion?.messages);
		if (!text) {
			throw terminalRunError({
				summary: "The model continuation completed without a final answer.",
			});
		}
		const metadata = collectProtectedRunMetadata(completion?.messages);
		logCompletedRun(text, metadata, effects.logAnswer);
		if (piKeepAlive && metadata.protectedDataUsed !== true) {
			retainRuntimeProcess = true;
		} else {
			const discarded = await discardWarmPiProcess(profile);
			if (discarded) await assertRuntimeExit(discarded);
			else await waitForClosedRuntime(child, exited);
		}
		completedSuccessfully = true;
		return { profile, thread, text, ...metadata };
	} catch (error) {
		runError = error;
		// Latched here, not read at log time. Teardown can take seconds — draining
		// a warm Pi waits on its exit — and a browser that gives up during it would
		// otherwise turn a backend failure into a member stop.
		interruptedBeforeFailure = abortStop !== undefined;
		if (signal?.aborted && abortStop) await abortStop;
		const protectedDataUsed = error?.protectedDataUsed === true
			|| softInterruptMetadata?.protectedDataUsed === true;
		if (softInterrupted && !protectedDataUsed) {
			if (piKeepAlive && !hasWarmPiProcess(profile) && child && exited && rpc) {
				rememberWarmPiProcess(profile, { profile, binding, sessionId, child, exited, rpc });
			}
			retainRuntimeProcess = true;
		} else {
			await discardWarmPiProcess(profile).catch((cleanupError) => {
				effects.log(`[Pi] Failed to discard warm Pi process: ${cleanupError.message}`);
			});
		}
		throw error;
	} finally {
		signal?.removeEventListener("abort", abort);
		if (!retainRuntimeProcess) endRuntimeInput(child);
		try {
			await phases.measure("finalize", () => effects.finalizeRuntimeLifecycle({
				profile,
				resources,
				bootstrapAttempted,
				completedSuccessfully,
				runError,
				abortStop,
				retainRuntimeProcess,
				ephemeral,
			}));
		} finally {
			// A member pressing stop is not a failure. Counting it as one makes every
			// failure-rate view built on this event wrong from its first day.
			record.classified = true;
			record.outcome = completedSuccessfully
				? "completed"
				: interruptedBeforeFailure ? "interrupted" : "failed";
		}
	}
}

/**
 * One turn, and the record of where its time went.
 *
 * The record is emitted from out here rather than from the teardown inside,
 * because a turn that failed *before* the run began — an expired member token, a
 * backend 5xx on the skill bootstrap — is exactly the turn an operator is
 * looking for, and a record emitted from the teardown never covers it. That is
 * the outage class a failure-rate view most needs and would silently read as
 * zero.
 */
async function runPrompt(request, effects = defaultTurnEffects) {
	const phases = createTurnPhases(effects.now);
	const record = { classified: false, outcome: "failed", audience: "private", sessionScope: "thread" };
	let answered = false;
	let stoppedBeforeItFailed = false;
	try {
		const result = await runTurn(request, effects, phases, record);
		answered = true;
		return result;
	} catch (error) {
		// Latched as the failure surfaces, for the same reason the run latches its
		// own: by the time the record is written the member may have given up.
		stoppedBeforeItFailed = request.signal?.aborted === true;
		throw error;
	} finally {
		effects.log(`[Pi] ${JSON.stringify({
			event: "pi_runtime.turn",
			// Two classifications, and which one applies depends on how far the turn
			// got. A run that reached its own teardown latched why it ended, and that
			// answer is kept — except "completed", which cannot survive a teardown
			// that then threw, because the member saw a failure. A turn that never
			// got that far has only the signal to go on, and there teardown never ran,
			// so reading the signal now is still reading it promptly.
			outcome: !record.classified
				? (stoppedBeforeItFailed ? "interrupted" : "failed")
				: answered
					? record.outcome
					: record.outcome === "interrupted" ? "interrupted" : "failed",
			audience: record.audience,
			sessionScope: record.sessionScope,
			wallMs: phases.wallMs(),
			phases: phases.durations(),
		})}`);
	}
}

export async function prompt(profileName, message, options = {}) {
	const profile = validateProfileName(profileName);
	const thread = validateThread(options.thread ?? "local-phase0");
	const metadata = readProfile(profile);
	const token = await loadToken(profile);
	const session = await fetchMemberSession({
		backendUrl: metadata.backendUrl,
		token,
	});
	assertPinnedProfile(metadata, session);
	return runPrompt({
		profile,
		thread,
		message,
		backendUrl: metadata.backendUrl,
		token,
		userId: metadata.userId,
		companyId: metadata.companyId,
		departmentId: metadata.departmentId,
		trustedSession: trustedRuntimeSession(session),
		// The terminal responder blocks on this process's stdin, which only
		// exists when a human ran the CLI. A server passes its own.
		answerRequest: options.answerRequest ?? createExtensionResponder(Boolean(options.approve)),
		// Without this, a disconnected caller could never end the run: the
		// promise never settled, so the admission slot was never released.
		signal: options.signal,
	});
}

export async function resolveRuntimeLease({ backendUrl, lease }) {
	if (typeof lease !== "string" || !lease.trim()) {
		throw new Error("runtimeLease must be a non-empty string");
	}
	const normalizedBackendUrl = normalizeBackendUrl(backendUrl);
	const session = await fetchRuntimeSession({
		backendUrl: normalizedBackendUrl,
		lease,
	});
	if (
		!isRuntimeChannel(session.runtime?.channel) ||
		!session.runtime.instanceId ||
		!session.runtime.threadId ||
		!session.runtime.runId
	) {
		throw new Error("Divo backend did not validate a Pi runtime lease");
	}
	const names = runtimeIdentityNames(
		session.companyId,
		session.userId,
		session.runtime.threadId,
		{
			contextAudience: session.runtime.contextAudience,
			runId: session.runtime.runId,
		},
	);
	return {
		...names,
		backendUrl: normalizedBackendUrl,
		token: lease,
		userId: session.userId,
		companyId: session.companyId,
		trustedSession: trustedRuntimeSession(session),
		instanceId: session.runtime.instanceId,
		channel: session.runtime.channel,
		runId: session.runtime.runId,
		// The department the backend launched this run for. Without it the
		// container picks the member's first department, so a run scoped to one
		// department would execute under another's tool grants.
		departmentId: session.runtime.departmentId ?? undefined,
		contextAudience: session.runtime.contextAudience,
	};
}

export async function promptWithRuntimeLease(runtime, message, options = {}, effects = defaultTurnEffects) {
	return runPrompt({
		...runtime,
		message,
		answerRequest: createHeadlessExtensionResponder(),
		attachments: options.attachments,
		sessionScope: validateSessionScope(options.sessionScope),
		ephemeral: runtime.ephemeral === true,
		model: options.model,
		signal: options.signal,
		onProgress: options.onProgress,
	}, effects);
}

export async function runRuntimeSessionLifecycle(runtime, operation, options = {}, effects = defaultTurnEffects) {
	const lifecycle = validateSessionLifecycleOperation(operation);
	return runPrompt({
		...runtime,
		message: "",
		answerRequest: createHeadlessExtensionResponder(),
		sessionScope: "thread",
		lifecycle,
		signal: options.signal,
	}, effects);
}

async function status(profileName) {
	const profile = validateProfileName(profileName);
	const metadata = readProfile(profile);
	const resources = resourcesFor(profile);
	const container = await findOwnedContainer(profile);
	console.log(
		JSON.stringify(
			{
				profile,
				userId: metadata.userId,
				companyId: metadata.companyId,
				backendUrl: metadata.backendUrl,
				resources,
				container: container ? container.State.Status : "missing",
			},
			null,
			2,
		),
	);
}

function parseArguments(argv) {
	const positional = [];
	const options = {};
	for (let index = 0; index < argv.length; index += 1) {
		const value = argv[index];
		if (!value.startsWith("--")) {
			positional.push(value);
			continue;
		}
		const key = value.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
		if (["approve", "noBrowser", "replaceProfile"].includes(key)) {
			options[key === "noBrowser" ? "browser" : key] = key === "noBrowser" ? false : true;
			continue;
		}
		const next = argv[index + 1];
		if (!next || next.startsWith("--")) throw new Error(`${value} requires a value`);
		options[key] = next;
		index += 1;
	}
	return { positional, options };
}

export async function main(argv = process.argv.slice(2)) {
	const { positional, options } = parseArguments(argv);
	const [command, profile, ...rest] = positional;
	if (command === "login") return login(profile, options);
	if (command === "prompt") {
		if (rest.length === 0) throw new Error("prompt requires a message");
		return prompt(profile, rest.join(" "), options);
	}
	if (command === "status") return status(profile);
	if (command === "stop") return idleContainers.stopNow(validateProfileName(profile));
	throw new Error(
		[
			"Usage:",
			"  node divo/local-rpc-controller.mjs login <profile> --backend <url> [--department <id>] [--no-browser]",
			"  node divo/local-rpc-controller.mjs prompt <profile> --thread <id> [--approve] <message>",
			"  node divo/local-rpc-controller.mjs status <profile>",
			"  node divo/local-rpc-controller.mjs stop <profile>",
		].join("\n"),
	);
}

const isMain =
	process.argv[1] &&
	path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
	main().catch((error) => {
		console.error(`[divo-controller] ${error.message}`);
		process.exitCode = 1;
	});
}
