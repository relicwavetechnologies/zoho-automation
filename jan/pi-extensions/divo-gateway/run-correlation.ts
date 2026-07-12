import { readFile } from "node:fs/promises";

export const DIVO_RUN_CONTEXT_PATH_ENV = "DIVO_RUN_CONTEXT_PATH";

export interface DivoRunCorrelationV1 {
	version: 1;
	threadId: string;
	runId: string;
}

const MAX_IDENTIFIER_LENGTH = 200;

function identifier(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`Divo run correlation ${field} is missing`);
	}
	const result = value.trim();
	if (result.length > MAX_IDENTIFIER_LENGTH) {
		throw new Error(`Divo run correlation ${field} is too long`);
	}
	return result;
}

/** Read the exact desktop owner for this persistent Pi process. Never cache. */
export async function readDivoRunCorrelation(
	env: NodeJS.ProcessEnv = process.env,
): Promise<DivoRunCorrelationV1> {
	const path = env[DIVO_RUN_CONTEXT_PATH_ENV]?.trim();
	if (!path) throw new Error("Divo run correlation is unavailable");
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(path, "utf8"));
	} catch {
		throw new Error("Divo run correlation could not be read");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Divo run correlation is malformed");
	}
	const record = parsed as Record<string, unknown>;
	if (record.version !== 1) {
		throw new Error("Divo run correlation version is unsupported");
	}
	return {
		version: 1,
		threadId: identifier(record.threadId, "threadId"),
		runId: identifier(record.runId, "runId"),
	};
}
