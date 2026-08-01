import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { executeGatewayRequest } from "./gateway-execution.ts";
import type { GatewayRequestBody } from "./gateway-client.ts";

const config = { backendUrl: "http://localhost:4000", memberToken: "member-token" };
const ctx = {
	cwd: "/workspace",
	signal: undefined,
	ui: { confirm: async () => true },
};

describe("gateway execution protocol", () => {
	it("executes a read with one gateway request", async () => {
		const requests: GatewayRequestBody[] = [];
		const result = await executeGatewayRequest(
			config,
			{ op: "tools.invoke", payload: { toolId: "googleGmail", args: { op: "search" } } },
			"call-read",
			ctx,
			{
				callGateway: async (_config, request) => {
					requests.push(request);
					return { body: { ok: true, status: "success", data: { messages: [] } }, httpStatus: 200 };
				},
			},
		);

		assert.equal(result.body.status, "success");
		assert.equal(requests.length, 1);
	});

	it("never opens desktop-local approval from the cloud runtime", async () => {
		const requests: GatewayRequestBody[] = [];
		const original: GatewayRequestBody = {
			op: "tools.invoke",
			departmentId: "dept-1",
			payload: { toolId: "googleGmail", args: { op: "send" } },
			execution: {
				version: 1,
				threadId: "thread-1",
				runId: "run-1",
				actionId: "tool-write",
			},
		};
		const result = await executeGatewayRequest(config, original, "call-write", ctx, {
			callGateway: async (_config, request) => {
				requests.push(request);
				return {
					body: {
						ok: false,
						status: "local_approval_required",
						data: { intentId: "intent-1", presentation: { operation: "send" } },
					},
					httpStatus: 200,
				};
			},
		});

		assert.equal(result.body.status, "local_approval_required");
		assert.deepEqual(requests, [original]);
	});
});
