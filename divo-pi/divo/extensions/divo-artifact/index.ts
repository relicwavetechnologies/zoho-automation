/**
 * Pi-owned artifact badge for Divo.
 *
 * Artifacts are normal workspace files. The model creates and revises them with
 * write/edit/read; this tool takes the finished file and makes it readable
 * outside the container.
 *
 * That last part is the whole job, and it is why the tool cannot be a pure
 * badge. The container is torn down when the run ends. A path handed to a reader
 * who has no filesystem to look in — a browser — names a file that will not
 * exist by the time they click it. So the body is lifted out here, at the one
 * moment the model has said the document is finished, and stored against the
 * member who asked for it.
 *
 * Presentation only, still: no gateway, no SaaS, no RBAC authority. It moves one
 * file the model already wrote, to the reader who already asked for it.
 */

import { access, constants, readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readRuntimeRunContext } from "../../runtime-run-context.mjs";
import { resolveMemberCredentials } from "../../runtime-member-credentials.mjs";
import { readDepartmentPersonaContext } from "../divo-gateway/department-persona.ts";

export const DIVO_ARTIFACT_TOOL_NAME = "divo_artifact";
export const DIVO_ARTIFACT_DETAILS_VERSION = 2 as const;
export const MAX_ARTIFACT_TITLE_CHARS = 160;
export const MAX_ARTIFACT_ID_CHARS = 120;
export const MAX_SUMMARY_CHARS = 800;
export const MAX_PATH_CHARS = 1_200;

const ArtifactParams = Type.Object({
	path: Type.String({
		description:
			"Workspace-relative or absolute path to an existing file to open in the sidebar. Prefer artifacts/<name>.md for deliverables.",
		minLength: 1,
		maxLength: MAX_PATH_CHARS,
	}),
	title: Type.Optional(
		Type.String({
			description: "Short document title shown on the sidebar tab. Defaults to the file basename.",
			minLength: 1,
			maxLength: MAX_ARTIFACT_TITLE_CHARS,
		}),
	),
	artifactId: Type.Optional(
		Type.String({
			description:
				"Stable id to update an existing sidebar tab in place. Omit to derive one from the file path.",
			minLength: 1,
			maxLength: 120,
		}),
	),
	summaryForChat: Type.Optional(
		Type.String({
			description: "One or two sentence pointer for the chat reply.",
			maxLength: MAX_SUMMARY_CHARS,
		}),
	),
});

export type ArtifactMime = "text/markdown" | "text/html";

export type DivoArtifactDetails = {
	/** This record's shape, not the document's. */
	version: typeof DIVO_ARTIFACT_DETAILS_VERSION;
	artifactId: string;
	title: string;
	mime: ArtifactMime;
	path: string;
	summaryForChat?: string;
	/** Which revision of the document the store now holds. */
	storedVersion?: number;
	updatedAt: string;
};

type ArtifactParams = {
	path: string;
	title?: string;
	artifactId?: string;
	summaryForChat?: string;
};

export function resolveArtifactsDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const raw = env.DIVO_ARTIFACTS_DIR?.trim();
	return raw || undefined;
}

/**
 * What the reader's panel will make of this file, decided by its extension.
 *
 * HTML is a first-class document type, not a hazard being tolerated: the panel
 * renders it in a frame with no same-origin access and no network, so markup a
 * model wrote can style itself freely and still reach nothing. The extension is
 * the whole contract — a `.txt` full of markup is still not a document, because
 * the writer did not say it was one.
 */
export function mimeFromPath(filePath: string): ArtifactMime | undefined {
	const ext = extname(filePath).toLowerCase();
	if (ext === ".md" || ext === ".markdown") return "text/markdown";
	if (ext === ".html" || ext === ".htm") return "text/html";
	return undefined;
}

