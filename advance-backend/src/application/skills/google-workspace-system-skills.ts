import type { Prisma, PrismaClient } from '../../generated/prisma';
import {
  GOOGLE_WORKSPACE_PRODUCTS,
  type GoogleWorkspaceProductDefinition,
} from '../google/google-workspace-mcp-manifest';
import {
  GOVERNED_DIRECT_ACTION_CRITERION,
  GOVERNED_LOCAL_AVAILABLE_RUNTIME,
  GOVERNED_LOCAL_WORKFLOW_CRITERION,
} from './governed-local-routing';
import type { DivoProductivitySystemSkillDefinition } from './divo-productivity-system-skills';
import {
  buildSystemSkill,
  ensureSystemSkillFolder,
  provisionSystemSkill,
  type SystemSkillStore,
} from './system-skill-provisioner';

export type GoogleWorkspaceSystemSkillDefinition = DivoProductivitySystemSkillDefinition;

const GOOGLE_SKILL_ALIASES: Record<GoogleWorkspaceProductDefinition['service'], readonly string[]> = {
  gmail: ['google email', 'inbox', 'mail'],
  drive: ['google files', 'cloud files', 'shared drive', 'read export url', 'check row in spreadsheet link'],
  calendar: ['google events', 'schedule', 'availability'],
  docs: ['google document', 'word processor'],
  sheets: ['google sheet', 'google sheet url', 'docs.google.com/spreadsheets', 'drive.google.com/file', 'excel workbook url', 'convert excel to google sheet', 'spreadsheet', 'workbook', 'cells', 'dropdown', 'data validation', 'freeze header'],
  slides: ['google presentation', 'slide deck'],
  forms: ['google form', 'survey'],
  tasks: ['google to-do', 'task list'],
  contacts: ['google people', 'address book'],
  chat: ['google spaces', 'google messages'],
  appscript: ['google script', 'workspace automation'],
};

export const GOOGLE_WORKSPACE_SYSTEM_SKILLS: readonly GoogleWorkspaceSystemSkillDefinition[] =
  GOOGLE_WORKSPACE_PRODUCTS.map((product, index) => ({
    slug: `google-${product.service}`,
    name: product.name,
    summary: product.description,
    markdown: buildProductSkillMarkdown(product),
    toolIds: [product.toolId],
    tags: ['google', 'workspace', product.service],
    aliases: GOOGLE_SKILL_ALIASES[product.service],
    sortOrder: (index + 1) * 10,
  }));

const GOOGLE_FOLDER = {
  key: 'folder:google-workspace',
  name: 'Google Workspace',
  slug: 'google-workspace',
  sortOrder: 30,
} as const;

const COMPANY_PLACEMENT = (companyId: string, folderId: string) => ({
  folderId,
  departmentId: null,
  scope: 'company' as const,
  granteeType: 'company' as const,
  granteeId: companyId,
});

export async function provisionGoogleWorkspaceSystemSkills(
  db: SystemSkillStore,
  companyId: string,
): Promise<{ folderId: string; created: number; updated: number; existing: number; skipped: number }> {
  const folderId = await ensureSystemSkillFolder(db, companyId, GOOGLE_FOLDER);
  const totals = { folderId, created: 0, updated: 0, existing: 0, skipped: 0 };
  for (const definition of GOOGLE_WORKSPACE_SYSTEM_SKILLS) {
    const result = await provisionSystemSkill(
      db,
      companyId,
      definition,
      COMPANY_PLACEMENT(companyId, folderId),
    );
    totals[result.outcome] += 1;
  }
  return totals;
}

export async function provisionGoogleWorkspaceSkillsForExistingCompanies(
  db: Pick<PrismaClient, 'company'> & SystemSkillStore,
): Promise<{ companies: number; created: number; updated: number; existing: number; skipped: number }> {
  const companies = await db.company.findMany({ select: { id: true } });
  const totals = { companies: companies.length, created: 0, updated: 0, existing: 0, skipped: 0 };
  for (const company of companies) {
    const result = await provisionGoogleWorkspaceSystemSkills(db, company.id);
    totals.created += result.created;
    totals.updated += result.updated;
    totals.existing += result.existing;
    totals.skipped += result.skipped;
  }
  return totals;
}

export function buildGoogleWorkspaceSystemSkill(
  companyId: string,
  folderId: string,
  definition: GoogleWorkspaceSystemSkillDefinition,
): Prisma.SkillUncheckedCreateInput & { id: string } {
  return buildSystemSkill(companyId, definition, COMPANY_PLACEMENT(companyId, folderId));
}

