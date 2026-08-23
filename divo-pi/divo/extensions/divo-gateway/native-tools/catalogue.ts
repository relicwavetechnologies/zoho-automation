import type {
	TypedToolHost,
	TypedToolInvoker,
} from "../typed-tool-runtime.ts";
import type { WorkBootstrap } from "../work-bootstrap.ts";
import { bindNativeContracts } from "../typed-tools.ts";
import { GENERATED_NATIVE_TOOL_SPECS } from "./generated/index.ts";
import type { NativeToolSpec } from "./catalogue-contract.ts";

export interface NativeCatalogueRegistration {
	readonly registered: string[];
	readonly toolIds: string[];
}

export type NativeContract = WorkBootstrap["nativeContracts"][number];
export type NativeContractCache = Map<string, NativeContract>;
export type NativeContractCoverage = Set<string>;

const EMPTY_CONTRACT_SIGNATURE = "[]";

const PROVIDER_NATIVE_CONTRACT_TOOL_IDS = new Set([
	"airtableBase",
	"airtableRecords",
	"googleCalendar",
	"googleDocs",
	"googleDrive",
	"googleGmail",
	"googleSheets",
]);

/** Keep provider schema preload away from tools whose outer contract is complete. */
export function providerNativeContractToolIds(toolIds: readonly string[]): string[] {
	return [...new Set(toolIds.filter(toolId => PROVIDER_NATIVE_CONTRACT_TOOL_IDS.has(toolId)))];
}

export function missingCompleteNativeContractToolIds(
	toolIds: readonly string[],
	coverage: NativeContractCoverage,
): string[] {
	return providerNativeContractToolIds(toolIds).filter(toolId => !coverage.has(toolId));
}

export function markCompleteNativeContractCoverage(
	contracts: readonly NativeContract[],
	coverage: NativeContractCoverage,
): string[] {
	const added: string[] = [];
	for (const contract of contracts) {
		if (coverage.has(contract.toolId)) continue;
		coverage.add(contract.toolId);
		added.push(contract.toolId);
	}
	return added;
}

/** Register one permanent Pi definition per generated backend capability. */
export function registerGeneratedNativeToolCatalogue(
	host: TypedToolHost,
	invoke: TypedToolInvoker,
): NativeCatalogueRegistration {
	const names = new Set<string>();
	const toolIds = new Set<string>();
	for (const spec of GENERATED_NATIVE_TOOL_SPECS) {
		assertUnique(spec, names, toolIds);
		registerSpec(host, invoke, spec, spec.parameters as Record<string, unknown>);
	}
	return { registered: [...names], toolIds: [...toolIds] };
}

/**
 * Record provider-native contracts without touching what the model can see.
 *
 * Caching and binding used to be one call, which made "we now know Gmail's
 * exact schema" and "the model's Gmail tool just changed" the same event. They
 * are not: the first is internal knowledge the backend is authoritative for,
 * the second is a model-visible mutation that has to happen where the turn's
 * surface is decided. Keeping them apart is what lets a runtime cache a
 * complete contract bundle without paying for it on every request.
 *
 * Returns the backend tool IDs whose cached contracts actually changed.
 */
export function cacheNativeContracts(
	contracts: readonly NativeContract[],
	cache: NativeContractCache,
): string[] {
	const changedToolIds = new Set<string>();
	for (const contract of contracts) {
		const key = `${contract.toolId}\u0000${contract.nativeTool}`;
		const previous = cache.get(key);
		if (JSON.stringify(previous) === JSON.stringify(contract)) continue;
		cache.set(key, contract);
		changedToolIds.add(contract.toolId);
	}
	return [...changedToolIds];
}

