import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { prepareGatewayArguments } from "./gateway-arguments.ts";

describe("gateway argument preparation", () => {
	/** Shape taken verbatim from a production session that failed validation. */
	const nativeArgs = {
		op: "call",
		nativeTool: "create_spreadsheet",
		connectionId: "366ede0d-ffcd-4b84-aca8-ccd77d5d3b58",
		input: { title: "Nayab Shopify Data - July 2026" },
	};

	it("lifts a gateway op written one level too deep", () => {
		assert.deepEqual(
			prepareGatewayArguments({
				payload: { toolId: "googleSheets", args: nativeArgs, op: "tools.invoke" },
			}),
			{ op: "tools.invoke", payload: { toolId: "googleSheets", args: nativeArgs } },
		);
	});

	it("keeps the provider's own op untouched while lifting the gateway one", () => {
		const result = prepareGatewayArguments({
			payload: { toolId: "googleSheets", args: nativeArgs, op: "tools.invoke" },
		}) as { payload: { args: { op: string } } };
		// `args.op` is the provider's operation and means something else entirely.
		assert.equal(result.payload.args.op, "call");
	});

	it("infers tools.invoke from a toolId and args with no op anywhere", () => {
		assert.deepEqual(
			prepareGatewayArguments({ payload: { toolId: "googleSheets", args: nativeArgs } }),
			{ op: "tools.invoke", payload: { toolId: "googleSheets", args: nativeArgs } },
		);
	});

	it("never overwrites an op the caller already chose", () => {
		const raw = { op: "tools.list", payload: { toolId: "googleSheets", args: nativeArgs } };
		// Wrong, perhaps — but it is a real decision, and hiding it would turn a
		// visible mistake into a silent one.
		assert.deepEqual(prepareGatewayArguments(raw), raw);
	});

	it("leaves a nested value that is not a gateway op alone", () => {
		const raw = { payload: { op: "call", nativeTool: "create_spreadsheet" } };
		assert.deepEqual(prepareGatewayArguments(raw), raw);
	});

	it("does not guess when only a toolId is present", () => {
		// tools.list and tools.invoke both accept a bare toolId, so this one is
		// genuinely ambiguous and must fail validation rather than be decided.
		const raw = { payload: { toolId: "googleSheets" } };
		assert.deepEqual(prepareGatewayArguments(raw), raw);
	});

	it("passes through anything that is not an object", () => {
		assert.equal(prepareGatewayArguments(undefined), undefined);
		assert.equal(prepareGatewayArguments("tools.invoke"), "tools.invoke");
		assert.deepEqual(prepareGatewayArguments([1, 2]), [1, 2]);
	});

	it("leaves a well-formed call exactly as it was", () => {
		const raw = { op: "connections.list", payload: { provider: "lark" } };
		assert.deepEqual(prepareGatewayArguments(raw), raw);
	});
});
