/**
 * What the model is allowed to see for one turn, decided once.
 *
 * Divo used to decide this twice. Retrieval chose a small tool set at the
 * `input` event, and provider-native contract enrichment re-registered Google
 * and Airtable wrappers later inside `before_agent_start`. The second decision
 * silently replaced the first: a measured turn planned 5 governed tools worth
 * 18,691 bytes and put 55 tools worth 148,048 bytes on the wire. Neither half
 * was wrong on its own. The defect was that there were two halves and nothing
 * compared them.
 *
 * So this module owns the plan and, just as importantly, owns checking that the
 * request matched it. `auditTurnSurface` is the invariant: whatever decides the
 * surface, the bytes that reach the provider have to be the bytes that were
 * planned. A drift is a bug in the planner or an unplanned mutation behind its
 * back, and both are worth failing loudly for.
 *
 * The plan governs Divo's own catalogue only. Pi's built-ins (`read`, `bash`)
 * are the harness's to expose, not Divo's, so they are outside the audit rather
 * than silently counted as drift.
 */

/** Governed tool schema bytes a turn may put on the wire before it is a defect. */
export const DEFAULT_MAX_TOOL_SCHEMA_BYTES = 65_536;

export interface TurnSurfaceLedger {
	/** Schema bytes for the governed tools the plan chose to show. */
	readonly plannedToolSchemaBytes: number;
	/** Schema bytes the plan deliberately withheld, recoverable through search. */
	readonly deferredToolSchemaBytes: number;
	readonly maxToolSchemaBytes: number;
}

export interface TurnSurfacePlan {
	readonly mode: "eager" | "retrieved";
	/** Every tool name this plan has authority over. */
	readonly governedToolNames: readonly string[];
	/** The governed tools the model may see this turn. */
	readonly visibleToolNames: readonly string[];
	readonly ledger: TurnSurfaceLedger;
}

/** The request as it actually left Pi, read at the last seam before the provider. */
export interface ObservedTurnSurface {
	readonly toolNames: readonly string[];
	readonly toolSchemaBytes: number;
	readonly systemPromptBytes: number;
	readonly messagesBytes: number;
}

export interface TurnSurfaceDrift {
	readonly withinPlan: boolean;
	/** Governed tools on the wire that the plan did not choose to show. */
	readonly unplannedToolNames: readonly string[];
	/** Governed tools the plan chose to show that never reached the wire. */
	readonly missingToolNames: readonly string[];
	readonly plannedToolSchemaBytes: number;
	readonly observedToolSchemaBytes: number;
	readonly overBudgetBytes: number;
	readonly reasons: readonly string[];
}

export interface TurnSurfaceEntry {
	readonly name: string;
	readonly schemaBytes: number;
}

/**
 * Build the plan for a turn from an already-made visibility decision.
 *
 * The decision arrives as names rather than being made here so that retrieval,
 * an explicit skill resolution, and the eager fallback all produce the same
 * shape of plan and are all held to the same ledger.
 */
export function planTurnSurface(input: {
	readonly mode: "eager" | "retrieved";
	readonly catalogue: readonly TurnSurfaceEntry[];
	readonly visibleToolNames: readonly string[];
	readonly maxToolSchemaBytes?: number;
}): TurnSurfacePlan {
	const governedToolNames = input.catalogue.map(entry => entry.name);
	const governed = new Set(governedToolNames);
	// Eager is still a plan, not an absence of one. Saying so keeps the ledger
	// meaningful on the fallback path, which is where bloat went unmeasured.
	const visible = input.mode === "eager"
		? governedToolNames
		: [...new Set(input.visibleToolNames)].filter(name => governed.has(name));
	const visibleSet = new Set(visible);

	let plannedToolSchemaBytes = 0;
	let deferredToolSchemaBytes = 0;
	for (const entry of input.catalogue) {
		if (visibleSet.has(entry.name)) plannedToolSchemaBytes += entry.schemaBytes;
		else deferredToolSchemaBytes += entry.schemaBytes;
	}

	return {
		mode: input.mode,
		governedToolNames,
		visibleToolNames: visible,
		ledger: {
			plannedToolSchemaBytes,
			deferredToolSchemaBytes,
			maxToolSchemaBytes: input.maxToolSchemaBytes ?? DEFAULT_MAX_TOOL_SCHEMA_BYTES,
		},
	};
}

/**
 * Compare the plan against the request that was actually sent.
 *
 * Byte drift and membership drift are reported separately because they fail for
 * different reasons. An unplanned tool name means something re-exposed a
 * capability behind the planner's back. Byte overrun with the planned membership
 * intact means a visible tool's schema grew after the plan was costed — which is
 * what provider-native contract binding does.
 */
export function auditTurnSurface(
	plan: TurnSurfacePlan,
	observed: ObservedTurnSurface,
): TurnSurfaceDrift {
	const governed = new Set(plan.governedToolNames);
	const visible = new Set(plan.visibleToolNames);
	const observedGoverned = observed.toolNames.filter(name => governed.has(name));

	const unplannedToolNames = [...new Set(observedGoverned.filter(name => !visible.has(name)))];
	const observedSet = new Set(observedGoverned);
	const missingToolNames = plan.visibleToolNames.filter(name => !observedSet.has(name));
	const overBudgetBytes = Math.max(
		0,
		observed.toolSchemaBytes - plan.ledger.maxToolSchemaBytes,
	);

	const reasons: string[] = [];
	if (unplannedToolNames.length > 0) {
		reasons.push(`${unplannedToolNames.length} governed tools reached the model outside the plan`);
	}
	if (missingToolNames.length > 0) {
		reasons.push(`${missingToolNames.length} planned tools never reached the model`);
	}
	if (overBudgetBytes > 0) {
		reasons.push(`tool schemas exceeded the turn budget by ${overBudgetBytes} bytes`);
	}

	return {
		withinPlan: reasons.length === 0,
		unplannedToolNames,
		missingToolNames,
		plannedToolSchemaBytes: plan.ledger.plannedToolSchemaBytes,
		observedToolSchemaBytes: observed.toolSchemaBytes,
		overBudgetBytes,
		reasons,
	};
}
