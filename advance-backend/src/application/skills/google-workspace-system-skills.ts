import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '../../generated/prisma';
import {
  GOOGLE_WORKSPACE_MCP_AUTH_CONTRACT,
  GOOGLE_WORKSPACE_MCP_SOURCE,
  GOOGLE_WORKSPACE_PRODUCTS,
  type GoogleWorkspaceProductDefinition,
} from '../google/google-workspace-mcp-manifest';
import { recordSkillRegistryMutation } from './skill-registry-versioning';
import {
  GOVERNED_DIRECT_ACTION_CRITERION,
  GOVERNED_LOCAL_AVAILABLE_RUNTIME,
  GOVERNED_LOCAL_WORKFLOW_CRITERION,
} from './governed-local-routing';

export interface GoogleWorkspaceSystemSkillDefinition {
  readonly slug: string;
  readonly name: string;
  readonly summary: string;
  readonly markdown: string;
  readonly toolIds: readonly string[];
  readonly tags: readonly string[];
  readonly aliases: readonly string[];
  readonly sortOrder: number;
}

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
  name: 'Google Workspace',
  slug: 'google-workspace',
  departmentId: null,
  parentId: null,
  status: 'active',
  sortOrder: 30,
} as const;

type GoogleSkillStore = Pick<
  Prisma.TransactionClient,
  'skillFolder' | 'skill' | 'skillVersion' | 'skillRegistryRevision' | 'skillAccessGrant' | 'skillAlias'
>;

type ExistingSkill = {
  id: string;
  slug: string;
  companyId: string;
  departmentId: string | null;
  folderId: string | null;
  scope: string;
  name: string;
  summary: string;
  markdown: string;
  toolIds: string[];
  tags: string[];
  status: string;
  isSystem: boolean;
  sortOrder: number;
  revision: number;
  createdBy: string | null;
  updatedBy: string | null;
  aliases?: { alias: string }[];
};

const EXISTING_SKILL_SELECT = {
  id: true,
  slug: true,
  companyId: true,
  departmentId: true,
  folderId: true,
  scope: true,
  name: true,
  summary: true,
  markdown: true,
  toolIds: true,
  tags: true,
  status: true,
  isSystem: true,
  sortOrder: true,
  revision: true,
  createdBy: true,
  updatedBy: true,
  aliases: { select: { alias: true }, orderBy: { alias: 'asc' as const } },
} as const;

export async function provisionGoogleWorkspaceSystemSkills(
  db: GoogleSkillStore,
  companyId: string,
): Promise<{ folderId: string; created: number; updated: number; existing: number; skipped: number }> {
  const folderId = await ensureFolder(db, companyId);
  let created = 0;
  let updated = 0;
  let existing = 0;
  let skipped = 0;

  for (const definition of GOOGLE_WORKSPACE_SYSTEM_SKILLS) {
    const current = await db.skill.findFirst({
      where: { companyId, slug: definition.slug, status: { not: 'archived' } },
      select: EXISTING_SKILL_SELECT,
    }) as ExistingSkill | null;

    if (current && !current.isSystem) {
      skipped += 1;
      continue;
    }

    let skill: ExistingSkill;
    if (!current) {
      skill = await db.skill.create({
        data: buildGoogleWorkspaceSystemSkill(companyId, folderId, definition),
      }) as ExistingSkill;
      await recordSkillRegistryMutation(db, skill, 'system');
      created += 1;
    } else if (matchesDefinition(current, folderId, definition)) {
      skill = current;
      existing += 1;
    } else {
      skill = await db.skill.update({
        where: { id: current.id },
        data: {
          ...definitionFields(folderId, definition),
          toolIds: [...definition.toolIds],
          tags: [...definition.tags],
          revision: { increment: 1 },
        },
      }) as ExistingSkill;
      await recordSkillRegistryMutation(db, skill, 'system');
      updated += 1;
    }

    await db.skillAccessGrant.upsert({
      where: {
        skillId_granteeType_granteeId: {
          skillId: skill.id,
          granteeType: 'company',
          granteeId: companyId,
        },
      },
      create: {
        companyId,
        skillId: skill.id,
        granteeType: 'company',
        granteeId: companyId,
      },
      update: {},
    });
    await syncAliases(db, skill.id, definition.aliases);
  }

  return { folderId, created, updated, existing, skipped };
}

