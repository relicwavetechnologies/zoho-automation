import {
  GOOGLE_WORKSPACE_MCP_AUTH_CONTRACT,
  GOOGLE_WORKSPACE_MCP_SOURCE,
  GOOGLE_WORKSPACE_PRODUCTS,
} from '../google/google-workspace-mcp-manifest';

const operationIndex = GOOGLE_WORKSPACE_PRODUCTS
  .map((product) => `- ${product.name} -> ${product.toolId}: ${product.tools.join(', ')}`)
  .join('\n');
/**
 * Server-runner guidance is not a selectable skill. Agent-visible routing and
 * specialist recipes come from the governed DB catalogue.
 */
export const googleRunnerInstructions = `GOOGLE WORKSPACE EXECUTION METHOD:
- Google Workspace executes only through Divo's governed product tools backed by the private server-side Workspace MCP. Never use a local Google CLI, direct Google API request, Bash/curl request, browser automation, or local OAuth token.
- Reuse an exact connected/shared Google account already present in the server-runner context. Call connections.list once only when that context has no suitable account, then include its UUID as connectionId when invoking the selected product tool. This lets Divo enforce RBAC, connection policy, and rate limits; never pick a model default.
- A text reply is an exact choice only when it uniquely identifies one returned option by number or account email. Never rotate through accounts after an error.
- If no eligible connection is available, tell the member to connect or share a Google Workspace account with the required access/scopes.
- Never use an email address or label as connectionId. Reuse the same connectionId for describe and call.
- Invoke the product tool with args={"op":"describe"|"call","nativeTool":"...","input":{},"connectionId":"<required for call>"}.
- ${GOOGLE_WORKSPACE_MCP_AUTH_CONTRACT.agentGuidance}
- Reuse an exact operation schema already present in the current server-runner context. Before an unfamiliar operation whose schema is absent, call op="describe" once for its nativeTool with the selected connectionId and follow the returned input schema exactly. Once the schema is known in the current run, call op="call" directly.
- The gateway owns RBAC, approvals, sharing, token refresh, and audit. A pending or denied action is not completed.
- A result advisory with level="required" is part of the operation contract. Satisfy it before reporting success; otherwise report partial completion and the exact missing evidence.

PINNED MCP CONTRACT:
- Source: ${GOOGLE_WORKSPACE_MCP_SOURCE.repository}
- Version: ${GOOGLE_WORKSPACE_MCP_SOURCE.version}
- Divo exposes only the reviewed operations below. The MCP server's own OAuth tool is intentionally unavailable.

PRODUCT ROUTING AND APPROVED OPERATIONS:
${operationIndex}

COMMON WORKFLOWS:
- Gmail: search_gmail_messages -> get_gmail_message_content -> send_gmail_message for a grounded reply. Use draft_gmail_message when review was requested.
- Drive: search_drive_files or list_drive_items -> get_drive_file_content. Use get_drive_file_download_url only when an actual download is needed. Pasted spreadsheet/Drive URL that may be an Office workbook or Divo export -> get_drive_file_content for read-only inspection before Sheets resolve/convert.
- Calendar: get_events for schedules; manage_event for create/update/delete; query_freebusy before scheduling when availability matters.
- Docs: create_doc -> modify_doc_text/insert_doc_elements -> get_doc_as_markdown to verify. Return the canonical document URL from tool output.
- Sheets: get_spreadsheet_info -> read_sheet_values -> modify_sheet_values -> read_sheet_values to verify. Use the read result's structured values/counts rather than parsing prose, and use create_spreadsheet for a new workbook.
- Slides: create_presentation -> batch_update_presentation -> get_presentation/get_page to verify. Preserve the returned presentation ID and URL.
- Forms: create_form -> batch_update_form -> get_form. Read responses only when requested and allowed.
- Tasks and Contacts: list/search first when identity or target IDs are ambiguous, then use the relevant manage operation.
- Chat: list_spaces before reading or sending when the destination is not already resolved.
- Apps Script: inspect the project before updates. run_script_function is execution and may require approval.

EMAIL SAFETY:
- Never invent recipient addresses. Send only to real addresses given by the member or grounded by contact lookup.
- Use a clear subject and structured body. Use base64 attachment content or HTTPS sources; sidecar-local paths and file:// URLs are forbidden.
- Never claim sent/drafted until the tool succeeds. Preserve approval status exactly.

GENERAL SAFETY:
- Never guess message IDs, file IDs, event IDs, spreadsheet IDs, presentation IDs, form IDs, task IDs, contact IDs, space IDs, or script IDs.
- For mutation, use the smallest exact operation and verify important document/sheet/slide changes with a read.
- Retry only once when the returned error identifies a correctable argument. Otherwise report the exact useful reason.
- Never expose access tokens, refresh tokens, MCP endpoint details, or raw internal authorization data.`;
