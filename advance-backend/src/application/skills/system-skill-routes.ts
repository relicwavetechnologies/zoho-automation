import type { Prisma, PrismaClient } from '../../generated/prisma';
import { CONNECTED_PROVIDER_SYSTEM_SKILLS } from './connected-provider-system-skills';
import { DATA_EXPORT_SYSTEM_SKILL } from './data-export-system-skill';
import {
  CREATE_FILES_SKILL_SLUG,
  FILES_AND_DOCUMENTS_SYSTEM_SKILLS,
  READ_FILES_SKILL_SLUG,
} from './files-and-documents-system-skills';
import {
  provisionDivoProductivitySystemSkill,
  type DivoProductivitySystemSkillDefinition,
} from './divo-productivity-system-skills';
import { GOOGLE_WORKSPACE_SYSTEM_SKILLS } from './google-workspace-system-skills';
import { LARK_SYSTEM_SKILLS } from './lark-system-skills';
import { MAIL_OPS_SYSTEM_SKILLS } from './mail-ops-system-skills';
import { DIVO_OMS_SITE_DATA_SYSTEM_SKILL } from './oms-site-data-system-skill';
import { SCHEDULE_DIVO_WORK_SKILL_SLUG } from './scheduled-work-system-skill';
import { DIVO_SEMRUSH_SYSTEM_SKILL } from './semrush-system-skill';
import { SHARE_MEMORY_SKILL_SLUG } from './share-memory-system-skill';
import { ZOHO_FINANCE_SYSTEM_SKILLS } from './zoho-finance-system-skills';