export async function provisionGoogleWorkspaceSkillsForExistingCompanies(
  db: Pick<PrismaClient, 'company' | 'skillFolder' | 'skill' | 'skillVersion' | 'skillRegistryRevision' | 'skillAccessGrant' | 'skillAlias'>,
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
  return {
    id: deterministicId(companyId, `skill:${definition.slug}`),
    companyId,
    ...definitionFields(folderId, definition),
    toolIds: [...definition.toolIds],
    tags: [...definition.tags],
  };
}

function buildProductSkillMarkdown(product: GoogleWorkspaceProductDefinition): string {
  const productWorkflow = buildProductWorkflow(product.service);

  return `# ${product.name}

Use this skill for ${product.description.toLowerCase()}

## Governed execution

1. Reuse the exact connected/shared Google account already returned by the current unified run bootstrap. Call \`divo_connections\` only when that bootstrap explicitly says Google account discovery is missing. Before any \`op: "call"\`, include the chosen UUID as \`connectionId\`; this is required for RBAC, owner policy, and connection rate limits.
   If the bootstrap says no Google account is accessible, loading this skill has not sent a card. Invoke the registered Divo ${product.name} capability exactly once with \`{"op":"describe","nativeTool":"${product.tools[0]}"}\`; do not include \`connectionId\`. Only a returned \`google_workspace_authorization_pending\` proves the backend sent the Connect Google card. Then end the current run; OAuth completion starts a fresh run automatically. Never invent a Lark operation, claim a card was sent without that tool result, or send the user to a settings page.
2. Never choose a model default or rotate through accounts after an error. A text reply is an exact choice only when it uniquely identifies one returned option by number or account email.
3. Reuse the same exact \`connectionId\` for both \`op: "describe"\` and \`op: "call"\` when the bootstrap provides it. It may be omitted for \`describe\` only when there is no selected account and account resolution is unambiguous. Never use an email address or label itself as \`connectionId\`.
4. Use only Divo's governed \`${product.toolId}\` route. For ${GOVERNED_DIRECT_ACTION_CRITERION}, call the runtime's governed wrapper directly. ${GOVERNED_LOCAL_AVAILABLE_RUNTIME}, use one persistent Python file and invoke this same tool through credential-free \`divo-local\` only when the work has ${GOVERNED_LOCAL_WORKFLOW_CRITERION}. Never call Google directly from Bash: no Google CLI, curl, browser automation, direct Google API call, local OAuth token, or credential-bearing SDK. \`divo-local\` is a governed Divo wrapper, not a Google client.
5. If the current run bootstrap already contains the exact \`nativeTool\` input schema, use it and do not call \`describe\` again. Otherwise call \`op: "describe"\` once before that unfamiliar operation. ${GOVERNED_LOCAL_AVAILABLE_RUNTIME}, perform that describe inside the same persistent Python file through \`divo-local\`; never describe through the registered tool first and then repeat it in the script. \`input\` may be omitted for describe; follow the returned MCP input schema exactly.
6. Call \`op: "call"\` with the same \`nativeTool\` and its arguments under \`input\`.
7. ${GOOGLE_WORKSPACE_MCP_AUTH_CONTRACT.agentGuidance}

## Canonical governed call shape

For a direct ${GOVERNED_DIRECT_ACTION_CRITERION}, call the registered Divo ${product.name} capability with this argument object: \`{ "op": "describe|call", "nativeTool": "<approved operation>", "connectionId": "<UUID required for call>", "input": {} }\`. ${GOVERNED_LOCAL_AVAILABLE_RUNTIME}, when the local-workflow criterion above applies, put that same object in an adjacent JSON file and call \`divo-local invoke --tool ${product.toolId} --args-file <path>\` from the one persistent Python file. The file holds the argument object alone — a wrapper envelope carrying \`toolId\`, \`args\`, or \`skillId\` is rejected. Keep \`connectionId\` inside that argument object.

## Approved operations

${product.tools.map((tool) => `- \`${tool}\``).join('\n')}
${productWorkflow}

## Reliability and safety

- The operation contract is pinned to Workspace MCP ${GOOGLE_WORKSPACE_MCP_SOURCE.version}. Do not invent operations outside the list above.
- Preserve Divo RBAC, sharing, approval, and audit results. Pending or denied is not completed.
- Never guess Google resource IDs. Discover or read the target before an ambiguous mutation.
- Verify important content changes with a read operation and return canonical Google URLs from successful responses.
- Treat every result advisory with \`level: "required"\` as part of the tool contract. Satisfy it before reporting completion; if it cannot be satisfied, report partial completion and the exact missing evidence.
- Never expose tokens or the private MCP endpoint. A local path is forbidden only inside native Google \`input\`; it cannot be used as provider content. ${GOVERNED_LOCAL_AVAILABLE_RUNTIME}, a local JSON \`--args-file\` passed to credential-free \`divo-local\` is allowed as Divo transport. Use base64 content or HTTPS sources when the native Google operation requires content.`;
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

