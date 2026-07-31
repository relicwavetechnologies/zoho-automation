import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import divoLlmExtension, {
	DIVO_REQUEST_TOO_LARGE_ERROR,
	normalizeDivoLlmRequestError,
} from "./index.ts";
import { clearCapturedDivoGatewayConfig } from "../divo-gateway/gateway-client.ts";

afterEach(() => {
	clearCapturedDivoGatewayConfig();
	delete process.env.DIVO_BACKEND_URL;
	delete process.env.DIVO_MEMBER_TOKEN;
	delete process.env.DIVO_LLM_PROXY_ACTIVE;
});

describe("Divo LLM proxy failure normalization", () => {
	it("turns a structured HTTP 413 response into a concise Pi-visible request_too_large failure", () => {
		const original = {
			role: "assistant",
			provider: "deepseek",
			stopReason: "error",
			errorMessage:
				'413: {"message":"Request body is too large","type":"request_too_large","code":"payload_too_large"}',
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};

		assert.deepEqual(normalizeDivoLlmRequestError(original), {
			...original,
			errorMessage: DIVO_REQUEST_TOO_LARGE_ERROR,
		});
	});

	it("does not rewrite unrelated providers or failures", () => {
		const unrelated = {
			role: "assistant",
			provider: "openai",
			stopReason: "error",
			errorMessage: "HTTP 413",
		};
		assert.equal(normalizeDivoLlmRequestError(unrelated), unrelated);

		const deepseekRateLimit = {
			role: "assistant",
			provider: "deepseek",
			stopReason: "error",
			errorMessage: "429 rate limit",
		};
		assert.equal(normalizeDivoLlmRequestError(deepseekRateLimit), deepseekRateLimit);
	});

	it("registers the normalizer only when the Divo proxy is configured", () => {
		process.env.DIVO_BACKEND_URL = "http://localhost:4000/";
		process.env.DIVO_MEMBER_TOKEN = "member-token";
		const handlers = new Map<string, (event: any) => unknown>();
		let providerConfig: unknown;

		divoLlmExtension({
			registerProvider: (_provider: string, config: unknown) => {
				providerConfig = config;
			},
			on: (name: string, handler: (event: any) => unknown) => {
				handlers.set(name, handler);
			},
		} as never);

		assert.ok(providerConfig);
		assert.equal((providerConfig as { apiKey?: string }).apiKey, "member-token");
		assert.equal(process.env.DIVO_MEMBER_TOKEN, undefined);
		providerConfig = undefined;
		divoLlmExtension({
			registerProvider: (_provider: string, config: unknown) => {
				providerConfig = config;
			},
			on: () => undefined,
		} as never);
		assert.equal((providerConfig as { apiKey?: string }).apiKey, "member-token");
		assert.equal(process.env.DIVO_LLM_PROXY_ACTIVE, "1");
		const original = {
			role: "assistant",
			provider: "deepseek",
			stopReason: "error",
			errorMessage: "PayloadTooLargeError: request entity too large",
		};
		assert.deepEqual(handlers.get("message_end")?.({ message: original }), {
			message: { ...original, errorMessage: DIVO_REQUEST_TOO_LARGE_ERROR },
		});
	});

	it("scrubs member auth when partial proxy configuration fails closed", () => {
		process.env.DIVO_MEMBER_TOKEN = "member-token";
		let registered = false;

		divoLlmExtension({
			registerProvider: () => {
				registered = true;
			},
			on: () => undefined,
		} as never);

		assert.equal(registered, false);
		assert.equal(process.env.DIVO_MEMBER_TOKEN, undefined);
	});
});
