import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRuntimeAskRegistry } from "../runtime-ask-registry.mjs";
import {
	createRuntimeExtensionResponder,
	readConnectAsk,
	DIVO_CONNECT_PROTOCOL_TITLE,
} from "../approval-responder.mjs";

const later = () => new Date(Date.now() + 60_000).toISOString();

describe("runtime ask registry", () => {
	it("holds a question open and settles it when the answer arrives", async () => {
		const asks = createRuntimeAskRegistry();
		let settled;
		const parked = asks.park({
			askId: "intent-1",
			expiresAt: later(),
			settle: granted => { settled = granted; },
		});

		assert.equal(parked, true);
		assert.equal(asks.pendingCount, 1);
		assert.equal(settled, undefined, "nothing may be settled before the answer");

		assert.equal(asks.answer("intent-1", true), true);
		assert.equal(settled, true);
		assert.equal(asks.pendingCount, 0);
	});

	it("reports an answer nobody was waiting for", () => {
		const asks = createRuntimeAskRegistry();
		assert.equal(asks.answer("never-parked", true), false);
	});

	it("settles a question at its deadline rather than leaving the run hanging", async () => {
		/* An unanswered confirm holds the run until the admission slot expires
		   twenty minutes later. Expiring the question ourselves turns that into
		   something the model can tell the member about. */
		const asks = createRuntimeAskRegistry();
		let settled;
		asks.park({
			askId: "intent-expiring",
			expiresAt: new Date(Date.now() + 20).toISOString(),
			settle: granted => { settled = granted; },
		});

		await new Promise(resolve => setTimeout(resolve, 60));
		assert.equal(settled, false);
		assert.equal(asks.pendingCount, 0);
	});

	it("releases the question when the run is abandoned", () => {
		const asks = createRuntimeAskRegistry();
		const controller = new AbortController();
		let settled;
		asks.park({
			askId: "intent-aborting",
			expiresAt: later(),
			signal: controller.signal,
			settle: granted => { settled = granted; },
		});

		controller.abort();
		assert.equal(settled, false);
		assert.equal(asks.pendingCount, 0);
	});

	it("refuses a deadline that has already passed", () => {
		const asks = createRuntimeAskRegistry();
		const parked = asks.park({
			askId: "intent-stale",
			expiresAt: new Date(Date.now() - 1_000).toISOString(),
			settle: () => {},
		});
		assert.equal(parked, false);
	});

	it("refuses to park the same question twice", () => {
		const asks = createRuntimeAskRegistry();
		asks.park({ askId: "intent-dup", expiresAt: later(), settle: () => {} });
		assert.equal(
			asks.park({ askId: "intent-dup", expiresAt: later(), settle: () => {} }),
			false,
		);
	});

	it("stops accepting questions past its cap", () => {
		const asks = createRuntimeAskRegistry({ maxPending: 2 });
		asks.park({ askId: "a", expiresAt: later(), settle: () => {} });
		asks.park({ askId: "b", expiresAt: later(), settle: () => {} });
		assert.equal(asks.park({ askId: "c", expiresAt: later(), settle: () => {} }), false);
	});
});

describe("reading a connect ask off the wire", () => {
	it("takes the ask id from a well-formed request", () => {
		const read = readConnectAsk(
			DIVO_CONNECT_PROTOCOL_TITLE,
			JSON.stringify({ askId: "intent-9", expiresAt: "2026-08-21T00:00:00.000Z" }),
		);
		assert.deepEqual(read, { askId: "intent-9", expiresAt: "2026-08-21T00:00:00.000Z" });
	});

	it("ignores another protocol, malformed JSON, and a missing id", () => {
		assert.equal(readConnectAsk("divo_approval_v1", JSON.stringify({ askId: "x" })), undefined);
		assert.equal(readConnectAsk(DIVO_CONNECT_PROTOCOL_TITLE, "not json"), undefined);
		assert.equal(readConnectAsk(DIVO_CONNECT_PROTOCOL_TITLE, JSON.stringify({})), undefined);
	});
});

describe("the runtime responder", () => {
	const connectRequest = {
		id: "req-1",
		method: "confirm",
		title: DIVO_CONNECT_PROTOCOL_TITLE,
		message: JSON.stringify({ askId: "intent-2", expiresAt: later() }),
	};

	it("parks a connect request instead of answering it", async () => {
		const asks = createRuntimeAskRegistry();
		const responder = createRuntimeExtensionResponder({ asks });
		const responses = [];

		await responder(connectRequest, response => responses.push(response));

		assert.deepEqual(responses, [], "the run must still be waiting");
		assert.equal(asks.pendingCount, 1);

		asks.answer("intent-2", true);
		assert.deepEqual(responses, [
			{ type: "extension_ui_response", id: "req-1", confirmed: true },
		]);
	});

	it("answers rather than hangs when the question cannot be parked", async () => {
		const asks = createRuntimeAskRegistry({ maxPending: 0 });
		const responder = createRuntimeExtensionResponder({ asks });
		const responses = [];

		await responder(connectRequest, response => responses.push(response));

		assert.deepEqual(responses, [
			{ type: "extension_ui_response", id: "req-1", confirmed: false },
		]);
	});

	it("leaves every other decision to the headless policy", async () => {
		const asks = createRuntimeAskRegistry();
		const responder = createRuntimeExtensionResponder({ asks });
		const responses = [];

		await responder({
			id: "req-2",
			method: "confirm",
			title: "divo_approval_v1",
			message: JSON.stringify({ source: "bash" }),
		}, response => responses.push(response));
		await responder({
			id: "req-3",
			method: "confirm",
			title: "divo_approval_v1",
			message: JSON.stringify({ source: "divo" }),
		}, response => responses.push(response));

		assert.deepEqual(responses, [
			{ type: "extension_ui_response", id: "req-2", confirmed: true },
			{ type: "extension_ui_response", id: "req-3", confirmed: false },
		]);
		assert.equal(asks.pendingCount, 0);
	});
});
