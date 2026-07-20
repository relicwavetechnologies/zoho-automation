import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clearDivoGatewaySkillCache } from "./gateway-client.ts";
import {
	DIVO_SKILL_POLICY,
	formatSkillResolveResult,
	resolveDivoSkills,
} from "./skill-resolver.ts";

function workResolutionData() {
	return {
		originalQuery: "Research the best TTS models and write an HTML document",
		queries: [
			"Research the best TTS models and write an HTML document",
			"Compare current TTS models using public web research and benchmarks",
			"Present the findings as an interactive HTML dashboard",
		],
		registryRevision: 9,
		persona: {
			rules: [{
				nodeId: "persona-node-1",
				scopeKey: "project-prototyping",
				ruleKey: "html-preview-first",
				kind: "workflow",
				instruction: "Use the linked Cursor dashboard skill.",
				confidence: 0.95,
				matchScore: 8.5,
				matchedOn: ["instruction", "skill"],
				learningSources: [{
					source: "teach",
					sourceId: "teach-1",
					rationale: "The manager demonstrated this presentation style.",
					evidenceRefs: ["frame-1"],
					learnedAt: "2026-07-19T00:00:00.000Z",
				}],
				linkedSkills: [],
			}],
			linkedSkills: [{
				source: "persona_link",
				references: [{ nodeId: "persona-node-1", scopeKey: "project-prototyping", ruleKey: "html-preview-first" }],
				skill: {
					id: "cursor-dashboard",
					slug: "cursor-dashboard",
					name: "Cursor Design HTML Dashboard",
					description: "Interactive HTML dashboard",
					instructions: "Use Cursor tokens, tabs, and state transitions.",
					toolIds: [],
					revision: 2,
				},
			}],
		},
		additionalSkills: [{
			source: "skill_search",
			matchedQueries: ["Compare current TTS models using public web research and benchmarks"],
			bestScore: 14,
			reason: "Passed the strong fuzzy-match threshold for this request.",
			skill: {
				id: "web-search",
				slug: "web-search",
				name: "Web Search",
				description: "Research current public information",
				instructions: "Search multiple current sources and cite evidence.",
				toolIds: ["webSearch"],
				revision: 1,
			},
		}],
		rejectedSkills: [{
			id: "seo-report",
			name: "Competitive SEO Analysis Report",
			bestScore: 7,
			matchedQueries: ["Research the best TTS models and write an HTML document"],
			reason: "Below the strong relevance threshold; do not apply this recipe automatically.",
		}],
	};
}

