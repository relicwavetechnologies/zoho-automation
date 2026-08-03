import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
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
import {
	classifyDivoRunTerminal,
	isTransientDivoRunFailure,
} from "./run-terminal.mjs";
import {
	RUNTIME_MODEL_IDS,
	isRuntimeModel,
	providerForModel,
} from "./runtime-models.mjs";

const execFileAsync = promisify(execFile);
const IMAGE = process.env.DIVO_PI_IMAGE ?? "divo-pi-local:phase0";
const KEYCHAIN_SERVICE = "dev.divo-pi.local";
const PROFILE_ROOT = path.join(os.homedir(), ".divo-pi", "profiles");
const RESOURCE_PREFIX = process.env.DIVO_PI_RESOURCE_PREFIX ?? "divo-pi-local";
const RPC_TIMEOUT_MS = 30_000;
const KEYCHAIN_TIMEOUT_MS = 15_000;
const MAX_TRANSIENT_MODEL_RETRIES = 3;
const MODEL_RETRY_IDLE_TIMEOUT_MS = 5_000;
const MODEL_RETRY_PROMPT =
	"The previous model continuation failed because the provider was temporarily unavailable. Continue this same request from the work already present in the session. Do not repeat completed tool calls or side effects. Finish the remaining work and return only the final user-facing answer.";
/**
 * How long a finished DM runtime stays running before it is stopped.
 *
 * Stopping is what makes the *next* turn cold: it discards the tmpfs holding the
 * transpile cache, so the following run pays the full boot again. An idle
 * container is `sleep infinity` under cgroup limits — it holds no CPU and only
 * the few megabytes its tmpfs already contains — so a short window buys almost
 * nothing back and charges the user for it on their next message.
 */
export const RUNTIME_IDLE_TIMEOUT_MS = 45 * 60_000;
export const RUNTIME_STOP_RETRY_MS = 30_000;
const RUNTIME_CONTAINER_MODE = "exec-v1";
let tokenReadTail = Promise.resolve();

/**
 * Where inbound conversation files land inside the user's own Docker volume.
 *
 * Everything under here is derived by this controller from the signed runtime
 * lease. The backend never names a path, a volume or a profile — it hands over
 * bytes and metadata, and gets back a descriptor. That asymmetry is the whole
 * isolation guarantee, so nothing below may accept a caller-supplied path.
 */
const INBOX_CONTAINER_ROOT = "/data/workspace/.divo/inbox";
const WORKSPACE_UID_GID = "10001:10001";
export const MAX_RUNTIME_ATTACHMENTS = 4;
export const MAX_RUNTIME_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_RUNTIME_REQUEST_BYTES = 50 * 1024 * 1024;

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

export const SESSION_SCOPES = ["thread", "run"];

/**
 * Which session a run reopens.
 *
 * `thread` is the durable session on the user's volume, and stays the default:
 * a DM is one person's conversation, and resuming it is the continuity.
 *
 * `run` gives the run a session that is deleted when it ends. The backend asks
 * for it when a thread is shared by several people, because each of them runs
 * in their own container: that conversation is held centrally and sent into
 * every run, so keeping a copy per user would append the same transcript to one
 * volume on every turn and replay all of it on the next.
 */
export function validateSessionScope(value) {
	if (value === undefined || value === null) return "thread";
	if (!SESSION_SCOPES.includes(value)) {
		throw new Error(`sessionScope must be one of: ${SESSION_SCOPES.join(", ")}`);
	}
	return value;
}

/**
 * The model a run is launched on.
 *
 * The backend picks one from the member's grant and names it here; naming none
 * leaves the manifest's default, which is what every run used before the grant
 * could reach this far.
 */
export function validateRuntimeModel(value) {
	if (value === undefined || value === null || value === "") return undefined;
	if (!isRuntimeModel(value)) {
		throw new Error(`model must be one of: ${RUNTIME_MODEL_IDS.join(", ")}`);
	}
	return { model: value, provider: providerForModel(value) };
}

export function resourcesFor(profileName, resourcePrefix = RESOURCE_PREFIX) {
	const profile = validateProfileName(profileName);
	const prefix = validateProfileName(resourcePrefix);
	return {
		authVolume: `${prefix}-${profile}-auth`,
		container: `${prefix}-${profile}`,
		network: `${prefix}-${profile}`,
		volume: `${prefix}-${profile}`,
	};
}

export function runtimeIdentityNames(
	companyId,
	userId,
	runtimeThreadId,
	{ contextAudience = "private", runId } = {},
) {
	if (!companyId || !userId || !runtimeThreadId) {
		throw new Error("Runtime identity is incomplete");
	}
	if (contextAudience !== "private" && contextAudience !== "shared") {
		throw new Error("Runtime context audience is invalid");
	}
	if (contextAudience === "shared" && !runId) {
		throw new Error("A shared runtime requires a run identity");
	}
	const digest = (value) => createHash("sha256").update(value).digest("hex");
	const privateProfile = `cloud-${digest(`${companyId}:${userId}`).slice(0, 20)}`;
	const sharedProfile = runId
		? `shared-${digest(`${companyId}:${userId}:${runId}`).slice(0, 20)}`
		: undefined;
	return {
		profile: contextAudience === "shared" ? sharedProfile : privateProfile,
		thread: `lark-${digest(runtimeThreadId).slice(0, 24)}`,
		runtimeThreadId,
		contextAudience,
		ephemeral: contextAudience === "shared",
	};
}

