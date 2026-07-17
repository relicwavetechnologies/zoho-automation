import { createHash } from 'node:crypto';
import type { Prisma } from '../../generated/prisma';
import { recordSkillRegistryMutation } from './skill-registry-versioning';
import { larkSkillEnglishOnlyError } from './lark-skill-language-policy';

export interface LarkSystemSkillDefinition {
  readonly slug: string;
  readonly legacySlugs?: readonly string[];
  readonly name: string;
  readonly summary: string;
  readonly markdown: string;
  readonly toolIds: readonly string[];
  readonly tags: readonly string[];
  readonly aliases?: readonly string[];
  readonly sortOrder: number;
}

export const LARK_SYSTEM_SKILLS: readonly LarkSystemSkillDefinition[] = [
  {
    slug: 'lark-documents',
    name: 'Lark Documents',
    summary: 'Create polished Lark documents, structure their content with blocks and tables, edit existing documents, and return the real Lark link.',
    toolIds: ['larkDoc'],
    tags: ['lark', 'documents', 'writing', 'reports', 'notes'],
    sortOrder: 10,
    markdown: `# Lark Documents

Use this skill for Lark documents, meeting notes, reports, plans, briefs, SOPs, and structured write-ups.

## Connection

1. List accessible connections with provider \`lark\`.
2. If exactly one connection is available, use its \`connectionId\`.
3. If several are available and the member did not identify one, ask which account to use.
4. Send \`connectionId\` with every user-scoped Lark document action. Never use local credentials, Bash, curl, or lark-cli.

## Create a polished document

1. Decide a concise title from the member's request. Create the document with \`larkDoc\` operation \`create\`.
2. Preserve both \`docToken\` and \`url\` from the successful response. The returned \`url\` is canonical; never construct or search for a URL from \`docToken\`.
3. Build the document in a readable order using \`append_block\`:
   - a short purpose or executive summary;
   - meaningful \`heading1\` / \`heading2\` sections;
   - short paragraphs and \`bullet\` blocks;
   - a table only when rows and columns improve comprehension.
4. Keep each block focused. Do not place an entire report in one text block.
5. Confirm completion with the title and a clickable link using the exact returned \`url\`.

## Edit an existing document

1. Use \`list_blocks\` to identify the exact \`blockId\` before updating or deleting content.
2. Use \`update_block\` or \`delete_block\` only for the member's requested change.
3. Use \`insert_table\` with explicit row and column counts. Ask for clarification if the desired structure is ambiguous.

## Safety and truthfulness

- Never claim a document or block was created unless the tool returned success.
- Never use a guessed tenant hostname or expose internal IDs when a canonical URL is available.
- If the response is missing \`url\`, report that the document was created but the link was not returned; do not recover it with local shell commands.
- Respect Divo RBAC and approval results exactly.`,
  },
  {
    slug: 'lark-tasks',
    legacySlugs: ['lark-productivity'],
    name: 'Lark Tasks',
    summary: 'Create, assign, list, update, complete, and organize Lark tasks, subtasks, and tasklists.',
    toolIds: ['larkTask'],
    tags: ['lark', 'tasks', 'todos', 'tasklists', 'productivity'],
    sortOrder: 20,
    markdown: `# Lark Tasks

Use this skill for todos, follow-ups, reminders, assignments, subtasks, and tasklists in Lark.

## Connection

- Resolve an accessible \`lark\` connection and pass its \`connectionId\` to every task action.
- Never run lark-cli, call Lark directly, or ask for an access token.

## Operating rules

- Use \`create\` for a task and preserve the member's requested title.
- Set assignees only when the member explicitly assigns or delegates the task. A person mentioned as part of a meeting title is not automatically an assignee.
- Use \`assignToMe\` for “me” rather than searching for the requester by name.
- Include a due date only when one was given or confirmed; use an ISO timestamp with timezone offset.
- Use \`create_subtask\` with the parent task ID, and use tasklist operations for project grouping.
- Read the current task before a destructive or ambiguous update.

Return the useful task title, assignee, and due date. Never claim completion while approval is pending.`,
  },
  {
    slug: 'lark-calendar',
    name: 'Lark Calendar',
    summary: 'List schedules, create and update events, check availability, manage attendees, and handle recurring meetings in Lark.',
    toolIds: ['larkCalendar'],
    tags: ['lark', 'calendar', 'meetings', 'availability', 'events'],
    sortOrder: 30,
    markdown: `# Lark Calendar

Use this skill for meetings, events, schedules, attendees, recurring events, and free/busy checks.

- Resolve an accessible \`lark\` connection and pass its \`connectionId\`.
- Use explicit ISO start and end times with timezone offsets. Use a 30-minute duration only when duration is omitted.
- Add attendees only when explicitly requested. Resolve names and ask when several people match.
- Use \`free_busy\` for availability; a person's open ID is not a calendar ID.
- Use recurring-event operations with an explicit recurrence rule for repeating meetings.
- Use attendee update operations for additions/removals instead of recreating an event.
- Never run lark-cli or call Lark outside Divo.

Confirm the event title, local date/time, timezone, and attendees. Never claim creation or update without tool success.`,
  },
  {
    slug: 'lark-meetings',
    name: 'Lark Meetings',
    summary: 'Search Lark video meetings, inspect their details, and retrieve recording links through a governed Lark connection.',
    toolIds: ['larkMeeting'],
    tags: ['lark', 'meetings', 'video-conferencing', 'recordings'],
    sortOrder: 35,
    markdown: `# Lark Meetings

Use this skill to find Lark video meetings, inspect a known meeting, or retrieve its recording link.

## Connection

- Resolve an accessible \`lark\` connection and include its \`connectionId\` on every action.
- If several accounts are available, ask the member which connection to use. Never guess and never use lark-cli, Bash, curl, or a local token.

## Operating rules

- Use \`search\` for a meeting title, keyword, or a bounded historical time range. Lark requires \`startTime\` and \`endTime\` as Unix timestamps in seconds when filtering by time.
- Use \`get\` only after a meeting ID is known from a search or trusted context.
- Use \`get_recording\` only with a known meeting ID. Return the exact Lark recording URL when the API returns one; never fabricate a link.
- This is read-only: it cannot join, end, invite participants to, remove participants from, or record a live meeting.
- A missing recording is a valid outcome. State that it was not available instead of claiming one exists.

Confirm the meeting title and time when present, and give the canonical recording link only when returned by Lark.`,
  },
  {
    slug: 'lark-messaging',
    name: 'Lark Messaging',
    summary: 'Send and reply to Lark messages, resolve chats, search conversation history, and mention people safely.',
    toolIds: ['larkMessaging'],
    tags: ['lark', 'messaging', 'chat', 'dm', 'mentions'],
    sortOrder: 40,
    markdown: `# Lark Messaging

Use this skill for direct messages, group messages, replies, message search, and mentions.

- Resolve an accessible \`lark\` connection and pass its \`connectionId\`.
- Send only when the member explicitly asked to send and named a recipient or destination.
- For a direct message, use recipient-name resolution and ask when the match is ambiguous.
- For a group, list chats first to resolve the chat. If Divo is absent, tell the member it must be added.
- Resolve mention names before sending. Do not guess IDs.
- Preserve approval state: pending is not sent, rejected is not sent.
- Never run lark-cli, call Lark with curl, or expose connection tokens.

Confirm the destination and a short description of what was sent without exposing raw IDs.`,
  },
  {
    slug: 'lark-contacts',
    name: 'Lark Contacts',
    summary: 'Resolve Lark people by name or email and retrieve governed directory details for downstream actions.',
    toolIds: ['larkContacts'],
    tags: ['lark', 'contacts', 'directory', 'people', 'identity'],
    aliases: [
      'employee lookup',
      'company directory',
      'colleague search',
      'staff contact',
      'resolve person',
    ],
    sortOrder: 50,
    markdown: `# Lark Contacts

Use this skill to resolve people before messaging, assigning tasks, or inviting calendar attendees.

- Use lookup for a name or email and list-department only when department traversal is explicitly needed.
- Return all plausible candidates when a name is ambiguous; never pick one silently.
- Treat open IDs and user IDs as internal routing values, not user-facing identity.
- Request only the directory detail needed for the member's task.
- Contacts may be an installed-company capability; Divo still enforces company policy and audit.
- Use internalRouting only to pass a resolved person into another Lark action. Never include that block or any Lark ID in user-facing output.
- Never use lark-cli, local credentials, or direct Lark API requests.

In user-facing output, prefer the person's name, email, job title, department names, and organization when available. Omit fields the governed directory did not return.`,
  },
  {
    slug: 'lark-base',
    legacySlugs: ['lark-workflows-and-base'],
    name: 'Lark Base',
    summary: 'Read, search, create, update, and delete governed records in Lark Base tables.',
    toolIds: ['larkBase'],
    tags: ['lark', 'base', 'bitable', 'records', 'tables'],
    sortOrder: 60,
    markdown: `# Lark Base

Use this skill for Lark Base record lookup and mutation.

- Resolve an accessible \`lark\` connection and pass its \`connectionId\`.
- Require the exact Base app and table identifiers supplied or resolved from trusted context.
- Read before updating when the target record is unclear. Never guess field names or record IDs.
- Preserve typed field values and structured results returned by Lark.
- Confirm the exact record-level mutation; never claim completion while approval is pending.
- Never use local Lark credentials, Bash, curl, or lark-cli.`,
  },
  {
    slug: 'lark-approvals',
    name: 'Lark Approvals',
    summary: 'Inspect and create governed native Lark approval instances through the company-installed Lark application.',
    toolIds: ['larkApproval'],
    tags: ['lark', 'approvals', 'workflow', 'forms', 'hitl'],
    sortOrder: 70,
    markdown: `# Lark Approvals

Use this skill for native Lark approval definitions, instances, and submissions.

- Native approvals use the company-installed Lark application and remain governed by Divo permission checks, HITL policy, and audit.
- List or inspect the approval definition before creation when its required fields are not known.
- Submit only form values explicitly supplied or confirmed by the member.
- Preserve instance codes internally for follow-up reads, but present human-readable status and definition names.
- Pending, rejected, denied, or misconfigured actions are not successful submissions.
- Never use lark-cli, local credentials, or direct Lark API calls.

Return the approval name, current status, and next required action.`,
  },
] as const;

