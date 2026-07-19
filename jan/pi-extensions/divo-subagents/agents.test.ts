import assert from "node:assert/strict";
import test from "node:test";
import { DIVO_SUBAGENT_ROLES } from "./agents.ts";

test("every bundled subagent role has read-only local tools and Divo gateway access", () => {
	for (const role of DIVO_SUBAGENT_ROLES) {
		assert.ok(role.tools.includes("divo_gateway"), `${role.name} should access divo_gateway`);
		assert.ok(role.tools.includes("divo_skill_resolve"), `${role.name} should access divo_skill_resolve`);
		assert.ok(!role.tools.includes("write"), `${role.name} must not write files`);
		assert.ok(!role.tools.includes("edit"), `${role.name} must not edit files`);
		assert.ok(!role.tools.includes("bash"), `${role.name} must not make direct HTTP requests`);
	}
});
