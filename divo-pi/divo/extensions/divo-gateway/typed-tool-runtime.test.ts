import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { WorkBootstrap } from "./work-bootstrap.ts";
import { registerTypedTools, type TypedToolHost, type TypedToolResult } from "./typed-tool-runtime.ts";

const fixtures = JSON.parse(
	readFileSync(new URL("./backend-schema-fixture.json", import.meta.url), "utf8"),
) as Record<string, Record<string, unknown>>;

type Registered = Parameters<TypedToolHost["registerTool"]>[0];

function host(): { host: TypedToolHost; tools: Registered[] } {
	const tools: Registered[] = [];
	return { host: { registerTool: (definition) => void tools.push(definition) }, tools };
}

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

const noopInvoke = async (): Promise<TypedToolResult> => ({ content: [{ type: "text", text: "ok" }], details: undefined });

describe("registerTypedTools", () => {
	it("registers one Pi tool per bootstrap contract", () => {
		const { host: pi, tools } = host();
		const result = registerTypedTools(pi, bootstrapWith([{}]), noopInvoke, new Set());
		assert.deepEqual(result.registered, ["divo_web_search"]);
		assert.deepEqual(result.rejected, []);
		assert.equal(tools.length, 1);
		assert.equal(tools[0]?.name, "divo_web_search");
		assert.match(tools[0]?.promptSnippet ?? "", /governed context work \(read\)/);
	});

	it("routes execution through the injected gateway invoker with the canonical tool ID", async () => {
		const calls: Array<{ toolId: string; args: Record<string, unknown>; toolCallId: string }> = [];
		const { host: pi, tools } = host();
		registerTypedTools(pi, bootstrapWith([{ id: "zohoBooks", argsSchema: fixtures.zohoBooks }]), async (input) => {
			calls.push(input);
			return { content: [{ type: "text", text: "invoked" }], details: undefined };
		}, new Set());

		const result = await tools[0]!.execute("call-1", { connectionId: "c", op: "list_invoices" }, undefined, undefined, {});
		assert.deepEqual(calls, [{
			toolId: "zohoBooks",
			args: { connectionId: "c", op: "list_invoices" },
			toolCallId: "call-1",
		}]);
		assert.equal(result.content[0]?.text, "invoked");
	});

	it("does not replace a tool already live earlier in the same session", () => {
		const registry = new Set<string>();
		const { host: pi, tools } = host();
		registerTypedTools(pi, bootstrapWith([{}]), noopInvoke, registry);
		const second = registerTypedTools(pi, bootstrapWith([{}]), noopInvoke, registry);
		assert.deepEqual(second.registered, []);
		assert.deepEqual(second.skipped, ["divo_web_search"]);
		assert.equal(tools.length, 1, "the live tool must not be re-registered mid-run");
	});

	it("registers a denied tool so the model sees a permission decision, not an absence", () => {
		const { host: pi, tools } = host();
		registerTypedTools(pi, bootstrapWith([{ allowedActions: [] }]), noopInvoke, new Set());
		assert.equal(tools.length, 1);
		assert.match(tools[0]?.description ?? "", /permission decision, not a missing capability/);
		assert.match(tools[0]?.promptSnippet ?? "", /not permitted for you/);
	});

	it("still sends a denied tool's call to the backend, which owns the decision", async () => {
		const calls: string[] = [];
		const { host: pi, tools } = host();
		registerTypedTools(pi, bootstrapWith([{ allowedActions: [] }]), async (input) => {
			calls.push(input.toolId);
			return { content: [{ type: "text", text: "backend denied" }], details: undefined, isError: true };
		}, new Set());
		await tools[0]!.execute("call-1", { query: "x" }, undefined, undefined, {});
		assert.deepEqual(calls, ["webSearch"], "Pi must not decide authorization locally");
	});

	it("registers the schema Pi actually validates against", () => {
		const { host: pi, tools } = host();
		registerTypedTools(pi, bootstrapWith([{ id: "larkTask", argsSchema: fixtures.larkTask }]), noopInvoke, new Set());
		const piTool = { name: tools[0]!.name, description: "", parameters: tools[0]!.parameters } as never;
		assert.throws(
			() => validateToolArguments(piTool, { name: tools[0]!.name, arguments: { op: "notARealOp" } } as never),
			/allowed values/,
		);
	});

	it("reports a rejected contract instead of registering a wrong one", () => {
		const { host: pi, tools } = host();
		const result = registerTypedTools(
			pi,
			bootstrapWith([{ id: "brokenTool", argsSchema: { type: "string" } }]),
			noopInvoke,
			new Set(),
		);
		assert.deepEqual(tools, []);
		assert.equal(result.rejected[0]?.toolId, "brokenTool");
	});
});
