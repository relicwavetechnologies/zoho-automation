import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '../../generated/prisma';
import {
  GOOGLE_WORKSPACE_MCP_AUTH_CONTRACT,
  GOOGLE_WORKSPACE_MCP_SOURCE,
  GOOGLE_WORKSPACE_PRODUCTS,
  type GoogleWorkspaceProductDefinition,
} from '../google/google-workspace-mcp-manifest';
import { recordSkillRegistryMutation } from './skill-registry-versioning';

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
  drive: ['google files', 'cloud files', 'shared drive'],
  calendar: ['google events', 'schedule', 'availability'],
  docs: ['google document', 'word processor'],
  sheets: ['google sheet', 'spreadsheet', 'workbook', 'cells', 'dropdown', 'data validation', 'freeze header'],
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

1. Call \`${product.toolId}\` without \`connectionId\` unless the user already chose an exact account. Divo auto-selects only when exactly one eligible connected/shared account can perform the action.
2. When the tool returns \`google_workspace_connection_selection_required\`, ask one short account-choice question using only those returned options, then retry once with that exact \`connectionId\`. Never rotate through accounts after an error.
3. Use \`connections.list\` only when the user explicitly asks to inspect or manage available accounts. Never use an email address or label as \`connectionId\`.
4. Use only \`${product.toolId}\`. Never use a local Google CLI, Bash, curl, browser automation, or direct Google API calls.
5. Call \`op: "describe"\` with the selected \`nativeTool\` before its first unfamiliar use. \`input\` may be omitted for describe; follow the returned MCP input schema exactly.
6. Call \`op: "call"\` with the same \`nativeTool\` and its arguments under \`input\`.
7. ${GOOGLE_WORKSPACE_MCP_AUTH_CONTRACT.agentGuidance}

## Canonical governed call shape

Invoke the runtime's governed wrapper with \`toolId: "${product.toolId}"\` and keep all product arguments under its \`args\` object: \`{ "op": "describe|call", "nativeTool": "<approved operation>", "connectionId": "<UUID when selected>", "input": {} }\`. Never place \`connectionId\` beside the wrapper's payload.

## Approved operations

${product.tools.map((tool) => `- \`${tool}\``).join('\n')}
${productWorkflow}

## Reliability and safety

- The operation contract is pinned to Workspace MCP ${GOOGLE_WORKSPACE_MCP_SOURCE.version}. Do not invent operations outside the list above.
- Preserve Divo RBAC, sharing, approval, and audit results. Pending or denied is not completed.
- Never guess Google resource IDs. Discover or read the target before an ambiguous mutation.
- Verify important content changes with a read operation and return canonical Google URLs from successful responses.
- Never expose tokens or the private MCP endpoint. Sidecar-local file paths and file URLs are forbidden; use base64 content or HTTPS sources.`;
}

function buildProductWorkflow(service: GoogleWorkspaceProductDefinition['service']): string {
  switch (service) {
    case 'gmail':
      return `

## Gmail workflow

### Find and understand mail

