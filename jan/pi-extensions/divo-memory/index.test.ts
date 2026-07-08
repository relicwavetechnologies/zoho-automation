import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import divoMemoryExtension from "./index.ts";
import { handleMemoryRequest } from "./memory-store.ts";

async function withMemoryDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "divo-memory-extension-test-"));
	const previous = process.env.DIVO_MEMORY_DIR;
	process.env.DIVO_MEMORY_DIR = dir;
	try {
		return await fn(dir);
	} finally {
		if (previous === undefined) {
			delete process.env.DIVO_MEMORY_DIR;
		} else {
			process.env.DIVO_MEMORY_DIR = previous;
		}
		await rm(dir, { recursive: true, force: true });
	}
}

test("registers memory tool and injects memory prompt context", async () => {
	await withMemoryDir(async () => {
		await handleMemoryRequest({
			action: "add",
			target: "user",
			content: "User prefers concise summaries.",
		});

		const handlers = new Map<string, Function[]>();
		const tools: any[] = [];
		divoMemoryExtension({
			on(event: string, handler: Function) {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
			registerTool(tool: any) {
				tools.push(tool);
			},
		} as any);

		assert.equal(tools[0]?.name, "memory");
		const beforeStart = handlers.get("before_agent_start")?.[0];
		assert.equal(typeof beforeStart, "function");

		const result = await beforeStart({
			systemPrompt: "base prompt",
		});
		assert.match(result.systemPrompt, /base prompt/);
		assert.match(result.systemPrompt, /divo_user_memory/);
		assert.match(result.systemPrompt, /USER MEMORY/);
		assert.match(result.systemPrompt, /User prefers concise summaries/);
	});
});
