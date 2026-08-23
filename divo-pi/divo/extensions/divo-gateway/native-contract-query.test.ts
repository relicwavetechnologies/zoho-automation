import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	nativeContractQuery,
	SPECULATIVE_NATIVE_CONTRACT_MODE,
} from "./typed-tool-runtime.ts";

describe("nativeContractQuery", () => {
	it("trims and bounds prompt context to the backend tools.list contract", () => {
		assert.equal(nativeContractQuery("  airtable records  "), "airtable records");
		assert.equal(nativeContractQuery("x".repeat(2_001))?.length, 2_000);
	});

	it("omits search context that is too short to be useful", () => {
		assert.equal(nativeContractQuery("  x  "), undefined);
	});

	it("keeps speculative complete preload off the provider critical path", () => {
		assert.equal(SPECULATIVE_NATIVE_CONTRACT_MODE, "complete_cached");
	});
});
