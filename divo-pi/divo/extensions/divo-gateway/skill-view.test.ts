import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadDivoSkill, parseLoadedSkill, registerDivoSkillView } from "./skill-view.ts";

describe("Divo exact skill view", () => {
	it("advertises only the narrow compatibility use", () => {
		let registered: Record<string, unknown> | undefined;
		registerDivoSkillView({
			registerTool: (tool: Record<string, unknown>) => {
				registered = tool;
			},
		} as unknown as ExtensionAPI);

		assert.match(String(registered?.description), /Compatibility loader/i);
		assert.match(String(registered?.promptSnippet), /Do not use divo_skill_view for ordinary native skills/i);
		assert.match(String(registered?.promptSnippet), /provenance-bound knowledge-publishing/i);
		assert.doesNotMatch(String(registered?.promptSnippet), /scheduling/i);
	});

	it("loads an exact skill through the backend-owned skills.get operation", async () => {
		let request: unknown;
		const skill = await loadDivoSkill({ skillId: "skill-1", departmentId: "dept-1" }, {
			resolveConfig: () => ({
				backendUrl: "http://localhost:8000",
				memberToken: "member-token",
			}),
			callGateway: async (_config, input) => {
				request = input;
				return {
					httpStatus: 200,
					body: {
						ok: true,
						status: "success",
						data: {
							registryRevision: 11,
							skill: {
								id: "skill-1",
								slug: "daily-report",
								name: "Daily Report",
								description: "Prepare the daily report.",
								instructions: "Follow these steps.",
								toolIds: ["googleSheets"],
								revision: 3,
							},
							bootstrap: {
								version: 1,
								scope: "run",
								registryRevision: 11,
								tools: [{
									id: "googleSheets",
									family: "google",
									description: "Read and write Google Sheets.",
									allowedActions: ["read", "create"],
									parameterDocs: "connectionId, op, input",
									argsSchema: { type: "object" },
								}],
								nativeContracts: [],
								connections: [],
								advisories: [],
							},
						},
					},
				};
			},
		});

		assert.deepEqual(request, {
			op: "skills.get",
			departmentId: "dept-1",
			payload: { skillId: "skill-1" },
		});
		assert.equal(skill.slug, "daily-report");
		assert.equal(skill.registryRevision, 11);
		assert.equal(skill.bootstrap?.tools[0]?.id, "googleSheets");
	});

	it("rejects denied and malformed responses instead of treating them as recipes", () => {
		assert.throws(() => parseLoadedSkill({
			ok: false,
			status: "permission_denied",
			error: { message: "Skill is not available for this user" },
		}), /not available/i);
		assert.throws(() => parseLoadedSkill({
			ok: true,
			status: "success",
			data: { skill: { id: "skill-1" } },
		}), /missing slug/i);
	});
});
