import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeLocalInvokeResponse } from "./local-broker-response.mjs";

describe("local broker invoke response", () => {
	it("unwraps a governed Google result into one stable programming envelope", () => {
		const response = normalizeLocalInvokeResponse({
			version: 1,
			ok: true,
			status: "success",
			httpStatus: 200,
			data: {
				toolId: "googleGmail",
				action: "read",
				result: {
					success: true,
					nativeTool: "search_gmail_messages",
					data: {
						messages: [{ messageId: "message-1" }],
						pagination: { hasNextPage: false },
					},
					message: "Gmail operation completed",
				},
			},
			trace: { actionId: "action-1" },
		});

		assert.deepEqual(response.data, {
			messages: [{ messageId: "message-1" }],
			pagination: { hasNextPage: false },
		});
		assert.deepEqual(response.meta, {
			toolId: "googleGmail",
			action: "read",
			nativeTool: "search_gmail_messages",
			message: "Gmail operation completed",
		});
		assert.deepEqual(response.trace, { actionId: "action-1" });
	});

	it("unwraps non-vendor results without changing failures", () => {
		assert.deepEqual(normalizeLocalInvokeResponse({
			ok: true,
			status: "success",
			data: { toolId: "webSearch", action: "read", result: { results: [] } },
		}), {
			ok: true,
			status: "success",
			data: { results: [] },
			meta: { toolId: "webSearch", action: "read" },
		});

		const denied = {
			ok: false,
			status: "permission_denied",
			error: { code: "permission_denied", message: "Denied" },
		};
		assert.equal(normalizeLocalInvokeResponse(denied), denied);
	});

	it("does not present an unsuccessful vendor result as process success", () => {
		const response = normalizeLocalInvokeResponse({
			ok: true,
			status: "success",
			data: {
				toolId: "googleSheets",
				action: "read",
				result: {
					success: false,
					nativeTool: "read_sheet_values",
					data: { code: "google_workspace_connection_selection_required" },
					message: "Choose a Google Workspace connection before continuing.",
				},
			},
		});

		assert.equal(response.ok, false);
		assert.equal(response.status, "tool_error");
		assert.equal(response.error.message, "Choose a Google Workspace connection before continuing.");
		assert.deepEqual(response.data, {
			code: "google_workspace_connection_selection_required",
		});
	});
});
