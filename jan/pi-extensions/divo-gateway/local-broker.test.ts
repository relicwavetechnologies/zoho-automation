import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import {
	captureDivoGatewayConfig,
	clearCapturedDivoGatewayConfig,
} from "./gateway-client.ts";
import { executeGatewayRequest } from "./gateway-execution.ts";
import {
	executeLocalBrokerRequest,
	parseLocalBrokerRequest,
	registerLocalDivoBroker,
	type ActiveBashCall,
} from "./local-broker.ts";
import type { GatewayRequestBody } from "./gateway-client.ts";

const config = { backendUrl: "http://localhost:4000", memberToken: "member-token" };
const correlation = {
	version: 1 as const,
	threadId: "thread-1",
	runId: "run-1",
	departmentId: "dept-1",
};
const execFileAsync = promisify(execFile);

function loadedSkills(skillId = "workspace") {
	return (toolId: string) => ({ runId: correlation.runId, skillId: `${skillId}:${toolId}` });
}

function activeCalls(signal?: AbortSignal): Map<string, ActiveBashCall> {
	return new Map([["bash-1", {
		toolCallId: "bash-1",
		context: {
			cwd: "/workspace",
			signal,
			ui: { confirm: async () => true },
		},
		correlation,
		nextBrokerCall: 0,
	}]]);
}

