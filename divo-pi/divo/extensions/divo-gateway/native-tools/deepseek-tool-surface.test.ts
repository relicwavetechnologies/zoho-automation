import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	buildDeepSeekToolCatalog,
	DIVO_DEEPSEEK_TOOL_SURFACE_ENV,
	DIVO_TOOL_SEARCH_NAME,
	registerDeepSeekToolSurface,
	searchDeepSeekToolCatalog,
	planForSelection,
	summarizeDeepSeekProviderPayload,
	toolIdsForDeepSeekPreload,
} from "./deepseek-tool-surface.ts";
import { auditTurnSurface } from "./turn-surface.ts";

const DEEPSEEK = { id: "deepseek-v4-pro", api: "openai-completions" } as const;
const LUNA = { id: "gpt-5.6-luna", api: "openai-responses" } as const;

function createPiHarness() {
	const catalog = buildDeepSeekToolCatalog();
	const registered = new Map<string, Record<string, unknown>>();
	for (const entry of catalog) registered.set(entry.name, { name: entry.name });
	for (const name of ["read", "bash", "divo_skill_resolve", "divo_web_search", "divo_knowledge"]) {
		registered.set(name, { name });
	}
	let active = [...registered.keys()];
	const activeHistory: string[][] = [];
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const pi = {
		on(event: string, handler: (...args: unknown[]) => unknown) {
			handlers.set(event, handler);
		},
		registerTool(definition: Record<string, unknown>) {
			const name = String(definition.name);
			registered.set(name, definition);
			active.push(name);
		},
		getAllTools() {
			return [...registered.values()];
		},
		getActiveTools() {
			return [...active];
		},
		setActiveTools(names: string[]) {
			active = [...names];
			activeHistory.push([...names]);
		},
	} as unknown as ExtensionAPI;
	return {
		pi,
		catalog,
		registered,
		active: () => [...active],
		activeHistory,
		handlers,
	};
}