describe("resolveDivoSkills", () => {
	it("uses one unified work.resolve response with persona provenance and full recipes", async () => {
		clearDivoGatewaySkillCache();
		const requests: Array<{ op: string; payload?: Record<string, unknown> }> = [];
		const env = {
			DIVO_BACKEND_URL: "http://localhost:8000",
			DIVO_MEMBER_TOKEN: "token-work-resolve",
		};
		const variants = [
			"Compare current TTS models using public web research and benchmarks",
			"Present the findings as an interactive HTML dashboard",
		];
		const fetchImpl = (async (_url: string, init?: RequestInit) => {
			requests.push(JSON.parse(String(init?.body)));
			return new Response(JSON.stringify({ ok: true, status: "success", data: workResolutionData() }), { status: 200 });
		}) as typeof fetch;

		const first = await resolveDivoSkills({
			query: "Research the best TTS models and write an HTML document",
			variants,
			env,
			fetchImpl,
		});
		const cached = await resolveDivoSkills({
			query: "Research the best TTS models and write an HTML document",
			variants,
			env,
			fetchImpl,
		});

		assert.equal(requests.length, 1);
		assert.equal(requests[0]?.op, "work.resolve");
		assert.equal(requests[0]?.payload?.query, "Research the best TTS models and write an HTML document");
		assert.deepEqual(requests[0]?.payload?.variants, variants);
		assert.equal(first.policy, DIVO_SKILL_POLICY);
		assert.equal(first.selected?.id, "cursor-dashboard");
		assert.equal(first.selected?.slug, "cursor-dashboard");
		assert.equal(cached.selected?.id, "cursor-dashboard");
		assert.deepEqual(first.results.map(skill => skill.id), ["cursor-dashboard", "web-search"]);
		assert.equal(first.personaRules[0]?.learningSources[0]?.sourceId, "teach-1");
		const formatted = formatSkillResolveResult(first);
		assert.match(formatted, /Manager persona matches/);
		assert.match(formatted, /exact manager-persona link/);
		assert.match(formatted, /multi-query skill search/);
		assert.match(formatted, /Rejected fuzzy matches/);
		assert.match(formatted, /Use Cursor tokens, tabs, and state transitions/);
		assert.doesNotMatch(formatted, /call .*skills\.get/i);
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

	it("resolves work context before adding the governed Google vendor-onboarding plan", async () => {
		clearDivoGatewaySkillCache();
		const requests: Array<{ op: string; payload?: Record<string, unknown> }> = [];
		const result = await resolveDivoSkills({
			query: "Find the vendor onboarding Gmail thread, resolve through Google Contacts, create a Google Doc and Google Sheet tracker",
			env: { DIVO_BACKEND_URL: "http://localhost:8000", DIVO_MEMBER_TOKEN: "token-plan" },
			fetchImpl: (async (_url: string, init?: RequestInit) => {
				const request = JSON.parse(String(init?.body));
				requests.push(request);
				if (request.op === "work.resolve") {
					return new Response(JSON.stringify({
						ok: true, status: "success", data: {
							originalQuery: request.payload.query,
							queries: [request.payload.query],
							persona: { rules: [], linkedSkills: [] },
							additionalSkills: [], rejectedSkills: [],
						},
					}), { status: 200 });
				}
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

		assert.deepEqual(requests.map(request => request.op), ["work.resolve", "google.plan"]);
		assert.deepEqual(requests[1]?.payload?.phaseIds, ["gmail_source", "google_contact", "google_doc", "google_sheet"]);
		assert.match(result.selected?.instructions ?? "", /Compact parent guidance/);
		assert.match(formatSkillResolveResult(result), /Google Contacts — contacts-id/);
	});

	it("does not expose a partial searched skill when the required Google plan is denied", async () => {
		clearDivoGatewaySkillCache();
		const operations: string[] = [];
		const result = await resolveDivoSkills({
			query: "vendor onboarding from Gmail into Google Contacts, Google Docs, and Google Sheets",
			env: { DIVO_BACKEND_URL: "http://localhost:8000", DIVO_MEMBER_TOKEN: "token-denied-plan" },
			fetchImpl: (async (_url: string, init?: RequestInit) => {
				const request = JSON.parse(String(init?.body));
				operations.push(request.op);
				if (request.op === "work.resolve") {
					return new Response(JSON.stringify({
						ok: true, status: "success", data: {
							originalQuery: request.payload.query,
							queries: [request.payload.query],
							persona: { rules: [], linkedSkills: [] },
							additionalSkills: [{
								source: "skill_search", matchedQueries: [request.payload.query], bestScore: 10,
								reason: "strong", skill: { id: "generic", name: "Generic", description: "generic", instructions: "generic", toolIds: [], revision: 1 },
							}],
							rejectedSkills: [],
						},
					}), { status: 200 });
				}
				return new Response(JSON.stringify({
					ok: false, status: "permission_denied", error: { message: "Google Docs update is not granted" },
				}), { status: 200 });
			}) as typeof fetch,
		});

		assert.deepEqual(operations, ["work.resolve", "google.plan"]);
		assert.equal(result.selected, null);
		assert.deepEqual(result.results, []);
		assert.ok(result.notes.some(note => /google\.plan returned permission_denied/i.test(note)));
	});
});
