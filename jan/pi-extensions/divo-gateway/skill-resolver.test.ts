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
			linkedSkills: [],
		},
		additionalSkills: [],
		rejectedSkills: [],
		routerCandidates: [{
			skillId: "research-router",
			slug: "research-router",
			name: "Research Router",
			description: "Route research work to one exact specialist.",
			score: 14,
			matchedTerms: ["research", "compare"],
		}],
		bootstrap: {
			version: 1,
			scope: "run",
			registryRevision: 9,
			tools: [],
			nativeContracts: [],
			connections: [],
			advisories: [],
		},
	};
}

describe("resolveDivoSkills", () => {
	it("uses router-only work.resolve with advisory persona context", async () => {
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

		// Without trusted desktop run correlation the result is deliberately not
		// cached across calls; normal desktop runs carry a runId and are covered by
		// the gateway-client run-cache test.
		assert.equal(requests.length, 2);
		assert.equal(requests[0]?.op, "work.resolve");
		assert.equal(requests[0]?.payload?.query, "Research the best TTS models and write an HTML document");
		assert.deepEqual(requests[0]?.payload?.variants, variants);
		assert.equal(first.policy, DIVO_SKILL_POLICY);
		assert.equal(first.selected?.id, "research-router");
		assert.equal(first.selected?.slug, "research-router");
		assert.equal(cached.selected?.id, "research-router");
		assert.deepEqual(first.results.map(skill => skill.id), ["research-router"]);
		assert.equal(first.personaRules[0]?.learningSources[0]?.sourceId, "teach-1");
		assert.deepEqual(first.bootstrap?.tools, []);
		assert.deepEqual(first.bootstrap?.nativeContracts, []);
		const formatted = formatSkillResolveResult(first);
		assert.match(formatted, /Manager persona matches/);
		assert.match(formatted, /Router candidates/);
		assert.match(formatted, /router-only DB discovery/);
		assert.match(formatted, /Run bootstrap \(already loaded/);
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

	it("receives the governed Google vendor-onboarding plan through work.resolve", async () => {
		clearDivoGatewaySkillCache();
		const requests: Array<{ op: string; payload?: Record<string, unknown> }> = [];
		const result = await resolveDivoSkills({
			query: "Find the vendor onboarding Gmail thread, resolve through Google Contacts, create a Google Doc and Google Sheet tracker",
			env: { DIVO_BACKEND_URL: "http://localhost:8000", DIVO_MEMBER_TOKEN: "token-plan" },
			fetchImpl: (async (_url: string, init?: RequestInit) => {
				const request = JSON.parse(String(init?.body));
				requests.push(request);
				return new Response(JSON.stringify({
					ok: true, status: "success", data: {
						originalQuery: request.payload.query,
						queries: [request.payload.query],
						persona: { rules: [], linkedSkills: [] },
						additionalSkills: [], rejectedSkills: [],
						googleVendorOnboarding: {
							status: "ready",
							plan: {
								workflow: "vendor_onboarding",
								parent: { id: "google", name: "Google Workspace", description: "parent", instructions: "Compact parent guidance" },
								connection: { message: "Selection is execution-time." },
								phases: [
									{ id: "source", name: "Gmail source", skillId: "gmail-id", toolId: "googleGmail" },
									{ id: "contact", name: "Google Contacts", skillId: "contacts-id", toolId: "googleContacts" },
									{ id: "brief", name: "Google Docs", skillId: "docs-id", toolId: "googleDocs" },
									{ id: "tracker", name: "Google Sheets", skillId: "sheets-id", toolId: "googleSheets" },
								],
							},
						},
					},
				}), { status: 200 });
			}) as typeof fetch,
		});

		assert.deepEqual(requests.map(request => request.op), ["work.resolve"]);
		assert.match(result.selected?.instructions ?? "", /Compact parent guidance/);
		assert.match(formatSkillResolveResult(result), /Google Contacts — contacts-id/);
	});

	it("does not expose a partial searched skill when unified work resolution marks vendor onboarding unavailable", async () => {
		clearDivoGatewaySkillCache();
		const operations: string[] = [];
		const result = await resolveDivoSkills({
			query: "vendor onboarding from Gmail into Google Contacts, Google Docs, and Google Sheets",
			env: { DIVO_BACKEND_URL: "http://localhost:8000", DIVO_MEMBER_TOKEN: "token-denied-plan" },
			fetchImpl: (async (_url: string, init?: RequestInit) => {
				const request = JSON.parse(String(init?.body));
				operations.push(request.op);
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
						googleVendorOnboarding: { status: "unavailable", missing: ["Google Docs"] },
					},
				}), { status: 200 });
			}) as typeof fetch,
		});

		assert.deepEqual(operations, ["work.resolve"]);
		assert.equal(result.selected, null);
		assert.deepEqual(result.results, []);
		assert.ok(result.notes.some(note => /Google Docs/i.test(note)));
	});
});
