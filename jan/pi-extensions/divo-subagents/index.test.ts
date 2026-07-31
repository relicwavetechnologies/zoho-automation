import assert from "node:assert/strict";
import test from "node:test";
import extension, {
	applyChildEvent,
	buildDivoSubagentArgs,
	buildDivoSubagentEnvironment,
} from "./index.ts";
import { getDivoSubagentRole } from "./agents.ts";
import { createChild, MAX_OUTPUT_PREVIEW_CHARS } from "./progress.ts";
import {
	captureDivoGatewayConfig,
	clearCapturedDivoGatewayConfig,
} from "../divo-gateway/gateway-client.ts";

test("registers one Pi-owned subagent tool and a shutdown handler", () => {
	const tools: Array<{
		name?: string;
		description?: string;
		promptSnippet?: string;
		promptGuidelines?: string[];
	}> = [];
	const handlers = new Map<string, () => void>();
	extension({
		registerTool(tool: { name?: string }) {
			tools.push(tool);
		},
		on(event: string, handler: () => void) {
			handlers.set(event, handler);
		},
	} as never);

	assert.equal(tools.length, 1);
	assert.equal(tools[0]?.name, "divo_subagents");
	assert.equal(typeof handlers.get("session_shutdown"), "function");
	assert.match(tools[0]?.description ?? "", /company research, retrieval, analysis, planning, preparation, or verification/i);
	assert.match(tools[0]?.promptSnippet ?? "", /substantial independent company workstreams/i);
	assert.doesNotMatch(tools[0]?.promptSnippet ?? "", /without losing the parent conversation/i);
	assert.ok(tools[0]?.promptGuidelines?.some((guideline) => /does not receive the parent conversation/i.test(guideline)));
	assert.ok(tools[0]?.promptGuidelines?.some((guideline) => /do not delegate approvals, external mutations/i.test(guideline)));
});

test("keeps the full completed assistant message separate from its live preview", () => {
	const child = createChild(0, "reviewer", "Review the escalation rules");
	const report = "r".repeat(MAX_OUTPUT_PREVIEW_CHARS + 500);

	const captured = applyChildEvent(child, {
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: report }],
		},
	});

	assert.equal(captured, report);
	assert.equal(child.outputPreview, `${report.slice(0, MAX_OUTPUT_PREVIEW_CHARS)}…`);
});

test("passes captured member auth only to the Pi child environment", () => {
	clearCapturedDivoGatewayConfig();
	captureDivoGatewayConfig({
		DIVO_BACKEND_URL: "http://localhost:8000",
		DIVO_MEMBER_TOKEN: "member-token",
		DIVO_DEPARTMENT_ID: "finance",
	});
	const scrubbedParentEnv = { PATH: "/usr/bin" };
	const result = buildDivoSubagentEnvironment(scrubbedParentEnv);

	assert.ok("env" in result);
	if (!("env" in result)) return;
	assert.equal(scrubbedParentEnv.DIVO_MEMBER_TOKEN, undefined);
	assert.equal(result.env.DIVO_MEMBER_TOKEN, "member-token");
	assert.equal(result.env.DIVO_BACKEND_URL, "http://localhost:8000");
	assert.equal(result.env.DIVO_DEPARTMENT_ID, "finance");
	assert.equal(result.env.DIVO_SUBAGENT_CHILD, "1");
	clearCapturedDivoGatewayConfig();
});

test("fails closed instead of launching a direct-provider child without member auth", () => {
	clearCapturedDivoGatewayConfig();
	const previousBackendUrl = process.env.DIVO_BACKEND_URL;
	const previousMemberToken = process.env.DIVO_MEMBER_TOKEN;
	delete process.env.DIVO_BACKEND_URL;
	delete process.env.DIVO_MEMBER_TOKEN;
	try {
		const result = buildDivoSubagentEnvironment({ PATH: "/usr/bin" });
		assert.ok("error" in result);
		if ("error" in result) assert.match(result.error, /child authentication is unavailable/i);
	} finally {
		if (previousBackendUrl === undefined) delete process.env.DIVO_BACKEND_URL;
		else process.env.DIVO_BACKEND_URL = previousBackendUrl;
		if (previousMemberToken === undefined) delete process.env.DIVO_MEMBER_TOKEN;
		else process.env.DIVO_MEMBER_TOKEN = previousMemberToken;
		clearCapturedDivoGatewayConfig();
	}
});

test("pins child inference to the Divo-proxied DeepSeek model", () => {
	const role = getDivoSubagentRole("scout");
	assert.ok(role);
	if (!role) return;
	const args = buildDivoSubagentArgs(
		role,
		"/tmp/scout.md",
		["/bundle/divo-llm/index.ts", "/bundle/divo-gateway/index.ts"],
		"Inspect the evidence",
	);

	assert.deepEqual(args.slice(args.indexOf("--provider"), args.indexOf("--provider") + 4), [
		"--provider",
		"deepseek",
		"--model",
		"deepseek-v4-flash",
	]);
	assert.ok(args.includes("/bundle/divo-llm/index.ts"));
	assert.ok(args.includes("/bundle/divo-gateway/index.ts"));
});