1. Use \`search_gmail_messages\` to find candidates. Put Gmail search syntax in the schema's query field; useful patterns include \`is:unread\`, \`from:person@example.com\`, \`to:person@example.com\`, \`subject:(quarterly report)\`, \`has:attachment\`, \`filename:pdf\`, \`newer_than:7d\`, \`-label:spam\`, and \`{from:a@example.com from:b@example.com}\`.
2. Use \`get_gmail_messages_content_batch\` for several independent messages, \`get_gmail_message_content\` for one message, or \`get_gmail_thread_content\` when reply history matters. Search snippets are not enough for summarizing, extracting commitments, or composing a grounded reply.
3. Fetch attachment content only when the task requires the attachment itself. Do not infer attachment contents from its filename.

### Draft, send, and organize

- Use \`draft_gmail_message\` when the user asks to draft, review, or prepare an email. Use \`send_gmail_message\` only when the user asks to send.
- Never invent a recipient. Resolve an address from the user's text or governed contact data; ask if multiple people match.
- Preserve threading identifiers when replying. Do not turn a requested reply into an unrelated new conversation.
- Use \`modify_gmail_message_labels\` for one message and \`batch_modify_gmail_message_labels\` for an established set. Resolve label names with \`list_gmail_labels\`; use \`manage_gmail_label\` only to create, update, or delete labels.
- Use filter operations only when the user explicitly asks for an ongoing Gmail rule. A one-time cleanup is a label operation, not a filter.

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

### Completion contract

Creation, import, copy, or sharing is complete only when the successful response identifies the exact file and requested permission outcome. Preserve the returned file ID and canonical Drive URL/shareable link. If a creation response lacks an ID, do not blindly create a second copy—search the intended folder first, then report a real blocker if the resource cannot be identified.`;

    case 'calendar':
      return `

## Google Calendar workflow

1. Resolve relative dates against the current date and the user's timezone. Keep start/end times, all-day intent, recurrence, attendees, and timezone explicit; never silently assume a timezone for a cross-region meeting.
2. Use \`list_calendars\` when the target calendar is unknown. Use \`get_events\` for a bounded time window and identify the exact event before update or deletion.
3. Use \`query_freebusy\` before scheduling when attendee availability matters. Free/busy data shows availability, not permission to expose private event details.
4. Use \`manage_event\` for event create, update, or delete exactly as its described action schema requires. Use \`manage_out_of_office\` and \`manage_focus_time\` only for those specialized event types.
5. Use \`create_calendar\` only when the user asks for a separate calendar, not for an ordinary event.

### Completion contract

After a calendar mutation, return the event/calendar name, resolved date and timezone, attendees when relevant, and canonical Calendar URL or resource ID returned by Google. For an important update, read the event window again. If an ambiguous failure follows a create request, search that window before retrying to avoid duplicate meetings.`;

    case 'docs':
      return `

## Google Docs workflow

1. For an existing document, use \`search_docs\` or \`list_docs_in_folder\` to resolve it, then \`get_doc_content\` or \`get_doc_as_markdown\` to understand its current content. Never guess a document ID.
2. For a new document, call \`create_doc\` once and immediately retain the returned document ID and canonical URL. Do not start follow-up edits until the created resource is identifiable.
3. Choose the smallest semantic edit: \`modify_doc_text\` for text changes, \`find_and_replace_doc\` for grounded replacements, \`insert_doc_elements\` for structural elements, \`create_table_with_data\` for tables, and \`insert_doc_image\` for images. Use \`batch_update_doc\` for a cohesive multi-edit request rather than many avoidable one-block calls.
4. Inspect structure with \`inspect_doc_structure\` before index-sensitive edits. Use \`update_paragraph_style\`, \`update_doc_headers_footers\`, or \`manage_doc_tab\` only after describing and following their exact schemas.
5. Verify the final document with \`get_doc_as_markdown\` or \`get_doc_content\`. Use comment operations for review discussion, not as a substitute for requested document edits.

### Completion contract

A create/edit task is complete only when the final content is verified and the response includes the canonical Google Docs URL. If \`create_doc\` returns no usable document ID or URL, do not claim success and do not create another document blindly; report the exact gateway/API result as a blocker. Export is complete only when \`export_doc_to_pdf\` returns the requested artifact or usable download result.`;

    case 'sheets':
      return `

## Google Sheets workflow

For a new structured spreadsheet, use this order:

1. \`create_spreadsheet\` and retain the returned spreadsheet ID and URL.
2. \`modify_sheet_values\` to write headers and rows.
3. \`format_sheet_range\` for header and cell formatting, following its described flat input schema exactly.
4. \`resize_sheet_dimensions\` for column sizing and \`frozen_row_count\` / \`frozen_column_count\`.
5. \`manage_sheet_data_validation\` for dropdowns. Use explicit sheet-qualified ranges such as \`Sheet1!D2:D100\` and either \`one_of_list\` values or a \`one_of_range\` source.
6. \`read_sheet_values\` to verify the important written range.
7. Return the canonical Google Sheets URL from the successful result. A task is partial if requested formatting, freezing, validation, or URL return has not completed.

Example governed operation arguments:

\`\`\`json
{
  "toolId": "googleSheets",
  "args": {
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
}
\`\`\`

The runtime's governed wrapper may be \`call_tool\` or \`divo_gateway\`; in both cases keep \`connectionId\` inside the Google tool's \`args\` object shown above.

### Completion contract

A create or edit task is complete only after the important requested range is read back and the response includes the canonical spreadsheet URL. Preserve the spreadsheet ID, sheet ID/title, and exact A1 ranges across steps. If a write returns an ambiguous failure, read the target range before retrying so rows or values are not duplicated.`;

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
    scope: 'global',
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
    && current.scope === 'global'
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
