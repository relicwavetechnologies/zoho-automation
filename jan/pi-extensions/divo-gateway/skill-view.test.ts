import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadDivoSkill, parseLoadedSkill } from "./skill-view.ts";

describe("Divo exact skill view", () => {
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
