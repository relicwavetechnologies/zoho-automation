import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { authorizeToolInvocation } from "./skill-authorization.ts";

describe("skill authorization", () => {
	const loaded = { runId: "run-1", skillId: "skill-1" };

	it("does not gate read operations", () => {
		assert.equal(authorizeToolInvocation({
			op: "tools.list",
			toolId: undefined,
			runId: "run-1",
			lookup: () => loaded,
			scheduling: false,
		}), null);
	});

	it("requires a skill loaded in the current run", () => {
		assert.deepEqual(authorizeToolInvocation({
			op: "tools.invoke",
			toolId: "knowledge",
			runId: "run-1",
			lookup: () => undefined,
			scheduling: false,
		}), {
			ok: false,
			message: "Exact company skill required. Load the relevant DB skill with divo_skill_view, then retry this tool call.",
		});
	});

	it("rejects stale scheduling provenance with focused guidance", () => {
		assert.deepEqual(authorizeToolInvocation({
			op: "tools.invoke",
			toolId: "scheduledWorkflows",
			runId: "run-2",
			lookup: () => loaded,
			scheduling: true,
		}), {
			ok: false,
			message: "Scheduling recipe required. Load the exact Schedule Divo Work skillId from the injected catalogue with divo_skill_view, then retry.",
		});
	});

	it("binds only a matching current-run skill", () => {
		assert.deepEqual(authorizeToolInvocation({
			op: "tools.invoke",
			toolId: "knowledge",
			runId: "run-1",
			lookup: () => loaded,
			scheduling: false,
		}), { ok: true, skillId: "skill-1" });
	});
});