const LARK_FOLDER = {
  name: 'Lark',
  slug: 'lark',
  departmentId: null,
  parentId: null,
  status: 'active',
  sortOrder: 20,
} as const;

type LarkSkillStore = Pick<
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

export async function provisionLarkSystemSkills(
  db: LarkSkillStore,
  companyId: string,
): Promise<{ folderId: string; created: number; updated: number; existing: number; skipped: number }> {
  for (const definition of LARK_SYSTEM_SKILLS) {
    const languageError = larkSkillEnglishOnlyError({
      slug: definition.slug,
      name: definition.name,
      summary: definition.summary,
      markdown: definition.markdown,
      toolIds: definition.toolIds,
      tags: definition.tags,
    });
    if (languageError) throw new Error(`Invalid system skill "${definition.slug}": ${languageError}`);
  }

  const folderId = await ensureLarkFolder(db, companyId);
  let created = 0;
  let updated = 0;
  let existing = 0;
  let skipped = 0;

  for (const definition of LARK_SYSTEM_SKILLS) {
    let current = await db.skill.findFirst({
      where: { companyId, slug: definition.slug, status: { not: 'archived' } },
      select: EXISTING_SKILL_SELECT,
    }) as ExistingSkill | null;
    if (!current && definition.legacySlugs?.length) {
      current = await db.skill.findFirst({
        where: {
          companyId,
          slug: { in: [...definition.legacySlugs] },
          status: { not: 'archived' },
          isSystem: true,
        },
        select: EXISTING_SKILL_SELECT,
      }) as ExistingSkill | null;
    }

    if (current && !current.isSystem) {
      skipped += 1;
      continue;
    }

    let skill: ExistingSkill;
    if (!current) {
      skill = await db.skill.create({
        data: buildLarkSystemSkill(companyId, folderId, definition),
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
    if (definition.aliases) {
      await syncAliases(db, skill.id, definition.aliases);
    }
  }

  return { folderId, created, updated, existing, skipped };
}

export function buildLarkSystemSkill(
  companyId: string,
  folderId: string,
  definition: LarkSystemSkillDefinition,
): Prisma.SkillUncheckedCreateInput & { id: string } {
  return {
    id: deterministicId(companyId, `skill:${definition.slug}`),
    companyId,
    ...definitionFields(folderId, definition),
    toolIds: [...definition.toolIds],
    tags: [...definition.tags],
  };
}

async function ensureLarkFolder(db: LarkSkillStore, companyId: string): Promise<string> {
  const existing = await db.skillFolder.findFirst({
    where: {
      companyId,
      departmentId: null,
      parentId: null,
      slug: LARK_FOLDER.slug,
      status: 'active',
    },
    select: { id: true },
  });
  if (existing) return existing.id;

  const folder = await db.skillFolder.upsert({
    where: { id: deterministicId(companyId, 'folder:lark') },
    create: {
      id: deterministicId(companyId, 'folder:lark'),
      companyId,
      ...LARK_FOLDER,
    },
    update: { ...LARK_FOLDER },
    select: { id: true },
  });
  return folder.id;
}

function definitionFields(folderId: string, definition: LarkSystemSkillDefinition) {
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

async function syncAliases(
  db: LarkSkillStore,
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

function matchesDefinition(
  current: ExistingSkill,
  folderId: string,
  definition: LarkSystemSkillDefinition,
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
    && (definition.aliases === undefined
      || arraysEqual((current.aliases ?? []).map((item) => item.alias), [...definition.aliases].sort()));
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function deterministicId(companyId: string, key: string): string {
  const hex = createHash('md5').update(`${companyId}:${key}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