function buildProductSkillMarkdown(product: GoogleWorkspaceProductDefinition): string {
  const productWorkflow = buildProductWorkflow(product.service);

  return `# ${product.name}

Use this skill for ${product.description.toLowerCase()}

## Governed execution

1. Do not call \`divo_connections\` before ordinary Google work. Omit \`connectionId\` unless the member selected an account or the previous Google result returned eligible choices; Divo selects the sole account eligible for the exact action and scopes. If no account is eligible, invoke the registered Divo ${product.name} capability exactly once with \`{"op":"describe","nativeTool":"${product.tools[0]}"}\` and no \`connectionId\`. Only a returned \`google_workspace_authorization_pending\` proves the backend sent the Connect Google card. Then end the current run; OAuth completion starts a fresh run automatically. Never claim a card was sent without that result or send the user to a settings page.
2. Never choose a model default or rotate through accounts after an error. A text reply is an exact choice only when it uniquely identifies one returned option by number or account email. Never use an email address or label itself as \`connectionId\`.
3. Use only Divo's governed \`${product.toolId}\` route. For ${GOVERNED_DIRECT_ACTION_CRITERION}, call the runtime's governed wrapper directly. ${GOVERNED_LOCAL_AVAILABLE_RUNTIME}, use one persistent Python file and invoke this same tool through credential-free \`divo-local\` only when the work has ${GOVERNED_LOCAL_WORKFLOW_CRITERION}. Never call Google directly from Bash: no Google CLI, curl, browser automation, direct Google API call, local OAuth token, or credential-bearing SDK. \`divo-local\` is a governed Divo wrapper, not a Google client.
4. ${GOVERNED_LOCAL_AVAILABLE_RUNTIME}, and the local-workflow criterion above applies, put only the native operation \`input\` object in an adjacent JSON file and call \`divo-local call ${product.toolId}.<nativeTool> --input-file <path>\` from the one persistent Python file. The command names the tool and operation, and the client constructs the governed selector internally. Use \`divo-local describe ${product.toolId}.<nativeTool>\` only when a genuinely required native operation schema was not already loaded. Include \`--connection-id\` only after an explicit account choice. Use legacy \`divo-local invoke\` only for special Google operations with no native call surface, such as resolved-Sheet follow-up handles. Never describe through the registered tool and then repeat the describe inside the script.
${productWorkflow}

## Reliability and safety

- Preserve Divo RBAC, sharing, approval, and audit results. Pending or denied is not completed.
- Never guess Google resource IDs. Discover or read the target before an ambiguous mutation.
- Verify important content changes with a read operation and return canonical Google URLs from successful responses.
- Treat every result advisory with \`level: "required"\` as part of the tool contract. Satisfy it before reporting completion; if it cannot be satisfied, report partial completion and the exact missing evidence.
- Never expose tokens or the private MCP endpoint. A local path is forbidden only inside native Google \`input\`; it cannot be used as provider content. ${GOVERNED_LOCAL_AVAILABLE_RUNTIME}, a local JSON file passed to credential-free \`divo-local call ... --input-file\` is allowed as Divo transport. Use base64 content or HTTPS sources when the native Google operation requires content.`;
}

