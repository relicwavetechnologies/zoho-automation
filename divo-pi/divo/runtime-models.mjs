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
	"deepseek-v4-flash": "deepseek",
	"deepseek-v4-pro": "deepseek",
	"gpt-5.6-luna": "openai",
};

export const RUNTIME_MODEL_IDS = Object.keys(RUNTIME_MODELS);

/** Which models can be shown an image rather than a transcription of one. */
export const VISION_MODELS = new Set(["gpt-5.6-luna"]);

/**
 * Exact Pi reasoning levels each provider model honours as a distinct mode.
 *
 * DeepSeek maps `medium` to `high`; exposing both would create a control whose
 * label changes while the provider request does not. `xhigh` is Pi's portable
 * name for DeepSeek's `max` effort.
 */
export const RUNTIME_REASONING_LEVELS = Object.freeze({
	"deepseek-v4-flash": Object.freeze(["off", "high", "xhigh"]),
	"deepseek-v4-pro": Object.freeze(["off", "high", "xhigh"]),
	"gpt-5.6-luna": Object.freeze(["off", "minimal", "low", "medium", "high"]),
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