const ROUTING_SYSTEM_SKILLS = [
  {
    slug: 'airtable-router',
    name: 'Airtable Router',
    summary: 'Routes Airtable record, schema, and automation work to the exact specialist.',
    markdown: `# Airtable Router

Choose the exact approved specialist returned by this router.

- Records and comments → \`airtable-core\`.
- Bases, tables, fields, schemas, and views → \`airtable-schema-ops\`.
- Interfaces and automations → \`airtable-automation-ops\`.

Airtable and AITable are different products. Never route an AITable request here.
This router is instruction-only: loading it successfully means to load one specialist above next.`,
    toolIds: [],
    tags: ['airtable', 'router', 'records', 'schema', 'automation'],
    aliases: [
      'airtable',
      'airtable records',
      'airtable bases',
      'airtable automation',
      'customer queries',
      'query status',
      'record status counts',
    ],
    sortOrder: 3,
  },
  {
    slug: 'aitable-router',
    name: 'AITable Router',
    summary: 'Routes AITable Fusion datasheet and field work to the exact specialist.',
    markdown: `# AITable Router

Choose the exact approved specialist returned by this router.

- Spaces, nodes, datasheets, views, records, and attachments → \`aitable-datasheets\`.
- Field creation, metadata, and deletion → \`aitable-fields\`.

AITable and Airtable are different products. Never route an Airtable request here.`,
    toolIds: [],
    tags: ['aitable', 'router', 'fusion', 'datasheets', 'fields'],
    aliases: ['aitable', 'aitable fusion', 'aitable datasheets', 'aitable fields'],
    sortOrder: 4,
  },
  {
    slug: 'data-router',
    name: 'Data Work Router',
    summary: 'Routes bounded data processing separately from governed complete-data exports.',
    markdown: `# Data Work Router

Choose the exact approved specialist returned by this router.

- Calculate, group, filter, reshape, or format data → \`data-processing\`.
- Produce a CSV, Google Sheet, or governed complete-data artifact → \`secure-data-export\`.
- Analyse a file already in the workspace, or one too large to hold in
  context → \`${READ_FILES_SKILL_SLUG}\`.

Never treat this router as permission to process or export data. Load the specialist first.`,
    toolIds: [],
    tags: ['data', 'router', 'processing', 'analysis', 'export'],
    aliases: ['data processing', 'calculate data', 'analyze rows', 'export data', 'csv export'],
    sortOrder: 5,
  },
  {
    slug: 'files-router',
    name: 'Files & Documents Router',
    summary: 'Routes work on a file the user sent or wants produced to the exact specialist.',
    markdown: `# Files & Documents Router

Choose the exact approved specialist returned by this router.

- Read, extract from, summarise, or answer questions about a file → \`${READ_FILES_SKILL_SLUG}\`.
- Produce or edit a spreadsheet, document, or export → \`${CREATE_FILES_SKILL_SLUG}\`.

A file sent in this conversation is already saved in the workspace and listed
under [ATTACHED_FILES]. Loading this router is not permission to answer from a
filename — load the specialist and open the file.

Files living in Google Drive, Zoho, Airtable, or Lark are a connected-account
job, not this one.`,
    toolIds: [],
    tags: ['files', 'router', 'documents', 'spreadsheets', 'attachments'],
    aliases: [
      'file',
      'attachment',
      'document',
      'this pdf',
      'this spreadsheet',
      'read the attached file',
      'make a spreadsheet',
    ],
    sortOrder: 6,
  },
  {
    slug: 'research-router',
    name: 'Research Router',
    summary: 'Routes current web research, Semrush SEO evidence, and OMS site inventory work.',
    markdown: `# Research Router

Choose the exact approved specialist returned by this router.

- Current public facts and external verification → \`web-search\`.
- Official Semrush domain, keyword, ranking, or backlink data → \`divo-semrush-seo-research\`.
- Approved OMS publisher/site inventory → \`divo-oms-site-inventory\`.

Never substitute web results for official Semrush or OMS data.

Files the user sent are not researched here — they are already in the
workspace. Route those to \`files-router\`.`,
    toolIds: [],
    tags: ['research', 'router', 'web', 'semrush', 'seo', 'oms', 'site-inventory'],
    aliases: ['research', 'web research', 'semrush', 'seo research', 'oms sites', 'site inventory'],
    sortOrder: 7,
  },
  {
    slug: 'work-automation-router',
    name: 'Work Automation Router',
    summary: 'Routes reminders, recurring monitoring, and scheduled agent work.',
    markdown: `# Work Automation Router

Choose \`schedule-divo-work\` for one-time or recurring Divo work, reminders, monitoring, and reports.
Calendar events belong to the relevant Google or Lark calendar specialist instead.`,
    toolIds: [],
    tags: ['work', 'automation', 'router', 'schedule', 'recurring', 'reminder', 'monitoring'],
    aliases: ['schedule work', 'recurring work', 'reminder', 'monitoring', 'run every'],
    sortOrder: 8,
  },
  {
    slug: 'memory-router',
    name: 'Personal Memory Router',
    summary: 'Routes explicit requests to save durable personal memory for review.',
    markdown: `# Personal Memory Router

Choose \`share-memory\` only when the member explicitly asks to save or share durable memory.
Do not route transient task state, secrets, or unconfirmed assistant inference to memory.`,
    toolIds: [],
    tags: ['personal', 'memory', 'router', 'save', 'remember', 'review'],
    aliases: ['remember this', 'save memory', 'share memory', 'personal memory'],
    sortOrder: 9,
  },
  {
    slug: 'data-processing',
    name: 'Bounded Data Processing',
    summary: 'Transform and analyze governed datasets with deterministic calculations.',
    markdown: `# Bounded Data Processing

Use \`dataProcessor\` for exact transformations and calculations over data already present or a governed source.
Preserve exact values, keep currencies separate, and require complete source pagination before calling a result complete.
Use \`secure-data-export\` instead when the user explicitly requests a file, CSV, Google Sheet, or export artifact.
Use \`${READ_FILES_SKILL_SLUG}\` instead when the data is a file in the workspace, or when the row count is too large to hold in context — that path queries the file on disk rather than carrying rows through the model.`,
    toolIds: ['dataProcessor'],
    tags: ['data', 'processing', 'transform', 'analysis', 'csv'],
    aliases: ['process data', 'calculate rows', 'group records', 'transform dataset'],
    sortOrder: 20,
  },
  {
    slug: 'web-search',
    name: 'Web Search',
    summary: 'Search current public information, verify exact facts, and cite relevant URLs.',
    markdown: `# Web Search

Use \`webSearch\` for current public information and external verification.
Prefer primary or official sources, verify time-sensitive claims, and include relevant URLs.
Do not use public web search as a substitute for official Semrush or OMS data, or for a file the user has already sent.`,
    toolIds: ['webSearch'],
    tags: ['search', 'research', 'web', 'verification'],
    aliases: ['web search', 'internet research', 'current public information', 'verify online'],
    sortOrder: 21,
  },
] as const satisfies readonly DivoProductivitySystemSkillDefinition[];