function buildProductWorkflow(service: GoogleWorkspaceProductDefinition['service']): string {
  switch (service) {
    case 'gmail':
      return `

## Gmail workflow

### Find and understand mail

1. Start with the narrowest \`search_gmail_messages\` query that identifies the sender, subject, and time window. Deduplicate candidates, select the single newest matching message/thread, then fetch only that bounded target. Widen the search only when the narrow query returns no candidates. Put Gmail search syntax in the schema's query field; useful patterns include \`is:unread\`, \`from:person@example.com\`, \`to:person@example.com\`, \`subject:(quarterly report)\`, \`has:attachment\`, \`filename:pdf\`, \`newer_than:7d\`, \`-label:spam\`, and \`{from:a@example.com from:b@example.com}\`.
2. Use \`get_gmail_messages_content_batch\` only for several independently selected messages, \`get_gmail_message_content\` for the selected newest message, or \`get_gmail_thread_content\` when that selected message needs reply history. Search snippets are not enough for summarizing, extracting commitments, or composing a grounded reply.
3. Fetch attachment content only when the task requires the attachment itself. Do not infer attachment contents from its filename.

### Hard bounded latest-thread contract

When the user asks for the single latest or one deduplicated thread, this contract is mandatory:

1. Call \`describe\` before the first search unless its current schema was returned in this request. The native field is \`page_size\`, never \`maxResults\`.
2. Make at most three metadata/search calls total. Use \`get_gmail_messages_content_batch\` with \`format: "metadata"\` when metadata beyond search results is required.
3. Deduplicate by thread ID and select exactly one candidate. After selecting it, do not widen the query and do not inspect competing full threads.
4. Make at most one full-content call, using \`get_gmail_thread_content\` for the selected thread. Never call a thread-content batch operation for this task.
5. If no candidate meets the stated criteria, return a truthful no-match result from the bounded metadata evidence. Do not keep searching merely to produce an answer.
6. Report \`_divoResult\` truncation and continuation fields exactly. Never turn desktop trace-preview truncation into Gmail content truncation and never invent a continuation handle.
7. For paginated searches, consume the complete machine-readable \`messages\` array. \`modelVisibleMessages\` counts only prose shown in the trace; it is not the provider page size. Continue only when \`continuation.available\` is true, using its exact \`inputField\` and \`token\`.

### Draft, send, and organize

- Use \`draft_gmail_message\` when the user asks to draft, review, or prepare an email. Use \`send_gmail_message\` only when the user asks to send.
- Never invent a recipient. Resolve an address from the user's text or governed contact data; ask if multiple people match.
- Preserve threading identifiers when replying. Do not turn a requested reply into an unrelated new conversation.
- Use \`modify_gmail_message_labels\` for one message and \`batch_modify_gmail_message_labels\` for an established set. Resolve label names with \`list_gmail_labels\`; use \`manage_gmail_label\` only to create, update, or delete labels.
- Use filter operations only when the user explicitly asks for an ongoing Gmail rule. A one-time cleanup is a label operation, not a filter.

### Newsletter cleanup

1. Before scanning a large candidate set, decide every intended mutation and call \`divo_preflight\` once with one complete proposed \`googleGmail\` invocation per mutation.
2. Map actions exactly: \`manage_gmail_label\` with a create action requires \`googleGmail:create\`; \`modify_gmail_message_labels\` and \`batch_modify_gmail_message_labels\` (apply or remove labels) require \`googleGmail:update\`; \`manage_gmail_label\` with a delete action requires \`googleGmail:delete\`.
3. If required preflight entries are denied, say so before scanning the candidate set and offer only a read-only report when useful. Do not scan/classify a large batch in preparation for a mutation that cannot run.
4. Keep counts distinct: report the number of search candidates separately from the number classified as newsletters. Do not describe every candidate as a newsletter.

### Completion contract

A search/read task is complete only after the requested message or thread content has been read. A draft/send task is complete only when the successful tool result identifies the created message or draft; report its message/thread identifiers when returned. After an ambiguous mutation failure, inspect existing messages or drafts before retrying so an email is never duplicated.`;

    case 'drive':
      return `

## Google Drive workflow

1. Use \`search_drive_files\` for a natural-language or metadata search and \`list_drive_items\` to browse a known folder. Do not guess a file or folder ID from its name.
2. When multiple items match, compare returned name, type, owner, location, and modified time. Ask one short clarification if the intended target is still ambiguous.
3. Use \`get_drive_file_content\` when the task needs readable content. Use \`get_drive_file_download_url\` only when the user needs the original/exported file itself.
4. Use \`create_drive_folder\` or \`create_drive_file\` for native creation. Use the matching \`import_to_google_doc\`, \`import_to_google_sheets\`, or \`import_to_google_slides\` operation when converting supplied content into a Google-native file.
5. Use \`copy_drive_file\` before modifying a copy. Use \`update_drive_file\` for metadata or placement changes supported by its described schema.
6. Inspect permissions with \`get_drive_file_permissions\` or \`check_drive_file_public_access\` before changing access. Use \`manage_drive_access\` / \`set_drive_file_permissions\` only for the exact recipient and role requested; never make a file public merely to obtain a link.

## Pasted Google workbook URL (read-only)

\`https://docs.google.com/spreadsheets/d/<id>\` and
\`https://drive.google.com/file/d/<id>\` may point to a native Google Sheet
**or** an Office file stored in Drive.

When the member wants to **read, inspect, look up a row or column, or verify a
value** in a pasted link:

1. Extract the Drive file ID from the URL path segment after \`/d/\`.
2. Call \`get_drive_file_content\` with that \`file_id\` **before** any Sheets
   API call or Excel-to-Sheet conversion.
3. Answer only from the returned file content. Cite the row/column from that
   result.

Never answer from an earlier Menhood, Semrush, or other provider table when the
member references a file link. If \`get_drive_file_content\`
succeeds, that result is the only evidence for the answer.

### Completion contract

Creation, import, copy, or sharing is complete only when the successful response identifies the exact file and requested permission outcome. Preserve the returned file ID and canonical Drive URL/shareable link. If a creation response lacks an ID, do not blindly create a second copy—search the intended folder first, then report a real blocker if the resource cannot be identified.`;

    case 'calendar':
      return `

## Google Calendar workflow

1. Resolve relative dates against the current date and the user's timezone. Keep start/end times, all-day intent, recurrence, attendees, and timezone explicit; never silently assume a timezone for a cross-region meeting.
2. Use \`list_calendars\` when the target calendar is unknown. Use \`get_events\` for a bounded time window and identify the exact event before update or deletion.
3. Use \`query_freebusy\` before scheduling when attendee availability matters. Free/busy data shows availability, not permission to expose private event details.
4. Use \`manage_event\` for event create, update, or delete exactly as its described action schema requires. Before claiming an event is ready to create, call \`describe\`, construct the complete proposed event including action, calendar, times, timezone and grounded attendees, and pass that exact invocation to \`divo_preflight\`. Use \`manage_out_of_office\` and \`manage_focus_time\` only for those specialized event types.
5. Use \`create_calendar\` only when the user asks for a separate calendar, not for an ordinary event.

### Completion contract

After a calendar mutation, return the event/calendar name, resolved date and timezone, attendees when relevant, and canonical Calendar URL or resource ID returned by Google. For an important update, read the event window again. If an ambiguous failure follows a create request, search that window before retrying to avoid duplicate meetings.`;

    case 'docs':
      return `

## Google Docs workflow

1. For an existing document, use \`search_docs\` or \`list_docs_in_folder\` to resolve it, then \`get_doc_content\` or \`get_doc_as_markdown\` to understand its current content. Never guess a document ID.
2. For a new document, call \`create_doc\` once and immediately retain the returned document ID and canonical URL. When the workflow requires preflight, validate the exact title and complete initial content first; never preflight placeholder content. Do not start follow-up edits until the created resource is identifiable.
3. Choose the smallest semantic edit: \`modify_doc_text\` for text changes, \`find_and_replace_doc\` for grounded replacements, \`insert_doc_elements\` for structural elements, \`create_table_with_data\` for tables, and \`insert_doc_image\` for images. Use \`batch_update_doc\` for a cohesive multi-edit request rather than many avoidable one-block calls.
4. Inspect structure with \`inspect_doc_structure\` before index-sensitive edits. Use \`update_paragraph_style\`, \`update_doc_headers_footers\`, or \`manage_doc_tab\` only after describing and following their exact schemas.
5. Verify the final document with \`get_doc_as_markdown\` or \`get_doc_content\`. Use comment operations for review discussion, not as a substitute for requested document edits.

### Completion contract

A create/edit task is complete only when the final content is verified and the response includes the canonical Google Docs URL. If \`create_doc\` returns no usable document ID or URL, do not claim success and do not create another document blindly; report the exact gateway/API result as a blocker. Export is complete only when \`export_doc_to_pdf\` returns the requested artifact or usable download result.`;

    case 'sheets':
      return `

## Google Sheets workflow

\`get_spreadsheet_info\` returns machine-readable \`spreadsheetId\`,
\`spreadsheetTitle\`, \`locale\`, \`sheets\`, \`sheetCount\`, and \`complete\`
directly under the governed \`data\` object. Each \`sheets\` entry contains
\`title\`, \`sheetId\`, \`rowCount\`, \`columnCount\`, and
\`conditionalFormatCount\`. Never parse or inspect its compatibility prose in
\`data.result\`.

## Pasted Google Sheet or Excel workbook URL

This covers an exact pasted \`https://docs.google.com/spreadsheets/d/...\` Sheet
URL or \`https://drive.google.com/file/d/...\` Excel workbook URL. Branch on
intent before choosing a tool:

- **Read-only** — inspect, look up a row or value, verify something, summarize
  → load \`google-drive\` and follow its pasted-URL recipe with
  \`get_drive_file_content\`. Do not run \`resolve_reference\` for read-only work.
- **Edit as a native Sheet, or convert an Excel workbook** → \`resolve_reference\`
  on the exact pasted URL. Before generic web search or any native Sheets
  operation, route the URL through that governed resolver: never derive an ID
  from the URL yourself, fetch it as a public web page, request a download URL,
  or call \`import_to_google_sheets\` directly.

A URL on its own resolves metadata and access only. Confirm Divo can open the
Sheet, then ask what the member wants done next.

Never spend a resolver call rediscovering an account the run bootstrap already
selected. If Divo returns several eligible accounts, ask once, then retry the
same URL with the exact chosen connection.

In Lark, stop after a successful resolver call on an Excel workbook: the backend
delivers the confirmation card and owns the conversion after the member clicks
it. On Desktop, keep the governed \`data.resource.resourceId\` and
\`data.resource.connectionId\` handles Divo already returned. Never reconstruct
Google IDs or move Sheet rows through model context.

## Writing to a Sheet

Keep bulk source rows in local files and write in bounded calls.

When the connected source is authoritative and the member asks to correct or
replace an existing tab, inspect the header plus the final populated row once —
not several arbitrary ranges. Validate every replacement row locally and persist
it before the first mutation, so a formatting or verification retry reuses that
saved file instead of refetching provider pages. Clear any stale tail beyond the
new final row, write in the fewest bounded calls, apply each requested style or
dimension once, then read back the header and final written row.

For a new structured spreadsheet, work in this order: \`create_spreadsheet\`,
\`modify_sheet_values\` for headers and rows, \`format_sheet_range\`,
\`resize_sheet_dimensions\` for column sizing and \`frozen_row_count\` /
\`frozen_column_count\`, \`manage_sheet_data_validation\` for dropdowns, then
\`read_sheet_values\` on the important range. Treat a successful create as final
even if later parsing or code fails; never create a second spreadsheet to
rediscover the first response.

Read \`read_sheet_values\` from its machine-readable \`values\`, \`rowCount\`,
\`returnedRowCount\`, \`isEmpty\`, and \`complete\` fields rather than parsing
prose.

For bulk writes, make the value grid rectangular and derive an explicit A1 range
from the widest row, not the first row. Inspect \`rowCount\` and \`columnCount\`
once and resize before writing when the header plus data will not fit. Pair a
custom number-format pattern with its required number-format type. Read-back may
return displayed numbers with grouping separators; verify numeric equality
rather than raw string equality. The backend adapts ordinary scalar cells to the
pinned provider's string wire format; objects and arrays still require deliberate
serialization.

Never nest formatting under \`cell_format\`, never invent index-based resize
fields, and give data validation a sheet-qualified range with either
\`one_of_list\` values or a \`one_of_range\` source. If no loaded native operation
can implement a requested feature, report that feature partial instead of
claiming it was applied.

Dropdowns are the one shape the run bootstrap never binds, so it is written out
here: \`manage_sheet_data_validation\` takes
\`{"action":"set","ranges":["Sheet1!D2:D100"],"rule":{"type":"one_of_list","values":["Pending","Approved"]}}\`.
Every other operation's arguments come from the bound native contract or one
\`describe\`.

### Completion contract

A create or edit is complete only after the important requested range is read
back successfully in the same workflow, every required advisory is satisfied,
and the response carries the canonical spreadsheet URL. A task is partial if
requested formatting, freezing, validation, or URL return has not completed.

A successful write may return only an acknowledgement under \`data.result\`,
without \`updatedRows\`. Count the intended rows from your own \`input.values\`
and claim that count as written only once the exact read-back matches; never
turn a missing \`updatedRows\` field into a zero-row claim when verification
proves the rows exist. A read with \`complete: false\` exposed only part of the
range — read a narrower exact range before claiming verification. A failed,
rate-limited, incomplete, or missing read-back cannot be replaced by an earlier
write acknowledgement or an inferred count. Preserve the spreadsheet ID, sheet
ID/title, and exact A1 ranges across steps, and if a write fails ambiguously,
read the target range before retrying so rows or values are not duplicated.`;

    case 'contacts':
      return `

## Google Contacts workflow

1. Use \`search_contacts\` to resolve a person from name, email, phone, or organization. Use \`list_contacts\` only for browsing or a bounded collection; do not scan the whole address book when a targeted search is possible.
2. If multiple people match, compare returned names, email addresses, organizations, and resource names, then ask one short clarification before any downstream email, calendar, or contact mutation.
3. Use \`get_contact\` for the complete current record before update or deletion. Never invent an email address or treat an unverified display name as a unique identity.
4. Use \`manage_contact\` for one contact and \`manage_contacts_batch\` for an explicitly established set. Resolve groups with \`list_contact_groups\` / \`get_contact_group\` before \`manage_contact_group\`.
5. Preserve the contact resource name and version metadata required by the described schema. Do not retry an ambiguous create until search confirms that no duplicate contact was created.

### Completion contract

Return the exact resolved contact identity and the requested fields, while omitting unrelated private data. A create, update, delete, or group change is complete only when the tool confirms the target resource and action; re-read important updates when the API supports it.`;

    default:
      return '';
  }
}
