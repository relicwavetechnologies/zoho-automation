import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import divoLlmExtension, {
	DIVO_LUNA_MODEL,
	DIVO_REQUEST_TOO_LARGE_ERROR,
	normalizeDivoLlmRequestError,
} from "./index.ts";
import { clearCapturedDivoGatewayConfig } from "../divo-gateway/gateway-client.ts";
import { reasoningLevelsForModel } from "../../runtime-models.mjs";

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

	// Both providers are the same Divo proxy under different names, so the 413
	// Express raises before the proxy is reached reads identically on either.
	it("normalizes the same failure on the OpenAI side", () => {
		const original = {
			role: "assistant",
			provider: "openai",
			stopReason: "error",
			errorMessage: "PayloadTooLargeError: request entity too large",
		};

		assert.deepEqual(normalizeDivoLlmRequestError(original), {
			...original,
			errorMessage: DIVO_REQUEST_TOO_LARGE_ERROR,
		});
	});

	it("does not rewrite unproxied providers or unrelated failures", () => {
		const unproxied = {
			role: "assistant",
			provider: "anthropic",
			stopReason: "error",
			errorMessage: "HTTP 413",
		};
		assert.equal(normalizeDivoLlmRequestError(unproxied), unproxied);

		const rateLimit = {
			role: "assistant",
			provider: "deepseek",
			stopReason: "error",
			errorMessage: "429 rate limit",
		};
		assert.equal(normalizeDivoLlmRequestError(rateLimit), rateLimit);
	});

	it("registers the normalizer only when the Divo proxy is configured", () => {
		process.env.DIVO_BACKEND_URL = "http://localhost:4000/";
		process.env.DIVO_MEMBER_TOKEN = "member-token";
		const handlers = new Map<string, (event: any) => unknown>();
		const providers = new Map<string, any>();

		divoLlmExtension({
			registerProvider: (provider: string, config: unknown) => {
				providers.set(provider, config);
			},
			on: (name: string, handler: (event: any) => unknown) => {
				handlers.set(name, handler);
			},
		} as never);

		// Every provider goes to the Divo proxy with the member token, never to
		// the vendor with a key — Pi holds none.
		assert.deepEqual([...providers.keys()].sort(), ["deepseek", "meta", "openai"]);
		for (const config of providers.values()) {
			assert.equal(config.apiKey, "member-token");
			assert.equal(config.baseUrl, "http://localhost:4000/api/llm/v1");
		}
		assert.equal(process.env.DIVO_MEMBER_TOKEN, undefined);

		// Both named models can be shown a picture, and Pi's read tool consults
		// exactly this to decide whether to hand over image bytes. A wrong value
		// here does not error — it silently blinds the model.
		const luna = providers.get("openai").models[0];
		assert.equal(luna.id, "gpt-5.6-luna");
		assert.deepEqual(luna.input, ["text", "image"]);
		assert.equal(luna.api, "openai-responses");

		// Meta is not a provider Pi ships with. Without this registration a run
		// launched on Spark dies at startup with `Unknown provider "meta"`, so the
		// name and the model behind it are asserted rather than assumed.
		const spark = providers.get("meta").models[0];
		assert.equal(spark.id, "muse-spark-1.2-contributor");
		assert.deepEqual(spark.input, ["text", "image"]);
		assert.equal(spark.api, "openai-responses");

		providers.clear();
		divoLlmExtension({
			registerProvider: (provider: string, config: unknown) => {
				providers.set(provider, config);
			},
			on: () => undefined,
		} as never);
		assert.equal(providers.get("deepseek").apiKey, "member-token");
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

		assert.throws(
			() =>
				divoLlmExtension({
					registerProvider: () => {
						registered = true;
					},
					on: () => undefined,
				} as never),
			/Standalone Divo Pi refuses direct provider fallback/,
		);

		assert.equal(registered, false);
		assert.equal(process.env.DIVO_MEMBER_TOKEN, undefined);
	});
});

// Both rungs above `high` are opt-in: Pi hides one unless this map names it.
// So runtime-models.mjs can advertise a level this entry forgot to map and
// nothing errors — the run just quietly thinks less than it was asked to.
describe("Luna reasoning ladder", () => {
	it("maps every rung the runtime table advertises to its own wire value", () => {
		const map: Record<string, string | null> = DIVO_LUNA_MODEL.thinkingLevelMap;

		for (const level of reasoningLevelsForModel("gpt-5.6-luna")) {
			// `off` is deliberately unmapped: this API already sends it as `none`.
			if (level === "off") continue;
			assert.equal(map[level] ?? level, level, `${level} must reach the provider as itself`);
		}
		assert.equal(map.xhigh, "xhigh");
		assert.equal(map.max, "max");
	});

	it("marks the retired minimal level unsupported so Pi clamps it", () => {
		assert.equal(reasoningLevelsForModel("gpt-5.6-luna").includes("minimal"), false);
		assert.equal(DIVO_LUNA_MODEL.thinkingLevelMap.minimal, null);
	});
});
