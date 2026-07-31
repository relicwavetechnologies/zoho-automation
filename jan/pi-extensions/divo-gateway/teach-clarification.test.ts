import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	executeTeachClarification,
	validateTeachClarificationRequest,
} from "./teach-clarification.ts";
import { DIVO_RUN_CONTEXT_PATH_ENV } from "./run-correlation.ts";

const originalContextPath = process.env[DIVO_RUN_CONTEXT_PATH_ENV];

afterEach(() => {
	if (originalContextPath === undefined) delete process.env[DIVO_RUN_CONTEXT_PATH_ENV];
	else process.env[DIVO_RUN_CONTEXT_PATH_ENV] = originalContextPath;
});

const proposal = {
	reason: "The recording does not establish the trigger or action boundary.",
	questions: [
		{
			id: "trigger",
			question: "When should Divo run this workflow?",
			selection: "single",
			options: [
				{ id: "new-email", label: "When a new email arrives" },
				{ id: "manual", label: "Only when I ask" },
			],
		},
	],
};

describe("Teach clarification protocol", () => {
	it("validates bounded material questions and defaults custom answers on", () => {
		const validated = validateTeachClarificationRequest(proposal);
		assert.equal(validated.questions[0]?.allowCustom, true);
		assert.throws(
			() => validateTeachClarificationRequest({ ...proposal, questions: [] }),
			/one to three questions/i,
		);
	});

	it("pauses the Teach run and returns structured manager answers to the agent", async () => {
		const dir = await mkdtemp(join(tmpdir(), "divo-teach-clarification-"));
		const contextPath = join(dir, "run-context.json");
		await writeFile(contextPath, JSON.stringify({
			version: 1,
			threadId: "thread-1",
			runId: "run-1",
			profile: "teach",
			teachSessionId: "teach-1",
			departmentId: "department-1",
		}));
		process.env[DIVO_RUN_CONTEXT_PATH_ENV] = contextPath;
		let title = "";
		let request = "";
		const result = await executeTeachClarification(proposal, {
			ui: {
				editor: async (receivedTitle: string, receivedRequest: string) => {
					title = receivedTitle;
					request = receivedRequest;
					return JSON.stringify({
						version: 1,
						decision: "answer",
						answers: [{ questionId: "trigger", selectedOptionIds: ["new-email"] }],
					});
				},
			} as never,
		});
		assert.equal(title, "divo_teach_clarification_v1");
		assert.match(request, /"profile":"teach"/);
		assert.match(result.content[0]?.text ?? "", /When a new email arrives/);
		assert.equal(result.details.decision, "answer");
		await rm(dir, { recursive: true, force: true });
	});
});
