/**
 * Divo LLM proxy — repoints DeepSeek inference through the Divo backend.
 *
 * PI holds NO DeepSeek key. It authenticates with DIVO_MEMBER_TOKEN; the backend
 * gates the request (block / budget / rate / model), forwards it to DeepSeek with
 * the real key, streams the response back, and records authoritative token usage.
 *
 * This overrides only the built-in `deepseek` provider's baseUrl + auth, so the
 * existing model ids (deepseek-v4-flash / -pro) and request shape are unchanged.
 * Config comes from desktop-managed env (DIVO_BACKEND_URL, DIVO_MEMBER_TOKEN).
 * If those are absent, we do nothing and PI calls DeepSeek directly as before.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const DIVO_REQUEST_TOO_LARGE_ERROR =
	"request_too_large (HTTP 413, payload_too_large): Divo could not start the model continuation because the request body was too large. Retry with narrower, paginated, or truncated tool results.";

const REQUEST_TOO_LARGE_PATTERN =
	/\b413\b|request[_ ]too[_ ]large|payload[_ ]too[_ ]large|entity\.too\.large|PayloadTooLargeError/i;

export function normalizeDivoLlmRequestError<T>(message: T): T {
	if (typeof message !== "object" || message === null) return message;
	const candidate = message as Record<string, unknown>;
	if (candidate.role !== "assistant" || candidate.stopReason !== "error") return message;
	if (candidate.provider !== "deepseek") return message;
	const errorMessage = typeof candidate.errorMessage === "string" ? candidate.errorMessage : "";
	if (!REQUEST_TOO_LARGE_PATTERN.test(errorMessage)) return message;
	if (errorMessage === DIVO_REQUEST_TOO_LARGE_ERROR) return message;
	return {
		...candidate,
		errorMessage: DIVO_REQUEST_TOO_LARGE_ERROR,
	} as T;
}

export default function divoLlmExtension(pi: ExtensionAPI) {
	const backendUrl = process.env.DIVO_BACKEND_URL;
	const memberToken = process.env.DIVO_MEMBER_TOKEN;
	if (!backendUrl || !memberToken) return; // unconfigured → fall back to direct DeepSeek
	// The trace extension uses this process-local marker to add Divo correlation
	// fields only when DeepSeek is actually repointed to our proxy. It prevents
	// proxy-only fields from leaking into direct provider requests.
	process.env.DIVO_LLM_PROXY_ACTIVE = "1";

	pi.registerProvider("deepseek", {
		// Our OpenAI-compatible proxy. The SDK appends /chat/completions.
		baseUrl: `${backendUrl.replace(/\/$/, "")}/api/llm/v1`,
		// Send the member token as the bearer key ($ENV resolved by pi-ai).
		apiKey: "$DIVO_MEMBER_TOKEN",
		authHeader: true,
		// Emit the session id header so the backend can group calls into a run.
		compat: { sendSessionAffinityHeaders: true },
	});

	// A request rejected by Express never reaches the LLM proxy or emits model
	// tokens. Keep the provider failure concise and machine-recognisable so Pi
	// can surface it and apply its normal oversized-context recovery path.
	pi.on("message_end", (event) => {
		const message = normalizeDivoLlmRequestError(event.message);
		return message === event.message ? undefined : { message };
	});
}
