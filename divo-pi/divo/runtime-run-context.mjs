/**
 * Who owns this Pi process right now.
 *
 * The controller writes one small JSON file per prompt and points
 * `DIVO_RUN_CONTEXT_PATH` at it. Everything inside the container that needs to
 * name the run it is part of — the trace, the artifact store — reads it from
 * here, and from nowhere else.
 *
 * One reader on purpose. Two readers of one file are two chances to disagree
 * about which run a side effect belongs to, and the one that drifts is the one
 * that files a document under the wrong conversation.
 *
 * Never cached. The file is rewritten for each prompt, and a cached run id
 * survives into the next one.
 */

import { readFile } from "node:fs/promises";

export const DIVO_RUN_CONTEXT_PATH_ENV = "DIVO_RUN_CONTEXT_PATH";

const MAX_IDENTIFIER_LENGTH = 200;

/** @param {unknown} value @param {string} field @returns {string} */
function identifier(value, field) {
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`Divo run correlation ${field} is missing`);
	}
	const result = value.trim();
	if (result.length > MAX_IDENTIFIER_LENGTH) {
		throw new Error(`Divo run correlation ${field} is too long`);
	}
	return result;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{ version: 1, threadId: string, runId: string, channel?: string, departmentId?: string }>}
 */
export async function readRuntimeRunContext(env = process.env) {
	const path = env[DIVO_RUN_CONTEXT_PATH_ENV]?.trim();
	if (!path) throw new Error("Divo run correlation is unavailable");
	let parsed;
	try {
		parsed = JSON.parse(await readFile(path, "utf8"));
	} catch {
		throw new Error("Divo run correlation could not be read");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Divo run correlation is malformed");
	}
	if (parsed.version !== 1) {
		throw new Error("Divo run correlation version is unsupported");
	}
	return {
		version: 1,
		threadId: identifier(parsed.threadId, "threadId"),
		runId: identifier(parsed.runId, "runId"),
		...(typeof parsed.channel === "string" ? { channel: parsed.channel } : {}),
		...(typeof parsed.departmentId === "string"
			? { departmentId: identifier(parsed.departmentId, "departmentId") }
			: {}),
	};
}
