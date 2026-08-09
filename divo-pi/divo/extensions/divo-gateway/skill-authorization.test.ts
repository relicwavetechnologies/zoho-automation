import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { authorizeToolInvocation } from "./skill-authorization.ts";

describe("skill authorization", () => {
	const loaded = { skillId: "skill-1" };

	it("does not gate read operations", () => {
		assert.equal(authorizeToolInvocation({
			op: "tools.list",
			toolId: undefined,
			lookup: () => loaded,
			scheduling: false,
		}), null);
	});

	it("allows an ordinary governed invocation without a loaded skill", () => {
		const result = authorizeToolInvocation({
			op: "tools.invoke",
			toolId: "knowledge",
			lookup: () => undefined,
			scheduling: false,
		});
		assert.equal(result, null);
	});

	it("gives scheduling work its own guidance", () => {
		const result = authorizeToolInvocation({
			op: "tools.invoke",
			toolId: "scheduledWorkflows",
			lookup: () => undefined,
			scheduling: true,
		});
		assert.deepEqual(result, {
			ok: false,
			message: "Scheduling recipe required. Load the exact Schedule Divo Work skillId from the injected catalogue with divo_skill_view, then retry.",
		});
	});

	it("binds the skill that was actually loaded", () => {
		assert.deepEqual(authorizeToolInvocation({
			op: "tools.invoke",
			toolId: "knowledge",
			lookup: () => loaded,
			scheduling: false,
		}), { ok: true, skillId: "skill-1" });
	});

	/**
	 * The behaviour this change exists for.
	 *
	 * A binding used to be scoped to the run that created it, so the second
	 * message in a thread was refused even though the recipe was already loaded
	 * and the model was passing the right skill id. The lookup is now the only
	 * thing consulted, and it survives for the container's life.
	 */
	it("keeps the binding across runs in the same container", () => {
		const lookup = () => loaded;
		const first = authorizeToolInvocation({
			op: "tools.invoke", toolId: "knowledge", lookup, scheduling: false,
		});
		// A later message is a different run; the binding is unchanged.
		const later = authorizeToolInvocation({
			op: "tools.invoke", toolId: "knowledge", lookup, scheduling: false,
		});
		assert.deepEqual(first, { ok: true, skillId: "skill-1" });
		assert.deepEqual(later, first);
	});

	it("does not invent provenance for a tool no skill ever loaded", () => {
		const result = authorizeToolInvocation({
			op: "tools.invoke",
			toolId: "zohoBooks",
			lookup: (toolId) => (toolId === "knowledge" ? loaded : undefined),
			scheduling: false,
		});
		assert.equal(result, null);
	});
});
