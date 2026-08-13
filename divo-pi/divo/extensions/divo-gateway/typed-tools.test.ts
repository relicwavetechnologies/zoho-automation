import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { bindNativeContracts, typedToolName } from "./typed-tools.ts";

describe("typedToolName", () => {
	it("converts canonical camelCase IDs to stable Divo names", () => {
		assert.equal(typedToolName("zohoBooks"), "divo_zoho_books");
		assert.equal(typedToolName("googleAppsScript"), "divo_google_apps_script");
		assert.equal(typedToolName("omsSiteData"), "divo_oms_site_data");
	});
});

describe("bindNativeContracts", () => {
	const wrapper = {
		type: "object",
		anyOf: [{
			type: "object",
			properties: {
				op: { type: "string", const: "call" },
				nativeTool: { type: "string", enum: ["read_rows", "write_rows"] },
				input: { type: "object", additionalProperties: {} },
			},
			required: ["op", "nativeTool"],
			additionalProperties: false,
		}],
	};

	it("adds an exact provider-owned input branch and retains other operations", () => {
		const enriched = bindNativeContracts(wrapper, [{
			toolId: "googleSheets",
			nativeTool: "write_rows",
			inputSchema: {
				type: "object",
				properties: { range: { type: "string" } },
				required: ["range"],
				additionalProperties: false,
			},
		}]);
		const tool = { name: "divo_google_sheets", description: "", parameters: enriched } as never;
		assert.doesNotThrow(() => validateToolArguments(tool, {
			name: "divo_google_sheets",
			arguments: { op: "call", nativeTool: "write_rows", input: { range: "A1:B2" } },
		} as never));
		assert.throws(() => validateToolArguments(tool, {
			name: "divo_google_sheets",
			arguments: { op: "call", nativeTool: "write_rows", input: {} },
		} as never), /Validation failed/);
		assert.doesNotThrow(() => validateToolArguments(tool, {
			name: "divo_google_sheets",
			arguments: { op: "call", nativeTool: "read_rows", input: {} },
		} as never));
	});

	it("ignores unresolved provider schemas instead of weakening the wrapper", () => {
		assert.equal(bindNativeContracts(wrapper, [{
			toolId: "googleSheets",
			nativeTool: "write_rows",
			inputSchema: { $ref: "#/$defs/Input" },
		}]), wrapper);
	});
});
