import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	executePersonalMemory,
	registerPersonalMemoryTool,
	validatePersonalMemoryCommand,
} from "./personal-memory.ts";

const config = { backendUrl: "https://backend.example", memberToken: "token" };

describe("personal memory tool", () => {
	it("exposes one provider-compatible top-level object schema", () => {
		const registered: Array<Record<string, unknown>> = [];
		registerPersonalMemoryTool({
			registerTool: tool => registered.push(tool as unknown as Record<string, unknown>),
		} as ExtensionAPI);

		const parameters = registered[0]?.parameters as Record<string, unknown>;
		assert.equal(parameters.type, "object");
		assert.equal(parameters.additionalProperties, false);
		assert.deepEqual(parameters.required, ["action", "subject", "logicalKey"]);
		assert.equal(parameters.anyOf, undefined);
		assert.equal(parameters.oneOf, undefined);
	});

	it("sends one closed personal command with exact run provenance", async () => {
		const requests: unknown[] = [];
		const result = await executePersonalMemory({
			action: "set",
			subject: "answer detail preference",
			logicalKey: "communication.answers.detail",
			facts: ["The user prefers very detailed answers."],
		}, {
			resolveConfig: () => config,
			readRunCorrelation: async () => ({ threadId: "thread-1", runId: "run-1" }),
			callGateway: async (_config, request) => {
				requests.push(request);
				return {
					httpStatus: 200,
					body: {
						ok: true,
						status: "success",
						data: {
							status: "applied",
							scope: "personal",
							action: "updated",
							logicalKey: "communication.answers.detail",
							resourceId: "resource-1",
							version: 3,
							projection: "completed",
						},
					},
				};
			},
		}, "call-1");

		assert.equal(result.details.outcome, "success");
		assert.deepEqual(requests, [{
			op: "memory.personal.mutate",
			execution: { version: 1, threadId: "thread-1", runId: "run-1", actionId: "call-1" },
			payload: {
				action: "set",
				subject: "answer detail preference",
				logicalKey: "communication.answers.detail",
				facts: ["The user prefers very detailed answers."],
			},
		}]);
		assert.match(result.content[0]!.text, /truthfully acknowledge/i);
	});

	it("rejects fields that could select another scope or identity", () => {
		assert.throws(() => validatePersonalMemoryCommand({
			action: "set",
			subject: "answer detail preference",
			logicalKey: "communication.answers.detail",
			facts: ["Detailed answers."],
			scope: "company",
		}), /accepts only/i);
	});

	it("does not claim persistence when the backend rejects the command", async () => {
		const result = await executePersonalMemory({
			action: "delete",
			subject: "answer detail preference",
			logicalKey: "communication.answers.detail",
		}, {
			resolveConfig: () => config,
			readRunCorrelation: async () => ({ threadId: "thread-1", runId: "run-1" }),
			callGateway: async () => ({
				httpStatus: 200,
				body: {
					ok: false,
					status: "bad_request",
					error: { message: "That personal memory does not exist." },
				},
			}),
		});

		assert.equal(result.details.outcome, "gateway_error");
		assert.match(result.content[0]!.text, /not verified/i);
		assert.doesNotMatch(result.content[0]!.text, /was (?:saved|created|updated|deleted)/i);
	});
});