1. Before scanning a large candidate set, decide every intended mutation and call \`tools.preflight\` once with one complete proposed \`googleGmail\` invocation per mutation. For Google calls, preflight validates RBAC/action, the exact pinned native schema, selected connection eligibility, and required OAuth scopes. It does not execute the mutation or create an approval intent. Never preflight placeholder or empty native input.
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

## Pasted workbook or Divo export URL (read-only)

\`https://docs.google.com/spreadsheets/d/<id>\` and
\`https://drive.google.com/file/d/<id>\` may point to a native Google Sheet
**or** an Office file stored in Drive (Divo xlsx/csv exports often use either
URL shape).

When the member wants to **read, inspect, look up a row or column, or verify a
value** in a pasted link or a \`RECENT DIVO EXPORTS\` \`artifactUrl\`:

1. Extract the Drive file ID from the URL path segment after \`/d/\`.
2. Call \`get_drive_file_content\` with that \`file_id\` **before** any Sheets
   API call or Excel-to-Sheet conversion.
3. Answer only from the returned file content. Cite the row/column from that
   result.

Never answer from an earlier Menhood, Semrush, or other provider table when the
member references a file link or recent export. If \`get_drive_file_content\`
succeeds, that result is the only evidence for the answer.

### Completion contract

Creation, import, copy, or sharing is complete only when the successful response identifies the exact file and requested permission outcome. Preserve the returned file ID and canonical Drive URL/shareable link. If a creation response lacks an ID, do not blindly create a second copy—search the intended folder first, then report a real blocker if the resource cannot be identified.`;

    case 'calendar':
      return `

## Google Calendar workflow

1. Resolve relative dates against the current date and the user's timezone. Keep start/end times, all-day intent, recurrence, attendees, and timezone explicit; never silently assume a timezone for a cross-region meeting.
2. Use \`list_calendars\` when the target calendar is unknown. Use \`get_events\` for a bounded time window and identify the exact event before update or deletion.
3. Use \`query_freebusy\` before scheduling when attendee availability matters. Free/busy data shows availability, not permission to expose private event details.
4. Use \`manage_event\` for event create, update, or delete exactly as its described action schema requires. Before claiming an event is ready to create, call \`describe\`, construct the complete proposed event including action, calendar, times, timezone and grounded attendees, and pass that exact invocation to \`tools.preflight\`. Empty or placeholder event input is not a preflight. Use \`manage_out_of_office\` and \`manage_focus_time\` only for those specialized event types.
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

**Branch on intent before choosing a tool:**

- **Read-only** (inspect, look up a row/column, verify a value, summarize rows)
  → load \`google-drive\` and follow its read-only pasted-URL recipe with
  \`get_drive_file_content\`. Do **not** run \`resolve_reference\` or a
  conversion flow for read-only work.
- **Edit as a native Sheet or convert Excel to Google Sheet** → use the
  \`resolve_reference\` flow below.

Before generic web search or a native Sheets operation for **edit/convert**
intent, route an exact pasted \`https://docs.google.com/spreadsheets/d/...\`
Sheet URL or \`https://drive.google.com/file/d/...\` Excel workbook URL through
Divo's governed reference resolver. Do not fetch it as a public web page, derive
an ID from the URL yourself, request a download URL, or call
\`import_to_google_sheets\` directly:

\`\`\`json
{
  "toolId": "googleSheets",
  "args": {
    "op": "resolve_reference",
    "url": "<exact pasted Google Sheet or Drive workbook URL>",
    "connectionId": "<optional exact returned connection UUID>"
  }
}
\`\`\`

When the current run bootstrap already supplies one exact selected Google
\`connectionId\`, include it on the first call. Otherwise omit it; if Divo
returns one eligible account, retry immediately with its exact connection ID.
If it returns several, ask once, then retry the same URL with the selected exact
connection. Never spend a resolver call rediscovering a bootstrap account.
In a Lark runtime, a resolved response returns only
\`data.destinationReferenceId\`; retain that opaque, short-lived handle bound
to the exact user, chat, thread, and run. Use it for reads or edits without
extracting a spreadsheet ID from the URL:

\`\`\`json
{
  "toolId": "googleSheets",
  "args": {
    "op": "call_resolved_sheet",
    "destinationReferenceId": "<opaque resolved reference>",
    "nativeTool": "read_sheet_values",
    "input": { "range_name": "Sheet1!A1:Z100" }
  }
}
\`\`\`

In Desktop, retain the governed
\`data.resource.resourceId\` and \`data.resource.connectionId\` handles already
returned by Divo. Never reconstruct Google IDs or move Sheet rows through
model context.

A URL-only request resolves metadata and access only. Confirm that Divo can
open the Sheet, then ask what the member wants to do next.

For an Excel workbook, \`resolve_reference\` prepares Divo's native confirmation
to create a new Google Sheet copy. The original workbook stays unchanged. In
Lark, stop after the successful resolver call: the backend delivers the
confirmation card and owns conversion after the member clicks it.

**If a Sheets operation fails with \`must not be an Office file\`**, Google is
saying the file is an Excel or CSV upload rather than a native Sheet — the
Sheets API cannot read or write one whatever the connection is allowed to do.
This is **not** a permission problem: never tell the member their scopes are
missing or ask them to reconnect Google over it, because reconnecting changes
nothing and they will do it and fail again. Recover by running
\`resolve_reference\` on the same URL, which offers the editable Google Sheet
copy. Say that the file is an Excel export and that editing needs a Sheet copy,
and let the member decide.

When RECENT DIVO EXPORTS lists a recent artifact:

- **\`google_sheet\`** → use its opaque \`resourceRef\` for every read or edit
  in Lark. Never copy an ID from its URL and never supply a connection or
  spreadsheet ID:

\`\`\`json
{
  "toolId": "googleSheets",
  "args": {
    "op": "call_exported_sheet",
    "resourceRef": "<opaque recent-export reference>",
    "nativeTool": "read_sheet_values",
    "input": { "range": "Sheet1!A1:Z100" }
  }
}
\`\`\`

- **\`xlsx\` or \`csv\`** → load \`google-drive\` and call
  \`get_drive_file_content\` with the file ID from that row's \`artifactUrl\`.
  Do **not** use Sheets API, \`resolve_reference\`, or
  \`call_exported_sheet\` for these artifact types.

Never answer from an earlier provider query when the member references a recent
export or pastes its \`artifactUrl\`.

For follow-up **edits** on a \`google_sheet\` export, inspect workbook metadata
or the exact header range first, perform the narrow requested native operation
through \`call_exported_sheet\`, then read the exact changed range back through
the same opaque reference. Divo revalidates the original Google account and
workbook on every call. \`xlsx\` and \`csv\` exports are not editable through
\`call_exported_sheet\`; for read-only inspection use \`google-drive\`. For
editing, ask the member to use a Google Sheet destination instead.

When the connected source is authoritative and the member asks to correct or
replace an existing tab, inspect the header plus the final populated row once;
do not sample several arbitrary existing ranges. Validate all replacement rows
locally and persist them before the first Sheet mutation. On a formatting or
verification retry, reuse that saved source file rather than refetching every
provider page. Clear any stale tail beyond the new final row, write values in
the fewest bounded calls, apply each requested style or dimension once, then
perform one exact verification read containing the header and final written
row.

Resolved-Sheet terminal calls use these flat native \`input\` shapes; the opaque
reference supplies \`spreadsheet_id\`:

\`\`\`json
{"nativeTool":"modify_sheet_values","input":{"range_name":"Expenses!A1","values":[["Amount"],["10.00"]]}}
{"nativeTool":"format_sheet_range","input":{"range_name":"Expenses!A1:G1","background_color":"#334D73","text_color":"#FFFFFF","bold":true,"horizontal_alignment":"CENTER"}}
{"nativeTool":"resize_sheet_dimensions","input":{"sheet_name":"Expenses","column_sizes":{"A":220,"B":120},"frozen_row_count":1}}
\`\`\`

Keep Sheet values scalar and string-safe before writing. Do not nest formatting
under \`cell_format\`, and do not invent index-based resize fields. If no loaded
native operation can implement a requested feature, report that feature as
partial instead of claiming it was applied.

For a new structured spreadsheet, use this order:

This workflow is for an ordinary workbook in the member's selected Google
account. It is not an export-delivery path. When connected provider data must
be delivered as Sheet, Excel, or CSV and the source returns \`exportCandidate\`,
load \`secure-data-export\` and call \`dataExport op=plan\`; never use
\`create_spreadsheet\` to bypass the configured company export account or its
invoker-only sharing verification.

1. \`create_spreadsheet\` and retain the returned \`spreadsheetId\` and \`spreadsheetUrl\` fields. Treat a successful create as final even if later parsing or code fails; never create a second spreadsheet to rediscover the first response.
2. \`modify_sheet_values\` to write headers and rows.
   A successful write may return only an acknowledgement under \`data.result\`, not \`updatedRows\`. In a terminal workflow, count the intended rows from the local \`input.values\`; claim that count as written only after the exact read-back matches. Never turn a missing \`updatedRows\` field into a zero-row claim when verification proves the rows exist.
3. \`format_sheet_range\` for header and cell formatting, following its described flat input schema exactly.
4. \`resize_sheet_dimensions\` for column sizing and \`frozen_row_count\` / \`frozen_column_count\`.
5. \`manage_sheet_data_validation\` for dropdowns. Use explicit sheet-qualified ranges such as \`Sheet1!D2:D100\` and either \`one_of_list\` values or a \`one_of_range\` source.
6. \`read_sheet_values\` to verify the important written range. Use its machine-readable \`values\`, \`rowCount\`, \`returnedRowCount\`, \`isEmpty\`, and \`complete\` fields instead of parsing prose. A read with \`complete: false\` exposes only part of the range; read a narrower exact range before claiming verification.
7. Return the canonical Google Sheets URL from the successful result. A task is partial if requested formatting, freezing, validation, or URL return has not completed.

Example governed operation arguments:

\`\`\`json
{
  "connectionId": "<selected connection UUID when required>",
  "op": "call",
  "nativeTool": "manage_sheet_data_validation",
  "input": {
    "spreadsheet_id": "<spreadsheet ID>",
    "action": "set",
    "ranges": ["Sheet1!D2:D100"],
    "rule": { "type": "one_of_list", "values": ["Pending", "Approved", "Rejected"] }
  }
}
\`\`\`

Use this same argument shape with the registered Divo Google Sheets capability. ${GOVERNED_LOCAL_AVAILABLE_RUNTIME}, use it as the \`divo-local\` args file in a governed terminal workflow.

### Completion contract

A create or edit task is complete only after the important requested range is read back successfully in the same workflow, every required advisory is satisfied, and the response includes the canonical spreadsheet URL. Compare the machine-readable header and final populated row against the intended write. A failed, rate-limited, incomplete, or missing read-back cannot be replaced by an earlier write acknowledgement or an inferred count. Preserve the spreadsheet ID, sheet ID/title, and exact A1 ranges across steps. If a write returns an ambiguous failure, read the target range before retrying so rows or values are not duplicated.`;

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

