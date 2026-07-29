import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildChildEnvironment, buildPiArguments } from "../runtime.mjs";

const values = {
	agentDir: "/tmp/divo-agent",
	artifactsDir: "/tmp/workspace/artifacts",
	backendUrl: "https://divo.example.com",
	dataDir: "/tmp/divo-data",
	departmentId: "department-1",
	homeDir: "/tmp/divo-home",
	internalDir: "/tmp/workspace/.divo",
	logsDir: "/tmp/run/logs",
	print: true,
	prompt: "hello",
	runContextPath: "/tmp/run-context.json",
	runDir: "/tmp/run",
	runId: "run-1",
	runtimeContextPath: "/tmp/runtime-context.json",
	scratchDir: "/tmp/run/tmp",
	scriptsDir: "/tmp/run/scripts",
	sessionDir: "/tmp/sessions",
	sessionPath: "/tmp/sessions/pi-session.jsonl",
	thread: "thread-1",
	token: "member-token",
	workspace: "/tmp/workspace",
};

describe("Divo Pi runtime boundary", () => {
	it("removes direct provider keys and injects only Divo authentication", () => {
		const environment = buildChildEnvironment(
			{
				OPENAI_API_KEY: "openai-secret",
				DEEPSEEK_API_KEY: "deepseek-secret",
				PATH: "/usr/bin",
			},
			values,
		);
		assert.equal(environment.OPENAI_API_KEY, undefined);
		assert.equal(environment.DEEPSEEK_API_KEY, undefined);
		assert.equal(environment.DIVO_MEMBER_TOKEN, "member-token");
		assert.equal(environment.DIVO_BACKEND_URL, "https://divo.example.com");
		assert.equal(environment.PATH, "/usr/bin");
	});

	it("pins Divo provider, model, extensions, skills, tools, and session", () => {
		const args = buildPiArguments(values);
		assert.deepEqual(args.slice(args.indexOf("--provider"), args.indexOf("--provider") + 4), [
			"--provider",
			"deepseek",
			"--model",
			"deepseek-v4-flash",
		]);
		assert.ok(args.includes("--no-extensions"));
		assert.ok(args.includes("--no-skills"));
		assert.ok(args.includes("/tmp/sessions/pi-session.jsonl"));
		assert.ok(args.some((argument) => argument.endsWith("/divo-llm/index.ts")));
		assert.ok(args.some((argument) => argument.endsWith("/divo-gateway/index.ts")));
	});
});
