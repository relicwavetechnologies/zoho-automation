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

	it("forwards the broker-owned local-file result mode", async () => {
		let resultMode: unknown;
		await executeGatewayRequest(
			config,
			{ op: "tools.invoke", payload: { toolId: "zohoBooks", args: {} } },
			"call-file",
			{ ...ctx, runtimeChannel: "lark", resultMode: "local-file" },
			{
				callGateway: async (_config, _request, _fetch, options) => {
					resultMode = options.resultMode;
					return { body: { ok: true, status: "success", data: {} }, httpStatus: 200 };
				},
			},
		);

		assert.equal(resultMode, "local-file");
	});

	it("never opens client-local approval from a backend-driven runtime", async () => {
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
		for (const runtimeChannel of ["lark", "web"] as const) {
			const requests: GatewayRequestBody[] = [];
			const result = await executeGatewayRequest(config, original, "call-write", {
				...ctx,
				runtimeChannel,
			}, {
				callGateway: async (_config, request) => {
					requests.push(request);
					return {
						body: {
							ok: false,
							status: "requester_confirmation_required",
							data: { intentId: "intent-1", presentation: { operation: "send" } },
						},
						httpStatus: 200,
					};
				},
				approveIntent: async () => {
					throw new Error(`${runtimeChannel} must not open client-local approval`);
				},
			});

			assert.equal(result.body.status, "requester_confirmation_required", runtimeChannel);
			assert.deepEqual(requests, [original], runtimeChannel);
		}
	});
});
