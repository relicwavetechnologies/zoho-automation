import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateToolArguments } from "@earendil-works/pi-ai";

/**
 * Phase 0 of the typed tool surface: prove the backend's own JSON Schema
 * survives the trip into Pi's validator unchanged.
 *
 * The fixture is real output from `serializeToolArgsSchema` — the exact value
 * the run bootstrap already sends and that `formatWorkBootstrap` currently
 * stringifies into the prompt. If Pi can compile it and reject bad arguments
 * against it, that value belongs in `registerTool({ parameters })` instead of
 * in prose.
 *
 * These assertions are the contract. A backend change that breaks one means
 * the typed surface would silently start accepting arguments the backend will
 * reject, so this test failing is a real regression, not fixture drift.
 */

const fixtures = JSON.parse(
	readFileSync(new URL("./backend-schema-fixture.json", import.meta.url), "utf8"),
) as Record<string, Record<string, unknown>>;

function validate(toolId: string, args: unknown): unknown {
	const parameters = fixtures[toolId];
	assert.ok(parameters, `missing fixture for ${toolId}`);
	return validateToolArguments(
		{ name: `divo_${toolId}`, description: "", parameters } as never,
		{ name: `divo_${toolId}`, arguments: args } as never,
	);
}

function rejection(toolId: string, args: unknown): string {
	try {
		validate(toolId, args);
		assert.fail(`expected ${toolId} to reject ${JSON.stringify(args)}`);
	} catch (error) {
		const message = (error as Error).message;
		assert.ok(
			message.startsWith("Validation failed"),
			`expected a validation failure, got: ${message.split("\n")[0]}`,
		);
		return message;
	}
}

describe("backend argsSchema compiles under Pi's tool validator", () => {
	it("accepts a well-formed call", () => {
		assert.deepEqual(validate("webSearch", { query: "divo pricing" }), { query: "divo pricing" });
	});

	it("tolerates the draft-07 $schema annotation the serializer emits", () => {
		assert.equal(fixtures.webSearch?.$schema, "http://json-schema.org/draft-07/schema#");
		assert.doesNotThrow(() => validate("webSearch", { query: "still compiles" }));
	});

	it("names every missing required property", () => {
		const message = rejection("zohoBooks", {});
		assert.match(message, /connectionId/);
		assert.match(message, /op/);
	});

	it("enforces an operation enum that prose could only request", () => {
		assert.doesNotThrow(() => validate("larkTask", { op: "create" }));
		assert.match(rejection("larkTask", { op: "notARealOp" }), /allowed values/);
	});

	it("enforces the connection UUID format instead of asking the model not to guess", () => {
		assert.match(rejection("zohoBooks", { connectionId: "the-finance-account", op: "list_invoices" }), /uuid/);
		assert.doesNotThrow(() =>
			validate("zohoBooks", { connectionId: "8b1f1f1e-0000-4000-8000-000000000000", op: "list_invoices" }),
		);
	});

	it("coerces a primitive the model got slightly wrong rather than failing the run", () => {
		assert.deepEqual(validate("webSearch", { query: 42 }), { query: "42" });
	});

	it("still rejects an absent required property after coercion", () => {
		assert.match(rejection("webSearch", {}), /query/);
	});
});
