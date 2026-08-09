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
	if (value.type !== REQUIRED_ROOT_TYPE) {
		return { error: `args schema root type must be "${REQUIRED_ROOT_TYPE}", got ${JSON.stringify(value.type)}` };
	}
	if (!isRecord(value.properties)) {
		return { error: "args schema has no properties object" };
	}
	// `$refStrategy: 'none'` is what the backend serializer passes, so a
	// surviving reference means the contract is not self-contained and the model
	// would be shown a shape it cannot satisfy.
	if (JSON.stringify(value).includes("\"$ref\"")) {
		return { error: "args schema contains an unresolved $ref" };
	}
	const schema: Record<string, unknown> = { ...value };
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
		const sanitized = sanitizeSchema(tool.argsSchema);
		if ("error" in sanitized) {
			rejected.push({ toolId: tool.id, reason: sanitized.error });
			continue;
		}
		claimed.add(name);
		const denied = tool.allowedActions.length === 0;
		tools.push({
			name,
			toolId: tool.id,
			family: tool.family,
			label: `Divo ${tool.id}`,
			description: denied ? describeDenial(tool) : tool.description,
			promptGuidelines: denied ? [describeDenial(tool)] : guidelinesFromParameterDocs(tool.parameterDocs),
			parameters: sanitized.schema,
			allowedActions: [...tool.allowedActions],
			denied,
		});
	}

	return { tools, rejected };
}
