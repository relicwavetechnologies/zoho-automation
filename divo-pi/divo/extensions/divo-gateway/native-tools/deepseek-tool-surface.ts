import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { GENERATED_NATIVE_TOOL_SPECS } from "./generated/index.ts";

export const DIVO_DEEPSEEK_TOOL_SURFACE_ENV = "DIVO_DEEPSEEK_TOOL_SURFACE";
export const DIVO_TOOL_SEARCH_NAME = "divo_tool_search";

const PRESELECT_LIMIT = 5;
const SEARCH_LIMIT = 6;
const ALWAYS_EAGER_TOOL_IDS = new Set(["webSearch", "knowledge"]);
const DEEPSEEK_MODELS = new Set(["deepseek-v4-flash", "deepseek-v4-pro"]);

/**
 * These are search vocabulary, not execution aliases. They improve recall for
 * ordinary user words that do not occur in a product's proper name. The exact
 * generated tool identity and backend policy remain authoritative.
 */
const DISCOVERY_TERMS: Readonly<Record<string, readonly string[]>> = {
	googleGmail: ["email", "mail", "inbox"],
	googleSheets: ["spreadsheet", "excel", "workbook", "csv"],
	googleDocs: ["document", "word document"],
	googleSlides: ["presentation", "powerpoint", "ppt", "deck"],
	googleCalendar: ["calendar", "schedule", "appointment", "availability"],
	googleTasks: ["task", "todo", "to do"],
	larkMessaging: ["message", "chat", "dm", "direct message"],
	larkCalendar: ["calendar", "schedule", "appointment", "availability"],
	larkTask: ["task", "todo", "to do"],
	larkDoc: ["document", "wiki", "drive file"],
	larkBase: ["database", "table", "records", "bitable"],
	zohoCrm: ["crm", "lead", "deal", "pipeline"],
	zohoBooks: ["invoice", "bill", "expense", "payment", "purchase order", "accounting"],
	shopifyAnalytics: ["store sales", "revenue", "inventory", "attribution"],
	shopifyOrders: ["store order", "order"],
	shopifyCustomers: ["store customer", "customer"],
	mailAutomations: ["inbox rule", "mail automation", "whenever", "future arrivals"],
	scheduledWorkflows: ["recurring", "daily", "weekly", "monthly", "schedule automation"],
};

const STOP_WORDS = new Set([
	"a", "an", "and", "are", "can", "check", "could", "create", "delete", "do", "find", "for",
	"company", "from", "get", "help", "i", "in", "is", "it", "list", "make", "manage", "me", "my",
	"of", "on", "our", "please", "prepare", "read", "run", "search", "show", "something", "system",
	"the", "thing", "to", "update", "use", "want", "with", "work", "would", "you",
]);

export interface DeepSeekToolCatalogEntry {
	readonly toolId: string;
	readonly name: string;
	readonly family: string;
	readonly description: string;
	readonly promptGuidelines: readonly string[];
	readonly schemaBytes: number;
	readonly tokens: readonly string[];
}

export interface DeepSeekToolMatch {
	readonly toolId: string;
	readonly name: string;
	readonly family: string;
	readonly description: string;
	readonly promptGuidelines: readonly string[];
	readonly schemaBytes: number;
	readonly score: number;
}

export interface DeepSeekToolSurfaceSelection {
	readonly mode: "eager" | "retrieved";
	readonly selectedToolIds: readonly string[];
	readonly selectedToolNames: readonly string[];
	readonly selectedSchemaBytes: number;
	readonly deferredSchemaBytes: number;
}

export interface DeepSeekToolSurface {
	prepareTurn(input: {
		readonly prompt: string;
		readonly model?: { readonly id?: unknown; readonly api?: unknown };
		readonly allowedToolIds?: readonly string[];
	}): DeepSeekToolSurfaceSelection;
	activateToolIds(toolIds: readonly string[]): string[];
	currentSelection(): DeepSeekToolSurfaceSelection;
}

export interface DeepSeekProviderPayloadSummary {
	readonly toolCount: number;
	readonly toolSchemaBytes: number;
	readonly systemPromptBytes: number;
	readonly messagesBytes: number;
}

