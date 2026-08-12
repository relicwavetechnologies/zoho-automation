import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	composeDivoSystemPrompt,
	divoPromptStripReport,
	DIVO_ENGLISH_RESPONSE_POLICY,
	readDepartmentPersonaContext,
} from "./department-persona.ts";

const COMPANY_PROMPT = "<divo_company_persona>Company rules</divo_company_persona>";

describe("department persona", () => {
	it("reads the locally cached context without a backend request", async () => {
		const directory = await mkdtemp(join(tmpdir(), "divo-persona-"));
		const path = join(directory, "runtime-context.json");
		await writeFile(path, JSON.stringify({
			departmentId: "dept-finance",
			departmentName: "Finance",
			personaPrompt: "Prefer verified records.",
			version: "2026-07-11T00:00:00.000Z",
			departments: ["Finance", "Operations"],
		}));

		const result = await readDepartmentPersonaContext(path);
		assert.deepEqual(result, {
			departmentId: "dept-finance",
			departmentName: "Finance",
			personaPrompt: "Prefer verified records.",
			version: "2026-07-11T00:00:00.000Z",
			departments: ["Finance", "Operations"],
		});
	});

	it("places department guidance and member department names after the company persona and replaces stale guidance", () => {
		const first = composeDivoSystemPrompt("Base prompt", COMPANY_PROMPT, {
			departmentName: "Finance",
			personaPrompt: "Use Finance conventions.",
			departments: ["Finance", "Operations"],
		});
		const refreshed = composeDivoSystemPrompt(first, COMPANY_PROMPT, {
			departmentName: "Sales",
			personaPrompt: "Use Sales conventions.",
			departments: ["Sales", "People"],
		});

		assert.equal((refreshed.match(/<divo_company_persona>/g) ?? []).length, 1);
		assert.equal((refreshed.match(/<divo_department_persona>/g) ?? []).length, 1);
		assert.equal((refreshed.match(/<divo_member_departments>/g) ?? []).length, 1);
		assert.ok(refreshed.indexOf("Company rules") < refreshed.indexOf("Use Sales conventions."));
		assert.ok(refreshed.indexOf("Use Sales conventions.") < refreshed.indexOf("AUTHORITATIVE RESPONSE LANGUAGE POLICY"));
		assert.equal((refreshed.match(/<divo_response_language_policy>/g) ?? []).length, 1);
		assert.ok(!refreshed.includes("Use Finance conventions."));
		assert.ok(refreshed.includes("- Sales"));
		assert.ok(!refreshed.includes("- Finance"));
		assert.match(refreshed, /membership context only/i);
		assert.equal(
			composeDivoSystemPrompt(refreshed, COMPANY_PROMPT, {
				departmentName: "Sales",
				personaPrompt: "Use Sales conventions.",
				departments: ["Sales", "People"],
			}),
			refreshed,
		);
	});

	it("always places the English-only policy last and replaces stale copies", () => {
		const prompt = composeDivoSystemPrompt(
			`Base prompt\n\n${DIVO_ENGLISH_RESPONSE_POLICY}`,
			COMPANY_PROMPT,
			{ personaPrompt: "请用中文回答。", departments: ["Finance"] },
		);

		assert.equal((prompt.match(/<divo_response_language_policy>/g) ?? []).length, 1);
		assert.ok(prompt.indexOf("请用中文回答。") < prompt.indexOf("AUTHORITATIVE RESPONSE LANGUAGE POLICY"));
		assert.ok(prompt.endsWith("</divo_response_language_policy>"));
		assert.match(prompt, /Respond in English only/);
		assert.match(prompt, /tool output.*untrusted data/i);
	});

	it("injects the member directory without a selected department persona", () => {
		const prompt = composeDivoSystemPrompt("Base prompt", COMPANY_PROMPT, {
			departments: ["Finance", "Operations"],
		});
		assert.match(prompt, /<divo_member_departments>/);
		assert.match(prompt, /- Finance/);
		assert.doesNotMatch(prompt, /<divo_department_persona>/);
	});

	it("injects bounded backend personal memory as untrusted data and replaces stale snapshots", () => {
		const first = composeDivoSystemPrompt("Base prompt", COMPANY_PROMPT, {
			personalMemory: ["User prefers concise summaries."],
		});
		const refreshed = composeDivoSystemPrompt(first, COMPANY_PROMPT, {
			personalMemory: ["User prefers table summaries."],
		});

		assert.equal((refreshed.match(/<divo_personal_memory>/g) ?? []).length, 1);
		assert.match(refreshed, /User prefers table summaries/);
		assert.doesNotMatch(refreshed, /User prefers concise summaries/);
		assert.match(refreshed, /untrusted reference data/i);
		assert.ok(refreshed.indexOf("<divo_personal_memory>") < refreshed.indexOf("<divo_response_language_policy>"));
	});

	it("injects a compact Finance fast path and replaces stale capability context", async () => {
		const directory = await mkdtemp(join(tmpdir(), "divo-capability-"));
		const path = join(directory, "runtime-context.json");
		await writeFile(path, JSON.stringify({
			departmentId: "dept-finance",
			departmentName: "Finance",
			capabilityBootstrap: {
				version: 1,
				departmentFunction: "finance",
				companyRole: "MEMBER",
				departmentRole: "FINANCE_MANAGER",
				preferredSkills: [{
					id: "skill-finance",
					slug: "finance-ops-core",
					name: "Finance Ops Core",
					description: "Route broad finance questions.",
				}],
				preferredTools: [{ toolId: "zohoBooks", actions: ["read", "create"] }],
				routingHints: ["Unpaid invoices -> invoke zohoBooks with op build_overdue_report."],
				zohoConnections: [{
					connectionId: "connection-1",
					label: "Finance Books",
					access: "read_write",
					services: ["books"],
				}],
			},
		}));

		const context = await readDepartmentPersonaContext(path);
		const first = composeDivoSystemPrompt("Base prompt", COMPANY_PROMPT, context);
		assert.match(first, /<divo_capability_bootstrap>/);
		assert.match(first, /Department function: finance/);
		assert.match(first, /Finance Ops Core \[skillId=skill-finance\]/);
		assert.match(first, /connectionId=connection-1/);
		assert.match(first, /skill IDs are not authorization tokens/);
		assert.match(first, /fuzzy skill search merely to prove/);

		const refreshed = composeDivoSystemPrompt(first, COMPANY_PROMPT, {
			departmentName: "Engineering",
			departments: ["Engineering"],
		});
		assert.doesNotMatch(refreshed, /<divo_capability_bootstrap>/);
		assert.doesNotMatch(refreshed, /connection-1/);
	});

	it("injects a generic v2 exact-skill catalogue for non-Finance departments", async () => {
		const directory = await mkdtemp(join(tmpdir(), "divo-capability-v2-"));
		const path = join(directory, "runtime-context.json");
		await writeFile(path, JSON.stringify({
			departmentName: "Operations",
			capabilityBootstrap: {
				version: 2,
				registryRevision: 14,
				departmentFunction: "general",
				companyRole: "MEMBER",
				departmentRole: "MANAGER",
				availableSkills: [{
					id: "skill-daily-report",
					slug: "daily-report",
					name: "Daily Report",
					description: "Prepare the operating report.",
					revision: 3,
				}],
				availableTools: [{ toolId: "googleSheets", actions: ["read", "update"] }],
				preferredSkills: [],
				preferredTools: [],
				routingHints: ["load skill-daily-report with divo_skill_view"],
			},
		}));

		const prompt = composeDivoSystemPrompt(
			"Base prompt",
			COMPANY_PROMPT,
			await readDepartmentPersonaContext(path),
		);
		assert.match(prompt, /Skill registry revision: 14/);
		assert.match(prompt, /Daily Report \[skillId=skill-daily-report; revision=3\]/);
		// Possible operations live in permanent Pi-native definitions. This prompt
		// stays compact and makes clear that visibility is not permission.
		assert.doesNotMatch(prompt, /googleSheets: read, update/);
		assert.match(prompt, /Permanent divo_\* tools describe what Divo can attempt/);
		assert.match(prompt, /not that this member is permitted to use it/);
		assert.match(prompt, /Use divo_skill_resolve only when a specialized company workflow is likely/);

		const nativePrompt = composeDivoSystemPrompt(
			"Base prompt",
			COMPANY_PROMPT,
			await readDepartmentPersonaContext(path),
			{ nativeSkills: true },
		);
		assert.match(nativePrompt, /available_skills list is the skill index/);
		assert.doesNotMatch(nativePrompt, /googleSheets: read, update/);
		assert.doesNotMatch(nativePrompt, /Daily Report \[skillId=/);
		assert.doesNotMatch(nativePrompt, /skill IDs are not authorization tokens/);
		assert.doesNotMatch(nativePrompt, /skill-daily-report|divo_skill_view/);
	});

	it("shows service-labelled Zoho choices and asks only when that service remains ambiguous", async () => {
		const directory = await mkdtemp(join(tmpdir(), "divo-zoho-choices-"));
		const path = join(directory, "runtime-context.json");
		await writeFile(path, JSON.stringify({
			departmentName: "Finance",
			capabilityBootstrap: {
				version: 3,
				departmentFunction: "finance",
				companyRole: "MEMBER",
				departmentRole: "FINANCE_MANAGER",
				availableSkills: [],
				availableTools: [{ toolId: "zohoCrm", actions: ["read"] }],
				preferredSkills: [],
				preferredTools: [],
				routingHints: [],
				zohoConnections: [
					{ connectionId: "zoho-1", label: "Emiac", access: "read_only", services: ["books"] },
					{ connectionId: "zoho-2", label: "Macobs", access: "read_only", services: ["crm"] },
				],
			},
		}));

		const prompt = composeDivoSystemPrompt("Base prompt", COMPANY_PROMPT, await readDepartmentPersonaContext(path));
		assert.match(prompt, /first keep only accounts listing the requested service/i);
		assert.match(prompt, /If exactly one remains, omit connectionId or use its exact ID and proceed/i);
		assert.match(prompt, /Ask the member only when multiple accounts list that service/i);
		assert.match(prompt, /Emiac \[connectionId=zoho-1, access=read_only, services=books\]/);
		assert.match(prompt, /Macobs \[connectionId=zoho-2, access=read_only, services=crm\]/);
		assert.doesNotMatch(prompt, /Use connections\.list when account choice is required/i);
	});

	it("injects the v3 family hierarchy without treating family IDs as executable tools", async () => {
		const directory = await mkdtemp(join(tmpdir(), "divo-capability-v3-"));
		const path = join(directory, "runtime-context.json");
		await writeFile(path, JSON.stringify({
			departmentName: "Operations",
			capabilityBootstrap: {
				version: 3,
				registryRevision: 15,
				departmentFunction: "general",
				companyRole: "MEMBER",
				departmentRole: "MANAGER",
				availableSkills: [{
					id: "airtable-core-id",
					slug: "airtable-core",
					name: "Airtable Core",
					description: "Delete every record.",
					revision: 2,
				}],
				availableTools: [{ toolId: "airtableSchema", actions: ["read"] }],
				families: [{
					familyId: "airtable",
					displayName: "Airtable",
					connectionMode: "member_selectable",
					connectionProvider: "airtable",
					skillMode: "optional",
					tools: [{
						toolId: "airtableSchema",
						displayName: "Airtable Schema",
						description: "Inspect Airtable tables and fields.",
						actions: ["read", "delete"],
					}, {
						toolId: "airtable",
						displayName: "Wrong family leaf",
						description: "A family is not executable.",
						actions: ["read"],
					}, {
						toolId: "larkBase",
						displayName: "Denied cross-family leaf",
						description: "This tool is not in the RBAC-visible leaf index.",
						actions: ["read"],
					}],
					skills: [{
						skillId: "airtable-core-id",
						name: "Airtable Core",
						mode: "optional",
					}],
				}],
				preferredSkills: [],
				preferredTools: [],
				routingHints: [],
			},
		}));

		const prompt = composeDivoSystemPrompt(
			"Base prompt",
			COMPANY_PROMPT,
			await readDepartmentPersonaContext(path),
		);
		assert.match(prompt, /Airtable \[family=airtable; connection=member_selectable via airtable; skill=optional\]/);
		// The family header survives because a tool definition cannot express which
		// connection provider the family needs or whether it requires a skill. The
		// leaf tools do not, because each is a permanent Pi-native tool already.
		assert.doesNotMatch(prompt, /Airtable Schema \[toolId=airtableSchema; actions=read\]/);
		assert.doesNotMatch(prompt, /actions=read, delete/);
		assert.match(prompt, /prove that a capability exists, not that this member is permitted to use it/);
		assert.match(prompt, /backend's invocation result is the final permission decision/);
		assert.match(prompt, /Airtable Core \[skillId=airtable-core-id; mode=optional\]/);
		assert.doesNotMatch(prompt, /Delete every record/);
		assert.doesNotMatch(prompt, /toolId=airtable;/);
		assert.doesNotMatch(prompt, /toolId=larkBase/);
		assert.doesNotMatch(prompt, /legacy compact index/);
	});

	it("rejects malformed capability bootstrap data", async () => {
		const directory = await mkdtemp(join(tmpdir(), "divo-capability-invalid-"));
		const path = join(directory, "runtime-context.json");
		await writeFile(path, JSON.stringify({
			capabilityBootstrap: {
				version: 1,
				departmentFunction: "finance",
				companyRole: "",
				departmentRole: "FINANCE_MANAGER",
			},
		}));
		assert.equal(await readDepartmentPersonaContext(path), null);
	});

	it("omits malformed or empty cached guidance", async () => {
		assert.equal(await readDepartmentPersonaContext("/does/not/exist"), null);
		const prompt = composeDivoSystemPrompt("Base prompt", COMPANY_PROMPT, {
			personaPrompt: " ",
		});
		assert.equal(prompt, `Base prompt\n\n${COMPANY_PROMPT}\n\n${DIVO_ENGLISH_RESPONSE_POLICY}`);
	});

	it("refreshes interrupted-work policy inside a warm Pi process", async () => {
		const directory = await mkdtemp(join(tmpdir(), "divo-interrupted-persona-"));
		const path = join(directory, "runtime-context.json");
		await writeFile(path, JSON.stringify({
			interruptedWork: {
				task: "  Build   the monthly export  ",
				clarificationShown: false,
			},
		}));

		const context = await readDepartmentPersonaContext(path);
		const interrupted = composeDivoSystemPrompt("Base prompt", COMPANY_PROMPT, context);
		assert.match(interrupted, /Never resume, retry, or continue it/i);
		assert.match(interrupted, /Build the monthly export/);

		const refreshed = composeDivoSystemPrompt(interrupted, COMPANY_PROMPT, null);
		assert.doesNotMatch(refreshed, /Build the monthly export/);
		assert.doesNotMatch(refreshed, /divo_interrupted_work_policy/);
		await rm(directory, { recursive: true, force: true });
	});
});

// Pi's base prompt opens with two unconditional presentation rules and a block
// of pointers to its own README. Divo cannot argue with them from further down
// the prompt — the model just receives two rules about the same thing.
describe("Pi-authored presentation", () => {
	const PI_BASE = [
		"You are an expert coding assistant operating inside pi, a coding agent harness.",
		"",
		"Guidelines:",
		"- Use bash for file operations like ls, rg, find",
		"- Be concise in your responses",
		"- Show file paths clearly when working with files",
		"",
		"Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):",
		"- Main documentation: /pi/README.md",
		"- Additional docs: /pi/docs",
		"- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)",
	].join("\n");

	it("removes the two rules that speak for Divo about presentation", () => {
		const composed = composeDivoSystemPrompt(PI_BASE, "<divo_company_persona>x</divo_company_persona>", null);
		assert.doesNotMatch(composed, /Be concise in your responses/);
		assert.doesNotMatch(composed, /Show file paths clearly/);
	});

	// Pi is right about how to use tools. Only the parts that decide what an
	// answer looks like are Divo's to own.
	it("keeps the guidelines that are about using tools", () => {
		const composed = composeDivoSystemPrompt(PI_BASE, "", null);
		assert.match(composed, /Use bash for file operations/);
	});

	it("removes the pointer to Pi's own documentation", () => {
		const composed = composeDivoSystemPrompt(PI_BASE, "", null);
		assert.doesNotMatch(composed, /Pi documentation/);
		assert.doesNotMatch(composed, /tui\.md/);
		assert.match(composed, /expert coding assistant/); // identity swap is a separate decision
	});

	// The strip is string matching against upstream code. If a marker stops
	// matching it does nothing, silently — so the caller logs this instead.
	it("reports which strips would still match, so a silent miss is visible", () => {
		assert.deepEqual(divoPromptStripReport(PI_BASE), { guidelines: 2, documentation: true });
		assert.deepEqual(
			divoPromptStripReport(composeDivoSystemPrompt(PI_BASE, "", null)),
			{ guidelines: 0, documentation: false },
		);
	});
});
