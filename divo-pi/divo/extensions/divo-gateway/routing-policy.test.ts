import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { Check } from "typebox/value";
import {
	DIVO_COMPANY_PERSONA_PROMPT,
	DIVO_DIRECT_WEB_SEARCH_POLICY,
	DIVO_GOVERNED_DIRECT_ACTION_CRITERION,
	DIVO_GOVERNED_LOCAL_WORKFLOW_CRITERION,
	DIVO_LOCAL_EXECUTION_PROMPT,
	DIVO_LOCAL_EXECUTION_UNAVAILABLE_PROMPT,
	nativeSkillPromptSummary,
} from "./index.ts";
import { localCliEnabled } from "./local-broker.ts";
import { DIVO_CONNECTIONS_PARAMS } from "./typed-platform-tools.ts";

const ROUTER_SKILL = readFileSync(
	new URL("../../skills/divo-gateway/SKILL.md", import.meta.url),
	"utf8",
);

describe("Divo normal-session routing policy", () => {
	it("reports native skills that survive into Pi's model prompt", () => {
		assert.deepEqual(
			nativeSkillPromptSummary(
				[
					{ filePath: "/app/divo/skills/divo-gateway/SKILL.md" },
					{ filePath: "/run/divo-skills/current/google-sheets/SKILL.md" },
				],
				"<available_skills><skill></skill><skill></skill></available_skills>",
			),
			{ loaded: 2, native: 1, exposed: 2 },
		);
	});

	it("routes an ordinary current-information comparison directly to webSearch", () => {
		assert.match(DIVO_DIRECT_WEB_SEARCH_POLICY, /read the exact Web Search skill from Pi's available_skills/i);
		assert.match(DIVO_DIRECT_WEB_SEARCH_POLICY, /missing guidance as permission denial/i);
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

	it("keeps the bundled router skill aligned with Pi-native routing", () => {
		assert.match(ROUTER_SKILL, /using no skill is correct/i);
		assert.match(ROUTER_SKILL, /read the exact Web Search skill from Pi's `available_skills`/i);
		assert.match(ROUTER_SKILL, /missing guidance as permission denial/i);
		assert.doesNotMatch(ROUTER_SKILL, /immediately invoke `tools\.invoke`/i);
		assert.match(ROUTER_SKILL, /without fuzzy skill discovery/i);
		assert.doesNotMatch(ROUTER_SKILL, /before planning every meaningful company task/i);
		assert.doesNotMatch(ROUTER_SKILL, /For every meaningful .*call `divo_skill_resolve`/i);
		assert.doesNotMatch(ROUTER_SKILL, /resolve\/fetch the backend `research` skill/i);
		assert.match(ROUTER_SKILL, /drive\.google\.com\/file\/d/);
		assert.match(ROUTER_SKILL, /Never derive a Google ID, request a download URL, or call `import_to_google_sheets` directly/i);
		assert.match(ROUTER_SKILL, /backend delivers the confirmation card and owns creation/i);
		assert.doesNotMatch(ROUTER_SKILL, /compact capability catalogue as the normal routing map/i);
	});

	it("requires artifact links and verified counts in the terminal answer", () => {
		assert.match(DIVO_COMPANY_PERSONA_PROMPT, /final answer is the only result the user is guaranteed to receive/i);
		assert.match(DIVO_COMPANY_PERSONA_PROMPT, /Repeat every canonical artifact link and requested verified count/i);
		assert.match(DIVO_COMPANY_PERSONA_PROMPT, /Never say "the link above"/i);
		assert.match(ROUTER_SKILL, /Repeat every canonical artifact link and requested verified count/i);
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

	it("treats Airtable as an exact governed connection family", () => {
		assert.equal(Check(DIVO_CONNECTIONS_PARAMS, { provider: "airtable" }), true);
		assert.match(DIVO_COMPANY_PERSONA_PROMPT, /airtable for Airtable/i);
		assert.match(DIVO_COMPANY_PERSONA_PROMPT, /never omit provider/i);
		assert.match(ROUTER_SKILL, /airtable.*for Airtable/i);
		assert.match(ROUTER_SKILL, /never omit `provider`/i);
	});

	it("treats Shopify as an exact governed connection family", () => {
		assert.equal(Check(DIVO_CONNECTIONS_PARAMS, { provider: "shopify" }), true);
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
		assert.match(DIVO_LOCAL_EXECUTION_PROMPT, /--output.*DIVO_RUN_DIR.*never print or cat rows/i);
		assert.match(DIVO_LOCAL_EXECUTION_PROMPT, /read the exact source recipe and the native divo-python-automation skill in this turn/i);
		assert.match(DIVO_LOCAL_EXECUTION_PROMPT, /a tool schema is not a source recipe/i);
		assert.match(DIVO_LOCAL_EXECUTION_PROMPT, /Do not write or run until those reads succeed/i);
		assert.match(DIVO_LOCAL_EXECUTION_PROMPT, /ask one short clarifying question instead of guessing a provider contract/i);
		assert.match(DIVO_LOCAL_EXECUTION_PROMPT, /divo-local invoke --tool <toolId> --args-file <path> --output <new-run-path>/i);
		assert.match(DIVO_LOCAL_EXECUTION_PROMPT, /provider result is under data.*Never count keys/is);
		assert.match(DIVO_LOCAL_EXECUTION_PROMPT, /never print preview or row values/i);
		assert.match(DIVO_LOCAL_EXECUTION_PROMPT, /provider schema describe also runs once inside this same file through divo-local/i);
		assert.match(DIVO_LOCAL_EXECUTION_PROMPT, /never call the registered provider tool first and then rediscover the same schema/i);
		assert.match(DIVO_LOCAL_EXECUTION_PROMPT, /retired divo_python_automation tool is unavailable/i);
		assert.doesNotMatch(DIVO_COMPANY_PERSONA_PROMPT, /use one divo_python_automation call/i);
		assert.match(ROUTER_SKILL, /Create one descriptive `.py` file/i);
		assert.match(ROUTER_SKILL, /patch the same `.py` file with `edit`/i);
		assert.match(ROUTER_SKILL, /Gmail\/CRM → Sheets is always this local-workflow path/i);
		assert.match(ROUTER_SKILL, /all connected reads, writes, and verification inside the same file through `divo-local`/i);
		assert.match(ROUTER_SKILL, /retired `divo_python_automation` tool is unavailable/i);
	});

	it("asks once instead of executing materially ambiguous work", () => {
		assert.match(DIVO_COMPANY_PERSONA_PROMPT, /CHASE MATERIAL CLARITY BEFORE EXECUTION/i);
		assert.match(DIVO_COMPANY_PERSONA_PROMPT, /at most one bounded read-only discovery call.*ask one short question and stop/is);
		assert.match(ROUTER_SKILL, /missing detail that could make the user reasonably reject the result/i);
		assert.match(ROUTER_SKILL, /Never choose the first plausible option/i);
		assert.match(ROUTER_SKILL, /one clear safe default.*presentation only/is);
	});

	it("keeps direct provider access forbidden while permitting the governed local bridge", () => {
		assert.match(DIVO_COMPANY_PERSONA_PROMPT, /Never call Lark directly from Bash/i);
		assert.match(
			DIVO_COMPANY_PERSONA_PROMPT,
			/credential-free divo-local from one persistent Python file.*pagination.*record set/s,
		);
		assert.doesNotMatch(JSON.stringify(DIVO_CONNECTIONS_PARAMS), /google\.plan/);
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

/**
 * The Menhood regression: on 2026-08-03 the runtime stopped writing the
 * divo-local launcher on server channels, and the prompt kept prescribing it.
 * Four days later an agent followed the prompt, hit FileNotFoundError, and
 * finished the task by pasting a 303-row sheet into a source literal — losing
 * ten rows and reporting the total as complete. Nothing failed loudly enough to
 * catch it, because a prompt and a runtime flag can disagree in silence.
 *
 * These bind the two together: whichever way the flag points, the instruction
 * the agent receives has to agree with what the channel can actually do.
 */
describe("divo-local prompt tracks the runtime flag", () => {
	it("offers the client only when the channel actually provides it", () => {
		const offered = localCliEnabled();
		assert.match(DIVO_LOCAL_EXECUTION_PROMPT, /divo-local client/i);
		assert.doesNotMatch(DIVO_LOCAL_EXECUTION_UNAVAILABLE_PROMPT, /use the.*divo-local client/i);
		assert.match(
			DIVO_LOCAL_EXECUTION_UNAVAILABLE_PROMPT,
			/There is no divo-local client on this channel/i,
		);
		// A disabled channel must not be told the absence is a fault to work around.
		assert.match(DIVO_LOCAL_EXECUTION_UNAVAILABLE_PROMPT, /absent by design, not broken/i);
		assert.equal(typeof offered, "boolean");
	});

	it("keeps skill provenance out of model-authored broker requests", () => {
		assert.match(DIVO_LOCAL_EXECUTION_PROMPT, /Never supply skillId/i);
		assert.match(DIVO_LOCAL_EXECUTION_PROMPT, /runtime attaches trusted provenance/i);
	});

	it("names the replacement route instead of leaving a hole", () => {
		assert.match(DIVO_LOCAL_EXECUTION_UNAVAILABLE_PROMPT, /aggregates server-side/i);
		assert.match(DIVO_LOCAL_EXECUTION_UNAVAILABLE_PROMPT, /backend export pipeline/i);
		assert.match(DIVO_LOCAL_EXECUTION_UNAVAILABLE_PROMPT, new RegExp(DIVO_GOVERNED_LOCAL_WORKFLOW_CRITERION));
		assert.match(DIVO_LOCAL_EXECUTION_UNAVAILABLE_PROMPT, new RegExp(DIVO_GOVERNED_DIRECT_ACTION_CRITERION));
	});

	it("forbids the fallback that actually caused the wrong number", () => {
		assert.match(
			DIVO_LOCAL_EXECUTION_UNAVAILABLE_PROMPT,
			/Never reconstruct a record set inside a script, a tool argument, or a message/i,
		);
		assert.match(DIVO_LOCAL_EXECUTION_UNAVAILABLE_PROMPT, /silently lossy/i);
		// Stopping must be presented as the better outcome, or the agent improvises.
		assert.match(DIVO_LOCAL_EXECUTION_UNAVAILABLE_PROMPT, /stop and say exactly which step is unavailable/i);
		assert.match(DIVO_LOCAL_EXECUTION_UNAVAILABLE_PROMPT, /do not describe an approximation as a result/i);
	});
});

/**
 * Every fabrication in the Menhood stress test lived in the prose around the
 * tables, never in the tables: a 5x multiplier borrowed from an unrelated
 * comparison and contradicting the model's own printed figures, a three-month
 * total relabelled as a monthly rate and inflating a headline by 2.6x, and a
 * budget narrative asserted over a source that holds no spend data at all.
 *
 * These are not Menhood-specific, so the rule is not either. It belongs beside
 * the persona every run receives, and it is pinned here so the summarizing
 * discipline cannot be quietly dropped from it.
 */
describe("derived claims discipline", () => {
	it("requires every derived figure to come from a query", () => {
		assert.match(DIVO_COMPANY_PERSONA_PROMPT, /Retrieved rows are evidence/i);
		assert.match(DIVO_COMPANY_PERSONA_PROMPT, /must come from a query, not from arithmetic you performed while writing/i);
		assert.match(DIVO_COMPANY_PERSONA_PROMPT, /retrieve both and divide them in SQL/i);
	});

	it("blocks the two arithmetic failures that actually shipped", () => {
		// A multiplier borrowed across comparisons.
		assert.match(DIVO_COMPANY_PERSONA_PROMPT, /never carries to a different one/i);
		// A total presented as a rate.
		assert.match(DIVO_COMPANY_PERSONA_PROMPT, /A three-month total is not a monthly figure/i);
		assert.match(DIVO_COMPANY_PERSONA_PROMPT, /State the divisor beside any rate/i);
		// Contradicting its own table.
		assert.match(DIVO_COMPANY_PERSONA_PROMPT, /re-read the numbers you already presented/i);
	});

	it("forbids asserting causes, spend, or margins with no source", () => {
		assert.match(
			DIVO_COMPANY_PERSONA_PROMPT,
			/Never assert a cause, a budget decision, a spend level, a cost, or a margin/i,
		);
		assert.match(DIVO_COMPANY_PERSONA_PROMPT, /not evidence of what anyone spent or decided/i);
		// Absence has to be reportable, or it gets filled in.
		assert.match(DIVO_COMPANY_PERSONA_PROMPT, /absence is a finding to report, not a gap to fill/i);
	});

	it("carries a result's stated limits into the summary and any recommendation", () => {
		assert.match(DIVO_COMPANY_PERSONA_PROMPT, /carry those limits into every sentence/i);
		assert.match(DIVO_COMPANY_PERSONA_PROMPT, /including the summary and any recommendation/i);
		assert.match(DIVO_COMPANY_PERSONA_PROMPT, /Do not invent a figure for a limit the result did not quantify/i);
		assert.match(DIVO_COMPANY_PERSONA_PROMPT, /say what would confirm it instead of prescribing the action/i);
	});
});