export interface SystemSkillRouteSeed {
  readonly routerSlug: string;
  readonly targetSlugs: readonly string[];
}

export const SYSTEM_SKILL_ROUTE_SEEDS: readonly SystemSkillRouteSeed[] = [
  {
    routerSlug: 'lark-router',
    targetSlugs: LARK_SYSTEM_SKILLS.filter(skill => skill.toolIds.length > 0).map(skill => skill.slug),
  },
  {
    routerSlug: 'google-workspace-router',
    targetSlugs: [
      ...GOOGLE_WORKSPACE_SYSTEM_SKILLS.map(skill => skill.slug),
      'mail-ops',
      SCHEDULE_DIVO_WORK_SKILL_SLUG,
    ],
  },
  {
    routerSlug: 'finance-zoho-router',
    targetSlugs: ZOHO_FINANCE_SYSTEM_SKILLS
      .filter(skill => skill.toolIds.length > 0)
      .map(skill => skill.slug),
  },
  {
    routerSlug: 'airtable-router',
    targetSlugs: CONNECTED_PROVIDER_SYSTEM_SKILLS
      .filter(skill => skill.slug.startsWith('airtable-'))
      .map(skill => skill.slug),
  },
  {
    routerSlug: 'aitable-router',
    targetSlugs: CONNECTED_PROVIDER_SYSTEM_SKILLS
      .filter(skill => skill.slug.startsWith('aitable-'))
      .map(skill => skill.slug),
  },
  {
    routerSlug: 'data-router',
    targetSlugs: ['data-processing', DATA_EXPORT_SYSTEM_SKILL.slug, READ_FILES_SKILL_SLUG],
  },
  {
    routerSlug: 'files-router',
    targetSlugs: FILES_AND_DOCUMENTS_SYSTEM_SKILLS.map(skill => skill.slug),
  },
  {
    routerSlug: 'research-router',
    targetSlugs: [
      'web-search',
      DIVO_SEMRUSH_SYSTEM_SKILL.slug,
      DIVO_OMS_SITE_DATA_SYSTEM_SKILL.slug,
    ],
  },
  {
    routerSlug: 'work-automation-router',
    targetSlugs: [SCHEDULE_DIVO_WORK_SKILL_SLUG],
  },
  {
    routerSlug: 'memory-router',
    targetSlugs: [SHARE_MEMORY_SKILL_SLUG],
  },
] as const;

export const SEEDED_EXECUTABLE_SYSTEM_SKILL_SLUGS = [
  ...LARK_SYSTEM_SKILLS,
  ...GOOGLE_WORKSPACE_SYSTEM_SKILLS,
  ...CONNECTED_PROVIDER_SYSTEM_SKILLS,
  ...ZOHO_FINANCE_SYSTEM_SKILLS,
  ...MAIL_OPS_SYSTEM_SKILLS,
  DATA_EXPORT_SYSTEM_SKILL,
  DIVO_SEMRUSH_SYSTEM_SKILL,
  DIVO_OMS_SITE_DATA_SYSTEM_SKILL,
  ...ROUTING_SYSTEM_SKILLS,
]
  .filter(skill => skill.toolIds.length > 0)
  .map(skill => skill.slug)
  .concat(SCHEDULE_DIVO_WORK_SKILL_SLUG, SHARE_MEMORY_SKILL_SLUG);