async function syncAliases(
  db: GoogleSkillStore,
  skillId: string,
  aliases: readonly string[],
): Promise<void> {
  await db.skillAlias.deleteMany({
    where: { skillId, alias: { notIn: [...aliases] } },
  });
  if (aliases.length === 0) return;
  await db.skillAlias.createMany({
    data: aliases.map((alias) => ({ skillId, alias })),
    skipDuplicates: true,
  });
}

async function ensureFolder(db: GoogleSkillStore, companyId: string): Promise<string> {
  const existing = await db.skillFolder.findFirst({
    where: {
      companyId,
      departmentId: null,
      parentId: null,
      slug: GOOGLE_FOLDER.slug,
      status: 'active',
    },
    select: { id: true },
  });
  if (existing) return existing.id;

  const id = deterministicId(companyId, 'folder:google-workspace');
  const folder = await db.skillFolder.upsert({
    where: { id },
    create: { id, companyId, ...GOOGLE_FOLDER },
    update: { ...GOOGLE_FOLDER },
    select: { id: true },
  });
  return folder.id;
}

function definitionFields(folderId: string, definition: GoogleWorkspaceSystemSkillDefinition) {
  return {
    departmentId: null,
    folderId,
    scope: 'company',
    name: definition.name,
    slug: definition.slug,
    summary: definition.summary,
    markdown: definition.markdown,
    status: 'active',
    isSystem: true,
    sortOrder: definition.sortOrder,
  } as const;
}

function matchesDefinition(
  current: ExistingSkill,
  folderId: string,
  definition: GoogleWorkspaceSystemSkillDefinition,
): boolean {
  return current.departmentId === null
    && current.folderId === folderId
    && current.scope === 'company'
    && current.slug === definition.slug
    && current.name === definition.name
    && current.summary === definition.summary
    && current.markdown === definition.markdown
    && current.status === 'active'
    && current.isSystem
    && current.sortOrder === definition.sortOrder
    && arraysEqual(current.toolIds, definition.toolIds)
    && arraysEqual(current.tags, definition.tags)
    && arraysEqual((current.aliases ?? []).map((item) => item.alias), [...definition.aliases].sort());
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function deterministicId(companyId: string, key: string): string {
  const hex = createHash('md5').update(`${companyId}:${key}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