describe("DeepSeek retrieved exact-tool surface", () => {
	it("routes explicit, ambiguous, cross-product, and conversational prompts locally", () => {
		const catalog = buildDeepSeekToolCatalog();
		assert.equal(searchDeepSeekToolCatalog(catalog, "Show last month's Shopify sales")[0]?.toolId, "shopifyAnalytics");
		assert.equal(searchDeepSeekToolCatalog(catalog, "Send an email to Raj")[0]?.toolId, "googleGmail");
		assert.deepEqual(
			searchDeepSeekToolCatalog(catalog, "Check my calendar tomorrow").map((match) => match.toolId),
			["googleCalendar", "larkCalendar"],
		);
		const crossProduct = searchDeepSeekToolCatalog(catalog, "Create a CRM report in Google Sheets");
		assert.ok(crossProduct.some((match) => match.toolId === "zohoCrm"));
		assert.ok(crossProduct.some((match) => match.toolId === "googleSheets"));
		assert.deepEqual(searchDeepSeekToolCatalog(catalog, "hi"), []);
	});

	it("sends DeepSeek only core, search, and locally selected exact tools", () => {
		const harness = createPiHarness();
		const surface = registerDeepSeekToolSurface(harness.pi, {
			[DIVO_DEEPSEEK_TOOL_SURFACE_ENV]: "on",
		});
		const result = surface.prepareTurn({
			prompt: "Show last month's Shopify sales",
			model: DEEPSEEK,
		});
		surface.applyTurn();

		assert.equal(result.mode, "retrieved");
		assert.ok(result.selectedToolNames.includes("divo_shopify_analytics"));
		assert.ok(result.deferredSchemaBytes > result.selectedSchemaBytes);
		assert.ok(harness.active().includes("read"));
		assert.ok(harness.active().includes(DIVO_TOOL_SEARCH_NAME));
		assert.ok(harness.active().includes("divo_shopify_analytics"));
		assert.equal(harness.active().includes("divo_zoho_books"), false);
		assert.equal(harness.active().includes("divo_google_gmail"), false);
	});

	it("keeps greetings free of business schemas and resets the prior selection", () => {
		const harness = createPiHarness();
		const surface = registerDeepSeekToolSurface(harness.pi, {
			[DIVO_DEEPSEEK_TOOL_SURFACE_ENV]: "on",
		});
		surface.prepareTurn({ prompt: "Show Shopify sales", model: DEEPSEEK });
		surface.applyTurn();
		assert.ok(harness.active().includes("divo_shopify_analytics"));

		const greeting = surface.prepareTurn({ prompt: "hi", model: DEEPSEEK });
		surface.applyTurn();
		assert.deepEqual(greeting.selectedToolNames, []);
		assert.equal(harness.active().includes("divo_shopify_analytics"), false);
		assert.ok(harness.active().includes(DIVO_TOOL_SEARCH_NAME));
		assert.ok(harness.active().includes("divo_web_search"), "always-eager utility remains available");
		assert.deepEqual(
			toolIdsForDeepSeekPreload(["googleGmail", "airtableRecords"], greeting),
			[],
			"a greeting must not trigger provider-native schema or connection preload",
		);
	});

	it("filters discovery using the backend-provided permission snapshot", () => {
		const harness = createPiHarness();
		const surface = registerDeepSeekToolSurface(harness.pi, {
			[DIVO_DEEPSEEK_TOOL_SURFACE_ENV]: "on",
		});
		const result = surface.prepareTurn({
			prompt: "Check my calendar",
			model: DEEPSEEK,
			allowedToolIds: ["larkCalendar"],
		});
		surface.applyTurn();
		assert.deepEqual(result.selectedToolNames, ["divo_lark_calendar"]);
		assert.equal(harness.active().includes("divo_google_calendar"), false);
	});

	it("lets one ambiguous search activate exact tools without a generic executor", async () => {
		const harness = createPiHarness();
		const surface = registerDeepSeekToolSurface(harness.pi, {
			[DIVO_DEEPSEEK_TOOL_SURFACE_ENV]: "on",
		});
		surface.prepareTurn({ prompt: "work with our company system", model: DEEPSEEK });
		surface.applyTurn();
		const search = harness.registered.get(DIVO_TOOL_SEARCH_NAME) as {
			execute: (id: string, params: Record<string, unknown>) => Promise<{
				details: { activatedToolNames: string[] };
			}>;
		};
		const result = await search.execute("search-1", { query: "send an email", limit: 3 });

		assert.ok(result.details.activatedToolNames.includes("divo_google_gmail"));
		assert.ok(harness.active().includes("divo_google_gmail"));
		assert.equal(harness.registered.has("tool_call"), false);
		assert.equal(harness.registered.has("divo_gateway"), false);
	});

	it("measures the exact final DeepSeek payload without logging message content", () => {
		assert.deepEqual(summarizeDeepSeekProviderPayload({
			tools: [{
				type: "function",
				function: { name: "small", parameters: { type: "object", properties: {} } },
			}],
			messages: [
				{ role: "system", content: "system" },
				{ role: "user", content: "private request" },
			],
		}), {
			toolCount: 1,
			toolNames: ["small"],
			toolSchemaBytes: Buffer.byteLength(JSON.stringify({ type: "object", properties: {} })),
			systemPromptBytes: Buffer.byteLength("system"),
			messagesBytes: Buffer.byteLength(JSON.stringify([
				{ role: "system", content: "system" },
				{ role: "user", content: "private request" },
			])),
		});
	});

	it("is byte-for-byte inactive for unsupported models or when the rollout switch is off", () => {
		for (const [environment, model] of [
			[{}, DEEPSEEK],
			[{ [DIVO_DEEPSEEK_TOOL_SURFACE_ENV]: "on" }, LUNA],
		] as const) {
			const harness = createPiHarness();
			const before = harness.active();
			const surface = registerDeepSeekToolSurface(harness.pi, environment);
			const result = surface.prepareTurn({ prompt: "Shopify sales", model });
			surface.applyTurn();
			assert.equal(result.mode, "eager");
			assert.deepEqual(harness.active(), before);
			assert.ok(harness.registered.has(DIVO_TOOL_SEARCH_NAME), "registered but not model-visible");
		}
	});

	// Measured on 2026-08-19: retrieval planned 5 governed tools and provider
	// contract enrichment re-registered two wrappers, taking the request from 25
	// active tools to 55 and from 18,691 to 148,048 schema bytes. The plan was
	// never wrong; nothing checked that the request still matched it.
	it("reports contract enrichment after the plan as surface drift", () => {
		const harness = createPiHarness();
		const surface = registerDeepSeekToolSurface(harness.pi, {
			[DIVO_DEEPSEEK_TOOL_SURFACE_ENV]: "on",
		});
		const selection = surface.prepareTurn({
			prompt: "Create a CRM report in Google Sheets",
			model: DEEPSEEK,
		});
		surface.applyTurn();
		const plan = planForSelection(harness.catalog, selection);
		assert.equal(auditTurnSurface(plan, {
			toolNames: harness.active(),
			toolSchemaBytes: plan.ledger.plannedToolSchemaBytes,
			systemPromptBytes: 0,
			messagesBytes: 0,
		}).withinPlan, true, "the plan holds before anything re-registers");

		// What enrichGeneratedNativeToolCatalogue does mid-turn.
		harness.pi.registerTool({ name: "divo_google_sheets" } as never);
		harness.pi.registerTool({ name: "divo_google_gmail" } as never);

		const drift = auditTurnSurface(plan, {
			toolNames: harness.active(),
			toolSchemaBytes: 148_048,
			systemPromptBytes: 0,
			messagesBytes: 0,
		});
		assert.equal(drift.withinPlan, false);
		assert.ok(drift.unplannedToolNames.includes("divo_google_gmail"));
		assert.ok(drift.overBudgetBytes > 0);
	});

	// The ordering that makes the drift above impossible: decide, bind, then
	// apply. Binding still re-expands Pi's active set, but the surface is applied
	// afterwards, so the turn ends on the plan rather than on the side effect.
	it("keeps the plan intact when contract binding precedes the surface apply", () => {
		const harness = createPiHarness();
		const surface = registerDeepSeekToolSurface(harness.pi, {
			[DIVO_DEEPSEEK_TOOL_SURFACE_ENV]: "on",
		});
		const selection = surface.prepareTurn({
			prompt: "Create a CRM report in Google Sheets",
			model: DEEPSEEK,
		});

		harness.pi.registerTool({ name: "divo_google_sheets" } as never);
		harness.pi.registerTool({ name: "divo_google_gmail" } as never);
		surface.applyTurn();

		const plan = planForSelection(harness.catalog, selection);
		const drift = auditTurnSurface(plan, {
			toolNames: harness.active(),
			toolSchemaBytes: plan.ledger.plannedToolSchemaBytes,
			systemPromptBytes: 0,
			messagesBytes: 0,
		});
		assert.deepEqual(drift.unplannedToolNames, []);
		assert.deepEqual(drift.missingToolNames, []);
		assert.equal(drift.withinPlan, true);
	});

	it("admits the small search seam in the packaged runtime", () => {
		const manifest = JSON.parse(
			readFileSync(new URL("../../../runtime-manifest.json", import.meta.url), "utf8"),
		) as { toolAllowlist?: unknown };
		assert.ok(Array.isArray(manifest.toolAllowlist));
		assert.ok(manifest.toolAllowlist.includes(DIVO_TOOL_SEARCH_NAME));
	});
});
