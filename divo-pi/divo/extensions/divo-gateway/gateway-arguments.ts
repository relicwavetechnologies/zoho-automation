/**
 * Repairs the one gateway envelope mistake the model reliably makes.
 *
 * `op` names two different things one level apart. The gateway's own operation
 * lives at the top (`tools.invoke`), while the provider's operation lives deep
 * inside `payload.args` (`describe`, `call`). Faced with two boxes of the same
 * name, the model fills the inner one and leaves the outer empty — seven times
 * in one observed production session, four of them after it had already read
 * the error and corrected itself once.
 *
 * Pi rejects those locally, before the request leaves the container, and hands
 * the rejection back as a tool result. That is cheap for the backend and
 * expensive for the user: each one costs a full model round trip to rewrite an
 * envelope whose meaning was never actually in doubt.
 *
 * So it is repaired here, ahead of validation.
 *
 * ONLY WHEN THERE IS ONE POSSIBLE READING. This normalizes shape, it never
 * infers intent. A request that could plausibly be two different operations is
 * left exactly as it came and fails validation honestly — a silently wrong
 * guess executed against company data is far worse than an error the model can
 * read. Every rule below is justified by which fields the other operations
 * cannot accept.
 */

/** Gateway operations, and the single source of truth for the tool's enum. */
export const DIVO_GATEWAY_OPS = [
	"capabilities.get",
	"tools.list",
	"skills.list",
	"skills.search",
	"skills.get",
	"work.resolve",
	"persona.resolve",
	"teach.context.get",
	"teach.learning.apply",
	"connections.list",
	"media.image_ocr",
	"tools.preflight",
	"tools.invoke",
] as const;

const OPS = new Set<string>(DIVO_GATEWAY_OPS);

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Normalizes a raw gateway tool call before schema validation.
 *
 * Returns the input untouched unless exactly one repair applies.
 */
export function prepareGatewayArguments(raw: unknown): unknown {
	if (!isRecord(raw)) return raw;
	// An op that is already present is the caller's own choice, even a wrong
	// one. Rewriting it would hide a real mistake rather than a clerical one.
	if (raw["op"] !== undefined) return raw;

	const payload = isRecord(raw["payload"]) ? raw["payload"] : undefined;
	if (!payload) return raw;

	// The op was written one level too deep. `payload` has no `op` field of its
	// own, so a gateway op found there can only have been meant for the top.
	const nested = payload["op"];
	if (typeof nested === "string" && OPS.has(nested)) {
		const { op: _moved, ...rest } = payload;
		return { ...raw, op: nested, payload: rest };
	}

	// No op anywhere, but a tool and its arguments. Nothing else in the enum
	// accepts that pair: tools.list takes a toolId with no args, and
	// tools.preflight carries `invocations` instead. Only tools.invoke fits.
	if (typeof payload["toolId"] === "string" && isRecord(payload["args"])) {
		return { ...raw, op: "tools.invoke" };
	}

	return raw;
}
