/**
 * A loaded DB skill is advisory provenance for a governed tool call.
 *
 * There are two ways into the gateway from inside the container — the
 * `divo_gateway` tool the model calls directly, and the `divo-local` CLI a
 * script runs over the broker socket. Both reach the same backend, so both
 * apply this consistently. Missing or stale skill guidance must not create a
 * second authorization system: the backend still owns RBAC, connection access,
 * validation, and approval policy.
 *
 * The caller cannot supply its own `skillId`. When present, it is read from
 * what was actually loaded so audit provenance cannot be forged.
 */

export interface LoadedSkillRef {
	readonly runId: string;
	readonly skillId: string;
}

/** Resolves the skill that registered a tool, if one did. */
export type LoadedSkillLookup = (toolId: string) => LoadedSkillRef | undefined;

export type SkillAuthorization =
	| { readonly ok: true; readonly skillId?: string }
	| { readonly ok: false; readonly message: string };

/**
 * Resolves advisory skill provenance for a `tools.invoke`.
 *
 * Returns `null` for any other op — reads such as `tools.list` carry no
 * execution authority and are not gated here.
 */
export function authorizeToolInvocation(input: {
	readonly op: string;
	readonly toolId: unknown;
	readonly runId: string;
	readonly lookup: LoadedSkillLookup;
	readonly scheduling: boolean;
}): SkillAuthorization | null {
	if (input.op !== "tools.invoke") return null;

	const toolId = typeof input.toolId === "string" ? input.toolId : undefined;
	const lookup = typeof input.lookup === "function" ? input.lookup : () => undefined;
	const loaded = toolId ? lookup(toolId) : undefined;

	if (!toolId || !loaded || loaded.runId !== input.runId) {
		return { ok: true };
	}
	return { ok: true, skillId: loaded.skillId };
}
