/**
 * Who answers Pi when it asks for permission.
 *
 * Pi raises the same request whether a person is watching or not, so something
 * always has to answer it. There are exactly two answerers and they differ in
 * kind, not in degree: one blocks on a terminal's stdin and is only reachable
 * when a human ran the CLI, and one is a policy that runs with nobody there.
 *
 * The headless one is the security-bearing half. It confirms a narrow list of
 * workspace actions and cancels everything else, because a run started by the
 * backend has no one to escalate to and "ask again later" is not available to
 * it. That policy is why this is a module: it is a decision about what an
 * unattended agent may do to its own workspace, and it should be readable
 * without the turn plan around it.
 */
import readline from "node:readline";

async function ask(question) {
	const terminal = readline.createInterface({
		input: process.stdin,
		output: process.stderr,
	});
	try {
		return await new Promise((resolve) => terminal.question(question, resolve));
	} finally {
		terminal.close();
	}
}

export function createExtensionResponder(autoApprove) {
	return async (request, respond) => {
		if (
			["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"].includes(
				request.method,
			)
		) {
			if (request.message) console.error(`[Pi] ${request.message}`);
			return;
		}
		if (request.method === "confirm") {
			const answer = autoApprove
				? "y"
				: await ask(`${request.title}: ${request.message} [y/N] `);
			respond({
				type: "extension_ui_response",
				id: request.id,
				confirmed: /^y(es)?$/i.test(answer.trim()),
			});
			return;
		}
		if (request.method === "select") {
			console.error(request.options.map((value, index) => `${index + 1}. ${value}`).join("\n"));
			const answer = await ask(`${request.title} (number, blank cancels): `);
			const selected = request.options[Number(answer) - 1];
			respond(
				selected
					? { type: "extension_ui_response", id: request.id, value: selected }
					: { type: "extension_ui_response", id: request.id, cancelled: true },
			);
			return;
		}
		const answer = await ask(`${request.title} (blank cancels): `);
		respond(
			answer
				? { type: "extension_ui_response", id: request.id, value: answer }
				: { type: "extension_ui_response", id: request.id, cancelled: true },
		);
	};
}

export function approveHeadlessWorkspaceAction(title, message) {
	if (title !== "divo_approval_v1" || typeof message !== "string") return false;
	try {
		const request = JSON.parse(message);
		return ["bash", "edit", "write"].includes(request?.source);
	} catch {
		return false;
	}
}

export function createHeadlessExtensionResponder() {
	return async (request, respond) => {
		if (
			["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"].includes(
				request.method,
			)
		) {
			if (request.message) console.error(`[Pi] ${request.message}`);
			return;
		}
		if (request.method === "confirm") {
			respond({
				type: "extension_ui_response",
				id: request.id,
				confirmed: approveHeadlessWorkspaceAction(request.title, request.message),
			});
			return;
		}
		respond({ type: "extension_ui_response", id: request.id, cancelled: true });
	};
}

/**
 * The wire title for "tell me when the member has connected this account".
 *
 * Declared here as well as in the gateway extension, the way
 * `divo_approval_v1` already is. The two halves are compiled separately and
 * only ever meet as a string on this channel, so the string is the contract.
 */
export const DIVO_CONNECT_PROTOCOL_TITLE = "divo_connect_v1";

/** The ask id, or undefined when this is not a connect request we can hold. */
export function readConnectAsk(title, message) {
	if (title !== DIVO_CONNECT_PROTOCOL_TITLE || typeof message !== "string") return undefined;
	try {
		const parsed = JSON.parse(message);
		const askId = parsed?.askId;
		if (typeof askId !== "string" || !askId.trim()) return undefined;
		return {
			askId,
			expiresAt: typeof parsed?.expiresAt === "string" ? parsed.expiresAt : undefined,
		};
	} catch {
		return undefined;
	}
}

/**
 * The headless policy, plus the one question it is allowed to not answer.
 *
 * Everything the policy already decided still decides the same way. A connect
 * request is the exception because there is no policy that could answer it:
 * whether the member connected their Google account is a fact about the world,
 * not a rule, and the only way to learn it is to wait for the world to say so.
 */
export function createRuntimeExtensionResponder({ asks, signal }) {
	const headless = createHeadlessExtensionResponder();
	return async (request, respond) => {
		if (request.method === "confirm") {
			const ask = readConnectAsk(request.title, request.message);
			if (ask) {
				const parked = asks.park({
					askId: ask.askId,
					expiresAt: ask.expiresAt,
					signal,
					settle: granted => respond({
						type: "extension_ui_response",
						id: request.id,
						confirmed: granted,
					}),
				});
				// Refusing to park is not a reason to leave the run hanging. A
				// declined wait reads to the model as "not connected", which is
				// both true and something it can act on.
				if (!parked) {
					respond({ type: "extension_ui_response", id: request.id, confirmed: false });
				}
				return;
			}
		}
		return headless(request, respond);
	};
}
