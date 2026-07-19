import assert from "node:assert/strict";
import test from "node:test";
import extension from "./index.ts";

test("registers one Pi-owned subagent tool and a shutdown handler", () => {
	const tools: Array<{
		name?: string;
		description?: string;
		promptSnippet?: string;
		promptGuidelines?: string[];
	}> = [];
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
	assert.match(tools[0]?.description ?? "", /company research, retrieval, analysis, planning, preparation, or verification/i);
	assert.match(tools[0]?.promptSnippet ?? "", /substantial independent company workstreams/i);
	assert.doesNotMatch(tools[0]?.promptSnippet ?? "", /without losing the parent conversation/i);
	assert.ok(tools[0]?.promptGuidelines?.some((guideline) => /does not receive the parent conversation/i.test(guideline)));
	assert.ok(tools[0]?.promptGuidelines?.some((guideline) => /do not delegate approvals, external mutations/i.test(guideline)));
});
