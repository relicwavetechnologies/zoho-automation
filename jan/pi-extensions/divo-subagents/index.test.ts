import assert from "node:assert/strict";
import test from "node:test";
import extension from "./index.ts";

test("registers one Pi-owned subagent tool and a shutdown handler", () => {
	const tools: Array<{ name?: string }> = [];
	const handlers = new Map<string, () => void>();
	extension({
		registerTool(tool: { name?: string }) {
			tools.push(tool);
		},
		on(event: string, handler: () => void) {
			handlers.set(event, handler);
		},
	} as never);

	assert.equal(tools.length, 1);
	assert.equal(tools[0]?.name, "divo_subagents");
	assert.equal(typeof handlers.get("session_shutdown"), "function");
});
