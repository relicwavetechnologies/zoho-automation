/**
 * One rule: a governed tool call is authorized by a DB skill loaded in the
 * same run, and the backend is told which skill that was.
 *
 * There are two ways into the gateway from inside the container — the
 * `divo_gateway` tool the model calls directly, and the `divo-local` CLI a
 * script runs over the broker socket. Both reach the same backend, so both
 * must apply this. When only the tool path did, every scripted `tools.invoke`
 * arrived without a `skillId` and the backend rejected it outright: the whole
 * scripted-workflow path was unusable while looking merely mis-documented.
 *
 * The caller cannot supply its own `skillId`. It is read from what was
 * actually loaded, because letting a caller assert its own authorization is
 * precisely what this gate exists to stop.
 */

export interface LoadedSkillRef {
	readonly runId: string;
	readonly skillId: string;
}

/** Resolves the skill that registered a tool, if one did. */
export type LoadedSkillLookup = (toolId: string) => LoadedSkillRef | undefined;

export type SkillAuthorization =
	| { readonly ok: true; readonly skillId: string }
	| { readonly ok: false; readonly message: string };

const GENERAL_REFUSAL =
	"Exact company skill required. Load the relevant DB skill with divo_skill_view, then retry this tool call.";
const SCHEDULING_REFUSAL =
	"Scheduling recipe required. Load the exact Schedule Divo Work skillId from the injected catalogue with divo_skill_view, then retry.";

/**
 * Decides whether a `tools.invoke` may proceed, and under which skill.
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
	// A caller that wired no registry has loaded nothing, which is a refusal
	// rather than an error: an authorization gate must fail closed.
	const lookup = typeof input.lookup === "function" ? input.lookup : () => undefined;
	const loaded = toolId ? lookup(toolId) : undefined;

	// The run has to match: a skill loaded during an earlier turn says nothing
	// about what this one is allowed to do.
	if (!toolId || !loaded || loaded.runId !== input.runId) {
		return { ok: false, message: input.scheduling ? SCHEDULING_REFUSAL : GENERAL_REFUSAL };
	}
	return { ok: true, skillId: loaded.skillId };
}
