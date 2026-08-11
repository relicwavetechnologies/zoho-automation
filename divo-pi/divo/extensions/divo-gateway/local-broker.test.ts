import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import {
	captureDivoGatewayConfig,
	clearCapturedDivoGatewayConfig,
} from "./gateway-client.ts";
import { executeGatewayRequest } from "./gateway-execution.ts";
import {
	executeLocalBrokerRequest,
	localCliEnabled,
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

	it("does not attach skill provenance to a scripted tool call", async () => {
		const gatewayRequests: GatewayRequestBody[] = [];
		await executeLocalBrokerRequest({
			version: 1,
			request: { op: "tools.invoke", payload: { toolId: "googleGmail", args: { operation: "search" } } },
		}, activeCalls(), {
			resolveConfig: () => config,
			readCorrelation: async () => correlation,
			executeGateway: async (_resolved, request) => {
				gatewayRequests.push(request);
				return { body: { ok: true, status: "ok", data: {} }, httpStatus: 200 };
			},
		});

		assert.equal((gatewayRequests[0]?.payload as { skillId?: string })?.skillId, undefined);
	});

	it("requests the trusted local-file transport only for an explicit file result", async () => {
		let resultMode: unknown;
		await executeLocalBrokerRequest({
			version: 1,
			resultMode: "local-file",
			request: { op: "tools.invoke", payload: { toolId: "zohoBooks", args: {} } },
		}, activeCalls(), {
			resolveConfig: () => config,
			readCorrelation: async () => correlation,
			executeGateway: async (_config, _request, _toolCallId, ctx) => {
				resultMode = ctx.resultMode;
				return { body: { ok: true, status: "success", data: {} }, httpStatus: 200 };
			},
		});

		assert.equal(resultMode, "local-file");
		assert.throws(() => parseLocalBrokerRequest({
			version: 1,
			resultMode: "local-file",
			request: { op: "connections.list", payload: {} },
		}), /only for tools.invoke/);
	});

	it("sends an ordinary scripted call without invented skill provenance", async () => {
		let sentPayload: unknown;
		await executeLocalBrokerRequest({
				version: 1,
				request: {
					op: "tools.invoke",
					payload: { skillId: "self-asserted", toolId: "googleGmail", args: {} },
				},
			}, activeCalls(), {
				resolveConfig: () => config,
				readCorrelation: async () => correlation,
				executeGateway: async (_resolved, request) => {
					sentPayload = request.payload;
					return { body: { ok: true, status: "ok", data: {} }, httpStatus: 200 };
				},
			});
		assert.deepEqual(sentPayload, { toolId: "googleGmail", args: {} });
	});

	it("rejects protected Shopify records before Bash can receive them", async () => {
		let gatewayCalls = 0;
		await assert.rejects(executeLocalBrokerRequest({
			version: 1,
			request: { op: "tools.invoke", payload: { toolId: "shopifyOrders", args: {} } },
		}, activeCalls(), {
			resolveConfig: () => config,
			readCorrelation: async () => correlation,
			executeGateway: async () => {
				gatewayCalls += 1;
				return { body: { ok: true, status: "success" }, httpStatus: 200 };
			},
		}), /must be called directly through their Divo tool/);
		assert.equal(gatewayCalls, 0);
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
			const retryAfterSeconds = status === "rate_limited" ? 17 : undefined;
			const result = await executeLocalBrokerRequest({
				version: 1,
				request: { op: "tools.invoke", payload: { toolId: "googleSheets", args: { operation: "read" } } },
			}, activeCalls(), {
				resolveConfig: () => config,
				readCorrelation: async () => correlation,
				executeGateway: async () => ({
					body: {
						ok: false,
						status,
						error: { code: status, message: `Backend ${status}`, retryAfterSeconds },
					},
					httpStatus: status === "rate_limited" ? 429 : 403,
				}),
			});
			assert.equal(result.ok, false);
			assert.equal(result.status, status);
			assert.equal(result.error?.retryAfterSeconds, retryAfterSeconds);
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
		const originalRunDir = process.env.DIVO_RUN_DIR;
		const runDir = await mkdtemp(join(tmpdir(), "divo-run-"));
		process.env.DIVO_RUN_DIR = runDir;
		captureDivoGatewayConfig({
			DIVO_BACKEND_URL: "http://localhost:4000",
			DIVO_MEMBER_TOKEN: "member-token",
		});
		delete process.env.DIVO_MEMBER_TOKEN;
		const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
		const gatewayRequests: GatewayRequestBody[] = [];
		const resultModes: unknown[] = [];
		let rateAttempts = 0;
		registerLocalDivoBroker({
			on(name: string, handler: (event: any, ctx: any) => unknown) {
				const existing = handlers.get(name) ?? [];
				existing.push(handler);
				handlers.set(name, existing);
			},
		} as never, {
			resolveConfig: () => config,
			readCorrelation: async () => correlation,
			executeGateway: async (_resolved, request, _actionId, ctx) => {
				gatewayRequests.push(request);
				if (request.op === "tools.invoke") resultModes.push(ctx.resultMode);
				const toolId = request.op === "tools.invoke"
					? (request.payload as { toolId?: string })?.toolId
					: undefined;
				if (toolId === "rateTool" && rateAttempts++ === 0) {
					return {
						body: {
							ok: false,
							status: "rate_limited",
							error: { code: "rate_limited", message: "Wait once", retryAfterSeconds: 1 },
						},
						httpStatus: 429,
					};
				}
				return {
					body: toolId === "badTool"
						? { ok: false, status: "invalid_args", error: { code: "invalid_args", message: "Bad test args" } }
						: { ok: true, status: "success", data: request.op === "tools.invoke"
						? { toolId: "zohoBooks", action: "read", result: { rows: [{ id: "row-1", secret: "file-only" }] } }
						: { op: request.op } },
					httpStatus: 200,
				};
			},
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
			await assert.rejects(execFileAsync("divo-local", [
				"request", "--op", " tools.invoke ", "--payload-json", "{}",
			], { env: process.env }), (error: { stderr?: string }) => {
				assert.match(error.stderr ?? "", /use invoke for tool execution/i);
				return true;
			});
			await assert.rejects(execFileAsync("divo-local", [
				"invoke", "--tool", "badTool", "--args-json", "{}",
			], { env: process.env }), (error: { stdout?: string }) => {
				assert.match(error.stdout ?? "", /invalid_args/);
				return true;
			});
			await assert.rejects(execFileAsync("divo-local", [
				"call", "airtableRecords", "--input-json", "{}",
			], { env: process.env }), (error: { stderr?: string }) => {
				assert.match(error.stderr ?? "", /<toolId>\.<nativeTool>/);
				return true;
			});
			await assert.rejects(access(join(runDir, "page.json")), { code: "ENOENT" });
			const nativeInputPath = join(runDir, "native-input.json");
			await writeFile(nativeInputPath, JSON.stringify({
				baseId: "app_1",
				tableId: "tbl_1",
				pageSize: 200,
			}));
			const nativeResult = await execFileAsync("divo-local", [
				"call",
				"airtableRecords.list_records_for_table",
				"--input-file",
				nativeInputPath,
				"--connection-id",
				"11111111-1111-4111-8111-111111111111",
				"--output",
				"native-page.json",
			], { env: process.env });
			assert.equal(JSON.parse(nativeResult.stdout).output, join(runDir, "native-page.json"));
			const nativeRequest = gatewayRequests.find(request =>
				request.op === "tools.invoke"
				&& (request.payload as { toolId?: string })?.toolId === "airtableRecords",
			);
			assert.deepEqual(nativeRequest?.payload, {
				toolId: "airtableRecords",
				args: {
					connectionId: "11111111-1111-4111-8111-111111111111",
					op: "call",
					nativeTool: "list_records_for_table",
					input: {
						baseId: "app_1",
						tableId: "tbl_1",
						pageSize: 200,
					},
				},
			});
			const describeResult = await execFileAsync("divo-local", [
				"describe",
				"googleSheets.create_spreadsheet",
				"--output",
				"describe.json",
			], { env: process.env });
			assert.equal(JSON.parse(describeResult.stdout).output, join(runDir, "describe.json"));
			const describeRequest = gatewayRequests.find(request =>
				request.op === "tools.invoke"
				&& (request.payload as { toolId?: string })?.toolId === "googleSheets",
			);
			assert.deepEqual(describeRequest?.payload, {
				toolId: "googleSheets",
				args: {
					op: "describe",
					nativeTool: "create_spreadsheet",
				},
			});
			const fileResult = await execFileAsync("divo-local", [
				"invoke", "--tool", "zohoBooks", "--args-json", "{}",
			], { env: process.env });
			const summary = JSON.parse(fileResult.stdout);
			assert.match(summary.output, new RegExp(`^${runDir}/divo-zohoBooks-[a-f0-9-]+\\.json$`));
			assert.doesNotMatch(fileResult.stdout, /file-only/);
			assert.match(await readFile(summary.output, "utf8"), /file-only/);
			const explicitResult = await execFileAsync("divo-local", [
				"invoke", "--tool", "zohoBooks", "--args-json", "{}", "--output", "page.json",
			], { env: process.env });
			assert.equal(JSON.parse(explicitResult.stdout).output, join(runDir, "page.json"));
			const retriedResult = await execFileAsync("divo-local", [
				"invoke", "--tool", "rateTool", "--args-json", "{}", "--output", "retried.json",
			], { env: process.env });
			assert.equal(JSON.parse(retriedResult.stdout).output, join(runDir, "retried.json"));
			assert.match(retriedResult.stderr, /retrying this exact call once in 1s/i);
			assert.equal(rateAttempts, 2);
			assert.equal(resultModes.length, 7);
			assert.equal(resultModes.every(mode => mode === "local-file"), true);
			await handlers.get("tool_execution_end")?.[0]?.({
				toolName: "bash",
				toolCallId: "bash-cli",
			}, {});
		} finally {
			await handlers.get("session_shutdown")?.[0]?.({}, {});
			clearCapturedDivoGatewayConfig();
			assert.equal(process.env.PATH, originalPath);
			assert.equal(process.env.DIVO_LOCAL_BROKER_SOCKET, originalSocket);
			if (originalRunDir === undefined) delete process.env.DIVO_RUN_DIR;
			else process.env.DIVO_RUN_DIR = originalRunDir;
			await rm(runDir, { recursive: true, force: true });
		}
	});
});

