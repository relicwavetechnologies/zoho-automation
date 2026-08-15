/**
 * What a finished run actually produced, and whether it may be re-run.
 *
 * A completed Pi run is a list of messages, not an answer. Reading one is a
 * policy question rather than a parsing question, and the policy is about side
 * effects: a run that already created an invoice must never be retried, and a
 * run that only read may be. So the same walk over the messages answers three
 * things at once — the text to deliver, the protected records it touched, and
 * whether anything irreversible happened.
 *
 * The conservative direction is deliberate and asymmetric. An unrecognised
 * gateway action counts as mutating, because the cost of wrongly retrying a
 * write is a duplicate side effect in someone's real account, and the cost of
 * wrongly refusing to retry is one honest failure message.
 *
 * `run-terminal.mjs` classifies the terminal event this run ended with. This
 * classifies the messages it produced along the way.
 */
import { isGovernedDivoTool } from "./runtime-progress.mjs";

export function collectRunAssistantText(messages) {
	if (!Array.isArray(messages)) return "";
	const lastUserIndex = messages.findLastIndex((message) => message?.role === "user");
	const candidates = messages.slice(lastUserIndex + 1).filter(
		(message) =>
			message?.role === "assistant" &&
			Array.isArray(message.content) &&
			message.content.some((content) => content?.type === "text" && content.text?.trim()),
	);
	const finalMessage = candidates.findLast((message) => message.stopReason === "stop")
		?? candidates.at(-1);
	if (!finalMessage) return "";
	const chunks = finalMessage.content.flatMap((content) => {
		if (content?.type !== "text" || typeof content.text !== "string") return [];
		const text = content.text.trim();
		return text ? [text] : [];
	});
	return chunks.join("\n\n");
}

const PROTECTED_SHOPIFY_TOOLS = new Set(["shopifyOrders", "shopifyCustomers"]);

function gatewayToolId(call, result) {
	if (call?.name === "divo_shopify_orders") return "shopifyOrders";
	if (call?.name === "divo_shopify_customers") return "shopifyCustomers";
	const payloadToolId = call?.arguments?.payload?.toolId;
	if (typeof payloadToolId === "string") return payloadToolId;
	const dataToolId = result?.details?.data?.toolId;
	return typeof dataToolId === "string" ? dataToolId : undefined;
}

export function collectProtectedRunMetadata(messages) {
	if (!Array.isArray(messages)) {
		return { protectedDataUsed: false, protectedRefs: [] };
	}
	const lastUserIndex = messages.findLastIndex((message) => message?.role === "user");
	const currentRun = messages.slice(lastUserIndex + 1);
	const gatewayCalls = currentRun.flatMap((message) =>
		message?.role === "assistant" && Array.isArray(message.content)
			? message.content.filter((content) =>
				content?.type === "toolCall" && isGovernedDivoTool(content.name))
			: [],
	);
	if (gatewayCalls.length === 0) {
		return { protectedDataUsed: false, protectedRefs: [] };
	}

	let protectedDataUsed = false;
	let protectedRefs = [];
	let protectedProvenanceValid = true;

	for (const call of gatewayCalls) {
		const result = currentRun.find((message) =>
			message?.role === "toolResult" && message.toolCallId === call.id);
		const toolId = gatewayToolId(call, result);
		if (toolId && PROTECTED_SHOPIFY_TOOLS.has(toolId)) {
			protectedDataUsed = true;
		}

		const protectedData = result?.details?.data?.protectedData;
		if (protectedData?.used === true) {
			protectedDataUsed = true;
			if (result?.isError !== true) {
				const refs = protectedData.references;
				if (Array.isArray(refs)) {
					protectedRefs = refs;
				} else if (refs !== undefined) {
					protectedProvenanceValid = false;
				}
			}
		}
	}

	if (!protectedDataUsed) {
		return { protectedDataUsed: false, protectedRefs: [] };
	}

	return {
		protectedDataUsed: true,
		protectedRefs,
		protectedProvenanceValid,
	};
}

export function logCompletedRun(text, metadata, logger) {
	if (metadata?.protectedDataUsed === true) {
		logger("[divo-pi] protected run completed; final text suppressed");
		return;
	}
	logger(text);
}

export function terminalRunError(terminal, messages) {
	const error = new Error(terminal.summary ?? "The model continuation did not complete.");
	error.code = "model_continuation_failed";
	error.statusCode = 502;
	const metadata = messages ? collectProtectedRunMetadata(messages) : undefined;
	if (metadata?.protectedDataUsed) {
		error.protectedDataUsed = true;
		error.protectedRefs = metadata.protectedRefs;
		if (!metadata.protectedProvenanceValid) {
			error.protectedProvenanceValid = false;
		}
	}
	return error;
}

const MUTATING_GATEWAY_ACTIONS = new Set(["create", "update", "delete", "send", "execute"]);
const KNOWN_GATEWAY_ACTIONS = new Set(["read", ...MUTATING_GATEWAY_ACTIONS]);

export function gatewayActionState(messages) {
	if (!Array.isArray(messages)) return "none";
	const lastUserIndex = messages.findLastIndex((message) => message?.role === "user");
	const currentRun = messages.slice(lastUserIndex + 1);
	const calls = currentRun.flatMap((message) =>
		message?.role === "assistant" && Array.isArray(message.content)
			? message.content.filter((content) =>
				content?.type === "toolCall"
				&& isGovernedDivoTool(content.name))
			: [],
	);
	if (calls.length === 0) return "none";
	const actions = [];
	for (const call of calls) {
		const result = currentRun.find((message) =>
			message?.role === "toolResult"
			&& message.toolCallId === call.id
			&& isGovernedDivoTool(message.toolName),
		);
		const action = result?.details?.data?.action;
		if (
			result?.isError !== false
			|| typeof action !== "string"
			|| !KNOWN_GATEWAY_ACTIONS.has(action)
		) return "unsafe";
		actions.push(action);
	}
	if (!actions.some((action) => MUTATING_GATEWAY_ACTIONS.has(action))) return "read_only";
	return actions.at(-1) === "read" ? "mutation_then_read" : "completed_mutation";
}

export function completedGatewayFallback(completion, readAfterMutation) {
	const text = readAfterMutation
		? "Divo completed the requested company action, and a subsequent read also succeeded. The final summary was interrupted, so Divo did not repeat the action."
		: "Divo completed the requested company action. The final summary was interrupted, so Divo did not repeat the action.";
	return {
		...completion,
		messages: [
			...(Array.isArray(completion?.messages) ? completion.messages : []),
			{
				role: "assistant",
				stopReason: "stop",
				usage: { input: 0, output: 1 },
				content: [{ type: "text", text }],
			},
		],
	};
}
