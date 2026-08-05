import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { Check } from "typebox/value";
import {
	DIVO_COMPANY_PERSONA_PROMPT,
	DIVO_DIRECT_WEB_SEARCH_POLICY,
	DIVO_GATEWAY_PARAMS,
	DIVO_GOVERNED_DIRECT_ACTION_CRITERION,
	DIVO_GOVERNED_LOCAL_WORKFLOW_CRITERION,
	DIVO_LOCAL_EXECUTION_PROMPT,
} from "./index.ts";

const ROUTER_SKILL = readFileSync(
	new URL("../../skills/divo-gateway/SKILL.md", import.meta.url),
	"utf8",
);

describe("Divo normal-session routing policy", () => {
	it("routes an ordinary current-information comparison directly to webSearch", () => {
		assert.match(DIVO_DIRECT_WEB_SEARCH_POLICY, /load the exact Web Search DB skill/i);
		assert.match(DIVO_DIRECT_WEB_SEARCH_POLICY, /then call webSearch/i);
		assert.match(DIVO_DIRECT_WEB_SEARCH_POLICY, /Do not run fuzzy discovery/i);
		assert.match(DIVO_DIRECT_WEB_SEARCH_POLICY, /cheapest.*do not by themselves/i);
		assert.match(DIVO_DIRECT_WEB_SEARCH_POLICY, /only when the user explicitly requests thorough/i);
		assert.match(DIVO_COMPANY_PERSONA_PROMPT, /call webSearch directly/i);
		assert.doesNotMatch(
			DIVO_COMPANY_PERSONA_PROMPT,
			/For public web search or deep research, use backend skills/i,
		);
	});

	it("keeps the bundled router skill aligned with catalogue-first routing", () => {
		assert.match(ROUTER_SKILL, /using no skill is correct/i);
		// The gateway refuses a tools.invoke whose skill was not loaded in the same
		// run, so the router must send the model through divo_skill_view first.
		// It previously said "immediately invoke", which was a guaranteed refusal.
		assert.match(ROUTER_SKILL, /load the exact web-search skill .* with `divo_skill_view`, then invoke `tools\.invoke`/i);
		assert.doesNotMatch(ROUTER_SKILL, /immediately invoke `tools\.invoke`/i);
		assert.match(ROUTER_SKILL, /without fuzzy skill discovery/i);
		assert.doesNotMatch(ROUTER_SKILL, /before planning every meaningful company task/i);
		assert.doesNotMatch(ROUTER_SKILL, /For every meaningful .*call `divo_skill_resolve`/i);
		assert.doesNotMatch(ROUTER_SKILL, /resolve\/fetch the backend `research` skill/i);
		assert.match(ROUTER_SKILL, /drive\.google\.com\/file\/d/);
		assert.match(ROUTER_SKILL, /Never derive a Google ID, request a download URL, or call `import_to_google_sheets` directly/i);
		assert.match(ROUTER_SKILL, /backend delivers the confirmation card and owns creation/i);
	});

	it("always routes a pasted Drive Excel workbook through the Sheets resolver", () => {
		assert.match(DIVO_COMPANY_PERSONA_PROMPT, /drive\.google\.com\/file\/d/);
		assert.match(DIVO_COMPANY_PERSONA_PROMPT, /load the exact Google Sheets skill/i);
		assert.match(DIVO_COMPANY_PERSONA_PROMPT, /googleSheets with op resolve_reference/i);
		assert.match(DIVO_COMPANY_PERSONA_PROMPT, /Never route it through Google Drive download, copy, or import operations/i);
		assert.match(DIVO_COMPANY_PERSONA_PROMPT, /backend owns confirmation and conversion/i);
	});

	it("prefers a backend-verified recent Sheet export over stale session history", () => {
		assert.match(DIVO_COMPANY_PERSONA_PROMPT, /RECENT DIVO EXPORTS lists a google_sheet/i);
		assert.match(DIVO_COMPANY_PERSONA_PROMPT, /overrides stale session claims/i);
		assert.match(DIVO_COMPANY_PERSONA_PROMPT, /googleSheets with op call_exported_sheet and its resourceRef/i);
		assert.match(DIVO_COMPANY_PERSONA_PROMPT, /do not search Drive, resolve the URL, choose an account, or ask which file/i);
	});

	it("marks raw skill operations as inspection paths rather than normal routing", () => {
		const schema = JSON.stringify(DIVO_GATEWAY_PARAMS);
		assert.match(schema, /only for explicit registry inspection/i);
		assert.match(schema, /do not use them as a routing loop/i);
	});

	it("treats Airtable as an exact governed connection family", () => {
		assert.equal(Check(DIVO_GATEWAY_PARAMS, {
			op: "connections.list",
			payload: { provider: "airtable" },
		}), true);
		assert.match(DIVO_COMPANY_PERSONA_PROMPT, /airtable for Airtable/i);
		assert.match(DIVO_COMPANY_PERSONA_PROMPT, /never omit provider/i);
		assert.match(ROUTER_SKILL, /airtable.*for Airtable/i);
		assert.match(ROUTER_SKILL, /never omit `provider`/i);
	});

	it("treats Shopify as an exact governed connection family", () => {
		assert.equal(Check(DIVO_GATEWAY_PARAMS, {
			op: "connections.list",
			payload: { provider: "shopify" },
		}), true);
		assert.match(DIVO_COMPANY_PERSONA_PROMPT, /shopify for Shopify/i);
	});

	it("uses one persistent local Python file and never routes through the retired inline-code tool", () => {
		assert.match(DIVO_LOCAL_EXECUTION_PROMPT, new RegExp(DIVO_GOVERNED_DIRECT_ACTION_CRITERION));
		assert.match(DIVO_LOCAL_EXECUTION_PROMPT, new RegExp(DIVO_GOVERNED_LOCAL_WORKFLOW_CRITERION));
		assert.match(DIVO_COMPANY_PERSONA_PROMPT, new RegExp(DIVO_GOVERNED_DIRECT_ACTION_CRITERION));
		assert.match(DIVO_COMPANY_PERSONA_PROMPT, new RegExp(DIVO_GOVERNED_LOCAL_WORKFLOW_CRITERION));
		assert.match(ROUTER_SKILL, new RegExp(DIVO_GOVERNED_DIRECT_ACTION_CRITERION));
		assert.match(ROUTER_SKILL, new RegExp(DIVO_GOVERNED_LOCAL_WORKFLOW_CRITERION));
		assert.match(DIVO_LOCAL_EXECUTION_PROMPT, /write once/i);
		assert.match(DIVO_LOCAL_EXECUTION_PROMPT, /edit on the same Python file/i);
		assert.match(DIVO_LOCAL_EXECUTION_PROMPT, /rerun the same Bash command/i);
		assert.match(DIVO_LOCAL_EXECUTION_PROMPT, /divo-local client/i);
		assert.match(DIVO_LOCAL_EXECUTION_PROMPT, /Gmail\/CRM → Sheets is always this path/i);
		assert.match(DIVO_LOCAL_EXECUTION_PROMPT, /Keep all connected reads, writes, and verification.*inside the file through divo-local/i);
		assert.match(DIVO_LOCAL_EXECUTION_PROMPT, /retired divo_python_automation tool is unavailable/i);
		assert.doesNotMatch(DIVO_COMPANY_PERSONA_PROMPT, /use one divo_python_automation call/i);
		assert.match(ROUTER_SKILL, /Create one descriptive `.py` file/i);
		assert.match(ROUTER_SKILL, /patch the same `.py` file with `edit`/i);
		assert.match(ROUTER_SKILL, /Gmail\/CRM → Sheets is always this local-workflow path/i);
		assert.match(ROUTER_SKILL, /all connected reads, writes, and verification inside the same file through `divo-local`/i);
		assert.match(ROUTER_SKILL, /retired `divo_python_automation` tool is unavailable/i);
	});

	it("keeps direct provider access forbidden while permitting the governed local bridge", () => {
		assert.match(DIVO_COMPANY_PERSONA_PROMPT, /Never call Lark directly from Bash/i);
		assert.match(
			DIVO_COMPANY_PERSONA_PROMPT,
			/credential-free divo-local from one persistent Python file.*pagination.*record set/s,
		);
		assert.doesNotMatch(JSON.stringify(DIVO_GATEWAY_PARAMS), /google\.plan/);
	});

	it("keeps Lark outcomes in chat while local artifact delivery is disabled", () => {
		assert.match(DIVO_COMPANY_PERSONA_PROMPT, /complete user-facing outcome in Lark chat/i);
		assert.match(DIVO_COMPANY_PERSONA_PROMPT, /Do not create a local artifact/i);
		assert.match(DIVO_COMPANY_PERSONA_PROMPT, /inaccessible workspace path/i);
		assert.doesNotMatch(DIVO_COMPANY_PERSONA_PROMPT, /artifact surface/i);
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
		assert.match(DIVO_DIRECT_WEB_SEARCH_POLICY, /then call webSearch/i);
		assert.match(
			DIVO_DIRECT_WEB_SEARCH_POLICY,
			/do not by themselves make a request a specialized workflow/i,
		);
	});
});
