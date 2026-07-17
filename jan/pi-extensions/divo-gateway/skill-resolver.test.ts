import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clearDivoGatewaySkillCache } from "./gateway-client.ts";
import {
	DIVO_SKILL_POLICY,
	formatSkillResolveResult,
	resolveDivoSkills,
} from "./skill-resolver.ts";

describe("resolveDivoSkills", () => {
	it("uses skills.search as the backend ranking authority", async () => {
		clearDivoGatewaySkillCache();
		let calls = 0;
		const operations: string[] = [];
		const fetchImpl = async (_url: string, init?: RequestInit) => {
			calls += 1;
			const operation = JSON.parse(String(init?.body)).op as string;
			operations.push(operation);
			if (operation === "skills.get") {
				return new Response(JSON.stringify({
					ok: true,
					status: "success",
					data: { skill: {
						id: "google-workspace",
						name: "Google Workspace",
						description: "Use connected Google Workspace Gmail Drive Calendar accounts.",
						instructions: "Use the governed Google tool and preserve account selection.",
						toolIds: ["googleGmail", "googleDrive", "googleCalendar"],
						revision: 4,
					} },
				}), { status: 200, headers: { "Content-Type": "application/json" } });
			}
			return new Response(JSON.stringify({
				ok: true,
				status: "success",
				data: { skills: [{
					id: "google-workspace",
					name: "Google Workspace",
					description: "Use connected Google Workspace Gmail Drive Calendar accounts.",
					toolIds: ["googleGmail", "googleDrive", "googleCalendar"],
				}] },
			}), { status: 200, headers: { "Content-Type": "application/json" } });
		};
		const env = {
			DIVO_BACKEND_URL: "http://localhost:8000",
			DIVO_MEMBER_TOKEN: "token-catalog-cache",
			DIVO_SKILL_DIRS: "/untrusted/local/skills",
		};

		const first = await resolveDivoSkills({ query: "gmail", env, fetchImpl: fetchImpl as typeof fetch });
		const second = await resolveDivoSkills({ query: "calendar", env, fetchImpl: fetchImpl as typeof fetch });
		const cached = await resolveDivoSkills({ query: "gmail", env, fetchImpl: fetchImpl as typeof fetch });

		assert.equal(calls, 3);
		assert.deepEqual(operations, ["skills.search", "skills.get", "skills.search"]);
		assert.equal(first.policy, DIVO_SKILL_POLICY);
		assert.equal(first.selected?.id, "google-workspace");
		assert.equal(second.selected?.id, "google-workspace");
		assert.equal(cached.selected?.id, "google-workspace");
		assert.equal(first.selected?.instructions, "Use the governed Google tool and preserve account selection.");
		assert.equal(first.selected?.revision, 4);
		assert.match(formatSkillResolveResult(first), /Loaded approved recipe \(revision 4\)/);
		assert.doesNotMatch(formatSkillResolveResult(first), /local skill|read .*skill\.md|call .*skills\.get/i);
	});

	it("fails closed when the backend registry is unavailable even when local paths exist", async () => {
		const result = await resolveDivoSkills({
			query: "extract OCR text from this PDF",
			env: { DIVO_SKILL_DIRS: "/untrusted/local/skills" },
		});

		assert.equal(result.policy, DIVO_SKILL_POLICY);
		assert.equal(result.selected, null);
		assert.deepEqual(result.results, []);
		assert.ok(result.notes.some((note) => /registry is unavailable/i.test(note)));
		assert.match(formatSkillResolveResult(result), /No matching company skills found/i);
	});

	it("uses the backend Google plan for vendor onboarding and keeps later recipes lazy", async () => {
		clearDivoGatewaySkillCache();
		const requests: Array<{ op: string; payload?: Record<string, unknown> }> = [];
		const result = await resolveDivoSkills({
			query: "Find the vendor onboarding Gmail thread, resolve through Google Contacts, create a Google Doc and Google Sheet tracker",
			env: { DIVO_BACKEND_URL: "http://localhost:8000", DIVO_MEMBER_TOKEN: "token-plan" },
			fetchImpl: (async (_url: string, init?: RequestInit) => {
				requests.push(JSON.parse(String(init?.body)));
				return new Response(JSON.stringify({
					ok: true, status: "success", data: {
						workflow: "vendor_onboarding",
						parent: { id: "google", name: "Google Workspace", description: "parent", instructions: "Compact parent guidance" },
						connection: { message: "Selection is execution-time." },
						phases: [
							{ id: "source", name: "Gmail source", skillId: "gmail-id", toolId: "googleGmail", skill: { id: "gmail-id", name: "Gmail", description: "mail", instructions: "Gmail recipe", toolIds: ["googleGmail"], revision: 1 } },
							{ id: "contact", name: "Google Contacts", skillId: "contacts-id", toolId: "googleContacts" },
							{ id: "brief", name: "Google Docs", skillId: "docs-id", toolId: "googleDocs" },
							{ id: "tracker", name: "Google Sheets", skillId: "sheets-id", toolId: "googleSheets" },
						],
					},
				}), { status: 200 });
			}) as typeof fetch,
		});
		assert.deepEqual(requests.map((request) => request.op), ["google.plan"]);
		assert.deepEqual(requests[0]?.payload?.phaseIds, ["gmail_source", "google_contact", "google_doc", "google_sheet"]);
		assert.match(result.selected?.instructions ?? "", /Compact parent guidance/);
		assert.match(result.selected?.instructions ?? "", /Gmail recipe/);
		assert.match(formatSkillResolveResult(result), /Google Contacts — contacts-id/);
		assert.match(formatSkillResolveResult(result), /later exact skill ID/i);
		assert.match(formatSkillResolveResult(result), /Compact parent guidance/);
		assert.doesNotMatch(formatSkillResolveResult(result), /Google Contacts recipe/);
	});

	it("routes a Gmail-only vendor thread request to the Gmail specialist instead of the multi-product plan", async () => {
		clearDivoGatewaySkillCache();
		const operations: string[] = [];
		const result = await resolveDivoSkills({
			query: "Find the single latest Gmail thread related to vendor onboarding; this is read-only",
			env: { DIVO_BACKEND_URL: "http://localhost:8000", DIVO_MEMBER_TOKEN: "token-gmail-only" },
			fetchImpl: (async (_url: string, init?: RequestInit) => {
				const operation = JSON.parse(String(init?.body)).op as string;
				operations.push(operation);
				if (operation === "skills.get") {
					return new Response(JSON.stringify({
						ok: true, status: "success", data: { skill: {
							id: "gmail-id", name: "Gmail", description: "mail", instructions: "Bounded Gmail recipe",
							toolIds: ["googleGmail"], revision: 5,
						} },
					}), { status: 200 });
				}
				return new Response(JSON.stringify({
					ok: true, status: "success", data: { skills: [{
						id: "gmail-id", name: "Gmail", description: "mail", toolIds: ["googleGmail"], score: 12,
					}] },
				}), { status: 200 });
			}) as typeof fetch,
		});

		assert.deepEqual(operations, ["skills.search", "skills.get"]);
		assert.equal(result.selected?.id, "gmail-id");
		assert.match(result.selected?.instructions ?? "", /Bounded Gmail recipe/);
	});

	it("does not fall back to a partial generic skill when the required Google plan is denied", async () => {
		clearDivoGatewaySkillCache();
		const operations: string[] = [];
		const result = await resolveDivoSkills({
			query: "vendor onboarding from Gmail into Google Contacts, Google Docs, and Google Sheets",
			env: { DIVO_BACKEND_URL: "http://localhost:8000", DIVO_MEMBER_TOKEN: "token-denied-plan" },
			fetchImpl: (async (_url: string, init?: RequestInit) => {
				operations.push(JSON.parse(String(init?.body)).op);
				return new Response(JSON.stringify({
					ok: false, status: "permission_denied", error: { message: "Google Docs update is not granted" },
				}), { status: 200 });
			}) as typeof fetch,
		});
		assert.deepEqual(operations, ["google.plan"]);
		assert.equal(result.selected, null);
		assert.deepEqual(result.results, []);
		assert.ok(result.notes.some((note) => /google\.plan returned permission_denied/i.test(note)));
	});
});
