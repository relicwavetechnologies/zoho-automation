import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
	fetchMemberSession,
	normalizeBackendUrl,
	signInWithLark,
} from "./auth.mjs";

const execFileAsync = promisify(execFile);
const IMAGE = process.env.DIVO_PI_IMAGE ?? "divo-pi-local:phase0";
const KEYCHAIN_SERVICE = "dev.divo-pi.local";
const PROFILE_ROOT = path.join(os.homedir(), ".divo-pi", "profiles");
const RESOURCE_PREFIX = "divo-pi-local";
const RPC_TIMEOUT_MS = 30_000;
const KEYCHAIN_TIMEOUT_MS = 15_000;
let tokenReadTail = Promise.resolve();

export function validateProfileName(value) {
	const profile = value?.trim().toLowerCase();
	if (!profile || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(profile)) {
		throw new Error("Profile must use 1-32 lowercase letters, numbers, dash, or underscore");
	}
	return profile;
}

export function validateThread(value) {
	if (!value || !/^[A-Za-z0-9._-]+$/.test(value)) {
		throw new Error("Thread must contain only letters, numbers, dot, underscore, or dash");
	}
	return value;
}

export function resourcesFor(profileName) {
	const profile = validateProfileName(profileName);
	return {
		authVolume: `${RESOURCE_PREFIX}-${profile}-auth`,
		container: `${RESOURCE_PREFIX}-${profile}`,
		network: `${RESOURCE_PREFIX}-${profile}`,
		volume: `${RESOURCE_PREFIX}-${profile}`,
	};
}

export function runtimeIdentityNames(companyId, userId, runtimeThreadId) {
	if (!companyId || !userId || !runtimeThreadId) {
		throw new Error("Runtime identity is incomplete");
	}
	const digest = (value) => createHash("sha256").update(value).digest("hex");
	return {
		profile: `cloud-${digest(`${companyId}:${userId}`).slice(0, 20)}`,
		thread: `lark-${digest(runtimeThreadId).slice(0, 24)}`,
	};
}

export function buildContainerCreateArgs(
	profileName,
	image = IMAGE,
	{ addHostGateway = process.env.DIVO_PI_ADD_HOST_GATEWAY !== "false" } = {},
) {
	const profile = validateProfileName(profileName);
	const resources = resourcesFor(profile);
	return [
		"create",
		"--interactive",
		"--name",
		resources.container,
		"--label",
		`dev.divo.profile=${profile}`,
		"--label",
		`dev.divo.volume=${resources.volume}`,
		"--network",
		resources.network,
		...(addHostGateway
			? ["--add-host", "host.docker.internal:host-gateway"]
			: []),
		"--mount",
		`type=volume,src=${resources.volume},dst=/data`,
		"--mount",
		`type=volume,src=${resources.authVolume},dst=/run/divo-auth`,
		"--read-only",
		"--tmpfs",
		"/tmp:rw,noexec,nosuid,nodev,size=256m,mode=1777",
		"--cap-drop",
		"ALL",
		"--security-opt",
		"no-new-privileges:true",
		"--pids-limit",
		"256",
		"--memory",
		"2g",
		"--cpus",
		"2",
		"--stop-timeout",
		"15",
		image,
	];
}

export function backendUrlForContainer(value) {
	const url = new URL(normalizeBackendUrl(value));
	if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
		url.hostname = "host.docker.internal";
	}
	return url.toString().replace(/\/+$/, "");
}

export function runtimeContainerNeedsReplacement(container, image = IMAGE) {
	return container?.Config?.Image !== image;
}

export function assertPinnedProfile(metadata, session) {
	if (
		metadata.userId !== session.userId ||
		metadata.companyId !== session.companyId
	) {
		throw new Error(
			`Current Lark identity does not match pinned profile "${metadata.profile}"`,
		);
	}
}

export function assertExpectedLogin(session, exchangeSession, expectedEmail) {
	if (!expectedEmail) return;
	const actualEmail = (
		session.email ??
		session.user?.email ??
		exchangeSession?.email ??
		""
	)
		.trim()
		.toLowerCase();
	if (actualEmail !== expectedEmail.trim().toLowerCase()) {
		throw new Error(
			`Authenticated as "${actualEmail || "unknown email"}", expected "${expectedEmail}"`,
		);
	}
}

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

async function run(file, args, options = {}) {
	try {
		return await execFileAsync(file, args, {
			encoding: "utf8",
			maxBuffer: 10 * 1024 * 1024,
			...options,
		});
	} catch (error) {
		const detail = error.stderr?.trim() || error.stdout?.trim() || error.message;
		throw new Error(`${file} ${args[0]} failed: ${detail}`);
	}
}

