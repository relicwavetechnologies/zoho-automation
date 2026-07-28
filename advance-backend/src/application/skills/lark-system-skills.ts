import { createHash } from 'node:crypto';
import type { Prisma } from '../../generated/prisma';
import { recordSkillRegistryMutation } from './skill-registry-versioning';
import { larkSkillEnglishOnlyError } from './lark-skill-language-policy';
import {
  GOVERNED_DIRECT_ACTION_CRITERION,
  GOVERNED_LOCAL_WORKFLOW_ROUTE,
} from './governed-local-routing';
import { larkDocumentsMarkdown } from './lark-system-skills/documents';
import { createLarkRouterSkill } from './lark-system-skills/router';
import {
  larkCalendarMarkdown,
  larkMeetingsMarkdown,
  larkTasksMarkdown,
} from './lark-system-skills/work-management';
import {
  larkApprovalsMarkdown,
  larkBaseMarkdown,
  larkContactsMarkdown,
  larkMessagingMarkdown,
} from './lark-system-skills/workspace';

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

const LARK_GOVERNED_ROUTING = `For ${GOVERNED_DIRECT_ACTION_CRITERION}, use the governed Divo route directly. ${GOVERNED_LOCAL_WORKFLOW_ROUTE} Never call Lark directly from Bash: no lark-cli, curl, local credentials, or direct Lark API calls.`;
const LARK_USER_CONNECTION = `- Reuse an exact \`connectionId\` already supplied by the current run.
- Otherwise omit \`connectionId\`. The backend selects an account only when exactly one accessible account qualifies; when several qualify, retry with one exact ID from the safe choices it returns.
- Never invent an ID or call \`connections.list\` merely to rediscover an account the backend can select.`;

export const LARK_SYSTEM_SKILLS: readonly LarkSystemSkillDefinition[] = [
  createLarkRouterSkill(LARK_GOVERNED_ROUTING),
  {
    slug: 'lark-documents',
    name: 'Lark Documents',
    summary: 'Create and edit Lark documents with native todos and rich blocks, and organize the implemented subset of Lark Drive.',
    toolIds: ['larkDoc'],
    tags: ['lark', 'documents', 'writing', 'reports', 'notes'],
    sortOrder: 10,
    markdown: larkDocumentsMarkdown({
      userConnection: LARK_USER_CONNECTION,
      governedRouting: LARK_GOVERNED_ROUTING,
    }),
  },
  {
    slug: 'lark-tasks',
    legacySlugs: ['lark-productivity'],
    name: 'Lark Tasks',
    summary: 'Create, assign, list, update, complete, and organize Lark tasks, subtasks, and tasklists.',
    toolIds: ['larkTask'],
    tags: ['lark', 'tasks', 'todos', 'tasklists', 'productivity'],
    sortOrder: 20,
    markdown: larkTasksMarkdown({
      userConnection: LARK_USER_CONNECTION,
      governedRouting: LARK_GOVERNED_ROUTING,
    }),
  },
  {
    slug: 'lark-calendar',
    name: 'Lark Calendar',
    summary: 'List schedules, create and update events, check availability, manage attendees, and handle recurring meetings in Lark.',
    toolIds: ['larkCalendar'],
    tags: ['lark', 'calendar', 'meetings', 'availability', 'events'],
    sortOrder: 30,
    markdown: larkCalendarMarkdown({
      userConnection: LARK_USER_CONNECTION,
      governedRouting: LARK_GOVERNED_ROUTING,
    }),
  },
  {
    slug: 'lark-meetings',
    name: 'Lark Meetings',
    summary: 'Search Lark video meetings, inspect their details, and retrieve recording links through a governed Lark connection.',
    toolIds: ['larkMeeting'],
    tags: ['lark', 'meetings', 'video-conferencing', 'recordings'],
    sortOrder: 35,
    markdown: larkMeetingsMarkdown({
      userConnection: LARK_USER_CONNECTION,
      governedRouting: LARK_GOVERNED_ROUTING,
    }),
  },
  {
    slug: 'lark-messaging',
    name: 'Lark Messaging',
    summary: 'Send and reply to Lark messages, resolve chats, search conversation history, and mention people safely.',
    toolIds: ['larkMessaging'],
    tags: ['lark', 'messaging', 'chat', 'dm', 'mentions'],
    sortOrder: 40,
    markdown: larkMessagingMarkdown({
      userConnection: LARK_USER_CONNECTION,
      governedRouting: LARK_GOVERNED_ROUTING,
    }),
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
    markdown: larkContactsMarkdown(LARK_GOVERNED_ROUTING),
  },
  {
    slug: 'lark-base',
    legacySlugs: ['lark-workflows-and-base'],
    name: 'Lark Base',
    summary: 'Read, search, create, update, and delete governed records in Lark Base tables.',
    toolIds: ['larkBase'],
    tags: ['lark', 'base', 'bitable', 'records', 'tables'],
    sortOrder: 60,
    markdown: larkBaseMarkdown({
      userConnection: LARK_USER_CONNECTION,
      governedRouting: LARK_GOVERNED_ROUTING,
    }),
  },
  {
    slug: 'lark-approvals',
    name: 'Lark Approvals',
    summary: 'Inspect and create governed native Lark approval instances through the company-installed Lark application.',
    toolIds: ['larkApproval'],
    tags: ['lark', 'approvals', 'workflow', 'forms', 'hitl'],
    sortOrder: 70,
    markdown: larkApprovalsMarkdown(LARK_GOVERNED_ROUTING),
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
