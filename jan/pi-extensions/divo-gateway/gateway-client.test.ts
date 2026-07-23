import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, it } from "node:test";
import {
	captureDivoGatewayConfig,
	callDivoGateway,
	clearCapturedDivoGatewayConfig,
	clearDivoGatewaySkillCache,
	formatGatewayResponse,
	isGatewayApprovalStatus,
	prepareDivoGatewayRequest,
	resolveDivoGatewayConfig,
} from "./gateway-client.ts";

afterEach(() => clearCapturedDivoGatewayConfig());

describe("resolveDivoGatewayConfig", () => {
	it("requires backend URL and member token", () => {
		const missing = resolveDivoGatewayConfig({});
		assert.ok("error" in missing);

		const ok = resolveDivoGatewayConfig({
			DIVO_BACKEND_URL: "http://127.0.0.1:3000/",
			DIVO_MEMBER_TOKEN: "jwt-test",
			DIVO_DEPARTMENT_ID: "dept-1",
		});
		assert.ok(!("error" in ok));
		if (!("error" in ok)) {
			assert.equal(ok.backendUrl, "http://127.0.0.1:3000");
			assert.equal(ok.memberToken, "jwt-test");
			assert.equal(ok.defaultDepartmentId, "dept-1");
		}
	});

	it("keeps captured desktop credentials available after the shell environment is scrubbed", () => {
		const env = {
			DIVO_BACKEND_URL: "http://localhost:4000/",
			DIVO_MEMBER_TOKEN: "member-token",
			DIVO_DEPARTMENT_ID: "dept-1",
		};
		assert.deepEqual(captureDivoGatewayConfig(env), {
			backendUrl: "http://localhost:4000",
			memberToken: "member-token",
			defaultDepartmentId: "dept-1",
		});
		assert.deepEqual(resolveDivoGatewayConfig(), {
			backendUrl: "http://localhost:4000",
			memberToken: "member-token",
			defaultDepartmentId: "dept-1",
		});
		assert.deepEqual(resolveDivoGatewayConfig({}), {
			error: "Divo gateway is not configured: DIVO_BACKEND_URL is missing. Sign in through Jan/Desktop first.",
		});
	});
});

describe("formatGatewayResponse", () => {
	it("renders success", () => {
		const result = formatGatewayResponse({
			ok: true,
			status: "success",
			data: { tools: ["zohoCrm"] },
		});
		assert.equal(result.isError, false);
		assert.match(result.text, /succeeded/);
		assert.match(result.text, /zohoCrm/);
	});

	it("renders the first Google recipe inline without expanding later recipes", () => {
		const result = formatGatewayResponse({
			ok: true,
			status: "success",
			data: {
				workflow: "vendor_onboarding",
				parent: { instructions: "Compact parent guidance" },
				connection: { message: "Choose a connection when the backend asks." },
				phases: [
					{ name: "Gmail source", skillId: "gmail-id", skill: { instructions: "inline only" } },
					{ name: "Google Contacts", skillId: "contacts-id" },
				],
			},
		});
		assert.equal(result.isError, false);
		assert.match(result.text, /Gmail source/);
		assert.match(result.text, /contacts-id/);
		assert.match(result.text, /Compact parent guidance/);
		assert.match(result.text, /inline only/);
		assert.match(result.text, /already loaded/i);
	});

	it("renders permission_denied", () => {
		const result = formatGatewayResponse({
			ok: false,
			status: "permission_denied",
			error: { code: "permission_denied", message: "not allowed" },
		});
		assert.equal(result.isError, true);
		assert.match(result.text, /permission denied/i);
		assert.match(result.text, /not allowed/);
	});

	it("renders unauthorized as a sign-in problem", () => {
		const result = formatGatewayResponse({
			ok: false,
			status: "unauthorized",
			error: { code: "unauthorized", message: "session expired" },
		});
		assert.equal(result.isError, true);
		assert.match(result.text, /unauthorized/i);
		assert.match(result.text, /sign in again/i);
		assert.match(result.text, /session expired/);
	});

	it("renders request contract failures without calling them tool errors", () => {
		for (const status of ["bad_request", "unknown_op", "unknown_tool", "invalid_args"]) {
			const result = formatGatewayResponse({
				ok: false,
				status,
				error: { code: status, message: `${status} message` },
			});
			assert.equal(result.isError, true);
			assert.match(result.text, /request rejected/i);
			assert.match(result.text, new RegExp(`${status} message`));
		}
	});

	it("renders approval_required", () => {
		const result = formatGatewayResponse({
			ok: false,
			status: "approval_required",
			approval: {
				approvalId: "ap-1",
				message: "sent to manager",
			},
		});
		assert.equal(result.isError, true);
		assert.match(result.text, /approval required/i);
		assert.match(result.text, /ap-1/);
		assert.match(result.text, /exact same divo_gateway tools\.invoke request/i);
		assert.match(result.text, /changed args require a fresh approval/i);
	});

	it("classifies only backend HITL terminal statuses for structured tool results", () => {
		assert.equal(isGatewayApprovalStatus("approval_required"), true);
		assert.equal(isGatewayApprovalStatus("approval_rejected"), true);
		assert.equal(isGatewayApprovalStatus("approval_misconfigured"), false);
		assert.equal(isGatewayApprovalStatus("tool_error"), false);
	});

	it("renders approval_misconfigured", () => {
		const result = formatGatewayResponse({
			ok: false,
			status: "approval_misconfigured",
			error: {
				code: "approval_misconfigured",
				message: "no manager configured",
			},
		});
		assert.equal(result.isError, true);
		assert.match(result.text, /approval misconfigured/i);
		assert.match(result.text, /no manager configured/);
	});

	it("renders tool_error", () => {
		const result = formatGatewayResponse({
			ok: false,
			status: "tool_error",
			error: { code: "tool_error", message: "Zoho API failed" },
		});
		assert.equal(result.isError, true);
		assert.match(result.text, /tool error/i);
		assert.match(result.text, /Zoho API failed/);
	});
});

