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

	it("waits for a connect ask, then resumes carrying the run's own provenance", async () => {
		/* The execution context is the reason this test exists. Under a Pi runtime
		   lease the backend refuses any call whose execution does not match the
		   signed run and thread, so a resume that drops it is rejected after the
		   member has already connected — the worst possible moment to lose a run.
		   `runtimeChannel` is set here on purpose: backend channels skip requester
		   confirmation, and the connect wait must happen anyway. */
		const requests: GatewayRequestBody[] = [];
		const execution = { version: 1 as const, threadId: "thread-1", runId: "run-1", actionId: "call-1" };
		let asked: unknown;

		const result = await executeGatewayRequest(
			config,
			{ op: "tools.invoke", payload: { toolId: "connectApp", args: {} }, execution },
			"call-connect",
			{ ...ctx, runtimeChannel: "web" },
			{
				callGateway: async (_config, request) => {
					requests.push(request);
					return request.op === "connections.resume"
						? { body: { ok: true, status: "success", data: { connected: true } }, httpStatus: 200 }
						: {
							body: {
								ok: false,
								status: "connection_pending",
								data: { askId: "intent-1", provider: "google_workspace" },
							},
							httpStatus: 200,
						};
				},
				awaitConnection: async value => {
					asked = value;
					return { askId: "intent-1", granted: true };
				},
			},
		);

		assert.deepEqual(asked, { askId: "intent-1", provider: "google_workspace" });
		assert.equal(requests.length, 2);
		assert.equal(requests[1]?.op, "connections.resume");
		assert.deepEqual(requests[1]?.payload, { askId: "intent-1" });
		assert.deepEqual(requests[1]?.execution, execution);
		assert.equal(result.body.status, "success");
	});

	it("hands back the pending status when the member never connected", async () => {
		/* Not an exception. The formatter turns this into "not connected", which
		   is something the model can say plainly rather than retry. */
		const requests: GatewayRequestBody[] = [];
		const result = await executeGatewayRequest(
			config,
			{ op: "tools.invoke", payload: { toolId: "connectApp", args: {} } },
			"call-connect-declined",
			{ ...ctx, runtimeChannel: "web" },
			{
				callGateway: async (_config, request) => {
					requests.push(request);
					return {
						body: { ok: false, status: "connection_pending", data: { askId: "intent-2" } },
						httpStatus: 200,
					};
				},
				awaitConnection: async () => ({ askId: "intent-2", granted: false }),
			},
		);

		assert.equal(requests.length, 1, "a declined wait must not resume");
		assert.equal(result.body.status, "connection_pending");
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