type SystemSkillRouteStore = Pick<
  Prisma.TransactionClient,
  | 'skillFolder'
  | 'skill'
  | 'skillVersion'
  | 'skillRegistryRevision'
  | 'skillAccessGrant'
  | 'skillAlias'
  | 'skillRoute'
>;

export async function provisionSystemSkillRoutes(
  db: SystemSkillRouteStore,
  companyId: string,
): Promise<{ createdOrUpdated: number; missingTargets: string[] }> {
  for (const definition of ROUTING_SYSTEM_SKILLS) {
    await provisionDivoProductivitySystemSkill(db, companyId, definition);
  }

  return syncSystemSkillRoutes(db, companyId);
}

export async function syncSystemSkillRoutes(
  db: Pick<SystemSkillRouteStore, 'skill' | 'skillRoute'>,
  companyId: string,
): Promise<{ createdOrUpdated: number; missingTargets: string[] }> {
  const allSlugs = [...new Set(SYSTEM_SKILL_ROUTE_SEEDS.flatMap(
    seed => [seed.routerSlug, ...seed.targetSlugs],
  ))];
  const skills = await db.skill.findMany({
    where: {
      companyId,
      status: { not: 'archived' },
      slug: { in: allSlugs },
    },
    select: { id: true, slug: true },
  });
  const bySlug = new Map(skills.map(skill => [skill.slug, skill.id]));
  const missingTargets = new Set<string>();
  let createdOrUpdated = 0;

  for (const seed of SYSTEM_SKILL_ROUTE_SEEDS) {
    const routerSkillId = bySlug.get(seed.routerSlug);
    if (!routerSkillId) continue;
    const targets = seed.targetSlugs.flatMap((slug, sortOrder) => {
      const targetSkillId = bySlug.get(slug);
      if (!targetSkillId) {
        missingTargets.add(slug);
        return [];
      }
      return [{ targetSkillId, sortOrder }];
    });

    await db.skillRoute.deleteMany({
      where: {
        routerSkillId,
        source: 'system',
        ...(targets.length > 0
          ? { targetSkillId: { notIn: targets.map(target => target.targetSkillId) } }
          : {}),
      },
    });
    for (const target of targets) {
      const updated = await db.skillRoute.updateMany({
        where: {
          routerSkillId,
          targetSkillId: target.targetSkillId,
          source: 'system',
        },
        data: { sortOrder: target.sortOrder },
      });
      if (updated.count > 0) {
        createdOrUpdated += updated.count;
        continue;
      }
      const created = await db.skillRoute.createMany({
        data: [{
          routerSkillId,
          targetSkillId: target.targetSkillId,
          source: 'system',
          sortOrder: target.sortOrder,
        }],
        skipDuplicates: true,
      });
      createdOrUpdated += created.count;
    }
  }

  return { createdOrUpdated, missingTargets: [...missingTargets].sort() };
}

export async function provisionSystemSkillRoutesForExistingCompanies(
  db: Pick<PrismaClient, 'company'> & SystemSkillRouteStore,
): Promise<{ companies: number; createdOrUpdated: number; missingTargets: string[] }> {
  const companies = await db.company.findMany({ select: { id: true } });
  let createdOrUpdated = 0;
  const missingTargets = new Set<string>();
  for (const company of companies) {
    const result = await provisionSystemSkillRoutes(db, company.id);
    createdOrUpdated += result.createdOrUpdated;
    result.missingTargets.forEach(slug => missingTargets.add(slug));
  }
  return {
    companies: companies.length,
    createdOrUpdated,
    missingTargets: [...missingTargets].sort(),
  };
}

export function unroutedSeededSystemSkillSlugs(): string[] {
  const routed = new Set(SYSTEM_SKILL_ROUTE_SEEDS.flatMap(seed => seed.targetSlugs));
  return [...new Set(SEEDED_EXECUTABLE_SYSTEM_SKILL_SLUGS)]
    .filter(slug => !routed.has(slug))
    .sort();
}
