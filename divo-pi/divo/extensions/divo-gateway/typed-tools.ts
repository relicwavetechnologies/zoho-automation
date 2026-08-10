import type { WorkBootstrap } from "./work-bootstrap.ts";

/**
 * Typed tool surface.
 *
 * The backend already publishes a JSON Schema for every governed tool. Today
 * that schema is stringified into the system prompt and the model reproduces
 * it by hand. Here it becomes the `parameters` of a real Pi tool, so Pi
 * validates the call inside the container and the provider constrains
 * generation against the same shape.
 *
 * This module only builds definitions. Registration and execution are injected
 * so the mapping stays pure and testable, and so the gateway keeps its single
 * execution, approval, and audit path.
 *
 * Pi validates; the backend still authorizes. Nothing here grants access.
 */

/** Prefix keeps typed tools clearly Divo-owned and free of Pi built-in collisions. */
const TOOL_NAME_PREFIX = "divo_";

/** Root must be an object schema — a tool call's arguments are always a record. */
const REQUIRED_ROOT_TYPE = "object";

/**
 * Annotation-only keys carried by `zod-to-json-schema` output. They cost tokens
 * in every request and mean nothing to a tool-parameter schema.
 */
const STRIPPED_ROOT_KEYS = ["$schema", "$id", "title"] as const;

export interface TypedToolDefinition {
	name: string;
	toolId: string;
	family: string;
	label: string;
	description: string;
	promptGuidelines: string[];
	parameters: Record<string, unknown>;
	allowedActions: string[];
	/** True when the department exposes the tool but this member may not call it. */
	denied: boolean;
	/** "parallel" only where every reachable action is a read. */
	executionMode: "parallel" | "sequential";
}

/**
 * Concurrency is decided per tool, and Pi has no per-call hook to decide it
 * later, so the answer has to hold for every call the member could make.
 *
 * A tool is safe to run concurrently only when reading is the sole thing this
 * member can do through it. `zohoBooks` with read and create is sequential even
 * for a read, because the same tool could issue the write — two invoices
 * created at once is how duplicates happen. `webSearch` or a read-only Shopify
 * grant has no such branch, so three pages can be fetched in one wait.
 */
export function executionModeFor(allowedActions: readonly string[]): "parallel" | "sequential" {
	return allowedActions.length > 0 && allowedActions.every((action) => action === "read")
		? "parallel"
		: "sequential";
}

export interface TypedToolBuildResult {
	tools: TypedToolDefinition[];
	/** Tool IDs skipped, with the reason, so a silent drop never looks like absence. */
	rejected: Array<{ toolId: string; reason: string }>;
}

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
	const property = isRecord(value) ? { ...value } : { type: "string" };
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

function exactNativeCallBranch(
	branch: Record<string, unknown>,
	contract: WorkBootstrap["nativeContracts"][number],
): Record<string, unknown> | undefined {
	if (!isRecord(contract.inputSchema) || JSON.stringify(contract.inputSchema).includes("\"$ref\"")) return undefined;
	const properties = isRecord(branch.properties) ? { ...branch.properties } : undefined;
	if (!properties) return undefined;
	properties.op = literalProperty(properties.op, "call");
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
	const remaining = values.filter((value) => !preloaded.has(value));
	if (remaining.length === 0) return undefined;
	const properties = { ...(branch.properties as Record<string, unknown>) };
	properties.nativeTool = { ...(properties.nativeTool as Record<string, unknown>), enum: remaining };
	return { ...branch, properties };
}

function operationIncludes(branch: Record<string, unknown>, operation: string): boolean {
	if (!isRecord(branch.properties) || !isRecord(branch.properties.op)) return false;
	return branch.properties.op.const === operation
		|| (Array.isArray(branch.properties.op.enum) && branch.properties.op.enum.includes(operation));
}

/** Binds preloaded native input contracts into the parent tool Pi already exposes. */
export function bindNativeContracts(
	schema: Record<string, unknown>,
	contracts: readonly WorkBootstrap["nativeContracts"][number][],
): Record<string, unknown> {
	if (contracts.length === 0) return schema;
	const branches = Array.isArray(schema.anyOf) ? schema.anyOf.filter(isRecord) : [schema];
	const callBranches = branches.filter(branch => operationIncludes(branch, "call"));
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
		if (!operationIncludes(branch, "call")) return [branch];
		const fallback = genericNativeCallBranch(branch, preloaded);
		return fallback ? [fallback] : [];
	});
	return { ...schema, anyOf: [...preserved, ...exact] };
}

function hasNativeOperationWrapper(schema: Record<string, unknown>): boolean {
	const branches = Array.isArray(schema.anyOf) ? schema.anyOf : [schema];
	return branches.some((value) => {
		if (!isRecord(value) || !isRecord(value.properties)) return false;
		const op = value.properties.op;
		return isRecord(op)
			&& (op.const === "describe" || (Array.isArray(op.enum) && op.enum.includes("describe")))
			&& isRecord(value.properties.nativeTool);
	});
}

