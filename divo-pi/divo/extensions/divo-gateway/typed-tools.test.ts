import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { WorkBootstrap } from "./work-bootstrap.ts";
import {
	buildTypedTools,
	guidelinesFromParameterDocs,
	sanitizeSchema,
	typedToolName,
} from "./typed-tools.ts";

const fixtures = JSON.parse(
	readFileSync(new URL("./backend-schema-fixture.json", import.meta.url), "utf8"),
) as Record<string, Record<string, unknown>>;

function bootstrapWith(tools: Array<Partial<WorkBootstrap["tools"][number]>>): WorkBootstrap {
	return {
		version: 1,
		scope: "run",
		registryRevision: 1,
		nativeContracts: [],
		connections: [],
		advisories: [],
		tools: tools.map((tool) => ({
			id: "webSearch",
			family: "context",
			description: "Search the public web.",
			allowedActions: ["read"],
			parameterDocs: "query: the search text",
			argsSchema: fixtures.webSearch,
			...tool,
		})) as WorkBootstrap["tools"],
	};
}

describe("typedToolName", () => {
	it("converts canonical camelCase IDs to a stable prefixed name", () => {
		assert.equal(typedToolName("zohoBooks"), "divo_zoho_books");
		assert.equal(typedToolName("omsSiteData"), "divo_oms_site_data");
		assert.equal(typedToolName("webSearch"), "divo_web_search");
		assert.equal(typedToolName("knowledge"), "divo_knowledge");
	});
});

describe("sanitizeSchema", () => {
	it("strips annotation-only keys that cost tokens and mean nothing here", () => {
		const result = sanitizeSchema(fixtures.webSearch);
		assert.ok("schema" in result);
		assert.ok(!("$schema" in result.schema));
		assert.deepEqual(result.schema.required, ["query"]);
	});

	it("keeps the sanitized schema usable by Pi's validator", () => {
		const result = sanitizeSchema(fixtures.zohoBooks);
		assert.ok("schema" in result);
		const tool = { name: "divo_zoho_books", description: "", parameters: result.schema } as never;
		assert.throws(
			() => validateToolArguments(tool, { name: "divo_zoho_books", arguments: {} } as never),
			/connectionId/,
		);
	});

	it("refuses a schema that is not a usable argument record", () => {
		assert.deepEqual(sanitizeSchema(null), { error: "args schema is not an object" });
		assert.match(
			(sanitizeSchema({ type: "string" }) as { error: string }).error,
			/root type must be "object"/,
		);
		assert.deepEqual(sanitizeSchema({ type: "object" }), { error: "args schema has no properties object" });
	});

	it("refuses a schema still carrying an unresolved reference", () => {
		assert.match(
			(sanitizeSchema({
				type: "object",
				properties: { a: { $ref: "#/definitions/A" } },
			}) as { error: string }).error,
			/\$ref/,
		);
	});
});

describe("guidelinesFromParameterDocs", () => {
	it("splits documentation into bullets and drops list markers", () => {
		assert.deepEqual(
			guidelinesFromParameterDocs("- first rule\n\n  * second rule\nthird rule\n"),
			["first rule", "second rule", "third rule"],
		);
	});

	it("returns nothing for empty documentation rather than an empty bullet", () => {
		assert.deepEqual(guidelinesFromParameterDocs("   \n\n"), []);
	});
});

describe("buildTypedTools", () => {
	it("maps a reachable tool to a typed definition carrying the real schema", () => {
		const { tools, rejected } = buildTypedTools(bootstrapWith([{}]));
		assert.deepEqual(rejected, []);
		assert.equal(tools.length, 1);
		assert.equal(tools[0]?.name, "divo_web_search");
		assert.equal(tools[0]?.denied, false);
		assert.equal((tools[0]?.parameters.properties as Record<string, unknown>).query !== undefined, true);
	});

	it("registers an unreachable tool as an explicit denial instead of dropping it", () => {
		const { tools } = buildTypedTools(bootstrapWith([{ allowedActions: [] }]));
		assert.equal(tools.length, 1);
		assert.equal(tools[0]?.denied, true);
		assert.match(tools[0]?.description ?? "", /permission decision, not a missing capability/);
		assert.match(tools[0]?.promptGuidelines[0] ?? "", /a company admin can grant it/);
	});

	it("rejects an unusable schema with a reason rather than registering a wrong contract", () => {
		const { tools, rejected } = buildTypedTools(bootstrapWith([{ id: "brokenTool", argsSchema: { type: "string" } }]));
		assert.deepEqual(tools, []);
		assert.equal(rejected.length, 1);
		assert.equal(rejected[0]?.toolId, "brokenTool");
		assert.match(rejected[0]?.reason ?? "", /root type must be "object"/);
	});

	it("refuses a second tool that would claim an existing typed name", () => {
		const { tools, rejected } = buildTypedTools(
			bootstrapWith([{ id: "webSearch" }, { id: "web_search" }]),
		);
		assert.equal(tools.length, 1);
		assert.equal(rejected.length, 1);
		assert.match(rejected[0]?.reason ?? "", /duplicate typed tool name divo_web_search/);
	});

	it("produces definitions Pi accepts end to end for every fixture contract", () => {
		const bootstrap = bootstrapWith(
			Object.entries(fixtures).map(([id, argsSchema]) => ({ id, argsSchema })),
		);
		const { tools, rejected } = buildTypedTools(bootstrap);
		assert.deepEqual(rejected, []);
		assert.equal(tools.length, Object.keys(fixtures).length);
		for (const tool of tools) {
			const piTool = { name: tool.name, description: tool.description, parameters: tool.parameters } as never;
			assert.throws(
				() => validateToolArguments(piTool, { name: tool.name, arguments: {} } as never),
				/Validation failed/,
				`${tool.name} should reject empty arguments`,
			);
		}
	});
});
