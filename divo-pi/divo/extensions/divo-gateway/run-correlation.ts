import { normalizeRuntimeChannel } from "../../runtime-channels.mjs";
import {
	DIVO_RUN_CONTEXT_PATH_ENV,
	readRuntimeRunContext,
} from "../../runtime-run-context.mjs";

export { DIVO_RUN_CONTEXT_PATH_ENV };

/** See `divo/runtime-channels.mjs` — absent means a desktop-local run. */
export type DivoRuntimeChannel = "lark" | "web";

export interface DivoRunCorrelationV1 {
	version: 1;
	threadId: string;
	runId: string;
	channel?: DivoRuntimeChannel;
	departmentId?: string;
}

/**
 * Read the exact runtime owner for this Pi process. Never cache.
 *
 * The file read and its bounds live at the runtime root, where every extension
 * that needs the run's identity can reach them. What this adds is the gateway's
 * own view of the result: a channel narrowed to one the runtime actually drives,
 * so a value nobody recognises cannot travel further as though it were a surface.
 */
export async function readDivoRunCorrelation(
	env: NodeJS.ProcessEnv = process.env,
): Promise<DivoRunCorrelationV1> {
	const context = await readRuntimeRunContext(env);
	const channel = normalizeRuntimeChannel(context.channel);
	return {
		version: 1,
		threadId: context.threadId,
		runId: context.runId,
		...(channel ? { channel } : {}),
		...(context.departmentId ? { departmentId: context.departmentId } : {}),
	};
}
