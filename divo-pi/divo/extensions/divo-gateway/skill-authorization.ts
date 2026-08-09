/**
 * A loaded DB skill is the local provenance binding for a governed tool call.
 *
 * There are two ways into the gateway from inside the container — the
 * `divo_gateway` tool the model calls directly, and the `divo-local` CLI a
 * script runs over the broker socket. Both reach the same backend, so both
 * attach the same trusted provenance when a recipe was loaded. Missing skill
 * guidance does not stop an ordinary call; the backend still owns identity,
 * RBAC, connection access, validation, and approval policy.
 *
 * The caller cannot supply its own `skillId`. When present, it is read from
 * what was actually loaded so audit provenance cannot be forged.
 *
 * The binding lasts as long as the container. It used to last a single run,
 * which meant every new message threw the binding away and the model had to
 * re-load a recipe it already had — one rejected call plus one redundant fetch
 * per turn, teaching it to pay the tax preemptively. Nothing was gained: the
 * backend re-resolves RBAC on every call, so this ledger is provenance, not a
 * permission boundary, and provenance does not expire when someone speaks
 * again. Staleness is bounded by the container's own idle lifetime, which is
 * the same window everything else in here already accepts.
 */

export interface LoadedSkillRef {
	readonly skillId: string;
}

/** Resolves the skill that registered a tool, if one did. */
export type LoadedSkillLookup = (toolId: string) => LoadedSkillRef | undefined;

export type SkillAuthorization =
	| { readonly ok: true; readonly skillId?: string }
	| { readonly ok: false; readonly message: string };

/**
 * Resolves the loaded skill binding for a `tools.invoke`.
 *
 * Returns `null` for any other op — reads such as `tools.list` carry no
 * execution authority and are not gated here.
 */
export function authorizeToolInvocation(input: {
	readonly op: string;
	readonly toolId: unknown;
	readonly lookup: LoadedSkillLookup;
}): SkillAuthorization | null {
	if (input.op !== "tools.invoke") return null;

	const toolId = typeof input.toolId === "string" ? input.toolId : undefined;
	const lookup = typeof input.lookup === "function" ? input.lookup : () => undefined;
	const loaded = toolId ? lookup(toolId) : undefined;

	if (!toolId || !loaded) return null;
	return { ok: true, skillId: loaded.skillId };
}
