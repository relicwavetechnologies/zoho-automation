import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NativeContract, NativeContractCache } from "./catalogue.ts";
import { MAX_BOUND_CONTRACTS, tierNativeContracts } from "./contract-tiering.ts";

function contract(
	toolId: string,
	nativeTool: string,
	description: string,
	padding = 0,
): NativeContract {
	return {
		toolId,
		nativeTool,
		description,
		inputSchema: {
			type: "object",
			properties: { value: { type: "string", description: "x".repeat(padding) } },
		},
	} as NativeContract;
}

function cacheOf(...contracts: NativeContract[]): NativeContractCache {
	return new Map(contracts.map(item => [`${item.toolId} ${item.nativeTool}`, item]));
}

const CACHE = cacheOf(
	contract("googleSheets", "create_spreadsheet", "Create a spreadsheet."),
	contract("googleSheets", "append_rows", "Append rows to a sheet."),
	contract("googleGmail", "send_message", "Send an email message."),
	contract("googleDocs", "create_document", "Create a document."),
);

describe("tierNativeContracts", () => {
	it("ignores operations of a tool the turn never made visible", () => {
		const tiered = tierNativeContracts({
			cache: CACHE,
			visibleToolIds: ["googleSheets"],
			query: "create a document and a spreadsheet",
		});
		assert.deepEqual(tiered.bound.map(item => item.nativeTool), ["create_spreadsheet"]);
		assert.equal(tiered.deferred.some(item => item.toolId === "googleDocs"), false);
	});

	it("leaves an operation the prompt gives no hint of on describe-then-call", () => {
		const tiered = tierNativeContracts({
			cache: CACHE,
			visibleToolIds: ["googleSheets", "googleGmail"],
			query: "send an email to the vendor",
		});
		assert.deepEqual(tiered.bound.map(item => item.nativeTool), ["send_message"]);
		assert.deepEqual(
			tiered.deferred.map(item => item.nativeTool).sort(),
			["append_rows", "create_spreadsheet"],
		);
	});

	// A greeting must cost no exact provider schema at all.
	it("binds nothing when the prompt names no operation", () => {
		const tiered = tierNativeContracts({
			cache: CACHE,
			visibleToolIds: ["googleSheets", "googleGmail"],
			query: "hi",
		});
		assert.deepEqual(tiered.bound, []);
		assert.equal(tiered.boundBytes, 0);
	});

	// Measured 2026-08-19: "what can you do with google sheets?" bound 28 of 29
	// operations, because every operation in a family repeats the family's own
	// vocabulary. Shared words must not be what earns a schema its bytes.
	it("does not bind a whole family just because they share a word", () => {
		const family = Array.from({ length: 12 }, (_, index) =>
			contract("googleSheets", `sheet_operation_${index}`, "Work with a Google sheet."));
		const tiered = tierNativeContracts({
			cache: cacheOf(
				...family,
				contract("googleSheets", "append_rows", "Append rows to a Google sheet."),
			),
			visibleToolIds: ["googleSheets"],
			query: "append rows for me",
		});
		assert.deepEqual(tiered.bound.map(item => item.nativeTool), ["append_rows"]);
		assert.equal(tiered.deferred.length, family.length);
	});

	it("never binds more than the turn's operation cap", () => {
		const cache = cacheOf(...Array.from({ length: 20 }, (_, index) =>
			contract("googleSheets", `distinct_operation_${index}`, `Unique verb ${index}.`)));
		const tiered = tierNativeContracts({
			cache,
			visibleToolIds: ["googleSheets"],
			query: Array.from({ length: 20 }, (_, index) => `distinct_operation_${index}`).join(" "),
		});
		assert.equal(tiered.bound.length, MAX_BOUND_CONTRACTS);
		assert.equal(tiered.deferred.length, 20 - MAX_BOUND_CONTRACTS);
	});

	it("defers a relevant operation that would break the turn's byte budget", () => {
		const cache = cacheOf(
			contract("googleSheets", "append_rows", "Append rows to a sheet.", 4_000),
			contract("googleSheets", "create_spreadsheet", "Create a spreadsheet."),
		);
		const tiered = tierNativeContracts({
			cache,
			visibleToolIds: ["googleSheets"],
			query: "append rows to a spreadsheet",
			maxContractBytes: 256,
		});
		assert.deepEqual(tiered.bound.map(item => item.nativeTool), ["create_spreadsheet"]);
		assert.deepEqual(tiered.deferred.map(item => item.nativeTool), ["append_rows"]);
		assert.ok(tiered.boundBytes <= 256);
		assert.ok(tiered.deferredBytes > 4_000);
	});
});
