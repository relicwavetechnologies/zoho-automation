/**
 * Moving one attachment's bytes into the user's own Docker volume.
 *
 * Everything that decides *where* those bytes land is derived here from the
 * signed runtime lease. The backend never names a path, a volume or a profile —
 * it hands over bytes and metadata, and gets back a descriptor. That asymmetry
 * is the whole isolation guarantee, so nothing here may accept a caller-supplied
 * path.
 *
 * `runtime-attachments.mjs` decides what a name and a path may be; this module
 * decides how bytes get there. The two guarantees it exists to hold are:
 *
 * - the writer is a throwaway container with no network, no capabilities and
 *   exactly one volume mounted, so a hostile filename has nothing to reach;
 * - the rename is the commit, so a stream cut short by the byte cap, an abort
 *   or a dead backend leaves a `.part` file that no manifest ever names — the
 *   agent can never be handed a truncated document as if it were whole.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import {
	MAX_RUNTIME_ATTACHMENT_BYTES,
	normalizeMimeType,
	safeAttachmentFileName,
	stagedAttachmentPath,
} from "./runtime-attachments.mjs";
import { validateProfileName } from "./runtime-identity.mjs";
import {
	IMAGE,
	WORKSPACE_UID_GID,
	codedError,
	ensureProfileVolume,
	shellQuote,
} from "./runtime-docker.mjs";

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
				throw codedError(
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
