import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gatewayToolResultDetails } from "./index.ts";

describe("protected Shopify gateway metadata", () => {
	it("preserves the exact backend marker for a zero-result protected read", () => {
		const protectedData = {
			used: true,
			provider: "shopify",
			connectionId: "11111111-1111-4111-8111-111111111111",
			category: "customers",
			references: [],
		};
		const details = gatewayToolResultDetails({
			ok: true,
			status: "success",
			data: { result: { count: 0 }, protectedData },
		}, 200);

		assert.equal(details.ok, true);
		assert.equal(details.status, "success");
		assert.strictEqual(
			(details.data as { protectedData: unknown }).protectedData,
			protectedData,
		);
	});
});
