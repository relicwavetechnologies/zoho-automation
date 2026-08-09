import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { TypedToolHost } from "./typed-tool-runtime.ts";
import {
	CONNECTION_PROVIDERS,
	DIVO_CONNECTIONS_PARAMS,
	DIVO_IMAGE_READ_PARAMS,
	registerTypedPlatformTools,
} from "./typed-platform-tools.ts";

type Registered = Parameters<TypedToolHost["registerTool"]>[0];

function host(): { host: TypedToolHost; tools: Registered[] } {
	const tools: Registered[] = [];
	return { host: { registerTool: (definition) => void tools.push(definition) }, tools };
}

const validate = (name: string, parameters: unknown, args: unknown) =>
	validateToolArguments({ name, description: "", parameters } as never, { name, arguments: args } as never);

describe("registerTypedPlatformTools", () => {
	it("replaces the mega-tool operations that are real model-facing capabilities", () => {
		const { host: pi, tools } = host();
		const names = registerTypedPlatformTools(pi, async () => ({ content: [], details: undefined }));
		assert.deepEqual(names, ["divo_connections", "divo_image_read", "divo_preflight"]);
		assert.deepEqual(tools.map((tool) => tool.name), names);
	});

	it("sends each tool to its own gateway operation", async () => {
		const calls: Array<{ op: string; payload: Record<string, unknown> }> = [];
		const { host: pi, tools } = host();
		registerTypedPlatformTools(pi, async ({ op, payload }) => {
			calls.push({ op, payload });
			return { content: [], details: undefined };
		});

		await tools[0]!.execute("c1", { provider: "zoho" }, undefined, undefined, {});
		await tools[1]!.execute("c2", { filePath: "/tmp/a.png" }, undefined, undefined, {});

		assert.deepEqual(calls, [
			{ op: "connections.list", payload: { provider: "zoho" } },
			{ op: "media.image_ocr", payload: { filePath: "/tmp/a.png" } },
		]);
	});

	it("makes an omitted or invented provider unexpressible rather than discouraged", () => {
		assert.doesNotThrow(() => validate("divo_connections", DIVO_CONNECTIONS_PARAMS, { provider: "google_workspace" }));
		assert.throws(() => validate("divo_connections", DIVO_CONNECTIONS_PARAMS, {}), /provider/);
		// "never use google" was a guideline bullet; the enum now decides it.
		assert.throws(() => validate("divo_connections", DIVO_CONNECTIONS_PARAMS, { provider: "google" }), /allowed values/);
		assert.ok(!CONNECTION_PROVIDERS.includes("google" as never));
	});

	it("requires an image path and keeps the optional hints optional", () => {
		assert.doesNotThrow(() => validate("divo_image_read", DIVO_IMAGE_READ_PARAMS, { filePath: "/tmp/a.png" }));
		assert.throws(() => validate("divo_image_read", DIVO_IMAGE_READ_PARAMS, {}), /filePath/);
		assert.throws(() => validate("divo_image_read", DIVO_IMAGE_READ_PARAMS, { filePath: "" }), /Validation failed/);
	});
});
