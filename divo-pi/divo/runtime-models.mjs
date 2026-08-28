/**
 * The models a Divo run may be launched on, and who serves each.
 *
 * Shared because the same table has to hold on both sides of the container
 * wall: the controller validates what the backend asked for before it starts
 * anything, and the runtime validates again before it turns the answer into a
 * command line. Two copies would drift, and the failure that drift produces is
 * a container that starts and then cannot reach a model.
 *
 * Membership here is not authorization. The member's grant is enforced by the
 * backend proxy, which is the only place that holds a provider key and the only
 * place that can audit a refusal. This list exists so an unknown model fails
 * early and legibly instead of somewhere the user only sees silence.
 */

export const RUNTIME_MODELS = {
	"muse-spark-1.2-contributor": "meta",
	"muse-spark-1.2": "meta",
	"deepseek-v4-flash": "deepseek",
	"deepseek-v4-pro": "deepseek",
	"gpt-5.6-luna": "openai",
};

export const RUNTIME_MODEL_IDS = Object.keys(RUNTIME_MODELS);

/** Which models can be shown an image rather than a transcription of one. */
export const VISION_MODELS = new Set(["gpt-5.6-luna", "muse-spark-1.2-contributor", "muse-spark-1.2"]);

/**
 * Exact Pi reasoning levels each provider model honours as a distinct mode.
 *
 * Every rung is named after the value that reaches the provider, which breaks
 * with upstream's habit of routing any model's ceiling through `xhigh`. That
 * shorthand works until one model offers both — GPT-5.6 does — because then the
 * same word means `xhigh` on Luna and `max` on DeepSeek, and no picker can be
 * read. So DeepSeek's ceiling sits on `max`, its literal wire value, applied as
 * a model override in `buildAgentConfiguration`; Luna spends all six of its own.
 *
 * A level is left out when the provider will not honour it as a distinct mode:
 * DeepSeek folds `low`/`medium` into `high`, and GPT-5.6 retired `minimal`.
 * Offering either is a control whose label changes while the request does not.
 */
export const RUNTIME_REASONING_LEVELS = Object.freeze({
	// Spark reasons on every call — there is no rung that turns it off, so one
	// is not offered. It also stops at `xhigh`; `max` is DeepSeek's literal wire
	// value below, not a shared ceiling.
	"muse-spark-1.2-contributor": Object.freeze(["minimal", "low", "medium", "high", "xhigh"]),
	"muse-spark-1.2": Object.freeze(["minimal", "low", "medium", "high", "xhigh"]),
	"deepseek-v4-flash": Object.freeze(["off", "high", "max"]),
	"deepseek-v4-pro": Object.freeze(["off", "high", "max"]),
	"gpt-5.6-luna": Object.freeze(["off", "low", "medium", "high", "xhigh", "max"]),
});

export const DEFAULT_RUNTIME_REASONING_LEVEL = "high";

export function isRuntimeModel(value) {
	return typeof value === "string" && Object.hasOwn(RUNTIME_MODELS, value);
}

export function providerForModel(value) {
	return RUNTIME_MODELS[value];
}

export function reasoningLevelsForModel(value) {
	return RUNTIME_REASONING_LEVELS[value] ?? [];
}

export function thinkingLevelForModel(value, requested = DEFAULT_RUNTIME_REASONING_LEVEL) {
	const supported = reasoningLevelsForModel(value);
	if (!supported.includes(requested)) {
		throw new Error(
			`thinkingLevel for ${value} must be one of: ${supported.join(", ")}`,
		);
	}
	return requested;
}