async function runWithInput(file, args, input) {
	return new Promise((resolve, reject) => {
		const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code === 0) resolve({ stdout, stderr });
			else reject(new Error(`${file} ${args[0]} failed: ${stderr.trim() || stdout.trim()}`));
		});
		child.stdin.end(input);
	});
}

async function docker(args, options) {
	return run("docker", args, options);
}

async function dockerObjectExists(kind, name) {
	try {
		await docker([kind, "inspect", name]);
		return true;
	} catch {
		return false;
	}
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
	const result = await run(
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

async function inspectOwnedContainer(profile) {
	const resources = resourcesFor(profile);
	const result = await docker(["container", "inspect", resources.container]);
	const [container] = JSON.parse(result.stdout);
	if (
		container?.Config?.Labels?.["dev.divo.profile"] !== profile ||
		container?.Config?.Labels?.["dev.divo.volume"] !== resources.volume
	) {
		throw new Error(
			`Refusing unowned or mismatched Docker container: ${resources.container}`,
		);
	}
	return container;
}

async function ensureRuntime(profile) {
	const resources = resourcesFor(profile);
	if (!(await dockerObjectExists("image", IMAGE))) {
		throw new Error(
			`Image ${IMAGE} is missing. Build it with: docker build -t ${IMAGE} .`,
		);
	}
	if (!(await dockerObjectExists("network", resources.network))) {
		await docker([
			"network",
			"create",
			"--driver",
			"bridge",
			"--label",
			`dev.divo.profile=${profile}`,
			resources.network,
		]);
	}
	if (!(await dockerObjectExists("volume", resources.volume))) {
		await docker([
			"volume",
			"create",
			"--label",
			`dev.divo.profile=${profile}`,
			resources.volume,
		]);
	}
	if (!(await dockerObjectExists("volume", resources.authVolume))) {
		await docker([
			"volume",
			"create",
			"--label",
			`dev.divo.profile=${profile}`,
			resources.authVolume,
		]);
	}
	if (await dockerObjectExists("container", resources.container)) {
		const container = await inspectOwnedContainer(profile);
		if (runtimeContainerNeedsReplacement(container)) {
			if (container.State.Running) await docker(["stop", resources.container]);
			await docker(["rm", resources.container]);
		}
	}
	if (!(await dockerObjectExists("container", resources.container))) {
		await docker(buildContainerCreateArgs(profile));
	}
	await inspectOwnedContainer(profile);
	return resources;
}

async function waitUntilRunning(container, timeoutMs = 10_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const result = await docker([
			"container",
			"inspect",
			"--format",
			"{{.State.Running}}",
			container,
		]);
		if (result.stdout.trim() === "true") return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`Container did not start: ${container}`);
}

async function runVolumeCommand(volume, script, input = "") {
	return new Promise((resolve, reject) => {
		const child = spawn(
			"docker",
			[
				"run",
				"--rm",
				"--interactive",
				"--mount",
				`type=volume,src=${volume},dst=/run/divo-auth`,
				"--entrypoint",
				"/bin/sh",
				IMAGE,
				"-c",
				script,
			],
			{ stdio: ["pipe", "pipe", "pipe"] },
		);
		let stderr = "";
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`Bootstrap volume command failed: ${stderr.trim()}`));
		});
		child.stdin.end(input);
	});
}

async function writeBootstrap(volume, bootstrap) {
	await runVolumeCommand(
		volume,
		"umask 077; cat > /run/divo-auth/bootstrap.json",
		JSON.stringify(bootstrap),
	);
}

async function clearBootstrap(volume) {
	await runVolumeCommand(volume, "rm -f /run/divo-auth/bootstrap.json");
}

export class JsonlRpc {
	constructor(child, answerRequest) {
		this.child = child;
		this.answerRequest = answerRequest;
		this.nextId = 0;
		this.pending = new Map();
		this.waiters = new Map();
		this.reader = readline.createInterface({ input: child.stdout });
		this.reader.on("line", (line) => this.handleLine(line));
		child.once("exit", (code, signal) => {
			const error = new Error(
				`Docker attach exited ${signal ? `with ${signal}` : `with code ${code}`}`,
			);
			for (const pending of this.pending.values()) pending.reject(error);
			this.pending.clear();
		});
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
		for (const waiter of waiters) waiter(value);
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
	}

