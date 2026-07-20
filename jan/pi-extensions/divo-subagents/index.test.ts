import assert from "node:assert/strict";
import test from "node:test";
import extension, { applyChildEvent } from "./index.ts";
import { createChild, MAX_OUTPUT_PREVIEW_CHARS } from "./progress.ts";

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

test("keeps the full completed assistant message separate from its live preview", () => {
	const child = createChild(0, "reviewer", "Review the escalation rules");
	const report = "r".repeat(MAX_OUTPUT_PREVIEW_CHARS + 500);

	const captured = applyChildEvent(child, {
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: report }],
		},
	});

	assert.equal(captured, report);
	assert.equal(child.outputPreview, `${report.slice(0, MAX_OUTPUT_PREVIEW_CHARS)}…`);
});