async function pathAfterSessionStart(
	disabled: string | undefined,
	runtimeHome?: string,
): Promise<string | undefined> {
	const originalDisabled = process.env.DIVO_LOCAL_CLI_DISABLED;
	const originalRuntimeHome = process.env.DIVO_HOME;
	const originalPath = process.env.PATH;
	const originalSocket = process.env.DIVO_LOCAL_BROKER_SOCKET;
	if (disabled === undefined) delete process.env.DIVO_LOCAL_CLI_DISABLED;
	else process.env.DIVO_LOCAL_CLI_DISABLED = disabled;
	if (runtimeHome === undefined) delete process.env.DIVO_HOME;
	else process.env.DIVO_HOME = runtimeHome;
	captureDivoGatewayConfig({
		DIVO_BACKEND_URL: "http://localhost:4000",
		DIVO_MEMBER_TOKEN: "member-token",
	});
	const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
	registerLocalDivoBroker({
		on(name: string, handler: (event: any, ctx: any) => unknown) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
	} as never);
	try {
		await handlers.get("session_start")?.[0]?.({}, {});
		return process.env.PATH;
	} finally {
		await handlers.get("session_shutdown")?.[0]?.({}, {});
		clearCapturedDivoGatewayConfig();
		process.env.PATH = originalPath;
		if (originalSocket === undefined) delete process.env.DIVO_LOCAL_BROKER_SOCKET;
		else process.env.DIVO_LOCAL_BROKER_SOCKET = originalSocket;
		if (originalDisabled === undefined) delete process.env.DIVO_LOCAL_CLI_DISABLED;
		else process.env.DIVO_LOCAL_CLI_DISABLED = originalDisabled;
		if (originalRuntimeHome === undefined) delete process.env.DIVO_HOME;
		else process.env.DIVO_HOME = originalRuntimeHome;
	}
}