describe("Divo local broker protocol", () => {
	it("exposes only the constrained read/invoke surface", () => {
		assert.equal(parseLocalBrokerRequest({
			version: 1,
			request: { op: "connections.list", payload: {} },
		}).request.op, "connections.list");
		assert.throws(() => parseLocalBrokerRequest({
			version: 1,
			request: { op: "tools.commit", payload: { intentId: "stolen" } },
		}), /not exposed/);
	});

	it("rejects calls that are not owned by one active approved Bash execution", async () => {
		await assert.rejects(
			executeLocalBrokerRequest({
				version: 1,
				request: { op: "connections.list", payload: {} },
			}, new Map()),
			/active, locally approved Bash command/,
		);
	});

	it("rejects a scripted tool invocation without an exact current-run skill", async () => {
		let gatewayCalls = 0;
		await assert.rejects(executeLocalBrokerRequest({
			version: 1,
			request: { op: "tools.invoke", payload: { toolId: "googleGmail", args: {} } },
		}, activeCalls(), {
			resolveConfig: () => config,
			readCorrelation: async () => correlation,
			lookupLoadedSkill: () => undefined,
			executeGateway: async () => {
				gatewayCalls += 1;
				return { body: { ok: true, status: "success" }, httpStatus: 200 };
			},
		}), /Exact company skill required/);
		assert.equal(gatewayCalls, 0);
	});

	it("rejects protected Shopify records before Bash can receive them", async () => {
		let gatewayCalls = 0;
		await assert.rejects(executeLocalBrokerRequest({
			version: 1,
			request: { op: "tools.invoke", payload: { toolId: "shopifyCustomers", args: {} } },
		}, activeCalls(), {
			resolveConfig: () => config,
			readCorrelation: async () => correlation,
			lookupLoadedSkill: loadedSkills("shopify-commerce"),
			executeGateway: async () => {
				gatewayCalls += 1;
				return { body: { ok: true, status: "success" }, httpStatus: 200 };
			},
		}), /must be called directly through divo_gateway/);
		assert.equal(gatewayCalls, 0);
	});

	it("routes a governed read with exact desktop correlation and no extra approval", async () => {
		const gatewayRequests: GatewayRequestBody[] = [];
		const result = await executeLocalBrokerRequest({
			version: 1,
			label: "Read recent Gmail",
			request: {
				op: "tools.invoke",
				payload: { toolId: "googleGmail", args: { operation: "search", query: "newer_than:1d" } },
			},
		}, activeCalls(), {
			resolveConfig: () => config,
			readCorrelation: async () => correlation,
			lookupLoadedSkill: loadedSkills("gmail-read"),
			executeGateway: async (resolved, request, toolCallId, ctx) => executeGatewayRequest(
				resolved,
				request,
				toolCallId,
				ctx,
				{
					callGateway: async (_config, gatewayRequest) => {
						gatewayRequests.push(gatewayRequest);
						return { body: { ok: true, status: "success", data: { messages: [] } }, httpStatus: 200 };
					},
					approveIntent: async () => { throw new Error("read must not prompt"); },
				},
			),
		});

		assert.equal(result.ok, true);
		assert.deepEqual(result.trace, {
			threadId: "thread-1",
			runId: "run-1",
			actionId: "bash-1:broker:1",
			label: "Read recent Gmail",
		});
		assert.deepEqual(gatewayRequests[0]?.execution, {
			version: 1,
			threadId: "thread-1",
			runId: "run-1",
			actionId: "bash-1:broker:1",
		});
		assert.equal(gatewayRequests[0]?.departmentId, "dept-1");
		assert.equal(
			(gatewayRequests[0]?.payload as { skillId?: string })?.skillId,
			"gmail-read:googleGmail",
		);
	});

	it("uses the existing prepared-intent approval protocol for mutations", async () => {
		const gatewayRequests: GatewayRequestBody[] = [];
		const approvals: string[] = [];
		const result = await executeLocalBrokerRequest({
			version: 1,
			request: {
				op: "tools.invoke",
				payload: { toolId: "googleSheets", args: { operation: "create_spreadsheet", title: "Test" } },
			},
		}, activeCalls(), {
			resolveConfig: () => config,
			readCorrelation: async () => correlation,
			lookupLoadedSkill: loadedSkills("sheets-write"),
			executeGateway: async (resolved, request, toolCallId, ctx) => executeGatewayRequest(
				resolved,
				request,
				toolCallId,
				ctx,
				{
					callGateway: async (_config, gatewayRequest) => {
						gatewayRequests.push(gatewayRequest);
						return gatewayRequests.length === 1
							? {
								body: {
									ok: false,
									status: "local_approval_required",
									data: { intentId: "intent-1", presentation: { action: "create" } },
								},
								httpStatus: 200,
							}
							: { body: { ok: true, status: "success", data: { spreadsheetId: "sheet-1" } }, httpStatus: 200 };
					},
					approveIntent: async (id) => {
						approvals.push(id);
						return "intent-1";
					},
				},
			),
		});

		assert.equal(result.ok, true);
		assert.deepEqual(approvals, ["bash-1:broker:1"]);
		assert.equal(gatewayRequests[0]?.op, "tools.invoke");
		assert.deepEqual(gatewayRequests[1], {
			op: "tools.commit",
			departmentId: "dept-1",
			payload: { intentId: "intent-1" },
			execution: gatewayRequests[0]?.execution,
		});
	});

	it("preserves backend RBAC and rate-limit failures without inventing success", async () => {
		for (const status of ["permission_denied", "rate_limited"]) {
			const result = await executeLocalBrokerRequest({
				version: 1,
				request: { op: "tools.invoke", payload: { toolId: "googleSheets", args: { operation: "read" } } },
			}, activeCalls(), {
				resolveConfig: () => config,
				readCorrelation: async () => correlation,
				lookupLoadedSkill: loadedSkills(),
				executeGateway: async () => ({
					body: { ok: false, status, error: { code: status, message: `Backend ${status}` } },
					httpStatus: status === "rate_limited" ? 429 : 403,
				}),
			});
			assert.equal(result.ok, false);
			assert.equal(result.status, status);
			assert.equal(result.error?.code, status);
		}
	});

	it("returns manager approval as pending instead of claiming the mutation ran", async () => {
		const result = await executeLocalBrokerRequest({
			version: 1,
			request: { op: "tools.invoke", payload: { toolId: "googleSheets", args: { operation: "create_spreadsheet" } } },
		}, activeCalls(), {
			resolveConfig: () => config,
			readCorrelation: async () => correlation,
			lookupLoadedSkill: loadedSkills(),
			executeGateway: async () => ({
				body: {
					ok: false,
					status: "approval_required",
					approval: { approvalId: "approval-1", message: "Waiting for connection owner" },
				},
				httpStatus: 202,
			}),
		});
		assert.equal(result.ok, false);
		assert.equal(result.status, "approval_required");
		assert.equal(result.approval?.approvalId, "approval-1");
	});

	it("stops before any gateway call when the owning Bash command is cancelled", async () => {
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(executeLocalBrokerRequest({
			version: 1,
			request: { op: "tools.invoke", payload: { toolId: "googleGmail", args: { operation: "search" } } },
		}, activeCalls(controller.signal)), /cancelled/);
	});

	it("aborts an in-flight gateway request when its broker client disconnects", async () => {
		const disconnected = new AbortController();
		let observedSignal: AbortSignal | undefined;
		const pending = executeLocalBrokerRequest({
			version: 1,
			request: { op: "tools.invoke", payload: { toolId: "googleSheets", args: { operation: "create" } } },
		}, activeCalls(), {
			resolveConfig: () => config,
			readCorrelation: async () => correlation,
			lookupLoadedSkill: loadedSkills(),
			executeGateway: async (_config, _request, _toolCallId, ctx) => {
				observedSignal = ctx.signal;
				if (ctx.signal?.aborted) throw new DOMException("cancelled", "AbortError");
				await new Promise<void>((_resolve, reject) => {
					ctx.signal?.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
				});
				throw new Error("unreachable");
			},
		}, disconnected.signal);

		disconnected.abort();
		await assert.rejects(pending, /cancelled/);
		assert.equal(observedSignal?.aborted, true);
	});

	it("rejects a run or department rotation after the owning Bash call starts", async () => {
		let executions = 0;
		await assert.rejects(executeLocalBrokerRequest({
			version: 1,
			request: { op: "tools.invoke", payload: { toolId: "googleGmail", args: { operation: "search" } } },
		}, activeCalls(), {
			resolveConfig: () => config,
			readCorrelation: async () => ({ ...correlation, departmentId: "dept-2" }),
			lookupLoadedSkill: loadedSkills(),
			executeGateway: async () => {
				executions += 1;
				throw new Error("unreachable");
			},
		}), /context changed/i);
		assert.equal(executions, 0);
	});

	it("installs a credential-free CLI, serves one active Bash call, and cleans up its process state", async () => {
		const originalPath = process.env.PATH;
		const originalSocket = process.env.DIVO_LOCAL_BROKER_SOCKET;
		captureDivoGatewayConfig({
			DIVO_BACKEND_URL: "http://localhost:4000",
			DIVO_MEMBER_TOKEN: "member-token",
		});
		delete process.env.DIVO_MEMBER_TOKEN;
		const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
		registerLocalDivoBroker({
			on(name: string, handler: (event: any, ctx: any) => unknown) {
				const existing = handlers.get(name) ?? [];
				existing.push(handler);
				handlers.set(name, existing);
			},
		} as never, {
			resolveConfig: () => config,
			readCorrelation: async () => correlation,
			lookupLoadedSkill: loadedSkills(),
			executeGateway: async (_resolved, request) => ({
				body: { ok: true, status: "success", data: { op: request.op } },
				httpStatus: 200,
			}),
		});
		try {
			await handlers.get("session_start")?.[0]?.({}, {});
			await handlers.get("tool_call")?.[0]?.({
				toolName: "bash",
				toolCallId: "bash-cli",
				input: { command: "divo-local request --op connections.list" },
			}, {
				cwd: "/workspace",
				signal: undefined,
				ui: { confirm: async () => true },
			});
			const result = await execFileAsync("divo-local", [
				"request",
				"--op",
				"connections.list",
				"--payload-json",
				"{}",
				"--label",
				"List connections",
			], { env: process.env });
			const output = JSON.parse(result.stdout);
			assert.equal(output.ok, true);
			assert.equal(output.data.op, "connections.list");
			assert.equal(output.trace.actionId, "bash-cli:broker:1");
			assert.match(result.stderr, /\[Divo\] List connections/);
			assert.doesNotMatch(`${result.stdout}${result.stderr}`, /member-token/);
			await handlers.get("tool_execution_end")?.[0]?.({
				toolName: "bash",
				toolCallId: "bash-cli",
			}, {});
		} finally {
			await handlers.get("session_shutdown")?.[0]?.({}, {});
			clearCapturedDivoGatewayConfig();
			assert.equal(process.env.PATH, originalPath);
			assert.equal(process.env.DIVO_LOCAL_BROKER_SOCKET, originalSocket);
		}
	});
});
