import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	isSettledDivoRunRefusal,
	isTransientDivoRunFailure,
} from "../run-terminal.mjs";

/** The shape Pi hands back when a continuation fails. */
const failedWith = (errorMessage) => [
	{ role: "assistant", stopReason: "error", errorMessage },
];

/** Exactly what the gateway sends a workspace with no model key yet. */
const NO_KEY =
	'Assistant error: 503: {"message":"The AI proxy has no DeepSeek key configured. Add one in Guardrails.","type":"not_configured"}';

describe("isTransientDivoRunFailure", () => {
	it("retries the failures that really are weather", () => {
		for (const message of [
			"Assistant error: 502: upstream unreachable",
			"Assistant error: 429: rate limit exceeded",
			"fetch failed",
			"socket hang up",
			"stream ended before message_stop",
		]) {
			assert.equal(isTransientDivoRunFailure(failedWith(message)), true, message);
		}
	});

	it("does not retry a missing model key, whatever status carries it", () => {
		/* The whole bug: 503 matches the status-code test, so this was retried
		   three times and then reported as a lost connection. */
		assert.equal(isTransientDivoRunFailure(failedWith(NO_KEY)), false);
	});

	it("does not retry a denied guardrail or a bad session", () => {
		assert.equal(
			isTransientDivoRunFailure(
				failedWith('Assistant error: 403: {"message":"Denied","type":"guardrails"}'),
			),
			false,
		);
		assert.equal(
			isTransientDivoRunFailure(
				failedWith('Assistant error: 401: {"message":"Unauthenticated","type":"auth"}'),
			),
			false,
		);
	});

	it("still retries an upstream 502, which is the one 5xx that can change", () => {
		assert.equal(
			isTransientDivoRunFailure(
				failedWith('Assistant error: 502: {"message":"Upstream unreachable","type":"upstream"}'),
			),
			true,
		);
	});

	it("ignores anything that is not a failed assistant turn", () => {
		assert.equal(isTransientDivoRunFailure([]), false);
		assert.equal(isTransientDivoRunFailure(undefined), false);
		assert.equal(
			isTransientDivoRunFailure([{ role: "assistant", stopReason: "stop" }]),
			false,
		);
		assert.equal(isTransientDivoRunFailure([{ role: "user" }]), false);
	});
});

describe("isSettledDivoRunRefusal", () => {
	it("names the three refusals that will refuse again", () => {
		assert.equal(isSettledDivoRunRefusal(failedWith(NO_KEY)), true);
		assert.equal(
			isSettledDivoRunRefusal(failedWith('{"type":"guardrails"}')),
			true,
		);
		assert.equal(isSettledDivoRunRefusal(failedWith('{"type":"auth"}')), true);
	});

	it("reads the type, not the prose beside it", () => {
		/* Prose is written for a person and gets rewritten by one. A message that
		   merely talks about keys is not a settled refusal. */
		assert.equal(
			isSettledDivoRunRefusal(failedWith("503: the key server was slow to answer")),
			false,
		);
	});

	it("survives whitespace in the JSON the gateway sends", () => {
		assert.equal(
			isSettledDivoRunRefusal(failedWith('{ "type" : "not_configured" }')),
			true,
		);
	});
});
