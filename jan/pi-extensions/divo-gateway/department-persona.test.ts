import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	composeDivoSystemPrompt,
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
		assert.match(refreshed, /ranking hints/i);
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
				zohoConnection: {
					accessibleCount: 1,
					connectionId: "connection-1",
					label: "Finance Books",
					access: "read_write",
				},
			},
		}));

		const context = await readDepartmentPersonaContext(path);
		const first = composeDivoSystemPrompt("Base prompt", COMPANY_PROMPT, context);
		assert.match(first, /<divo_capability_bootstrap>/);
		assert.match(first, /Department function: finance/);
		assert.match(first, /Finance Ops Core \[skillId=skill-finance\]/);
		assert.match(first, /connectionId=connection-1/);
		assert.match(first, /skip divo_skill_resolve/);

		const refreshed = composeDivoSystemPrompt(first, COMPANY_PROMPT, {
			departmentName: "Engineering",
			departments: ["Engineering"],
		});
		assert.doesNotMatch(refreshed, /<divo_capability_bootstrap>/);
		assert.doesNotMatch(refreshed, /connection-1/);
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
});
