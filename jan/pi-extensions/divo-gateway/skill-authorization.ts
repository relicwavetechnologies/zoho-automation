/** A current-run loaded skill is the local provenance binding for company work. */
export interface LoadedSkillRef {
	readonly runId: string;
	readonly skillId: string;
}

export type LoadedSkillLookup = (toolId: string) => LoadedSkillRef | undefined;

export type SkillAuthorization =
	| { readonly ok: true; readonly skillId?: string }
	| { readonly ok: false; readonly message: string };

/**
 * Require the exact skill that registered a governed tool in this run.
 * Backend identity, RBAC, connection access, validation, and HITL remain the
 * execution authority; this binding prevents the local broker from bypassing
 * the same recipe provenance enforced by the direct gateway tool.
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
	const loaded = toolId ? input.lookup(toolId) : undefined;
	if (!toolId || !loaded || loaded.runId !== input.runId) {
		return {
			ok: false,
			message: input.scheduling
				? "Scheduling recipe required. Load the exact Schedule Divo Work skillId from the injected catalogue with divo_skill_view, then retry."
				: "Exact company skill required. Load the relevant DB skill with divo_skill_view, then retry this tool call.",
		};
	}
	return { ok: true, skillId: loaded.skillId };
}
