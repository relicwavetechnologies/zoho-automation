import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
	DIVO_COMPANY_PERSONA_PROMPT,
	DIVO_DIRECT_WEB_SEARCH_POLICY,
	DIVO_GATEWAY_PARAMS,
} from "./index.ts";

const ROUTER_SKILL = readFileSync(
	new URL("../../pi-skills/divo-gateway/SKILL.md", import.meta.url),
	"utf8",
);

describe("Divo normal-session routing policy", () => {
	it("routes an ordinary current-information comparison directly to webSearch", () => {
		assert.match(DIVO_DIRECT_WEB_SEARCH_POLICY, /direct core capability/i);
		assert.match(DIVO_DIRECT_WEB_SEARCH_POLICY, /call webSearch directly/i);
		assert.match(DIVO_DIRECT_WEB_SEARCH_POLICY, /Do not call divo_skill_resolve/i);
		assert.match(DIVO_DIRECT_WEB_SEARCH_POLICY, /cheapest.*do not by themselves/i);
		assert.match(DIVO_DIRECT_WEB_SEARCH_POLICY, /only when the user explicitly requests thorough/i);
		assert.match(DIVO_DIRECT_WEB_SEARCH_POLICY, /If no exact recipe is identified.*without fuzzy skill discovery/i);
		assert.match(DIVO_COMPANY_PERSONA_PROMPT, /call webSearch directly/i);
		assert.doesNotMatch(
			DIVO_COMPANY_PERSONA_PROMPT,
			/For public web search or deep research, use backend skills/i,
		);
	});

	it("keeps the bundled router skill aligned with catalogue-first routing", () => {
		assert.match(ROUTER_SKILL, /using no skill is correct/i);
		assert.match(ROUTER_SKILL, /immediately invoke `tools\.invoke`/i);
		assert.match(ROUTER_SKILL, /without fuzzy skill discovery/i);
		assert.doesNotMatch(ROUTER_SKILL, /before planning every meaningful company task/i);
		assert.doesNotMatch(ROUTER_SKILL, /For every meaningful .*call `divo_skill_resolve`/i);
		assert.doesNotMatch(ROUTER_SKILL, /resolve\/fetch the backend `research` skill/i);
	});

	it("marks raw skill operations as inspection paths rather than normal routing", () => {
		const schema = JSON.stringify(DIVO_GATEWAY_PARAMS);
		assert.match(schema, /only for explicit registry inspection/i);
		assert.match(schema, /do not use them as a routing loop/i);
	});

	it("mentions durable deliverables once without stacking an artifacts mega-block or restating web-search policy", () => {
		assert.match(
			DIVO_COMPANY_PERSONA_PROMPT,
			/durable multi-section deliverable/i,
		);
		assert.match(DIVO_COMPANY_PERSONA_PROMPT, /artifact surface/i);
		assert.match(DIVO_COMPANY_PERSONA_PROMPT, /ordinary short answers stay in chat/i);
		assert.doesNotMatch(DIVO_COMPANY_PERSONA_PROMPT, /<divo_artifacts>/i);
		// Decision detail lives on the tool; persona must not restate the full when-to-use list.
		assert.doesNotMatch(
			DIVO_COMPANY_PERSONA_PROMPT,
			/Reuse the same artifactId/i,
		);
		assert.doesNotMatch(
			DIVO_COMPANY_PERSONA_PROMPT,
			/summaryForChat/i,
		);
		// Searching remains a direct capability; research words alone do not force an artifact.
		assert.match(DIVO_DIRECT_WEB_SEARCH_POLICY, /call webSearch directly/i);
		assert.match(
			DIVO_DIRECT_WEB_SEARCH_POLICY,
			/do not by themselves make a request a specialized workflow/i,
		);
	});
});
