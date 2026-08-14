/**
 * Channels the backend drives a run on.
 *
 * An absent channel means the run was started locally on a desktop: nobody
 * outside owns a run id, a status card, or a per-run directory, so the runtime
 * skips all the bookkeeping that exists to serve a remote reader.
 *
 * Every check in this tree that reads a channel is asking that question — "did
 * the backend launch this run?" — and not "is this Lark?". They were written as
 * `channel === "lark"` only because Lark was the sole answer. Naming the real
 * question is what lets a second surface behave identically without a second
 * code path.
 */
export const RUNTIME_CHANNELS = Object.freeze(["lark", "web"]);

/**
 * @param {unknown} value
 * @returns {value is "lark" | "web"}
 */
export function isRuntimeChannel(value) {
	return typeof value === "string" && RUNTIME_CHANNELS.includes(value);
}

/**
 * Drop anything that is not a channel we drive, so an unknown string can never
 * be mistaken for one downstream.
 *
 * @param {unknown} value
 * @returns {"lark" | "web" | undefined}
 */
export function normalizeRuntimeChannel(value) {
	return isRuntimeChannel(value) ? value : undefined;
}