export function validateAttachmentRequestId(value) {
	if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/.test(value)) {
		throw new Error("Attachment request id is invalid");
	}
	return value;
}

export function validateAttachmentFileId(value) {
	if (typeof value !== "string" || !/^file-[1-9][0-9]?$/.test(value)) {
		throw new Error("Attachment file id is invalid");
	}
	return value;
}

/**
 * Reduce a chat-supplied filename to something that can only ever name a file,
 * never a place. Directory separators, traversal, control characters, shell
 * metacharacters and leading dots are all removed rather than rejected: the
 * user picked this name in Lark and should not get an error because their
 * invoice had a quote in it.
 */
export function safeAttachmentFileName(value) {
	const base = path
		.basename(String(value ?? "").replace(/\\/g, "/"))
		.normalize("NFC")
		.replace(/[\u0000-\u001f\u007f]/g, "");
	const cleaned = base
		.replace(/[^A-Za-z0-9._ ()-]/g, "_")
		.replace(/\s+/g, " ")
		.replace(/^[.\s]+/, "")
		.trim();
	if (!cleaned) return "attachment";
	if (cleaned.length <= 120) return cleaned;
	const extension = path.extname(cleaned).slice(0, 16);
	return `${cleaned.slice(0, 120 - extension.length)}${extension}`;
}

export function decodeAttachmentFileName(encoded) {
	return safeAttachmentFileName(
		Buffer.from(String(encoded ?? ""), "base64url").toString("utf8"),
	);
}

/**
 * Build the one path an attachment is allowed to occupy.
 *
 * Composed from validated parts, so traversal cannot be expressed — the
 * containment check below is a second lock on a door that has no handle.
 * `fileId` gets its own directory level because two files in one message are
 * routinely called the same thing.
 */
export function stagedAttachmentPath(requestId, fileId, fileName) {
	const target = path.posix.join(
		INBOX_CONTAINER_ROOT,
		validateAttachmentRequestId(requestId),
		validateAttachmentFileId(fileId),
		safeAttachmentFileName(fileName),
	);
	if (!target.startsWith(`${INBOX_CONTAINER_ROOT}/`) || target.split("/").includes("..")) {
		throw new Error("Refusing an attachment path outside the workspace inbox");
	}
	return target;
}

/**
 * Descriptors arrive back from the backend on the run request. Every field is
 * re-validated and the path is *recomputed* rather than read, so a compromised
 * or buggy backend cannot point a run at another user's file.
 */
export function resolveStagedAttachments(value) {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) throw new Error("attachments must be an array");
	if (value.length > MAX_RUNTIME_ATTACHMENTS) {
		throw new Error(`At most ${MAX_RUNTIME_ATTACHMENTS} attachments are allowed per run`);
	}
	return value.map((item) => {
		if (!item || typeof item !== "object") throw new Error("attachment must be an object");
		const name = safeAttachmentFileName(item.fileName);
		return {
			name,
			kind: item.kind === "image" ? "image" : "file",
			mimeType: normalizeMimeType(item.mimeType),
			bytes: Number.isSafeInteger(item.bytes) && item.bytes >= 0 ? item.bytes : 0,
			path: stagedAttachmentPath(item.requestId, item.fileId, name),
		};
	});
}

export function normalizeMimeType(value) {
	// `content-type` legitimately carries parameters ("application/pdf;
	// charset=utf-8"). Matching the whole header would drop those types to
	// octet-stream and cost the agent the one hint it has about the file.
	const essence = String(value ?? "").split(";")[0].trim().toLowerCase();
	return /^[a-z0-9!#$&^_.+-]{1,127}\/[a-z0-9!#$&^_.+-]{1,127}$/.test(essence)
		? essence
		: "application/octet-stream";
}

/**
 * The manifest is the only thing the model is told about an attachment: a
 * path, not the bytes. Everything else — reading, OCR, conversion — happens
 * through the agent's own tools against its own filesystem.
 */
export function attachmentManifestBlock(attachments) {
	if (!attachments || attachments.length === 0) return "";
	const manifest = attachments.map((attachment) => ({
		path: attachment.path,
		name: attachment.name,
		kind: attachment.kind,
		mimeType: attachment.mimeType,
		bytes: attachment.bytes,
	}));
	return [
		"[ATTACHED_FILES]",
		JSON.stringify(manifest, null, 2),
		"[/ATTACHED_FILES]",
		"These files are already saved in your workspace at the paths above. Read and process them from there; never ask the sender to upload them again.",
		"",
		"",
	].join("\n");
}

function shellQuote(value) {
	if (/'/.test(value)) throw new Error("Refusing an unsafe attachment path");
	return `'${value}'`;
}

export function buildContainerCreateArgs(
	profileName,
	image = IMAGE,
	{
		addHostGateway = process.env.DIVO_PI_ADD_HOST_GATEWAY !== "false",
		ephemeral = false,
	} = {},
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
		"--label",
		`dev.divo.runtime-mode=${RUNTIME_CONTAINER_MODE}`,
		"--label",
		`dev.divo.ephemeral=${ephemeral ? "true" : "false"}`,
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
		"sleep",
		"infinity",
	];
}

export function backendUrlForContainer(value) {
	const url = new URL(normalizeBackendUrl(value));
	if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
		url.hostname = "host.docker.internal";
	}
	return url.toString().replace(/\/+$/, "");
}

