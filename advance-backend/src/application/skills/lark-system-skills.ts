import type { Prisma } from '../../generated/prisma';
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
import type { SystemSkillDefinition } from './system-skill-definition';
import {
  buildSystemSkill,
  ensureSystemSkillFolder,
  provisionSystemSkill,
  type SystemSkillStore,
} from './system-skill-provisioner';

export type LarkSystemSkillDefinition = SystemSkillDefinition;

const LARK_GOVERNED_ROUTING = `For ${GOVERNED_DIRECT_ACTION_CRITERION}, use the governed Divo route directly. ${GOVERNED_LOCAL_WORKFLOW_ROUTE} Never call Lark directly from Bash: no lark-cli, curl, local credentials, or direct Lark API calls.`;
/**
 * Every Lark tool states in parameterDocs how `connectionId` itself behaves —
 * omit it and the backend either selects the one accessible account or returns
 * exact choices. Six skills repeated that. What is left is the part no schema
 * can state: never re-discover through a different tool, and ask when the
 * backend hands back choices instead of picking one for you.
 */
const LARK_USER_CONNECTION = `- Never invent a \`connectionId\` or call \`connections.list\` to rediscover an account the backend can select for itself.
- When the backend returns account choices instead of selecting one, ask which account to use. Never pick for the member.`;

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
  key: 'folder:lark',
  name: 'Lark',
  slug: 'lark',
  sortOrder: 20,
} as const;
const LARK_FAMILY_FOLDERS = [
  { name: 'Documents and Drive', slug: 'documents-drive', skillSlug: 'lark-documents', sortOrder: 10 },
  { name: 'Tasks', slug: 'tasks', skillSlug: 'lark-tasks', sortOrder: 20 },
  { name: 'Calendar', slug: 'calendar', skillSlug: 'lark-calendar', sortOrder: 30 },
  { name: 'Meetings', slug: 'meetings', skillSlug: 'lark-meetings', sortOrder: 35 },
  { name: 'Messaging', slug: 'messaging', skillSlug: 'lark-messaging', sortOrder: 40 },
  { name: 'Contacts', slug: 'contacts', skillSlug: 'lark-contacts', sortOrder: 50 },
  { name: 'Base', slug: 'base', skillSlug: 'lark-base', sortOrder: 60 },
  { name: 'Approvals', slug: 'approvals', skillSlug: 'lark-approvals', sortOrder: 70 },
] as const;

export async function provisionLarkSystemSkills(
  db: SystemSkillStore,
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

  const { folderId, familyFolderIds } = await ensureLarkFolders(db, companyId);
  const totals = { folderId, created: 0, updated: 0, existing: 0, skipped: 0 };
  for (const definition of LARK_SYSTEM_SKILLS) {
    const definitionFolderId = familyFolderIds.get(definition.slug) ?? folderId;
    const result = await provisionSystemSkill(db, companyId, definition, {
      folderId: definitionFolderId,
      departmentId: null,
      scope: 'company',
      granteeType: 'company',
      granteeId: companyId,
    });
    totals[result.outcome] += 1;
  }
  return totals;
}

export function buildLarkSystemSkill(
  companyId: string,
  folderId: string,
  definition: LarkSystemSkillDefinition,
): Prisma.SkillUncheckedCreateInput & { id: string } {
  return buildSystemSkill(companyId, definition, {
    folderId,
    departmentId: null,
    scope: 'company',
    granteeType: 'company',
    granteeId: companyId,
  });
}

async function ensureLarkFolders(
  db: Pick<SystemSkillStore, 'skillFolder'>,
  companyId: string,
): Promise<{ folderId: string; familyFolderIds: ReadonlyMap<string, string> }> {
  const folderId = await ensureSystemSkillFolder(db, companyId, LARK_FOLDER);
  const familyFolderIds = new Map<string, string>();
  for (const family of LARK_FAMILY_FOLDERS) {
    const familyFolderId = await ensureSystemSkillFolder(db, companyId, {
      key: `folder:lark:${family.slug}`,
      name: family.name,
      slug: family.slug,
      sortOrder: family.sortOrder,
      parentId: folderId,
    });
    familyFolderIds.set(family.skillSlug, familyFolderId);
  }
  return { folderId, familyFolderIds };
}
