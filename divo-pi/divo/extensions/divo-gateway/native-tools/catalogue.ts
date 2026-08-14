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
 * Merge prompt-relevant provider-native input schemas into permanent Google
 * and Airtable wrappers. The outer tool identity, operations, guidance, and
 * handler remain Pi-owned; the provider description contributes only the
 * nested `input` object it is authoritative for.
 */
export function enrichGeneratedNativeToolCatalogue(
	host: TypedToolHost,
	invoke: TypedToolInvoker,
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
	const refreshed: string[] = [];
	for (const spec of GENERATED_NATIVE_TOOL_SPECS) {
		if (!changedToolIds.has(spec.toolId)) continue;
		const matching = [...cache.values()].filter(contract => contract.toolId === spec.toolId);
		const parameters = bindNativeContracts(
			spec.parameters as Record<string, unknown>,
			matching,
		);
		registerSpec(host, invoke, spec, parameters);
		refreshed.push(spec.name);
	}
	return refreshed;
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