	write(value) {
		this.child.stdin.write(`${JSON.stringify(value)}\n`);
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
		return new Promise((resolve) => {
			const waiters = this.waiters.get(type) ?? [];
			waiters.push(resolve);
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

function createHeadlessExtensionResponder() {
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

async function stopOwnedContainer(profile) {
	const resources = resourcesFor(profile);
	if (!(await dockerObjectExists("container", resources.container))) return;
	const container = await inspectOwnedContainer(profile);
	if (container.State.Running) await docker(["stop", resources.container]);
}

export async function reconcileOwnedContainers() {
	const result = await docker([
		"ps",
		"--filter",
		"label=dev.divo.profile",
		"--format",
		'{{.Label "dev.divo.profile"}}',
	]);
	const profiles = [...new Set(result.stdout.split("\n").filter(Boolean))];
	for (const profileName of profiles) {
		const profile = validateProfileName(profileName);
		const resources = resourcesFor(profile);
		await stopOwnedContainer(profile);
		if (await dockerObjectExists("volume", resources.authVolume)) {
			await clearBootstrap(resources.authVolume);
		}
	}
	return profiles;
}

async function runPrompt({
	profile,
	thread,
	message,
	backendUrl,
	token,
	userId,
	companyId,
	departmentId,
	answerRequest,
	signal,
}) {
	if (signal?.aborted) throw new Error("Pi run was interrupted before container start");
	const resources = await ensureRuntime(profile);
	const bootstrap = {
		backendUrl: backendUrlForContainer(backendUrl),
		token,
		profile,
		thread,
		userId,
		companyId,
		departmentId,
	};
	await writeBootstrap(resources.authVolume, bootstrap);
	const startedAt = Date.now();
	const child = spawn("docker", ["start", "--attach", "--interactive", resources.container], {
		stdio: ["pipe", "pipe", "pipe"],
	});
	child.stderr.pipe(process.stderr);
	const abort = () => {
		void stopOwnedContainer(profile).catch((error) => {
			console.error(`[Pi] Failed to stop interrupted container: ${error.message}`);
		});
	};
	signal?.addEventListener("abort", abort, { once: true });
	try {
		await waitUntilRunning(resources.container);
		const rpc = new JsonlRpc(child, answerRequest);
		const state = await rpc.send({ type: "get_state" }, 90_000);
		console.error(
			`Ready ${profile}/${thread} in ${Date.now() - startedAt}ms (session ${state.sessionId})`,
		);
		const completed = rpc.waitFor("agent_end");
		await rpc.send({ type: "prompt", message }, 90_000);
		await completed;
		const result = await rpc.send({ type: "get_last_assistant_text" });
		const stats = await docker([
			"stats",
			"--no-stream",
			"--format",
			"{{json .}}",
			resources.container,
		]);
		console.error(`Runtime stats: ${stats.stdout.trim()}`);
		const text = result?.text ?? "";
		console.log(text);
		return { profile, thread, text };
	} finally {
		signal?.removeEventListener("abort", abort);
		await clearBootstrap(resources.authVolume);
		await stopOwnedContainer(profile);
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
		answerRequest: createExtensionResponder(Boolean(options.approve)),
	});
}

export async function resolveRuntimeLease({ backendUrl, lease }) {
	if (typeof lease !== "string" || !lease.trim()) {
		throw new Error("runtimeLease must be a non-empty string");
	}
	const normalizedBackendUrl = normalizeBackendUrl(backendUrl);
	const session = await fetchMemberSession({
		backendUrl: normalizedBackendUrl,
		token: lease,
	});
	if (
		session.runtime?.channel !== "lark" ||
		!session.runtime.instanceId ||
		!session.runtime.threadId
	) {
		throw new Error("Divo backend did not validate a Lark Pi runtime lease");
	}
	const names = runtimeIdentityNames(
		session.companyId,
		session.userId,
		session.runtime.threadId,
	);
	return {
		...names,
		backendUrl: normalizedBackendUrl,
		token: lease,
		userId: session.userId,
		companyId: session.companyId,
		instanceId: session.runtime.instanceId,
	};
}

export async function promptWithRuntimeLease(runtime, message, options = {}) {
	return runPrompt({
		...runtime,
		message,
		answerRequest: createHeadlessExtensionResponder(),
		signal: options.signal,
	});
}

async function status(profileName) {
	const profile = validateProfileName(profileName);
	const metadata = readProfile(profile);
	const resources = resourcesFor(profile);
	const exists = await dockerObjectExists("container", resources.container);
	console.log(
		JSON.stringify(
			{
				profile,
				userId: metadata.userId,
				companyId: metadata.companyId,
				backendUrl: metadata.backendUrl,
				resources,
				container: exists ? (await inspectOwnedContainer(profile)).State.Status : "missing",
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
	if (command === "stop") return stopOwnedContainer(validateProfileName(profile));
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
