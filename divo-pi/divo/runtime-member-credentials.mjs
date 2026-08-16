/**
 * The member's backend credentials, held where a tool can still reach them.
 *
 * The runtime hands Pi a backend URL and a member token in its environment, and
 * then the gateway **deletes the token from `process.env` on purpose** — every
 * bash and python process the agent spawns inherits that environment, and a
 * member token in it would be a live credential handed to model-authored code.
 *
 * So the value is captured into the Pi process itself before that delete, and
 * read from here afterwards. Extensions share one module instance; spawned
 * shells do not, which is the whole point.
 *
 * This module exists because that was previously the gateway's private
 * arrangement, and any other tool that needed to call the backend read
 * `process.env` at call time and found the token gone — an absence with no
 * explanation at the point it was discovered. One owner, several readers.
 */

const CAPTURED = Symbol.for("divo.member.credentials");

/**
 * @typedef {{ backendUrl: string, memberToken: string, defaultDepartmentId?: string }} MemberCredentials
 */

/** @param {NodeJS.ProcessEnv} env @returns {MemberCredentials | { error: string }} */
export function readMemberCredentials(env) {
	const backendUrl = env.DIVO_BACKEND_URL?.trim().replace(/\/$/, "");
	const memberToken = env.DIVO_MEMBER_TOKEN?.trim();
	const defaultDepartmentId = env.DIVO_DEPARTMENT_ID?.trim() || undefined;

	if (!backendUrl) {
		return {
			error:
				"Divo gateway is not configured: DIVO_BACKEND_URL is missing. Sign in through Divo first.",
		};
	}
	if (!memberToken) {
		return {
			error:
				"Divo gateway is not configured: DIVO_MEMBER_TOKEN is missing. Sign in through Divo first.",
		};
	}
	return { backendUrl, memberToken, defaultDepartmentId };
}

/** @returns {MemberCredentials | undefined} */
export function capturedMemberCredentials() {
	return globalThis[CAPTURED];
}

/**
 * Take the credentials out of the environment and hold them.
 *
 * Called with an explicit environment on every turn that carries a fresh token,
 * because a warm process outlives the lease it started with.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {MemberCredentials | { error: string }}
 */
export function captureMemberCredentials(env) {
	if (!env && capturedMemberCredentials()) return capturedMemberCredentials();
	const resolved = readMemberCredentials(env ?? process.env);
	if ("error" in resolved) return resolved;
	globalThis[CAPTURED] = resolved;
	return resolved;
}

/**
 * What this run may call the backend with.
 *
 * An explicit environment wins, so a caller testing a specific environment gets
 * exactly that. Otherwise the captured value comes first and `process.env` is
 * the fallback — which is the order that matters, because by the time most tools
 * run, the environment no longer holds the token.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {MemberCredentials | { error: string }}
 */
export function resolveMemberCredentials(env) {
	if (env) return readMemberCredentials(env);
	const captured = capturedMemberCredentials();
	if (captured) return captured;
	return readMemberCredentials(process.env);
}

/** Test/lifecycle helper. Never use this to rotate a live Divo session. */
export function clearCapturedMemberCredentials() {
	delete globalThis[CAPTURED];
}
