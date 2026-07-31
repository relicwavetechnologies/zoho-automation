/**
 * Divo LLM proxy — repoints model inference through the Divo backend.
 *
 * PI holds NO provider key. It authenticates with DIVO_MEMBER_TOKEN; the backend
 * gates the request (block / budget / rate / model), forwards it to whichever
 * provider serves the model with the real key, streams the response back, and
 * records authoritative token usage.
 *
 * This overrides the built-in providers' baseUrl + auth, so the existing model
 * ids and request shape are unchanged. Config comes from the Divo runtime
 * launcher (DIVO_BACKEND_URL, DIVO_MEMBER_TOKEN). Missing configuration is
 * fatal: standalone Divo Pi never falls back to a direct provider.
 *
 * OpenAI is declared with an explicit model list rather than inherited. Luna
 * uses the Responses API because OpenAI does not support reasoning plus tools
 * for this model through Chat Completions. DeepSeek remains on Chat Completions.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { captureDivoGatewayConfig } from "../divo-gateway/gateway-client.ts";

export const DIVO_REQUEST_TOO_LARGE_ERROR =
	"request_too_large (HTTP 413, payload_too_large): Divo could not start the model continuation because the request body was too large. Retry with narrower, paginated, or truncated tool results.";

const REQUEST_TOO_LARGE_PATTERN =
	/\b413\b|request[_ ]too[_ ]large|payload[_ ]too[_ ]large|entity\.too\.large|PayloadTooLargeError/i;

/**
 * GPT-5.6 Luna, as Pi needs to know it.
 *
 * `input` carries the whole point: it is the one model here that can be handed
 * a picture, and Pi's `read` tool consults exactly this field to decide whether
 * to return image bytes or a note saying the model cannot see them. Getting it
 * wrong does not error — it silently turns every image into "I can't view that".
 *
 * Costs are recorded for Pi's own display only; the backend prices the run from
 * the provider's authoritative usage and never reads these.
 */
export const DIVO_LUNA_MODEL = {
	id: "gpt-5.6-luna",
	name: "GPT-5.6 Luna",
	api: "openai-responses" as const,
	reasoning: true,
	input: ["text", "image"] as ("text" | "image")[],
	cost: { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0 },
	contextWindow: 1_050_000,
	maxTokens: 128_000,
};

export function normalizeDivoLlmRequestError<T>(message: T): T {
	if (typeof message !== "object" || message === null) return message;
	const candidate = message as Record<string, unknown>;
	if (candidate.role !== "assistant" || candidate.stopReason !== "error") return message;
	// Every provider here is the Divo proxy behind a different name, so the 413
	// Express raises before the proxy is reached looks the same on all of them.
	if (candidate.provider !== "deepseek" && candidate.provider !== "openai") return message;
	const errorMessage = typeof candidate.errorMessage === "string" ? candidate.errorMessage : "";
	if (!REQUEST_TOO_LARGE_PATTERN.test(errorMessage)) return message;
	if (errorMessage === DIVO_REQUEST_TOO_LARGE_ERROR) return message;
	return {
		...candidate,
		errorMessage: DIVO_REQUEST_TOO_LARGE_ERROR,
	} as T;
}

export default function divoLlmExtension(pi: ExtensionAPI) {
	const config = captureDivoGatewayConfig();
	// Scrub the credential even when the remaining proxy configuration is
	// incomplete. A partial/misconfigured desktop launch must fail without
	// leaving member auth available to later Bash or Python children.
	delete process.env.DIVO_MEMBER_TOKEN;
	if ("error" in config) {
		throw new Error(`${config.error} Standalone Divo Pi refuses direct provider fallback.`);
	}
	// The trace extension uses this process-local marker to add Divo correlation
	// fields only when DeepSeek is actually repointed to our proxy. It prevents
	// proxy-only fields from leaking into direct provider requests.
	process.env.DIVO_LLM_PROXY_ACTIVE = "1";

	// Our OpenAI-compatible proxy. Each provider SDK appends its own endpoint.
	const baseUrl = `${config.backendUrl}/api/llm/v1`;
	const proxied = {
		baseUrl,
		// Pi keeps this value in provider memory. Remove it from process.env below
		// so ordinary Bash/Python children cannot inherit the member credential.
		apiKey: config.memberToken,
		authHeader: true,
		// Emit the session id header so the backend can group calls into a run.
		compat: { sendSessionAffinityHeaders: true },
	} as const;

	pi.registerProvider("deepseek", { ...proxied });
	pi.registerProvider("openai", {
		...proxied,
		api: "openai-responses",
		models: [DIVO_LUNA_MODEL],
	});
	// A request rejected by Express never reaches the LLM proxy or emits model
	// tokens. Keep the provider failure concise and machine-recognisable so Pi
	// can surface it and apply its normal oversized-context recovery path.
	pi.on("message_end", (event) => {
		const message = normalizeDivoLlmRequestError(event.message);
		return message === event.message ? undefined : { message };
	});
}