export function artifactIdFromPath(filePath: string): string {
	const hash = createHash("sha256").update(filePath).digest("hex").slice(0, 16);
	const stem = basename(filePath, extname(filePath))
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return `${stem || "artifact"}-${hash}`.slice(0, 120);
}

/**
 * Reduce a model-supplied id to the shape the store and a URL will both accept.
 *
 * Mechanical, never interpretive: strip what cannot travel, keep the rest. A
 * model that passes `reports/q3 review.md` meant one document, and rejecting the
 * call over punctuation would lose the document to make a point about it. An id
 * with nothing left after stripping falls back to the path, which is the only
 * other thing that identifies the same file.
 */
export function safeArtifactId(supplied: string | undefined, filePath: string): string {
	const cleaned = (supplied ?? "")
		.trim()
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^[^A-Za-z0-9]+/, "")
		.slice(0, MAX_ARTIFACT_ID_CHARS);
	return cleaned || artifactIdFromPath(filePath);
}

export function titleFromPath(filePath: string): string {
	const stem = basename(filePath, extname(filePath)).trim();
	if (!stem) return "Artifact";
	return stem.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, MAX_ARTIFACT_TITLE_CHARS);
}

/**
 * Resolve `path` under cwd and ensure it stays inside the workspace root.
 * Returns the absolute real path when the file exists.
 */
export async function resolveWorkspaceFilePath(
	rawPath: string,
	cwd: string = process.cwd(),
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
	const trimmed = rawPath.trim();
	if (!trimmed) return { ok: false, error: "path is required" };

	const workspaceRoot = resolve(cwd);
	const candidate = isAbsolute(trimmed) ? resolve(trimmed) : resolve(workspaceRoot, trimmed);

	const rootPrefix = workspaceRoot.endsWith(sep) ? workspaceRoot : `${workspaceRoot}${sep}`;
	if (candidate !== workspaceRoot && !candidate.startsWith(rootPrefix)) {
		return { ok: false, error: "path must be inside the workspace" };
	}

	try {
		await access(candidate, constants.R_OK);
		const info = await stat(candidate);
		if (!info.isFile()) return { ok: false, error: "path must be a file" };
		const real = await realpath(candidate);
		const realRoot = await realpath(workspaceRoot);
		const realRootPrefix = realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`;
		if (real !== realRoot && !real.startsWith(realRootPrefix)) {
			return { ok: false, error: "path must be inside the workspace" };
		}
		return { ok: true, path: real };
	} catch {
		return { ok: false, error: "file not found" };
	}
}

export function buildArtifactDetails(input: {
	artifactId: string;
	title: string;
	mime: ArtifactMime;
	path: string;
	summaryForChat?: string;
	updatedAt?: string;
	storedVersion?: number;
}): DivoArtifactDetails {
	return {
		version: DIVO_ARTIFACT_DETAILS_VERSION,
		artifactId: input.artifactId,
		title: input.title,
		mime: input.mime,
		path: input.path,
		...(input.summaryForChat ? { summaryForChat: input.summaryForChat } : {}),
		...(typeof input.storedVersion === "number" ? { storedVersion: input.storedVersion } : {}),
		updatedAt: input.updatedAt ?? new Date().toISOString(),
	};
}

/**
 * The store's address, or nothing.
 *
 * Read from the runtime's held credentials rather than from `process.env`. The
 * gateway deletes `DIVO_MEMBER_TOKEN` from the environment during startup, on
 * purpose — every shell the agent spawns inherits that environment — so by the
 * time this tool is called there is nothing left in it to read. Reading the
 * environment here was the whole reason a filed document reported "no document
 * store": the address was there and the credential was not.
 *
 * Nothing is still the honest answer when the container was started without a
 * backend to talk to. The tool says so rather than pretending it filed the
 * document somewhere.
 */
export function resolveArtifactStore(
	env?: NodeJS.ProcessEnv,
): { backendUrl: string; memberToken: string } | undefined {
	const held = resolveMemberCredentials(env);
	if ("error" in held) return undefined;
	return { backendUrl: held.backendUrl, memberToken: held.memberToken };
}

/** Named for the resource. The caller is a member, not a client. */
const STORE_PATH = "/api/artifacts";
const STORE_TIMEOUT_MS = 20_000;
/** Matches the store's own bound. A larger document wants object storage. */
export const MAX_ARTIFACT_BODY_CHARS = 400_000;

/**
 * Put the finished document where a reader can open it, and report which
 * version they will get.
 *
 * Awaited, unlike the trace's fire-and-forget POST, and the difference is the
 * point: a dropped trace event costs a line of a log nobody was reading, while a
 * dropped artifact costs the deliverable. If this fails the tool fails, so the
 * model finds out in the same turn and can say so instead of announcing a
 * document that was never stored.
 */
async function storeArtifact(input: {
	store: { backendUrl: string; memberToken: string };
	artifactId: string;
	title: string;
	mime: ArtifactMime;
	body: string;
	threadId?: string;
	executionRunId?: string;
}): Promise<{ ok: true; version: number } | { ok: false; error: string }> {
	try {
		const response = await fetch(`${input.store.backendUrl}${STORE_PATH}`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${input.store.memberToken}`,
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify({
				artifactId: input.artifactId,
				title: input.title,
				mime: input.mime,
				body: input.body,
				...(input.threadId ? { threadId: input.threadId } : {}),
				...(input.executionRunId ? { executionRunId: input.executionRunId } : {}),
			}),
			signal: AbortSignal.timeout(STORE_TIMEOUT_MS),
		});
		if (!response.ok) return { ok: false, error: `the document store answered ${response.status}` };
		const payload = (await response.json()) as { artifact?: { version?: unknown } };
		const version = payload?.artifact?.version;
		return { ok: true, version: typeof version === "number" ? version : 1 };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