export function runtimeContainerNeedsReplacement(container, image = IMAGE, imageId) {
	return (
		container?.Config?.Image !== image ||
		(typeof imageId === "string" && container?.Image !== imageId) ||
		container?.Config?.Labels?.["dev.divo.runtime-mode"] !== RUNTIME_CONTAINER_MODE
	);
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

/**
 * The image's immutable ID, or `null` when the tag names nothing.
 *
 * Existence and identity come from one `docker image inspect` because they
 * always used to come from two: a `dockerObjectExists` probe that threw its
 * output away, followed by the inspect that re-fetched it. Every Docker CLI
 * call is a process spawn on a path that runs before every single turn.
 */
async function resolveImageId(image) {
	let result;
	try {
		result = await docker(["image", "inspect", image]);
	} catch {
		return null;
	}
	const [metadata] = JSON.parse(result.stdout);
	if (typeof metadata?.Id !== "string" || !metadata.Id) {
		throw new Error(`Docker image ${image} has no resolved image ID`);
	}
	return metadata.Id;
}

/**
 * Run independent Docker probes concurrently, and do not return until every one
 * of them has finished.
 *
 * Deliberately not `Promise.all`, which rejects the moment the first task fails
 * and leaves the rest running. Here that would mean throwing out of
 * `ensureRuntime` while a `docker volume create` is still in flight, so the
 * caller starts cleaning up — or retrying — against a profile that is still
 * being mutated. Waiting costs nothing on the failure path and makes "this
 * function threw" mean "nothing it started is still running".
 *
 * The first task to fail by argument order is the one thrown, so the reported
 * error does not depend on which probe happened to lose the race.
 */
export async function settleAll(tasks) {
	const results = await Promise.allSettled(tasks);
	const failure = results.find(result => result.status === "rejected");
	if (failure) throw failure.reason;
	return results.map(result => result.value);
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

/**
 * The profile's container, or `null` when it does not exist.
 *
 * Absence returns null; a container that exists but is *not* ours still throws.
 * Collapsing "does it exist" and "is it ours" into one inspect keeps the
 * ownership check on every path that previously ran the two separately, without
 * paying for the same inspect twice.
 */
async function findOwnedContainer(profile) {
	const resources = resourcesFor(profile);
	let result;
	try {
		result = await docker(["container", "inspect", resources.container]);
	} catch {
		return null;
	}
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

async function inspectOwnedContainer(profile) {
	const container = await findOwnedContainer(profile);
	if (!container) {
		throw new Error(
			`Docker container is missing: ${resourcesFor(profile).container}`,
		);
	}
	return container;
}

async function ensureVolume(profile, name) {
	if (await dockerObjectExists("volume", name)) return name;
	await docker([
		"volume",
		"create",
		"--label",
		`dev.divo.profile=${profile}`,
		name,
	]);
	return name;
}

/**
 * Shaped like `ensureVolume` so the network can be established inside the same
 * concurrent batch. Probing the network, then creating it only once the volumes
 * had finished, put its create alone on the critical path — and a `network
 * create` is the most expensive object a group run makes.
 */
async function ensureNetwork(profile, name) {
	if (await dockerObjectExists("network", name)) return name;
	await docker([
		"network",
		"create",
		"--driver",
		"bridge",
		"--label",
		`dev.divo.profile=${profile}`,
		name,
	]);
	return name;
}

/**
 * Create the workspace volume without touching the container or network.
 *
 * Attachments are staged *before* the run starts, so this is often the first
 * thing that ever exists for a new user. Doing the full `ensureRuntime` here
 * would pull an image and create a container for a request that may still be
 * rejected.
 */
export async function ensureProfileVolume(profileName) {
	const profile = validateProfileName(profileName);
	// The staging writer runs from the Pi image. Checking here turns a raw
	// `docker run` failure mid-upload into a clear refusal before any bytes move.
	if (!(await resolveImageId(IMAGE))) {
		throw stagingError(
			"runtime_image_missing",
			`Image ${IMAGE} is missing, so attachments cannot be staged.`,
			503,
		);
	}
	return ensureVolume(profile, resourcesFor(profile).volume);
}

async function ensureRuntime(profile, { ephemeral = false } = {}) {
	const resources = resourcesFor(profile);
	let wasRunning = false;
	let created = false;
	// Resolve the immutable image ID on every activation. A mutable tag can move
	// after a deploy or rebuild while a warm container still runs old code.
	// Checked before anything else so a missing image refuses the run without
	// first creating volumes and a network for work that cannot start.
	const imageId = await resolveImageId(IMAGE);
	if (!imageId) {
		throw new Error(
			`Image ${IMAGE} is missing. Build it with: docker build -t ${IMAGE} .`,
		);
	}
	// The network, both volumes and the container are four unrelated Docker
	// objects. Probing them one after another spent four sequential CLI round
	// trips before every turn to learn what a warm profile already satisfies —
	// and on a group run, which starts from nothing every time, four creates.
	const [existing] = await settleAll([
		findOwnedContainer(profile),
		ensureNetwork(profile, resources.network),
		ensureVolume(profile, resources.volume),
		ensureVolume(profile, resources.authVolume),
	]);
	let container = existing;
	if (container) {
		if (runtimeContainerNeedsReplacement(container, IMAGE, imageId)) {
			if (container.State.Running) await docker(["stop", resources.container]);
			await docker(["rm", resources.container]);
			container = undefined;
		} else {
			wasRunning = container.State.Running;
		}
	}
	if (!container) {
		await docker(buildContainerCreateArgs(profile, IMAGE, { ephemeral }));
		container = await inspectOwnedContainer(profile);
		created = true;
	}
	return { resources, wasRunning, created };
}

/**
 * Remove one run-scoped runtime and both of its empty per-run volumes.
 *
 * The profile is derived from a signed lease and every Docker object is
 * inspected through the existing ownership check before removal. A shared run
 * never becomes warm state and therefore cannot leave a later room any bytes.
 */
async function destroyEphemeralRuntime(profileName) {
	const profile = validateProfileName(profileName);
	if (!profile.startsWith("shared-")) {
		throw new Error(`Refusing to destroy a non-ephemeral runtime: ${profile}`);
	}
	const resources = resourcesFor(profile);
	const container = await findOwnedContainer(profile);
	if (container) {
		if (container.State.Running) await docker(["stop", resources.container]);
		await docker(["rm", resources.container]);
	}
	for (const volume of [resources.authVolume, resources.volume]) {
		if (await dockerObjectExists("volume", volume)) await docker(["volume", "rm", volume]);
	}
	if (await dockerObjectExists("network", resources.network)) {
		await docker(["network", "rm", resources.network]);
	}
}

export function buildAttachmentStagingArgs(volume, script, image = IMAGE) {
	return [
		"run",
		"--rm",
		"--interactive",
		// The writer only ever reads stdin. Giving it a network would give a
		// malicious filename nothing to exploit, but it costs nothing to remove.
		"--network",
		"none",
		"--user",
		WORKSPACE_UID_GID,
		"--read-only",
		"--cap-drop",
		"ALL",
		"--security-opt",
		"no-new-privileges:true",
		"--mount",
		`type=volume,src=${volume},dst=/data`,
		"--entrypoint",
		"/bin/sh",
		image,
		"-c",
		script,
	];
}

export function buildAttachmentStagingScript(containerPath) {
	const partPath = `${containerPath}.part`;
	return [
		"set -e",
		"umask 077",
		`mkdir -p ${shellQuote(path.posix.dirname(containerPath))}`,
		`rm -f ${shellQuote(partPath)}`,
		// The rename is the commit. A stream that is cut short — by the byte cap,
		// an abort, or a dead backend — leaves only the .part file behind, so a
		// truncated document can never be presented to the agent as a whole one.
		`cat > ${shellQuote(partPath)}`,
		`mv ${shellQuote(partPath)} ${shellQuote(containerPath)}`,
	].join("\n");
}

function stagingError(code, message, statusCode = 400) {
	return Object.assign(new Error(message), { code, statusCode });
}

async function discardStagedPartial(volume, containerPath, spawnProcess) {
	try {
		await new Promise((resolve, reject) => {
			const child = spawnProcess(
				"docker",
				buildAttachmentStagingArgs(
					volume,
					`rm -f ${shellQuote(`${containerPath}.part`)}`,
				),
				{ stdio: ["ignore", "ignore", "ignore"] },
			);
			child.once("error", reject);
			child.once("exit", resolve);
		});
	} catch {
		// Best effort. A leftover .part is inert — it is never named in a
		// manifest — and failing cleanup must not mask the original error.
	}
}

/**
 * Stream one attachment into the user's own Docker volume.
 *
 * The caller supplies bytes and a name. Everything that decides *where* those
 * bytes land — profile, volume, directory — is derived here from the runtime
 * lease, so no caller can address another user's workspace.
 */
export async function stageRuntimeFile({
	profile,
	requestId,
	fileId,
	fileName,
	mimeType,
	kind = "file",
	stream,
	maxBytes = MAX_RUNTIME_ATTACHMENT_BYTES,
	signal,
	spawnProcess = spawn,
	prepareVolume = ensureProfileVolume,
}) {
	const safeProfile = validateProfileName(profile);
	const safeName = safeAttachmentFileName(fileName);
	const containerPath = stagedAttachmentPath(requestId, fileId, safeName);
	const volume = await prepareVolume(safeProfile);

	const child = spawnProcess(
		"docker",
		buildAttachmentStagingArgs(volume, buildAttachmentStagingScript(containerPath)),
		{ stdio: ["pipe", "ignore", "pipe"] },
	);
	// stdin dies with the container when we kill it mid-stream; the EPIPE that
	// follows is expected and must not become an unhandled error event.
	child.stdin.on("error", () => {});

	let stderr = "";
	child.stderr?.on("data", (chunk) => {
		stderr += chunk;
	});

	const exited = new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code, terminationSignal) => {
			if (code === 0) resolve();
			else {
				reject(
					new Error(
						`Attachment staging failed: ${stderr.trim() || `exit ${terminationSignal ?? code}`}`,
					),
				);
			}
		});
	});

	let bytes = 0;
	const pump = (async () => {
		for await (const chunk of stream) {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			bytes += buffer.length;
			if (bytes > maxBytes) {
				throw stagingError(
					"attachment_too_large",
					`"${safeName}" is larger than the ${Math.floor(maxBytes / (1024 * 1024))} MB limit.`,
					413,
				);
			}
			if (!child.stdin.write(buffer)) await once(child.stdin, "drain");
		}
		child.stdin.end();
	})();

	const abort = () => child.kill("SIGKILL");
	signal?.addEventListener("abort", abort, { once: true });
	pump.catch(() => {});
	exited.catch(() => {});

	try {
		await Promise.all([pump, exited]);
	} catch (error) {
		child.kill("SIGKILL");
		await discardStagedPartial(volume, containerPath, spawnProcess);
		throw error;
	} finally {
		signal?.removeEventListener("abort", abort);
	}

	return {
		requestId,
		fileId,
		fileName: safeName,
		kind: kind === "image" ? "image" : "file",
		mimeType: normalizeMimeType(mimeType),
		bytes,
		path: containerPath,
	};
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

