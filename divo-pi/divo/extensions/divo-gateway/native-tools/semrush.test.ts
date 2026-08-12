import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type {
	TypedToolHost,
	TypedToolResult,
} from "../typed-tool-runtime.ts";
import {
	DIVO_SEMRUSH_PARAMS,
	DIVO_SEMRUSH_TOOL_NAME,
} from "./semrush-contract.ts";
import { registerNativeSemrushTool } from "./semrush.ts";

type Registered = Parameters<TypedToolHost["registerTool"]>[0];

function captureTool(): {
	tool: Registered;
	calls: Array<{ toolId: string; args: Record<string, unknown>; toolCallId: string }>;
} {
	const tools: Registered[] = [];
	const calls: Array<{ toolId: string; args: Record<string, unknown>; toolCallId: string }> = [];
	const invoke = async (input: (typeof calls)[number]): Promise<TypedToolResult> => {
		calls.push(input);
		return { content: [{ type: "text", text: "Semrush complete" }], details: { ok: true } };
	};
	registerNativeSemrushTool({ registerTool: definition => void tools.push(definition) }, invoke);
	assert.equal(tools.length, 1);
	return { tool: tools[0]!, calls };
}

function validate(args: unknown): unknown {
	return validateToolArguments(
		{ name: DIVO_SEMRUSH_TOOL_NAME, description: "", parameters: DIVO_SEMRUSH_PARAMS } as never,
		{ name: DIVO_SEMRUSH_TOOL_NAME, arguments: args } as never,
	);
}

describe("native Semrush Pi tool", () => {
	it("is permanent model-facing Pi registration with read-only concurrency", () => {
		const { tool } = captureTool();
		assert.equal(tool.name, "divo_semrush");
		assert.equal(tool.executionMode, "parallel");
		assert.match(tool.description, /country-level domain overview/);
		assert.match(tool.promptGuidelines?.join("\n") ?? "", /one backlinks_comparison call/i);
	});

	it("accepts every supported operation", () => {
		assert.doesNotThrow(() => validate({ operation: "domain_overview", domain: "example.com", database: "in" }));
		assert.doesNotThrow(() => validate({ operation: "backlinks_comparison", targets: ["a.com", "b.com"] }));
		assert.doesNotThrow(() => validate({
			operation: "keyword_position_trend",
			domain: "example.com",
			keyword: "agent runtime",
			date: "20260813",
			dateType: "daily",
		}));
	});

	it("rejects semantically invalid model calls before they leave Pi", () => {
		assert.throws(() => validate({ operation: "domain_overview", domain: "https://example.com" }), /Validation failed/);
		assert.throws(() => validate({ operation: "backlinks_comparison", targets: ["a.com", "a.com"] }), /Validation failed/);
		assert.throws(() => validate({
			operation: "keyword_position_trend",
			domain: "example.com",
			keyword: "agent runtime",
			date: "2026-08-13",
		}), /Validation failed/);
		assert.throws(() => validate({ operation: "domain_overview", domain: "example.com", surprise: true }), /Validation failed/);
	});

	it("sends the validated call unchanged through the single governed invoker", async () => {
		const { tool, calls } = captureTool();
		const args = { operation: "backlinks_comparison", targets: ["a.com", "b.com"] };
		const result = await tool.execute("semrush-call-1", args, undefined, undefined, { channel: "lark" });
		assert.deepEqual(calls, [{ toolId: "semrush", args, toolCallId: "semrush-call-1" }]);
		assert.equal(result.content[0]?.text, "Semrush complete");
	});
});
