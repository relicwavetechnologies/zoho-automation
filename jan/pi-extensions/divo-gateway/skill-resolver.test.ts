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
});
