import path from "node:path";

const INBOX_CONTAINER_ROOT = "/data/workspace/.divo/inbox";
export const MAX_RUNTIME_ATTACHMENTS = 4;
export const MAX_RUNTIME_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_RUNTIME_REQUEST_BYTES = 50 * 1024 * 1024;

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

/** Reduce a chat-supplied filename to a file name, never a location. */
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

export function normalizeMimeType(value) {
	const essence = String(value ?? "").split(";")[0].trim().toLowerCase();
	return /^[a-z0-9!#$&^_.+-]{1,127}\/[a-z0-9!#$&^_.+-]{1,127}$/.test(essence)
		? essence
		: "application/octet-stream";
}

/** Revalidate every descriptor and recompute its path at the runtime boundary. */
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

/** Render paths and metadata only; attachment bytes remain in the workspace. */
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