describe("divo-local CLI availability", () => {
	it("offers the CLI by default for desktop and cloud workflows", () => {
		const original = process.env.DIVO_LOCAL_CLI_DISABLED;
		delete process.env.DIVO_LOCAL_CLI_DISABLED;
		try {
			assert.equal(localCliEnabled(), true);
		} finally {
			if (original !== undefined) process.env.DIVO_LOCAL_CLI_DISABLED = original;
		}
	});

	it("withholds the CLI when the runtime disables it", () => {
		const original = process.env.DIVO_LOCAL_CLI_DISABLED;
		process.env.DIVO_LOCAL_CLI_DISABLED = "1";
		try {
			assert.equal(localCliEnabled(), false);
		} finally {
			if (original === undefined) delete process.env.DIVO_LOCAL_CLI_DISABLED;
			else process.env.DIVO_LOCAL_CLI_DISABLED = original;
		}
	});

	it("stages nothing and leaves PATH alone when the CLI is withheld", async () => {
		// The point is absence, not refusal: a launcher the agent can find is a
		// launcher it will try to use, whatever the instructions say. The enabled
		// case is asserted alongside it so this cannot pass by staging never
		// happening at all.
		const staged = await pathAfterSessionStart(undefined);
		assert.notEqual(staged, process.env.PATH);
		assert.match(String(staged), /divo-cli-/);

		const withheld = await pathAfterSessionStart("1");
		assert.equal(withheld, process.env.PATH);
	});

	it("stages the cloud launcher outside turn-scoped run directories", async () => {
		const runtimeHome = await mkdtemp(join(tmpdir(), "divo-home-"));
		try {
			const staged = await pathAfterSessionStart(undefined, runtimeHome);
			assert.match(String(staged), new RegExp(`^${runtimeHome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/divo-cli-`));
		} finally {
			await rm(runtimeHome, { recursive: true, force: true });
		}
	});
});
