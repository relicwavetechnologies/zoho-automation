import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	callDivoGateway,
	formatGatewayResponse,
	resolveDivoGatewayConfig,
} from "./gateway-client.ts";

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
		assert.equal(result.body.status, "success");
	});
});