/**
 * Merge the given provider-native input schemas into permanent Google and
 * Airtable wrappers. The outer tool identity, operations, guidance, and handler
 * remain Pi-owned; the provider description contributes only the nested `input`
 * object it is authoritative for.
 *
 * The contracts to bind are an argument rather than a cache lookup. Everything
 * the runtime knows is not everything the model should be shown, and reading
 * the cache here would have made those the same set — which is how a single
 * selected Google tool came to carry every operation its provider offers.
 * Unbound operations keep their describe-then-call branch, so nothing becomes
 * unreachable by being left out.
 *
 * This registers, so it changes the model-visible surface. Call it before the
 * turn's surface is applied, never after: registration re-expands Pi's active
 * tool set, which silently discards a narrower plan.
 */
export class NativeContractBindings {
	private readonly signatures = new Map<string, string>();
	private readonly host: TypedToolHost;
	private readonly invoke: TypedToolInvoker;

	constructor(
		host: TypedToolHost,
		invoke: TypedToolInvoker,
		initiallyBaseToolIds: readonly string[] = [],
	) {
		this.host = host;
		this.invoke = invoke;
		for (const toolId of providerNativeContractToolIds(initiallyBaseToolIds)) {
			this.signatures.set(toolId, EMPTY_CONTRACT_SIGNATURE);
		}
	}

	/**
	 * Reconcile the exact provider schemas visible on this turn.
	 *
	 * This module owns the model-visible binding state. It resets a previously
	 * enriched wrapper when a later prompt selects no exact operation, and it
	 * skips registration when the selected contracts are byte-for-byte
	 * unchanged. The durable cache remains knowledge only; it cannot leak a
	 * previous turn's selection into a later model payload.
	 */
	reconcile(
		toolIds: readonly string[],
		contracts: readonly NativeContract[],
	): string[] {
		const targets = new Set([
			...providerNativeContractToolIds(toolIds),
			...[...this.signatures]
				.filter(([, signature]) => signature !== EMPTY_CONTRACT_SIGNATURE)
				.map(([toolId]) => toolId),
		]);
		if (targets.size === 0) return [];

		const byToolId = new Map<string, NativeContract[]>();
		for (const contract of contracts) {
			if (!targets.has(contract.toolId)) continue;
			const existing = byToolId.get(contract.toolId);
			if (existing) existing.push(contract);
			else byToolId.set(contract.toolId, [contract]);
		}

		const refreshed: string[] = [];
		for (const spec of GENERATED_NATIVE_TOOL_SPECS) {
			if (!targets.has(spec.toolId)) continue;
			const matching = [...(byToolId.get(spec.toolId) ?? [])]
				.sort((left, right) => left.nativeTool.localeCompare(right.nativeTool));
			const signature = JSON.stringify(matching);
			if (this.signatures.get(spec.toolId) === signature) continue;

			const parameters = bindNativeContracts(
				spec.parameters as Record<string, unknown>,
				matching,
			);
			registerSpec(this.host, this.invoke, spec, parameters);
			this.signatures.set(spec.toolId, signature);
			refreshed.push(spec.name);
		}
		return refreshed;
	}
}

function registerSpec(
	host: TypedToolHost,
	invoke: TypedToolInvoker,
	spec: NativeToolSpec,
	parameters: Record<string, unknown>,
): void {
	host.registerTool({
		name: spec.name,
		label: spec.label,
		description: spec.description,
		promptSnippet: spec.promptSnippet,
		promptGuidelines: [...spec.promptGuidelines],
		parameters,
		executionMode: spec.executionMode,
		execute: (toolCallId, params, _signal, _onUpdate, ctx) =>
			invoke({ toolId: spec.toolId, args: params, toolCallId }, ctx),
	});
}

function assertUnique(
	spec: NativeToolSpec,
	names: Set<string>,
	toolIds: Set<string>,
): void {
	if (names.has(spec.name)) {
		throw new Error(`Duplicate Pi-native tool name: ${spec.name}`);
	}
	if (toolIds.has(spec.toolId)) {
		throw new Error(`Duplicate Pi-native backend tool ID: ${spec.toolId}`);
	}
	names.add(spec.name);
	toolIds.add(spec.toolId);
}
