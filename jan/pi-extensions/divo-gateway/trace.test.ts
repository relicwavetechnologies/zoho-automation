import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { registerTraceCapture } from "./trace.ts";

describe("Divo trace correlation", () => {
	it("injects the desktop run correlation only into the governed DeepSeek request", async () => {
		const directory = await mkdtemp(join(tmpdir(), "divo-trace-"));
		const contextPath = join(directory, "run.json");
		await writeFile(contextPath, JSON.stringify({
			version: 1,
			threadId: "thread-1",
			runId: "run-1",
		}));
		process.env.DIVO_RUN_CONTEXT_PATH = contextPath;
		process.env.DIVO_BACKEND_URL = "http://localhost:8000";
		process.env.DIVO_MEMBER_TOKEN = "member-token";
		process.env.DIVO_LLM_PROXY_ACTIVE = "1";

		const handlers = new Map<string, (event: any, ctx: any) => unknown>();
		registerTraceCapture({
			on: (name: string, handler: (event: any, ctx: any) => unknown) => {
				handlers.set(name, handler);
			},
		} as never);

		await handlers.get("agent_start")?.({ type: "agent_start" }, {});
		const payload = await handlers.get("before_provider_request")?.(
			{ type: "before_provider_request", payload: { model: "deepseek-v4-flash" } },
			{ model: { provider: "deepseek" } },
		);
		assert.deepEqual(payload, {
			model: "deepseek-v4-flash",
			divo_run_id: "run-1",
			divo_trace_mode: "desktop",
		});

		const untouched = await handlers.get("before_provider_request")?.(
			{ type: "before_provider_request", payload: { model: "other" } },
			{ model: { provider: "openai" } },
		);
		assert.equal(untouched, undefined);
	});
});