/**
 * Accepts the backend schema or explains why it cannot be used. A schema that
 * cannot be trusted must not become a tool, because a tool with a wrong
 * contract is worse than no tool: the model would satisfy Pi and still be
 * rejected by the backend.
 */
export function sanitizeSchema(
	value: unknown,
): { schema: Record<string, unknown> } | { error: string } {
	if (!isRecord(value)) {
		return { error: "args schema is not an object" };
	}
	const objectRoot = value.type === REQUIRED_ROOT_TYPE && isRecord(value.properties);
	const unionRoot = Array.isArray(value.anyOf)
		&& value.anyOf.length > 0
		&& value.anyOf.every((branch) =>
			isRecord(branch)
			&& branch.type === REQUIRED_ROOT_TYPE
			&& isRecord(branch.properties));
	if (!objectRoot && !unionRoot) {
		if (value.type === REQUIRED_ROOT_TYPE) {
			return { error: "args schema has no properties object" };
		}
		return { error: "args schema root must be an object or an anyOf union of objects" };
	}
	// `$refStrategy: 'none'` is what the backend serializer passes, so a
	// surviving reference means the contract is not self-contained and the model
	// would be shown a shape it cannot satisfy.
	if (JSON.stringify(value).includes("\"$ref\"")) {
		return { error: "args schema contains an unresolved $ref" };
	}
	const schema: Record<string, unknown> = { ...value };
	// Model function APIs require an object root even though JSON Schema permits
	// an object-only discriminated union to express that fact through `anyOf`.
	// Keep the branches intact for validation and add only the equivalent root
	// annotation the provider requires.
	if (unionRoot) schema.type = REQUIRED_ROOT_TYPE;
	for (const key of STRIPPED_ROOT_KEYS) delete schema[key];
	return { schema };
}

/**
 * Splits backend parameter documentation into per-tool guideline bullets.
 * Pi appends these only while the tool is active, so guidance that lives here
 * costs nothing on turns that never touch the tool.
 */
export function guidelinesFromParameterDocs(parameterDocs: string): string[] {
	return parameterDocs
		.split(/\r?\n/)
		.map((line) => line.replace(/^\s*[-*•]\s*/, "").trim())
		.filter((line) => line.length > 0);
}

function describeDenial(tool: WorkBootstrap["tools"][number]): string {
	return [
		`${tool.id} exists for this department but is not permitted for you.`,
		"This is a permission decision, not a missing capability — a company admin can grant it.",
		"Report it plainly and do not substitute another route to achieve the same effect.",
	].join(" ");
}

/**
 * Builds one typed tool per bootstrap entry.
 *
 * A tool with no allowed actions is still registered, as an explicit denial.
 * Removing it instead would make the capability *absent*, and an absent tool is
 * what makes the model invent confident, wrong reasons for why it cannot act.
 */
export function buildTypedTools(bootstrap: WorkBootstrap): TypedToolBuildResult {
	const tools: TypedToolDefinition[] = [];
	const rejected: Array<{ toolId: string; reason: string }> = [];
	const claimed = new Set<string>();

	for (const tool of bootstrap.tools) {
		const name = typedToolName(tool.id);
		if (claimed.has(name)) {
			rejected.push({ toolId: tool.id, reason: `duplicate typed tool name ${name}` });
			continue;
		}
		const matchingNativeContracts = bootstrap.nativeContracts.filter(contract => contract.toolId === tool.id);
		const enrichedSchema = isRecord(tool.argsSchema)
			? bindNativeContracts(tool.argsSchema, matchingNativeContracts)
			: tool.argsSchema;
		const sanitized = sanitizeSchema(enrichedSchema);
		if ("error" in sanitized) {
			rejected.push({ toolId: tool.id, reason: sanitized.error });
			continue;
		}
		claimed.add(name);
		const denied = tool.allowedActions.length === 0;
		const promptGuidelines = denied
			? [describeDenial(tool)]
			: guidelinesFromParameterDocs(tool.parameterDocs);
		if (!denied && hasNativeOperationWrapper(sanitized.schema)) {
			promptGuidelines.push(
				"Never guess or probe nativeTool names. Use the exact operation named by the matching Pi skill or an unambiguous schema entry; otherwise read that skill, then ask one focused clarification if the operation is still unclear. Describe that exact operation at most once and use the returned field names.",
			);
		}
		tools.push({
			name,
			toolId: tool.id,
			family: tool.family,
			label: `Divo ${tool.id}`,
			description: denied ? describeDenial(tool) : tool.description,
			promptGuidelines,
			parameters: sanitized.schema,
			allowedActions: [...tool.allowedActions],
			denied,
			executionMode: executionModeFor(tool.allowedActions),
		});
	}

	return { tools, rejected };
}