describe("callDivoGateway", () => {
	it("caches successful skills.get responses by backend, token, department, and skill", async () => {
		clearDivoGatewaySkillCache();
		let calls = 0;
		const fetchImpl = async () => {
			calls += 1;
			return new Response(
				JSON.stringify({
					ok: true,
					status: "success",
					data: { skill: { id: "google", instructions: "Use Gmail" } },
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		const config = {
			backendUrl: "http://localhost:4000",
			memberToken: "member-jwt",
			defaultDepartmentId: "dept-default",
		};
		const request = {
			op: "skills.get",
			payload: { skillId: "google" },
		};

		const first = await callDivoGateway(config, request, fetchImpl as typeof fetch);
		const second = await callDivoGateway(config, request, fetchImpl as typeof fetch);

		assert.equal(calls, 1);
		assert.deepEqual(second, first);
	});

	it("does not cache side-effecting gateway calls", async () => {
		clearDivoGatewaySkillCache();
		let calls = 0;
		const fetchImpl = async () => {
			calls += 1;
			return new Response(
				JSON.stringify({ ok: true, status: "success", data: { n: calls } }),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		const config = {
			backendUrl: "http://localhost:4000",
			memberToken: "member-jwt",
		};
		const request = {
			op: "tools.invoke",
			payload: { toolId: "googleGmail", args: { action: "search" } },
		};

		await callDivoGateway(config, request, fetchImpl as typeof fetch);
		await callDivoGateway(config, request, fetchImpl as typeof fetch);

		assert.equal(calls, 2);
	});

	it("caches a Google plan by user-selected connection without caching preflight", async () => {
		clearDivoGatewaySkillCache();
		let calls = 0;
		const fetchImpl = async () => {
			calls += 1;
			return new Response(JSON.stringify({ ok: true, status: "success", data: { n: calls } }), { status: 200 });
		};
		const config = { backendUrl: "http://localhost:4000", memberToken: "member-jwt" };
		await callDivoGateway(config, { op: "google.plan", payload: { workflow: "vendor_onboarding" } }, fetchImpl as typeof fetch);
		await callDivoGateway(config, { op: "google.plan", payload: { workflow: "vendor_onboarding" } }, fetchImpl as typeof fetch);
		await callDivoGateway(config, { op: "tools.preflight", payload: { invocations: [] } }, fetchImpl as typeof fetch);
		assert.equal(calls, 2);
	});

	it("POSTs to /api/gateway with bearer auth", async () => {
		let captured: { url: string; init: RequestInit } | undefined;
		const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
			captured = {
				url: String(url),
				init: init ?? {},
			};
			return new Response(
				JSON.stringify({ ok: true, status: "success", data: { echoed: true } }),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		const result = await callDivoGateway(
			{
				backendUrl: "http://localhost:4000",
				memberToken: "member-jwt",
				defaultDepartmentId: "dept-default",
			},
			{
				op: "tools.invoke",
				payload: { toolId: "zohoCrm", args: { op: "search" } },
				execution: {
					version: 1,
					threadId: "thread-1",
					runId: "run-1",
					actionId: "tool-call-1",
				},
			},
			fetchImpl as typeof fetch,
		);

		assert.ok(captured);
		assert.equal(captured!.url, "http://localhost:4000/api/gateway");
		assert.equal(
			(captured!.init.headers as Record<string, string>).Authorization,
			"Bearer member-jwt",
		);
		const body = JSON.parse(String(captured!.init.body));
		assert.equal(body.op, "tools.invoke");
		assert.equal(body.departmentId, "dept-default");
		assert.deepEqual(body.payload, {
			toolId: "zohoCrm",
			args: { op: "search" },
		});
		assert.deepEqual(body.execution, {
			version: 1,
			threadId: "thread-1",
			runId: "run-1",
			actionId: "tool-call-1",
		});
		assert.equal(result.body.status, "success");
	});
});

describe("prepareDivoGatewayRequest", () => {
	it("materializes media.image_ocr filePath payloads to backend imageBase64 payloads", async () => {
		const dir = await mkdtemp(join(tmpdir(), "divo-gateway-"));
		const filePath = join(dir, "screen.png");
		await writeFile(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

		const result = await prepareDivoGatewayRequest({
			op: "media.image_ocr",
			payload: {
				filePath,
				mimeType: "image/png",
				fileName: "screen.png",
			},
		});

		assert.equal(result.op, "media.image_ocr");
		assert.deepEqual(result.payload, {
			imageBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"),
			mimeType: "image/png",
			fileName: "screen.png",
		});
	});

	it("leaves already materialized media.image_ocr payloads unchanged", async () => {
		const request = {
			op: "media.image_ocr",
			payload: {
				imageBase64: "abc",
				mimeType: "image/png",
				fileName: "screen.png",
			},
		};

		assert.equal(await prepareDivoGatewayRequest(request), request);
	});

	it("rejects unsupported image OCR MIME types before calling the backend", async () => {
		await assert.rejects(
			prepareDivoGatewayRequest({
				op: "media.image_ocr",
				payload: {
					imageBase64: "abc",
					mimeType: "image/heic",
					fileName: "photo.heic",
				},
			}),
			/Convert this image to PNG first/,
		);
	});
});
