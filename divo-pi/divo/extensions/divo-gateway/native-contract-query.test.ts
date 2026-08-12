import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { nativeContractQuery } from "./typed-tool-runtime.ts";

describe("nativeContractQuery", () => {
	it("trims and bounds prompt context to the backend tools.list contract", () => {
		assert.equal(nativeContractQuery("  airtable records  "), "airtable records");
		assert.equal(nativeContractQuery("x".repeat(2_001))?.length, 2_000);
	});

	it("omits search context that is too short to be useful", () => {
		assert.equal(nativeContractQuery("  x  "), undefined);
	});
});
