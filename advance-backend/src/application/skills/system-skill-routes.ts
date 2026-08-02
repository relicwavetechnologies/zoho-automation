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
import { DIVO_LOCAL_PYTHON_SKILL_SLUG } from './divo-local-python-system-skill';
import { SCHEDULE_DIVO_WORK_SKILL_SLUG } from './scheduled-work-system-skill';
import { DIVO_SEMRUSH_SYSTEM_SKILL } from './semrush-system-skill';
import { KNOWLEDGE_MANAGEMENT_SKILL_SLUG } from './knowledge-system-skill';
import { ZOHO_FINANCE_SYSTEM_SKILLS } from './zoho-finance-system-skills';

export const ROUTING_SYSTEM_SKILLS = [
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
    summary: 'Routes data work between a scripted workflow, a governed export, and reading a file already in the workspace.',
    markdown: `# Data Work Router

Choose the exact approved specialist returned by this router.

- One bounded provider lookup or preview → load that provider's specialist.
  If its result contains \`preview.exportOfferId\`, keep only that opaque offer
  and wait for the member to choose an export; never paginate or copy rows
  through the conversation.
- Produce a CSV, Excel file, Google Sheet, or governed complete-data artifact
  after an explicit offer choice → \`secure-data-export\`. Its direct recipes
  are only for the supported Airtable and Zoho Books sources with exact
  backend-resolved identifiers.
- Fetch across pages to calculate, group, join, reshape, or move data between
  connected products → \`${DIVO_LOCAL_PYTHON_SKILL_SLUG}\`. Write one script,
  run it, edit and rerun it.
- An exact pasted \`https://docs.google.com/spreadsheets/d/...\` URL →
  \`google-sheets\` before any generic web search. Resolve the reference first;
  a URL alone proves only metadata/access, so ask what the member wants to do
  next. Never claim existing-Sheet bulk write, append, or import is available.
- Read or analyse a file that is already in the workspace → \`${READ_FILES_SKILL_SLUG}\`.

Use the provider preview and governed export path for one source's complete
dataset. Use the scripted workflow only when the work needs pagination for a
calculation or transform, more than one connected product, or related writes.
Neither route carries a record set through the conversation.

Never treat this router as permission to process or export data. Load the specialist first.`,
    toolIds: [],
    tags: ['data', 'router', 'processing', 'analysis', 'export', 'python'],
    aliases: [
      'data processing', 'calculate data', 'analyze rows', 'export data', 'csv export',
      'move data', 'transfer records', 'sync between tools', 'python workflow',
    ],
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
- Official Semrush domain, keyword, ranking, or backlink data → \`divo-semrush-seo-research\`. Its bounded preview may return an opaque \`preview.exportOfferId\`; preserve it and route one explicit export choice through \`data-router\`, never through provider pagination or a local workflow.
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
    name: 'Knowledge Router',
    summary: 'Routes durable memory, taught procedures, and governed files through the correct review path.',
    markdown: `# Knowledge Router

Choose \`share-memory\` for durable personal or shared memory, a reusable procedure the member has finished teaching, or a file they want retained for later use.
Natural language is enough; the member does not need to know Divo's internal resource or approval terms.
Do not route transient task state, secrets, unfinished teaching, one-off work, or unconfirmed assistant inference into durable knowledge.`,
    toolIds: [],
    tags: ['knowledge', 'personal', 'memory', 'procedure', 'file', 'router', 'save', 'remember', 'shared', 'review'],
    aliases: ['remember this', 'save memory', 'share memory', 'personal memory', 'teach divo', 'save procedure', 'keep this file'],
    sortOrder: 9,
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
    targetSlugs: [
      DIVO_LOCAL_PYTHON_SKILL_SLUG,
      DATA_EXPORT_SYSTEM_SKILL.slug,
      'google-sheets',
      READ_FILES_SKILL_SLUG,
    ],
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
    targetSlugs: [KNOWLEDGE_MANAGEMENT_SKILL_SLUG],
  },
] as const;

/**
 * Every seeded skill a router could reach, tools or not. `unroutedSeededSystemSkillSlugs`
 * checks against this rather than the tool-bearing subset.
 */
export const ROUTABLE_SEEDED_SYSTEM_SKILL_SLUGS = [
  ...LARK_SYSTEM_SKILLS,
  ...GOOGLE_WORKSPACE_SYSTEM_SKILLS,
  ...CONNECTED_PROVIDER_SYSTEM_SKILLS,
  ...ZOHO_FINANCE_SYSTEM_SKILLS,
  ...MAIL_OPS_SYSTEM_SKILLS,
  ...FILES_AND_DOCUMENTS_SYSTEM_SKILLS,
  DATA_EXPORT_SYSTEM_SKILL,
  DIVO_SEMRUSH_SYSTEM_SKILL,
  DIVO_OMS_SITE_DATA_SYSTEM_SKILL,
  ...ROUTING_SYSTEM_SKILLS,
]
  .map(skill => skill.slug)
  .concat(
    SCHEDULE_DIVO_WORK_SKILL_SLUG,
    KNOWLEDGE_MANAGEMENT_SKILL_SLUG,
    DIVO_LOCAL_PYTHON_SKILL_SLUG,
  );

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

/**
 * Seeded skills that no router points at.
 *
 * Deliberately not limited to skills that carry tools. An instruction-only
 * recipe is exactly the kind that goes unnoticed: it provisions cleanly, shows
 * up in the registry, and is still unreachable router-first. That is how
 * `divo-python-automation` — the scripted-workflow path — sat unrouted.
 */
export function unroutedSeededSystemSkillSlugs(): string[] {
  const routed = new Set(SYSTEM_SKILL_ROUTE_SEEDS.flatMap(seed => seed.targetSlugs));
  const routers = new Set(SYSTEM_SKILL_ROUTE_SEEDS.map(seed => seed.routerSlug));
  return [...new Set(ROUTABLE_SEEDED_SYSTEM_SKILL_SLUGS)]
    .filter(slug => !routed.has(slug) && !routers.has(slug))
    .sort();
}