export default function divoArtifactExtension(pi: ExtensionAPI) {
	pi.registerTool<typeof ArtifactParams, unknown>({
		name: DIVO_ARTIFACT_TOOL_NAME,
		label: "Divo artifact",
		description:
			"File an existing workspace document so the current surface can render or link it. Create or revise the file first with write/edit; do not pass file contents here.",
		promptSnippet:
			"Create/revise durable deliverables with write/edit (prefer artifacts/<name>.html), then call divo_artifact with the file path to file it for the current surface. Read the divo-artifact skill's DESIGN.md before writing the first HTML document. Prefer edit for small revisions. Keep ordinary short answers in chat.",
		promptGuidelines: [
			"Durable multi-section deliverables (research briefs, reports, plans, comparisons, file-like docs) are normal workspace files — create them with write, revise with edit, inspect with read.",
			"Prefer paths under artifacts/ (for example artifacts/q4-flavour-review.html). DIVO_ARTIFACTS_DIR points at that folder when configured.",
			"Use .html for anything with structure or figures — tables, stat rows, charts, several sections. Use .md only when the document is genuinely nothing but prose and headings.",
			"Before writing the first .html document in a conversation, read DESIGN.md in the divo-artifact skill. It carries the colour tokens, type scale and component recipes that make a document look like Divo.",
			"An .html document is body markup only: no doctype, html, head or body tags. The panel supplies the wrapper, the design tokens and the chart function at render time. Put the document's own CSS in one <style> block and any interaction in a <script> at the end.",
			"In .html documents never write a hex colour — every colour is var(--ink), var(--surface), var(--line), var(--green) and the rest, so the document follows the reader's theme. Never hand-write chart SVG; emit <div class=\"chart\" data-chart='{...}'> and let the panel draw it.",
			"After creating or meaningfully editing such a file, call divo_artifact with its path (and optional title/summaryForChat) so the current surface can receive it. This tool does not write content.",
			"Prefer edit for small revisions; do not rewrite the whole file with write or by pasting the full body into divo_artifact.",
			"Write real links so the sidebar can render them: [label](https://…) in markdown, <a href=\"https://…\"> in HTML, and a Sources section with matching numbered URLs when using [1]/[2] citations.",
			"Stay in chat for short Q&A, status, confirmations, a single next step, mid-task tool chatter, or ordinary web lookups that only need a few bullets.",
			"After calling, reply with a brief pointer (prefer summaryForChat). Do not paste the full file body into the transcript.",
			"Reuse the same artifactId (or the same path) when updating a document already shown in the sidebar.",
			"Ordinary public web lookup remains a direct webSearch capability; searching does not by itself require an artifact.",
			"Write titles and headings in English. Do not mention tool names, tool IDs, or internal plumbing to the user.",
			"This tool is presentation only. It does not grant permissions, request approvals, or change company systems.",
		],
		parameters: ArtifactParams,

		async execute(_toolCallId, params: ArtifactParams) {
			/* One shape for every way this can fail, because the model reads the
			   text and the trace reads the details, and the two disagreeing about
			   whether a document exists is how a reader ends up being told about
			   one that does not. */
			const failure = (reason: string, code: string) => ({
				content: [{ type: "text" as const, text: `Could not show that document: ${reason}.` }],
				details: { version: DIVO_ARTIFACT_DETAILS_VERSION, error: code },
				isError: true,
			});

			const resolved = await resolveWorkspaceFilePath(params.path);
			if (!resolved.ok) return failure(resolved.error, resolved.error);

			const mime = mimeFromPath(resolved.path);
			if (!mime) {
				return failure(
					"only .html or markdown (.md / .markdown) files can be shown",
					"unsupported mime",
				);
			}

			const title =
				params.title?.trim().slice(0, MAX_ARTIFACT_TITLE_CHARS) || titleFromPath(resolved.path);
			const summaryForChat = params.summaryForChat?.trim() || undefined;
			const artifactId = safeArtifactId(params.artifactId, resolved.path);

			let body: string;
			try {
				body = await readFile(resolved.path, "utf8");
			} catch {
				return failure("the file could not be read", "unreadable");
			}
			if (body.length > MAX_ARTIFACT_BODY_CHARS) {
				return failure(
					`the document is ${body.length} characters, past the ${MAX_ARTIFACT_BODY_CHARS} this can carry — split it or summarise it`,
					"too large",
				);
			}

			// The store is what makes the file readable at all once this container
			// is gone, so a failure here is a failure of the tool. Reporting success
			// and letting the reader discover an empty panel would be the one
			// outcome worse than the model knowing it has to say so.
			const store = resolveArtifactStore();
			if (!store) return failure("this run has no document store to file it in", "no store");

			const context = await readRuntimeRunContext().catch(() => undefined);
			const surface = await readDepartmentPersonaContext();
			const artifactMode = surface?.surface?.artifacts;
			if (!artifactMode || artifactMode === "none") {
				return failure(
					"this surface cannot receive a document — put the result in the reply instead",
					"no surface",
				);
			}
			const stored = await storeArtifact({
				store,
				artifactId,
				title,
				mime,
				body,
				...(context?.threadId ? { threadId: context.threadId } : {}),
				...(context?.runId ? { executionRunId: context.runId } : {}),
			});
			if (!stored.ok) return failure(stored.error, "not stored");

			const details = buildArtifactDetails({
				artifactId,
				title,
				mime,
				path: resolved.path,
				summaryForChat,
				storedVersion: stored.version,
			});

			const pointer = summaryForChat ?? (
				artifactMode === "inline"
					? `Opened "${title}" beside the conversation, from ${basename(resolved.path)}. Keep the chat reply to a short pointer; do not paste the full body.`
					: `Filed "${title}" for link delivery, from ${basename(resolved.path)}. Keep the chat reply to a short pointer; do not paste the full body.`
			);

			return {
				content: [{ type: "text" as const, text: pointer }],
				details,
			};
		},
	});
}
