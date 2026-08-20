import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Compile } from "typebox/compile";
import type {
	TypedToolHost,
	TypedToolResult,
} from "../typed-tool-runtime.ts";
import {
	bindNativeContractsToCatalogue,
	cacheNativeContracts,
	markCompleteNativeContractCoverage,
	missingCompleteNativeContractToolIds,
	providerNativeContractToolIds,
	registerGeneratedNativeToolCatalogue,
} from "./catalogue.ts";
import { GENERATED_NATIVE_TOOL_SPECS } from "./generated/index.ts";
import { DIVO_SEMRUSH_TOOL_NAME } from "./semrush-contract.ts";
import { registerNativeSemrushTool } from "./semrush.ts";

type Registered = Parameters<TypedToolHost["registerTool"]>[0];

function captureCatalogue() {
	const tools: Registered[] = [];
	const calls: Array<{ toolId: string; args: Record<string, unknown>; toolCallId: string }> = [];
	const invoke = async (input: (typeof calls)[number]): Promise<TypedToolResult> => {
		calls.push(input);
		return { content: [{ type: "text", text: "ok" }], details: { ok: true } };
	};
	const host: TypedToolHost = { registerTool: definition => void tools.push(definition) };
	const generated = registerGeneratedNativeToolCatalogue(host, invoke);
	const semrush = registerNativeSemrushTool(host, invoke);
	return { tools, calls, generated, semrush };
}

describe("complete Pi-native Divo tool catalogue", () => {
	it("registers all 40 canonical business tools without bootstrap or RBAC input", () => {
		const { tools, generated, semrush } = captureCatalogue();
		assert.equal(GENERATED_NATIVE_TOOL_SPECS.length, 39);
		assert.equal(generated.registered.length, 39);
		assert.equal(tools.length, 40);
		assert.equal(semrush, DIVO_SEMRUSH_TOOL_NAME);
		assert.equal(new Set(tools.map(tool => tool.name)).size, 40);
	});

	it("compiles every committed model-facing JSON Schema with Pi's validator", () => {
		for (const spec of GENERATED_NATIVE_TOOL_SPECS) {
			assert.doesNotThrow(
				() => Compile(spec.parameters as never),
				`${spec.name} must carry a Pi-compatible schema`,
			);
		}
	});

	it("dispatches every native definition through the one governed executor", async () => {
		const { tools, calls } = captureCatalogue();
		for (const tool of tools) {
			await tool.execute(`call-${tool.name}`, { marker: tool.name }, undefined, undefined, {});
		}
		assert.equal(calls.length, 40);
		assert.deepEqual(
			calls.map(call => call.toolId).sort(),
			[...GENERATED_NATIVE_TOOL_SPECS.map(spec => spec.toolId), "semrush"].sort(),
		);
	});

	it("keeps every permanent business tool admitted by the packaged runtime", () => {
		const manifest = JSON.parse(
			readFileSync(new URL("../../../runtime-manifest.json", import.meta.url), "utf8"),
		) as { toolAllowlist?: unknown };
		assert.ok(Array.isArray(manifest.toolAllowlist));
		const allowlist = new Set(manifest.toolAllowlist as string[]);
		const missing = [
			...GENERATED_NATIVE_TOOL_SPECS.map(spec => spec.name),
			DIVO_SEMRUSH_TOOL_NAME,
		].filter(name => !allowlist.has(name));
		assert.deepEqual(missing, []);
	});

	it("uses parallel execution only for backend contracts that are entirely read-only", () => {
		const parallelIds = GENERATED_NATIVE_TOOL_SPECS
			.filter(spec => spec.executionMode === "parallel")
			.map(spec => spec.toolId)
			.sort();
		assert.deepEqual(parallelIds, [
			"airtableBase",
			"larkContacts",
			"larkMeeting",
			"menhoodData",
			"omsSiteData",
			"shopifyAnalytics",
			"shopifyCustomers",
			"shopifyOrders",
			"webSearch",
		]);
	});

	it("preloads nested contracts only for provider-native Google and Airtable wrappers", () => {
		assert.deepEqual(providerNativeContractToolIds([
			"zohoCrm",
			"googleSheets",
			"googleSheets",
			"airtableRecords",
			"semrush",
		]), ["googleSheets", "airtableRecords"]);
	});

	it("tracks complete provider-contract coverage by backend tool ID", () => {
		const coverage = new Set<string>();
		assert.deepEqual(missingCompleteNativeContractToolIds([
			"googleSheets",
			"airtableRecords",
			"zohoCrm",
		], coverage), ["googleSheets", "airtableRecords"]);

		assert.deepEqual(markCompleteNativeContractCoverage([{
			toolId: "googleSheets",
			nativeTool: "read_sheet_values",
			inputSchema: { type: "object" },
		}], coverage), ["googleSheets"]);
		assert.deepEqual(markCompleteNativeContractCoverage([{
			toolId: "googleSheets",
			nativeTool: "modify_sheet_values",
			inputSchema: { type: "object" },
		}], coverage), []);
		assert.deepEqual(missingCompleteNativeContractToolIds([
			"googleSheets",
			"airtableRecords",
		], coverage), ["airtableRecords"]);
	});

	it("enriches a permanent provider wrapper without letting bootstrap redefine its identity or handler", () => {
		const tools: Registered[] = [];
		const host: TypedToolHost = { registerTool: definition => void tools.push(definition) };
		const invoke = async (): Promise<TypedToolResult> => ({ content: [], details: {} });
		registerGeneratedNativeToolCatalogue(host, invoke);
		const baseCount = tools.length;
		const cache = new Map();
		const contracts = [{
			toolId: "googleSheets",
			nativeTool: "create_spreadsheet",
			description: "Create a spreadsheet.",
			inputSchema: {
				type: "object",
				properties: { title: { type: "string" } },
				required: ["title"],
				additionalProperties: false,
			},
		}];
		assert.deepEqual(cacheNativeContracts(contracts, cache), ["googleSheets"]);
		const refreshed = bindNativeContractsToCatalogue(host, invoke, contracts);

		assert.deepEqual(refreshed, ["divo_google_sheets"]);
		assert.equal(tools.length, baseCount + 1);
		const enriched = tools.at(-1)!;
		assert.equal(enriched.name, "divo_google_sheets");
		assert.equal(enriched.executionMode, "sequential");
		assert.match(JSON.stringify(enriched.parameters), /create_spreadsheet/);
		assert.match(JSON.stringify(enriched.parameters), /"title"/);
	});
});
