import type { Skill } from './skill.types';
import {
  GOOGLE_WORKSPACE_MCP_SOURCE,
  GOOGLE_WORKSPACE_PRODUCTS,
  GOOGLE_WORKSPACE_TOOL_IDS,
} from '../google/google-workspace-mcp-manifest';

const operationIndex = GOOGLE_WORKSPACE_PRODUCTS
  .map((product) => `- ${product.name} -> ${product.toolId}: ${product.tools.join(', ')}`)
  .join('\n');

export const googleSkill: Skill = {
  id: 'google',
  name: 'Google Workspace',
  description: 'Use governed Google Workspace connections for Gmail, Drive, Calendar, Docs, Sheets, Slides, Forms, Tasks, Contacts, Chat, and Apps Script.',
  toolIds: [...GOOGLE_WORKSPACE_TOOL_IDS],
  instructions: `GOOGLE WORKSPACE EXECUTION METHOD:
- Google Workspace executes only through Divo gateway tools backed by the private server-side Workspace MCP. Never use a local Google CLI, direct Google API request, Bash, curl, browser automation, or local OAuth token.
- Resolve accounts first with divo_gateway op="connections.list" and payload={"provider":"google_workspace"}.
- If no connection is available, tell the member to connect Google Workspace. If exactly one is available, use it. If several are plausible, ask one short account-choice question.
- Use only the returned backend connectionId. Never use an email address or label as connectionId.
- Invoke the product tool with args={"connectionId":"...","op":"describe"|"call","nativeTool":"...","input":{...}}.
- Divo injects user_google_email from the selected connection. Never place user_google_email in input.
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
- Never expose access tokens, refresh tokens, MCP endpoint details, or raw internal authorization data.`,
};
