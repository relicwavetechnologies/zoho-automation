import type { Skill } from './skill.types';
import {
  GOOGLE_WORKSPACE_MCP_AUTH_CONTRACT,
  GOOGLE_WORKSPACE_MCP_SOURCE,
  GOOGLE_WORKSPACE_PRODUCTS,
} from '../google/google-workspace-mcp-manifest';
import {
  GOVERNED_DIRECT_ACTION_CRITERION,
  GOVERNED_LOCAL_WORKFLOW_ROUTE,
} from './governed-local-routing';

const operationIndex = GOOGLE_WORKSPACE_PRODUCTS
  .map((product) => `- ${product.name} -> ${product.toolId}: ${product.tools.join(', ')}`)
  .join('\n');
export const googleSkill: Skill = {
  id: 'google',
  name: 'Google Workspace',
  description: 'Compact virtual parent for governed Google Workspace specialist workflows.',
  // This source-controlled parent is intentionally not a database skill and
  // does not require every Google product. Planning selects only executable,
  // RBAC-granted specialist recipes.
  toolIds: [],
  instructions: `GOOGLE WORKSPACE EXECUTION METHOD:
- Google Workspace executes only through Divo's governed route backed by the private server-side Workspace MCP. For ${GOVERNED_DIRECT_ACTION_CRITERION}, use the governed route directly. In Divo Desktop only, ${GOVERNED_LOCAL_WORKFLOW_ROUTE} Never call Google directly from a local command: no Google CLI, direct Google API request, curl, browser automation, local OAuth token, or credential-bearing SDK. divo-local is a Divo gateway wrapper, not a direct Google path.
- For an explicit multi-product vendor onboarding workflow, follow the onboarding recipe returned by Divo's bounded resolver. Its internal planner selects only the required phases. Do not invoke or search for a raw planning operation yourself. It is never a planner for exports, reports, aggregation, analysis, or a generic Gmail-to-Sheets task.
- Reuse the exact Google account already returned by the current run bootstrap. Call connections.list once only when the bootstrap explicitly says the required account is missing. Include the selected UUID as connectionId when invoking the product tool so Divo can enforce RBAC, connection policy, and rate limits; never pick a model default.
- A text reply is an exact choice only when it uniquely identifies one returned option by number or account email. If names or labels still match multiple options, ask again; never infer work versus personal.
- If no eligible connection is available, tell the member to connect or share a Google Workspace account with the required access/scopes.
- Never use an email address or label as connectionId. Reuse the same connectionId for both describe and call.
- Use exact native operation schemas already returned in bootstrap.nativeContracts. Call op="describe" once only for a genuinely required operation whose contract is absent, then follow that schema exactly. The gateway owns RBAC, approvals, sharing, token refresh, and audit.
- Treat every result advisory with level="required" as part of the operation contract; satisfy it before reporting success.
- Never invent recipients or resource IDs, never claim an action completed before a successful result, and never expose tokens or MCP endpoint details.`,
};

/**
 * Server-runner guidance is intentionally separate from the compact staged
 * parent above. The server Google runner has direct product tools, not the
 * desktop/Pi internal vendor-onboarding planning path.
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
- Drive: search_drive_files or list_drive_items -> get_drive_file_content. Use get_drive_file_download_url only when an actual download is needed.
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
