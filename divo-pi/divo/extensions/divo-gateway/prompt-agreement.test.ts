import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { GENERATED_NATIVE_TOOL_SPECS } from "./native-tools/generated/index.ts";
import {
	DIVO_COMPANY_PERSONA_PROMPT,
	DIVO_LOCAL_EXECUTION_PROMPT,
} from "./run-prompt.ts";

/**
 * The prompt's claims, checked against the code they describe.
 *
 * The existing prompt tests assert wording: that a sentence is present, spelled
 * a certain way. Not one asserts the sentence is true, which is how the persona
 * came to name Zoho Books as a `skill=required` family long after the registry
 * stopped marking it that way. Every assertion in that file stayed green.
 *
 * The rule these tests encode is that the persona states policy and the runtime
 * bootstrap states facts. A sentence naming a specific family, backend
 * operation, provider enum or retired tool is a fact in the wrong place, and it
 * will rot without anything going red.
 */

const PROMPTS = `${DIVO_COMPANY_PERSONA_PROMPT}\n${DIVO_LOCAL_EXECUTION_PROMPT}`;

/** Names the model can actually call, from the packaged runtime allowlist. */
const CALLABLE = new Set<string>(
	(JSON.parse(
		readFileSync(new URL("../../runtime-manifest.json", import.meta.url), "utf8"),
	) as { toolAllowlist?: string[] }).toolAllowlist ?? [],
);

describe("system prompt agrees with the code it describes", () => {
	it("names no tool the model cannot call", () => {
		const named = [...new Set(PROMPTS.match(/divo_[a-z_]+/g) ?? [])]
			.filter(name => name !== "divo_company_persona" && name !== "divo_local_execution");
		const uncallable = named.filter(name => !CALLABLE.has(name));
		assert.deepEqual(uncallable, [], `prompt names tools the model cannot call: ${uncallable.join(", ")}`);
	});

	it("names no backend operation identifier", () => {
		// The model calls tools, not ops. The persona also forbids showing backend
		// enums to the user, so naming one here contradicts its own closing rule.
		const ops = [...new Set(PROMPTS.match(/\b(?:media|documents)\.[a-z_]+/g) ?? [])];
		const callableOps = ops.filter(op => !op.startsWith("documents."));
		assert.deepEqual(callableOps, [], `prompt names backend ops: ${callableOps.join(", ")}`);
	});

	it("does not hardcode one channel on a surface-aware runtime", () => {
		// presentation-policy.ts writes the surface-specific sentences. One persona
		// serves web and Lark, so naming a channel here is wrong half the time.
		assert.equal(
			/\bLark chat\b/.test(DIVO_COMPANY_PERSONA_PROMPT),
			false,
			"persona hardcodes a delivery channel that presentation policy owns",
		);
	});

	it("leaves per-family skill requirements to the runtime bootstrap", () => {
		// The bootstrap emits `skill=<mode>` per family. Restating which family is
		// required duplicates a fact that changes without this file changing.
		const families = GENERATED_NATIVE_TOOL_SPECS.map(spec => spec.family);
		const claimed = [...new Set(families)].filter(family =>
			new RegExp(`Every ${family}[^.]*follows this rule`, "i").test(DIVO_COMPANY_PERSONA_PROMPT));
		assert.deepEqual(claimed, [], `persona hardcodes a required family: ${claimed.join(", ")}`);
	});

	it("states the recovery path for a tool the turn deferred", () => {
		// Under the retrieved surface most tools are not visible. A persona that
		// assumes every tool is listed is how an absent capability becomes an
		// invented refusal instead of a search.
		assert.match(DIVO_COMPANY_PERSONA_PROMPT, /divo_tool_search/);
	});
});