/** Reuse the same retrieval decision for provider-native schema preloading. */
export function toolIdsForDeepSeekPreload(
	permittedToolIds: readonly string[],
	selection: DeepSeekToolSurfaceSelection,
): string[] {
	if (selection.mode === "eager") return [...permittedToolIds];
	const selected = new Set(selection.selectedToolIds);
	return permittedToolIds.filter((toolId) => selected.has(toolId));
}

function words(value: string): string[] {
	return value
		.normalize("NFKC")
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.match(/[a-z0-9]+/g)
		?.map((token) => {
			if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
			if (token.length > 4 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
			return token;
		})
		.filter((token) => token.length > 1 && !STOP_WORDS.has(token)) ?? [];
}

function topLevelParameterNames(parameters: Readonly<Record<string, unknown>>): string[] {
	const names = new Set<string>();
	const collect = (value: unknown) => {
		if (!value || typeof value !== "object" || Array.isArray(value)) return;
		const record = value as Record<string, unknown>;
		if (record.properties && typeof record.properties === "object" && !Array.isArray(record.properties)) {
			for (const name of Object.keys(record.properties)) names.add(name);
		}
		if (Array.isArray(record.anyOf)) record.anyOf.forEach(collect);
	};
	collect(parameters);
	return [...names];
}

function schemaBytes(value: unknown): number {
	try {
		return Buffer.byteLength(JSON.stringify(value));
	} catch {
		return 0;
	}
}

/** Count the exact request body at Pi's last seam before DeepSeek. */
export function summarizeDeepSeekProviderPayload(payload: unknown): DeepSeekProviderPayloadSummary {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		return { toolCount: 0, toolSchemaBytes: 0, systemPromptBytes: 0, messagesBytes: 0 };
	}
	const record = payload as Record<string, unknown>;
	const tools = Array.isArray(record.tools) ? record.tools : [];
	const messages = Array.isArray(record.messages) ? record.messages : [];
	let toolSchemaBytes = 0;
	for (const candidate of tools) {
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
		const fn = (candidate as Record<string, unknown>).function;
		if (!fn || typeof fn !== "object" || Array.isArray(fn)) continue;
		toolSchemaBytes += schemaBytes((fn as Record<string, unknown>).parameters);
	}
	let systemPromptBytes = 0;
	for (const candidate of messages) {
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
		const message = candidate as Record<string, unknown>;
		if (message.role === "system" && typeof message.content === "string") {
			systemPromptBytes += Buffer.byteLength(message.content);
		}
	}
	return {
		toolCount: tools.length,
		toolSchemaBytes,
		systemPromptBytes,
		messagesBytes: schemaBytes(messages),
	};
}

export function buildDeepSeekToolCatalog(): DeepSeekToolCatalogEntry[] {
	return GENERATED_NATIVE_TOOL_SPECS
		.filter((spec) => !ALWAYS_EAGER_TOOL_IDS.has(spec.toolId))
		.map((spec) => {
			const searchText = [
				spec.toolId,
				spec.name,
				spec.family,
				spec.label,
				spec.description,
				...(DISCOVERY_TERMS[spec.toolId] ?? []),
				...topLevelParameterNames(spec.parameters),
			].join(" ");
			return {
				toolId: spec.toolId,
				name: spec.name,
				family: spec.family,
				description: spec.description,
				promptGuidelines: spec.promptGuidelines,
				schemaBytes: schemaBytes(spec.parameters),
				tokens: words(searchText),
			};
		});
}

