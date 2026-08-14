import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	parseSurfaceCapabilities,
	presentationPolicy,
	type DivoSurfaceCapabilities,
} from "./presentation-policy.ts";

const LARK: DivoSurfaceCapabilities = {
	key: "lark",
	artifacts: "none",
	charts: false,
	tables: { maxRows: 15, maxPerMessage: 3 },
	maxBlockChars: 1_200,
	maxMessageBytes: 18_000,
	worklog: "patched-card",
	approvals: "card-buttons",
	handoff: false,
};

describe("presentation policy", () => {
	// The whole design rests on this: one generator, no second prompt. A policy
	// that read the channel's name would be two prompts wearing one function.
	it("never branches on which surface it is describing", () => {
		const web = presentationPolicy({ ...LARK, key: "web", worklog: "streamed" });
		const lark = presentationPolicy(LARK);
		// The only prose difference between level-1 web and Lark is the work log.
		const normalize = (text: string) => text
			.replace(/"(lark|web)"/, '"surface"')
			.replace(/Your progress is[\s\S]*?do not restate the whole run at the end\./, "PROGRESS");
		assert.equal(normalize(web), normalize(lark));
	});

	it("tells the model the surface's real limits rather than a style preference", () => {
		const policy = presentationPolicy(LARK);
		assert.match(policy, /15 rows/);
		assert.match(policy, /at most 3 tables/);
		assert.match(policy, /under 1200 characters/);
		assert.match(policy, /under roughly 18KB/);
	});

	// This is the line company-workspace.md used to hard-code. It is now derived,
	// so a surface that gains file delivery flips one field instead of editing
	// the model's instructions.
	it("says not to write a file as the deliverable only when none can be delivered", () => {
		assert.match(presentationPolicy(LARK), /cannot hand a file to the reader/);
		assert.doesNotMatch(
			presentationPolicy({ ...LARK, artifacts: "inline" }),
			/cannot hand a file to the reader/,
		);
	});

	describe("reading the descriptor", () => {
		it("accepts what the backend sends", () => {
			assert.deepEqual(parseSurfaceCapabilities({ ...LARK }), LARK);
		});

		// Nothing is the right answer: no block is emitted and Divo behaves as it
		// did before any of this existed. A guessed descriptor would brief the
		// model on a surface we could not read.
		it("returns nothing rather than guessing at a malformed one", () => {
			assert.equal(parseSurfaceCapabilities(undefined), null);
			assert.equal(parseSurfaceCapabilities({ ...LARK, artifacts: "attachment" }), null);
			assert.equal(parseSurfaceCapabilities({ ...LARK, maxBlockChars: 0 }), null);
			assert.equal(parseSurfaceCapabilities({ ...LARK, tables: { maxRows: 15 } }), null);
			assert.equal(parseSurfaceCapabilities({ ...LARK, charts: "yes" }), null);
		});
	});
});
