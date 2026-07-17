import type { Skill } from './skill.types';
import {
  GOOGLE_WORKSPACE_MCP_AUTH_CONTRACT,
  GOOGLE_WORKSPACE_MCP_SOURCE,
  GOOGLE_WORKSPACE_PRODUCTS,
} from '../google/google-workspace-mcp-manifest';

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
- Google Workspace executes only through Divo gateway tools backed by the private server-side Workspace MCP. Never use a local Google CLI, direct Google API request, Bash, curl, browser automation, or local OAuth token.
- For a multi-product vendor workflow, call google.plan with only the ordered phaseIds required by the user's request: gmail_source, google_contact, calendar_availability, google_doc, google_sheet, and/or calendar_event. It returns allowed specialist phases in order, only the first full recipe inline, and exact later skill IDs to load just before their phase. Never call google.plan for a Gmail-only request and never add an unrelated product.
- Invoke the selected product tool without connectionId unless the user already chose an exact account. The backend auto-selects only when exactly one eligible connected/shared account can perform the action; never pick a model default.
- If the tool returns google_workspace_connection_selection_required, ask one short account-choice question using only those returned options, then retry once with that exact connectionId. Never rotate through accounts after an error.
- A text reply is an exact choice only when it uniquely identifies one returned option by number or account email. If names or labels still match multiple options, ask again; never infer work versus personal.
- If no eligible connection is available, tell the member to connect or share a Google Workspace account with the required access/scopes.
- Never use an email address or label as connectionId. Use connections.list only when the user explicitly asks to inspect/manage available accounts.
- Before an unfamiliar native operation, call op="describe" and follow the returned schema exactly. The gateway owns RBAC, approvals, sharing, token refresh, and audit.
- Never invent recipients or resource IDs, never claim an action completed before a successful result, and never expose tokens or MCP endpoint details.`,
};

/**
 * Server-runner guidance is intentionally separate from the compact staged
 * parent above. The server Google runner has direct product tools, not the
 * desktop/Pi `google.plan` gateway operation.
 */
export const googleRunnerInstructions = `GOOGLE WORKSPACE EXECUTION METHOD:
- Google Workspace executes only through Divo's governed product tools backed by the private server-side Workspace MCP. Never use a local Google CLI, direct Google API request, Bash, curl, browser automation, or local OAuth token.
- Invoke the selected product tool without connectionId unless the user already chose an exact account. The backend auto-selects only when exactly one eligible connected/shared account can perform the action.
- If the tool returns google_workspace_connection_selection_required, ask one short account-choice question using only those returned options, then retry once with that exact connectionId. Never rotate through accounts after an error.
- If no eligible connection is available, tell the member to connect or share a Google Workspace account with the required access/scopes.
- Never use an email address or label as connectionId. Use connections.list only when the user explicitly asks to inspect/manage available accounts.
- Invoke the product tool with args={"op":"describe"|"call","nativeTool":"...","input":{},"connectionId":"<only after explicit choice>"}.
- ${GOOGLE_WORKSPACE_MCP_AUTH_CONTRACT.agentGuidance}
- Before an unfamiliar operation, call op="describe" for its nativeTool and follow the returned input schema exactly. Once the schema is known in the current run, call op="call" directly.
- The gateway owns RBAC, approvals, sharing, token refresh, and audit. A pending or denied action is not completed.

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
- Sheets: get_spreadsheet_info -> read_sheet_values -> modify_sheet_values -> read_sheet_values to verify. Use create_spreadsheet for a new workbook.
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