function bm25Scores(catalog: readonly DeepSeekToolCatalogEntry[], query: string): number[] {
	const queryTokens = [...new Set(words(query))];
	if (queryTokens.length === 0 || catalog.length === 0) return catalog.map(() => 0);
	const averageLength = catalog.reduce((sum, entry) => sum + entry.tokens.length, 0) / catalog.length;
	const documentFrequency = new Map<string, number>();
	for (const entry of catalog) {
		for (const token of new Set(entry.tokens)) {
			documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
		}
	}
	return catalog.map((entry) => {
		const frequencies = new Map<string, number>();
		for (const token of entry.tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
		let score = 0;
		for (const token of queryTokens) {
			const frequency = frequencies.get(token) ?? 0;
			if (frequency === 0) continue;
			const documents = documentFrequency.get(token) ?? 0;
			const inverseFrequency = Math.log(1 + (catalog.length - documents + 0.5) / (documents + 0.5));
			const normalized = frequency * 2.5
				/ (frequency + 1.5 * (0.25 + 0.75 * entry.tokens.length / Math.max(averageLength, 1)));
			score += inverseFrequency * normalized;
		}
		return score;
	});
}

export function searchDeepSeekToolCatalog(
	catalog: readonly DeepSeekToolCatalogEntry[],
	query: string,
	limit = PRESELECT_LIMIT,
): DeepSeekToolMatch[] {
	if (limit <= 0) return [];
	const scores = bm25Scores(catalog, query);
	const ranked = catalog
		.map((entry, index) => ({ entry, index, score: scores[index] ?? 0 }))
		.filter((candidate) => candidate.score > 0)
		.sort((left, right) => right.score - left.score || left.index - right.index);
	const minimumScore = (ranked[0]?.score ?? 0) * 0.5;
	return ranked
		.filter((candidate) => candidate.score >= minimumScore)
		.slice(0, Math.min(limit, SEARCH_LIMIT))
		.map(({ entry, score }) => ({
			toolId: entry.toolId,
			name: entry.name,
			family: entry.family,
			description: entry.description,
			promptGuidelines: entry.promptGuidelines,
			schemaBytes: entry.schemaBytes,
			score,
		}));
}

function supportsRetrievedSurface(model: { readonly id?: unknown; readonly api?: unknown } | undefined): boolean {
	return model?.api === "openai-completions"
		&& typeof model.id === "string"
		&& DEEPSEEK_MODELS.has(model.id);
}

function enabled(environment: NodeJS.ProcessEnv): boolean {
	return environment[DIVO_DEEPSEEK_TOOL_SURFACE_ENV]?.trim().toLowerCase() === "on";
}

function eagerSelection(): DeepSeekToolSurfaceSelection {
	return {
		mode: "eager",
		selectedToolIds: [],
		selectedToolNames: [],
		selectedSchemaBytes: 0,
		deferredSchemaBytes: 0,
	};
}

function formatActivatedMatches(matches: readonly DeepSeekToolMatch[]): string {
	if (matches.length === 0) {
		return "No matching governed Divo capability was found. Ask which product or company system the user means; do not guess or route around permissions.";
	}
	const lines = [
		"Activated exact Divo tools. Call the matching exact tool directly now; do not use a generic executor:",
	];
	for (const match of matches) {
		lines.push(`- ${match.name}: ${match.description}`);
		for (const guideline of match.promptGuidelines) lines.push(`  - ${guideline}`);
	}
	return lines.join("\n");
}

/**
 * DeepSeek has no provider-native lazy schema protocol. This adapter keeps a
 * stable core visible, retrieves likely exact tools locally before the first
 * model call, and lets an ambiguous model turn activate more exact tools. It
 * never proxies execution: Pi and the backend still validate the real tool.
 */
export function registerDeepSeekToolSurface(
	pi: ExtensionAPI,
	environment: NodeJS.ProcessEnv = process.env,
): DeepSeekToolSurface {
	const fullCatalog = buildDeepSeekToolCatalog();
	const deferrableNames = new Set(fullCatalog.map((entry) => entry.name));
	let allowedCatalog = fullCatalog;
	let baselineActiveNames: string[] | undefined;
	let applied = false;
	let selection = eagerSelection();

	const registeredNames = () => new Set(pi.getAllTools().map((tool) => tool.name));
	const activeCoreNames = () => pi.getActiveTools()
		.filter((name) => !deferrableNames.has(name) && name !== DIVO_TOOL_SEARCH_NAME);
	const activateNames = (names: readonly string[]) => {
		const registered = registeredNames();
		const next = [...new Set([
			...activeCoreNames(),
			DIVO_TOOL_SEARCH_NAME,
			...names,
		])].filter((name) => registered.has(name));
		pi.setActiveTools(next);
	};
	const matchesForToolIds = (toolIds: readonly string[]) => {
		const requested = new Set(toolIds);
		return allowedCatalog
			.filter((entry) => requested.has(entry.toolId))
			.map((entry): DeepSeekToolMatch => ({ ...entry, score: Number.POSITIVE_INFINITY }));
	};
	const mergeMatches = (matches: readonly DeepSeekToolMatch[]) => {
		const existingNames = new Set(selection.selectedToolNames);
		const additions = matches.filter((match) => !existingNames.has(match.name));
		selection = {
			mode: "retrieved",
			selectedToolIds: [...new Set([
				...selection.selectedToolIds,
				...matches.map((match) => match.toolId),
			])],
			selectedToolNames: [...new Set([
				...selection.selectedToolNames,
				...matches.map((match) => match.name),
			])],
			selectedSchemaBytes: selection.selectedSchemaBytes
				+ additions.reduce((sum, match) => sum + match.schemaBytes, 0),
			deferredSchemaBytes: Math.max(
				0,
				selection.deferredSchemaBytes
					- additions.reduce((sum, match) => sum + match.schemaBytes, 0),
			),
		};
		activateNames(selection.selectedToolNames);
	};

	pi.registerTool({
		name: DIVO_TOOL_SEARCH_NAME,
		label: "Search Divo tools",
		description:
			"Search the permission-scoped Divo capability catalogue only when the user's company/SaaS request has no matching exact tool currently available. The matching exact typed tools become callable on the next model continuation.",
		promptSnippet:
			"Use divo_tool_search once when company work is ambiguous or no currently listed exact Divo tool fits; explicit requests should call their exact tool directly.",
		promptGuidelines: [
			"Call divo_tool_search with the user's exact capability wording, not a guessed product name.",
			"After divo_tool_search activates matches, call one of those exact typed tools; never invent a generic tool call.",
		],
		parameters: Type.Object({
			query: Type.String({ minLength: 2, maxLength: 500 }),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: SEARCH_LIMIT })),
		}),
		async execute(_toolCallId, params) {
			const matches = searchDeepSeekToolCatalog(
				allowedCatalog,
				String(params.query ?? ""),
				typeof params.limit === "number" ? params.limit : PRESELECT_LIMIT,
			);
			mergeMatches(matches);
			return {
				content: [{ type: "text", text: formatActivatedMatches(matches) }],
				details: {
					version: 1,
					query: params.query,
					matches,
					activatedToolNames: matches.map((match) => match.name),
				},
			};
		},
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!applied || !supportsRetrievedSurface(ctx.model)) return undefined;
		console.error(`[divo-deepseek-tools] ${JSON.stringify({
			phase: "provider_request",
			...summarizeDeepSeekProviderPayload(event.payload),
		})}`);
		return undefined;
	});

	return {
		prepareTurn(input) {
			if (!baselineActiveNames) {
				baselineActiveNames = pi.getActiveTools().filter((name) => name !== DIVO_TOOL_SEARCH_NAME);
			}
			if (!enabled(environment) || !supportsRetrievedSurface(input.model)) {
				const registered = registeredNames();
				pi.setActiveTools((baselineActiveNames ?? []).filter((name) => registered.has(name)));
				applied = false;
				allowedCatalog = fullCatalog;
				selection = eagerSelection();
				return selection;
			}

			const allowed = input.allowedToolIds ? new Set(input.allowedToolIds) : undefined;
			allowedCatalog = allowed
				? fullCatalog.filter((entry) => allowed.has(entry.toolId))
				: fullCatalog;
			const matches = searchDeepSeekToolCatalog(allowedCatalog, input.prompt, PRESELECT_LIMIT);
			activateNames(matches.map((match) => match.name));
			const selectedSchemaBytes = matches.reduce((sum, match) => sum + match.schemaBytes, 0);
			const totalSchemaBytes = allowedCatalog.reduce((sum, entry) => sum + entry.schemaBytes, 0);
			selection = {
				mode: "retrieved",
				selectedToolIds: matches.map((match) => match.toolId),
				selectedToolNames: matches.map((match) => match.name),
				selectedSchemaBytes,
				deferredSchemaBytes: totalSchemaBytes - selectedSchemaBytes,
			};
			applied = true;
			console.error(`[divo-deepseek-tools] ${JSON.stringify({
				selected: selection.selectedToolNames,
				selectedSchemaBytes,
				deferredSchemaBytes: selection.deferredSchemaBytes,
			})}`);
			return selection;
		},
		activateToolIds(toolIds) {
			if (!applied) return [];
			const matches = matchesForToolIds(toolIds);
			mergeMatches(matches);
			return matches.map((match) => match.name);
		},
		currentSelection() {
			return selection;
		},
	};
}