export function buildBootstrapWriteArgs(container) {
	return [
		"exec",
		"--interactive",
		"--user",
		WORKSPACE_UID_GID,
		container,
		"/bin/sh",
		"-c",
		"umask 077; cat > /run/divo-auth/bootstrap.json",
	];
}

async function writeBootstrap(container, bootstrap) {
	await runWithInput("docker", buildBootstrapWriteArgs(container), JSON.stringify(bootstrap));
}

async function clearBootstrap(volume) {
	await runVolumeCommand(volume, "rm -f /run/divo-auth/bootstrap.json");
}

function progressToolId(toolName, args) {
	const direct = args?.toolId;
	const nested = args?.payload?.toolId;
	const value = typeof direct === "string" ? direct : typeof nested === "string" ? nested : undefined;
	if (!value || !/^[A-Za-z0-9._-]{1,80}$/.test(value)) return undefined;
	return toolName === "divo_gateway" || toolName === "call_tool" ? value : undefined;
}

const PROGRESS_LABEL_MAX = 80;
const PROGRESS_CHILDREN_MAX = 8;
const PROGRESS_TODOS_MAX = 12;

const PROGRESS_DETAIL_MAX = 64;
const PROGRESS_SAY_MAX = 200;

function progressLabel(value, maxLength = PROGRESS_LABEL_MAX) {
	if (typeof value !== "string") return undefined;
	const flat = value.replace(/\s+/g, " ").trim();
	if (!flat) return undefined;
	return flat.length > maxLength ? `${flat.slice(0, maxLength - 1)}…` : flat;
}

