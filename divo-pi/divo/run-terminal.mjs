function asRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value
		: undefined;
}

/**
 * Pi emits agent_end for successful and failed loops. Only a stopped assistant
 * continuation with real model usage is a successful terminal run.
 */
export function classifyDivoRunTerminal(messages) {
	const last = asRecord(Array.isArray(messages) ? messages.at(-1) : undefined);
	if (!last || last.role !== "assistant") {
		const role = typeof last?.role === "string" ? last.role : "no message";
		return {
			status: "error",
			summary: `Run ended before the assistant continuation completed (terminal ${role}).`,
		};
	}

	const stopReason = typeof last.stopReason === "string" ? last.stopReason : undefined;
	if (stopReason !== "stop") {
		const errorMessage =
			typeof last.errorMessage === "string" ? last.errorMessage.trim().slice(0, 1_500) : "";
		return {
			status: "error",
			summary: errorMessage
				? `Assistant ${stopReason ?? "unknown"}: ${errorMessage}`
				: `Assistant ended with non-success stop reason ${stopReason ?? "unknown"}.`,
		};
	}

	const usage = asRecord(last.usage);
	if (
		typeof usage?.input === "number"
		&& typeof usage?.output === "number"
		&& usage.input
			+ usage.output
			+ (typeof usage.cacheRead === "number" ? usage.cacheRead : 0)
			+ (typeof usage.cacheWrite === "number" ? usage.cacheWrite : 0)
			=== 0
	) {
		return {
			status: "error",
			summary: "Assistant model call completed with zero tokens; no model continuation was produced.",
		};
	}

	return { status: "ok" };
}

export function isTransientDivoRunFailure(messages) {
	const last = asRecord(Array.isArray(messages) ? messages.at(-1) : undefined);
	if (!last || last.role !== "assistant" || last.stopReason !== "error") return false;
	const message = typeof last.errorMessage === "string" ? last.errorMessage : "";
	return /\b(?:408|425|429|5\d{2})\b|upstream unreachable|bad gateway|service unavailable|temporar(?:y|ily) unavailable|network error|connection (?:error|reset|closed|refused|lost)|other side closed|upstream connect|reset before headers|timed? ?out|fetch failed|econn(?:reset|refused)|socket hang up|rate limit|terminated|websocket (?:closed|error)|ended without|stream ended before message_stop|http2 request did not get a response/i.test(
		message,
	);
}
