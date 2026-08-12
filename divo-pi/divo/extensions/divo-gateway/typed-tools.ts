import type { WorkBootstrap } from "./work-bootstrap.ts";

/** Prefix keeps governed tools Divo-owned and free of Pi built-in collisions. */
const TOOL_NAME_PREFIX = "divo_";

/** `zohoBooks` -> `divo_zoho_books`. Stable, lowercase, and collision-free. */
export function typedToolName(toolId: string): string {
	const snake = toolId
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/[^a-zA-Z0-9]+/g, "_")
		.toLowerCase()
		.replace(/^_+|_+$/g, "");
	return `${TOOL_NAME_PREFIX}${snake}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function literalProperty(value: unknown, literal: string, description?: string): Record<string, unknown> {
	const property: Record<string, unknown> = isRecord(value) ? { ...value } : { type: "string" };
	delete property.enum;
	property.const = literal;
	if (description) property.description = description;
	return property;
}

function nativeToolValues(branch: Record<string, unknown>): string[] | undefined {
	if (!isRecord(branch.properties)) return undefined;
	const nativeTool = branch.properties.nativeTool;
	if (!isRecord(nativeTool)) return undefined;
	if (typeof nativeTool.const === "string") return [nativeTool.const];
	if (!Array.isArray(nativeTool.enum)) return undefined;
	return nativeTool.enum.filter((value): value is string => typeof value === "string");
}

function operationIncludes(branch: Record<string, unknown>, operation: string): boolean {
	if (!isRecord(branch.properties) || !isRecord(branch.properties.op)) return false;
	return branch.properties.op.const === operation
		|| (Array.isArray(branch.properties.op.enum) && branch.properties.op.enum.includes(operation));
}

function exactNativeCallBranch(
	branch: Record<string, unknown>,
	contract: WorkBootstrap["nativeContracts"][number],
): Record<string, unknown> | undefined {
	if (!isRecord(contract.inputSchema) || JSON.stringify(contract.inputSchema).includes("\"$ref\"")) return undefined;
	const properties = isRecord(branch.properties) ? { ...branch.properties } : undefined;
	if (!properties) return undefined;
	const operation = ["call", "call_resolved_sheet"].find(value => operationIncludes(branch, value));
	if (!operation) return undefined;
	properties.op = literalProperty(properties.op, operation);
	properties.nativeTool = literalProperty(properties.nativeTool, contract.nativeTool, contract.description);
	properties.input = contract.inputSchema;
	return {
		...branch,
		properties,
		required: [...new Set([
			...(Array.isArray(branch.required) ? branch.required.filter((value): value is string => typeof value === "string") : []),
			"op",
			"nativeTool",
			"input",
		])],
	};
}

function genericNativeCallBranch(
	branch: Record<string, unknown>,
	preloaded: ReadonlySet<string>,
): Record<string, unknown> | undefined {
	const values = nativeToolValues(branch);
	if (!values) return branch;
	const remaining = values.filter(value => !preloaded.has(value));
	if (remaining.length === 0) return undefined;
	const properties = { ...(branch.properties as Record<string, unknown>) };
	properties.nativeTool = { ...(properties.nativeTool as Record<string, unknown>), enum: remaining };
	return { ...branch, properties };
}

/**
 * Bind provider-authoritative nested inputs into a permanent Pi-owned wrapper.
 * Only Google/Airtable call branches have this shape. The outer tool identity,
 * operation allowlist, handler, and policy guidance never come from bootstrap.
 */
export function bindNativeContracts(
	schema: Record<string, unknown>,
	contracts: readonly WorkBootstrap["nativeContracts"][number][],
): Record<string, unknown> {
	if (contracts.length === 0) return schema;
	const branches = Array.isArray(schema.anyOf) ? schema.anyOf.filter(isRecord) : [schema];
	const callBranches = branches.filter(branch =>
		operationIncludes(branch, "call") || operationIncludes(branch, "call_resolved_sheet"));
	if (callBranches.length === 0) return schema;
	const preloaded = new Set(contracts.map(contract => contract.nativeTool));
	const exact = callBranches.flatMap(branch => contracts.flatMap(contract => {
		const branchValues = nativeToolValues(branch);
		if (branchValues && !branchValues.includes(contract.nativeTool)) return [];
		const bound = exactNativeCallBranch(branch, contract);
		return bound ? [bound] : [];
	}));
	if (exact.length === 0) return schema;
	const preserved = branches.flatMap(branch => {
		if (!operationIncludes(branch, "call") && !operationIncludes(branch, "call_resolved_sheet")) return [branch];
		const fallback = genericNativeCallBranch(branch, preloaded);
		return fallback ? [fallback] : [];
	});
	return { ...schema, anyOf: [...preserved, ...exact] };
}