/**
 * What a tool call is about, taken from the arguments it was called with.
 *
 * Five rows reading "Terminal / Files / Terminal" say only that something ran.
 * The argument that names the work is already in hand here — the projection
 * simply threw it away — and one short phrase per row is the difference between
 * a progress bar and a log somebody can read.
 *
 * Only the one identifying argument crosses, never the whole object: a tool's
 * arguments can carry a whole file body or a customer record, and this string
 * is rendered into a chat window a room full of colleagues can read.
 */
function progressToolDetail(toolName, args) {
	if (!args || typeof args !== "object") return undefined;
	const fileName = (value) =>
		typeof value === "string" ? value.split("/").filter(Boolean).at(-1) : undefined;

	if (toolName === "bash") return progressLabel(args.command, PROGRESS_DETAIL_MAX);
	if (toolName === "read" || toolName === "write" || toolName === "edit") {
		return progressLabel(fileName(args.file_path ?? args.path), PROGRESS_DETAIL_MAX);
	}
	// A skill is addressed by UUID, which names nothing to the person reading the
	// card. The row stays bare until the call returns and can be labelled with
	// the skill's actual name.
	if (toolName === "divo_skill_view") {
		return UUID_PATTERN.test(String(args.skillId ?? ""))
			? undefined
			: progressLabel(args.skillId, PROGRESS_DETAIL_MAX);
	}
	// The tool id already travels as its own field, and the backend holds the
	// table that turns it into a product name — so only the operation goes here.
	// Sending the raw id too would print it twice, untranslated.
	if (toolName === "divo_gateway") return progressLabel(args.op, PROGRESS_DETAIL_MAX);
	return undefined;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The text block the model is writing right now, out of the accumulated message. */
function assistantBlockText(assistantMessageEvent) {
	const content = assistantMessageEvent?.partial?.content;
	const block = Array.isArray(content) ? content[assistantMessageEvent.contentIndex] : undefined;
	return block?.type === "text" && typeof block.text === "string" ? block.text : undefined;
}

/**
 * Only whole sentences leave the container.
 *
 * A text delta arrives per token, and forwarding each one would redraw the
 * status card for every word of a thirteen-minute run — hundreds of edits of
 * one chat message, for a card nobody is reading letter by letter. Cutting at
 * the last completed sentence makes the projection self-rate-limiting without
 * any timer: the value only changes when the model finishes saying something.
 */
export function settledSentences(text) {
	const match = /^[\s\S]*[.!?…](?=["'’”)\]]*(?:\s|$))/.exec(text ?? "");
	return match ? match[0].trim() : "";
}

/** Pi child states, in the vocabulary the status card renders. */
const CHILD_STATE_STATUS = {
	queued: "pending",
	running: "running",
	completed: "done",
	failed: "failed",
	cancelled: "skipped",
};

/**
 * Subagent children, from the details `divo_subagents` already streams.
 *
 * Only the role, the task and the state cross this boundary. A child's output,
 * usage and event log are the run's internals, and the status card is shown in
 * a chat window — anything forwarded here is something a bystander may read.
 */
function progressChildren(details) {
	const children = details?.children;
	if (!Array.isArray(children) || children.length === 0) return undefined;
	const rows = children.slice(0, PROGRESS_CHILDREN_MAX).flatMap((child) => {
		const label = progressLabel(child?.role);
		if (!label) return [];
		const status = CHILD_STATE_STATUS[child?.state] ?? "running";
		const detail = progressLabel(child?.task);
		return [{ label, status, ...(detail ? { detail } : {}) }];
	});
	return rows.length > 0 ? rows : undefined;
}

/** The checklist `divo_todos` declared, if this tool call was that one. */
function progressTodos(details) {
	const items = details?.items;
	if (!Array.isArray(items) || items.length === 0) return undefined;
	const rows = items.slice(0, PROGRESS_TODOS_MAX).flatMap((item) => {
		const title = progressLabel(item?.title);
		if (!title) return [];
		const status = typeof item?.status === "string" ? item.status : "pending";
		return [{ title, status }];
	});
	return rows.length > 0 ? rows : undefined;
}

/**
 * What a tool's own details say about the work underneath it.
 *
 * Both extensions that have something to show already stream it as tool
 * details, so neither needs a transport of its own — the shape of the details
 * decides which it is.
 */
function progressDetail(details) {
	if (!details || typeof details !== "object") return undefined;
	const children = progressChildren(details);
	if (children) return { children };
	const todos = progressTodos(details);
	if (todos) return { todos };
	// A loaded skill knows its own name, which is the only readable thing about
	// a call the model addressed by UUID. It is only knowable once the call has
	// returned, so the row is named on the way out rather than the way in.
	const name = progressLabel(details.name, PROGRESS_DETAIL_MAX);
	if (name && typeof details.revision === "number") return { detail: name };
	return undefined;
}

export function projectRuntimeProgress(event) {
	if (!event || typeof event !== "object") return undefined;
	if (event.type === "agent_start" || event.type === "turn_start") {
		return { type: "thinking" };
	}
	if (event.type === "tool_execution_start") {
		const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
		const toolId = progressToolId(toolName, event.args);
		const detail = progressToolDetail(toolName, event.args);
		return {
			type: "tool_start",
			callId: String(event.toolCallId ?? ""),
			toolName,
			...(toolId ? { toolId } : {}),
			...(detail ? { detail } : {}),
		};
	}
	if (event.type === "tool_execution_update") {
		// Most tools stream partial stdout, which the card has no use for. Only a
		// call that describes structured work underneath itself is worth a redraw.
		const detail = progressDetail(event.partialResult?.details);
		if (!detail) return undefined;
		return {
			type: "tool_progress",
			callId: String(event.toolCallId ?? ""),
			toolName: typeof event.toolName === "string" ? event.toolName : "tool",
			...detail,
		};
	}
	if (event.type === "tool_execution_end") {
		// The final details settle every child at once: a run that ended between
		// the last update and here would otherwise leave children stuck running
		// under a parent already marked done.
		return {
			type: "tool_end",
			callId: String(event.toolCallId ?? ""),
			toolName: typeof event.toolName === "string" ? event.toolName : "tool",
			isError: event.isError === true,
			...(progressDetail(event.result?.details) ?? {}),
		};
	}
	if (
		event.type === "message_update"
		&& event.assistantMessageEvent?.type === "text_delta"
	) {
		// A long run that says nothing reads as a hang, however much work it is
		// doing. What the model says between its tool calls is the only thing on
		// the card written for a person rather than derived from one, so it is
		// forwarded rather than flattened into a bare "writing" flag.
		const said = progressLabel(
			settledSentences(assistantBlockText(event.assistantMessageEvent)),
			PROGRESS_SAY_MAX,
		);
		if (!said) return { type: "writing" };
		return {
			type: "say",
			index: Number.isInteger(event.assistantMessageEvent.contentIndex)
				? event.assistantMessageEvent.contentIndex
				: 0,
			text: said,
		};
	}
	// Reasoning stays inside the container. `thinking_delta` is the model
	// talking to itself, not to the room, and a status card is read by everyone
	// in the chat.
	return undefined;
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

function terminalRunError(terminal) {
	const error = new Error(terminal.summary ?? "The model continuation did not complete.");
	error.code = "model_continuation_failed";
	error.statusCode = 502;
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
				&& content.name === "divo_gateway"
				&& ["tools.invoke", "teach.learning.apply"].includes(content.arguments?.op))
			: [],
	);
	if (calls.length === 0) return "none";
	const actions = [];
	for (const call of calls) {
		const result = currentRun.find((message) =>
			message?.role === "toolResult"
			&& message.toolCallId === call.id
			&& message.toolName === "divo_gateway",
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
}) {
	for (let retry = 0; ; retry += 1) {
		const completed = rpc.waitFor("agent_end");
		await rpc.send(
			{ type: "prompt", message: retry === 0 ? message : MODEL_RETRY_PROMPT },
			90_000,
		);
		const completion = await completed;
		const terminal = classifyDivoRunTerminal(completion?.messages);
		if (terminal.status === "ok") return completion;
		if (!isTransientDivoRunFailure(completion?.messages) || retry >= maxRetries) {
			throw terminalRunError(terminal);
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
		if (retryDelayMs > 0) {
			await new Promise((resolve) => setTimeout(resolve, retryDelayMs * 2 ** retry));
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

export function runtimeStartupProgress({ wasRunning, created }) {
	return wasRunning || !created
		? [{ type: "working" }]
		: [
			{ type: "starting", stage: "workspace", label: "Checking your workspace…" },
			{ type: "starting", stage: "container", label: "Waking up Divo…" },
		];
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
	const container = await findOwnedContainer(profile);
	if (!container) return;
	if (container.State.Running) await docker(["stop", resources.container]);
}

export function createIdleContainerScheduler({
	stop,
	idleTimeoutMs = RUNTIME_IDLE_TIMEOUT_MS,
	retryDelayMs = RUNTIME_STOP_RETRY_MS,
	setTimer = setTimeout,
	clearTimer = clearTimeout,
	onError = (error) => console.error(`[Pi] Failed to stop idle container: ${error.message}`),
}) {
	const timers = new Map();
	const stopping = new Map();
	const trackedProfiles = new Set();
	let shuttingDown = false;

	const schedule = (profile, delay) => {
		if (shuttingDown) return;
		const previous = timers.get(profile);
		if (previous) clearTimer(previous);
		const timer = setTimer(() => stopAfterIdle(profile), delay);
		timer.unref?.();
		timers.set(profile, timer);
		trackedProfiles.add(profile);
	};

	const stopAfterIdle = (profile) => {
		timers.delete(profile);
		const work = Promise.resolve().then(() => stop(profile));
		stopping.set(profile, work);
		void work.then(
			() => {
				if (stopping.get(profile) === work) stopping.delete(profile);
				trackedProfiles.delete(profile);
			},
			(error) => {
				if (stopping.get(profile) === work) stopping.delete(profile);
				onError(error);
				schedule(profile, retryDelayMs);
			},
		);
	};

	const cancel = async (profile) => {
		while (true) {
			const timer = timers.get(profile);
			if (timer) {
				clearTimer(timer);
				timers.delete(profile);
			}
			const work = stopping.get(profile);
			if (!work) break;
			await work.catch(() => {});
		}
		trackedProfiles.delete(profile);
	};

	return {
		async activate(profile) {
			await cancel(profile);
		},
		keepWarm(profile) {
			schedule(profile, idleTimeoutMs);
		},
		async stopNow(profile) {
			await cancel(profile);
			try {
				await stop(profile);
			} catch (error) {
				onError(error);
				schedule(profile, retryDelayMs);
				throw error;
			}
		},
		async shutdown() {
			shuttingDown = true;
			const profiles = [...trackedProfiles];
			for (const timer of timers.values()) clearTimer(timer);
			timers.clear();
			await Promise.allSettled(stopping.values());
			await Promise.all(profiles.map(profile => stop(profile)));
			trackedProfiles.clear();
		},
	};
}

const idleContainers = createIdleContainerScheduler({ stop: stopOwnedContainer });

/**
 * Teardown that a reply is no longer waiting on.
 *
 * Removing a shared run's container, its two volumes and its network costs a
 * third of a second of Docker round trips, and it used to sit between the
 * model's last token and the reply reaching Lark — the room waited on work done
 * purely to reclaim resources.
 *
 * Leaking is not the price: `reconcileOwnedContainers` destroys every stray
 * `shared-` profile at controller startup, so backgrounding trades a removal
 * guaranteed *now* for one guaranteed by the next start. Shutdown drains this
 * set so an orderly stop still finishes what it began.
 */
const reclaiming = new Set();

export function trackRuntimeReclamation(
	profile,
	work,
	onError = (error) => console.error(`[Pi] ${error.message}`),
) {
	let settled;
	settled = work.then(
		() => undefined,
		(error) => onError(
			new Error(`Divo runtime reclamation failed for profile "${profile}": ${error.message}`),
		),
	).finally(() => {
		reclaiming.delete(settled);
	});
	reclaiming.add(settled);
	return settled;
}

export async function shutdownWarmContainers() {
	await idleContainers.shutdown();
	await Promise.allSettled([...reclaiming]);
}

export async function finalizeRuntimeLifecycle({
	profile,
	resources,
	bootstrapAttempted,
	completedSuccessfully,
	runError,
	abortStop,
	ephemeral = false,
}, {
	clearBootstrapFn = clearBootstrap,
	scheduler = idleContainers,
	destroyRuntimeFn = destroyEphemeralRuntime,
	reclaimFn = trackRuntimeReclamation,
	onCleanupError = (error) => console.error(
		`[Pi] ${error.message}: ${error.errors.map(String).join("; ")}`,
	),
} = {}) {
	const cleanupErrors = [];
	// Only a run that failed can still be holding the token. Reaching completion
	// means container-entry read the bootstrap, and it unlinks the file the moment
	// it does, so clearing again spends a throwaway container deleting nothing.
	// A run that died earlier may never have read it, and that one still needs it.
	if (bootstrapAttempted && !completedSuccessfully) {
		try {
			await clearBootstrapFn(resources.authVolume);
		} catch (error) {
			cleanupErrors.push(error);
		}
	}
	const abortError = await abortStop;
	if (abortError) cleanupErrors.push(abortError);
	if (ephemeral) {
		// A run that produced an answer has nothing left to decide, so its
		// teardown is reclamation and the room should not wait for it. A run that
		// failed still tears down synchronously: nobody is waiting on a reply
		// there, and a cleanup failure has to stay able to surface.
		if (completedSuccessfully && cleanupErrors.length === 0) {
			reclaimFn(profile, destroyRuntimeFn(profile));
		} else {
			try {
				await destroyRuntimeFn(profile);
			} catch (error) {
				cleanupErrors.push(error);
			}
		}
	} else if (completedSuccessfully && cleanupErrors.length === 0) {
		scheduler.keepWarm(profile);
	} else {
		try {
			await scheduler.stopNow(profile);
		} catch (error) {
			cleanupErrors.push(error);
		}
	}
	if (cleanupErrors.length === 0) return;
	const cleanupError = new AggregateError(
		cleanupErrors,
		`Divo runtime cleanup failed for profile "${profile}"`,
	);
	if (runError) onCleanupError(cleanupError);
	else throw cleanupError;
}

export async function reconcileOwnedContainers() {
	const results = await Promise.all([
		docker([
			"ps",
			"--all",
			"--filter",
			"label=dev.divo.profile",
			"--format",
			'{{.Label "dev.divo.profile"}}',
		]),
		docker([
			"volume",
			"ls",
			"--filter",
			"label=dev.divo.profile",
			"--format",
			'{{.Label "dev.divo.profile"}}',
		]),
		docker([
			"network",
			"ls",
			"--filter",
			"label=dev.divo.profile",
			"--format",
			'{{.Label "dev.divo.profile"}}',
		]),
	]);
	const profiles = [...new Set(
		results.flatMap(result => result.stdout.split("\n").filter(Boolean)),
	)];
	for (const profileName of profiles) {
		const profile = validateProfileName(profileName);
		if (profile.startsWith("shared-")) {
			// Normal completion removes every shared object immediately. Reaching
			// startup means the controller crashed mid-run; remove the exact
			// signed-run profile before new work is admitted.
			await destroyEphemeralRuntime(profile);
			continue;
		}
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
}) {
	const normalizedSessionScope = validateSessionScope(sessionScope);
	if (ephemeral && normalizedSessionScope !== "run") {
		throw new Error("A shared runtime must use a run-scoped session");
	}
	if (signal?.aborted) throw new Error("Pi run was interrupted before container start");
	let resources = resourcesFor(profile);
	const selectedModel = validateRuntimeModel(model);
	const bootstrap = {
		backendUrl: backendUrlForContainer(backendUrl),
		token,
		profile,
		thread,
		...(runtimeThreadId ? { runtimeThreadId } : {}),
		userId,
		companyId,
		...(runId ? { runId } : {}),
		departmentId,
		sessionScope: normalizedSessionScope,
		...(channel ? { channel } : {}),
		...(channel === "lark" ? { interruptionTask: message } : {}),
		...(selectedModel ?? {}),
	};
	if (!ephemeral) await idleContainers.activate(profile);
	let abortStop;
	let bootstrapAttempted = false;
	let child;
	let completedSuccessfully = false;
	let runError;
	const abort = () => {
		abortStop = stopOwnedContainer(profile).then(
			() => undefined,
			(error) => error,
		);
	};
	signal?.addEventListener("abort", abort, { once: true });
	if (signal?.aborted) abort();
	try {
		const runtime = await ensureRuntime(profile, { ephemeral });
		resources = runtime.resources;
		for (const progress of runtimeStartupProgress(runtime)) {
			emitRuntimeProgress(onProgress, progress);
		}
		if (signal?.aborted) throw new Error("Pi run was interrupted before container start");
		const startedAt = Date.now();
		// `ensureRuntime` just inspected this container and verified it is ours,
		// so its running state is already known here. Polling is only meaningful
		// when we actually issued the start: a container already reported running
		// has nothing to wait for, and if it died in the moment since, `docker
		// exec` reports that immediately rather than after ten seconds spent
		// waiting for a transition nobody triggered.
		if (!runtime.wasRunning) {
			await docker(["start", resources.container]);
			await waitUntilRunning(resources.container);
		}
		bootstrapAttempted = true;
		await writeBootstrap(resources.container, bootstrap);
		child = spawn("docker", [
			"exec",
			"--interactive",
			resources.container,
			"node",
			"divo/container-entry.mjs",
		], {
			stdio: ["pipe", "pipe", "pipe"],
		});
		child.stderr.pipe(process.stderr);
		const exited = new Promise((resolve) => {
			child.once("error", (error) => resolve({ error }));
			child.once("exit", (code, terminationSignal) => resolve({ code, terminationSignal }));
		});
		const rpc = new JsonlRpc(child, answerRequest, onProgress);
		const state = await rpc.send({ type: "get_state" }, 90_000);
		console.error(
			`Ready ${profile}/${thread} in ${Date.now() - startedAt}ms (session ${state.sessionId})`,
		);
		emitRuntimeProgress(onProgress, { type: "ready" });
		const completion = await promptWithTransientRetries({
			rpc,
			message: `${attachmentManifestBlock(attachments)}${message}`,
			onRetry: ({ attempt, maxRetries, summary }) => {
				console.error(
					`Transient model failure; retrying continuation ${attempt}/${maxRetries}: ${summary}`,
				);
				emitRuntimeProgress(onProgress, { type: "thinking" });
			},
		});
		const text = collectRunAssistantText(completion?.messages);
		if (!text) {
			throw terminalRunError({
				summary: "The model continuation completed without a final answer.",
			});
		}
		console.log(text);
		child.stdin.end();
		const outcome = await exited;
		if (outcome.error) throw outcome.error;
		if (outcome.code !== 0) {
			throw new Error(
				`Divo runtime exited ${outcome.terminationSignal ? `with ${outcome.terminationSignal}` : `with code ${outcome.code}`}`,
			);
		}
		completedSuccessfully = true;
		return { profile, thread, text };
	} catch (error) {
		runError = error;
		throw error;
	} finally {
		signal?.removeEventListener("abort", abort);
		if (child && !child.stdin.destroyed) child.stdin.end();
		await finalizeRuntimeLifecycle({
			profile,
			resources,
			bootstrapAttempted,
			completedSuccessfully,
			runError,
			abortStop,
			ephemeral,
		});
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
		!session.runtime.threadId ||
		!session.runtime.runId
	) {
		throw new Error("Divo backend did not validate a Lark Pi runtime lease");
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

export async function promptWithRuntimeLease(runtime, message, options = {}) {
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
	});
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
