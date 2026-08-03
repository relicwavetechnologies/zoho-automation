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

export function isRuntimeModel(value) {
	return typeof value === "string" && Object.hasOwn(RUNTIME_MODELS, value);
}

export function providerForModel(value) {
	return RUNTIME_MODELS[value];
}

export function thinkingLevelForModel(value, fallback = "medium") {
	return value === "gpt-5.6-luna" || value === "deepseek-v4-flash" || value === "deepseek-v4-pro"
		? "high"
		: fallback;
}
