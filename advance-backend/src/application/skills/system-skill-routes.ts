import type { Prisma, PrismaClient } from '../../generated/prisma';
import { CONNECTED_PROVIDER_SYSTEM_SKILLS } from './connected-provider-system-skills';
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
import { MENHOOD_DATA_SYSTEM_SKILL } from './menhood-data-system-skill';
import { DIVO_OMS_SITE_DATA_SYSTEM_SKILL } from './oms-site-data-system-skill';
import {
  DIVO_LOCAL_PYTHON_SKILL_SLUG,
  DIVO_LOCAL_PYTHON_SYSTEM_SKILL,
} from './divo-local-python-system-skill';
import { DIVO_PRESENTATIONS_SYSTEM_SKILL } from './divo-presentations-system-skill';
import {
  SCHEDULE_DIVO_WORK_SKILL_MARKDOWN,
  SCHEDULE_DIVO_WORK_SKILL_SLUG,
} from './scheduled-work-system-skill';
import { DIVO_SEMRUSH_SYSTEM_SKILL } from './semrush-system-skill';
import {
  KNOWLEDGE_MANAGEMENT_SKILL_MARKDOWN,
  KNOWLEDGE_MANAGEMENT_SKILL_SLUG,
} from './knowledge-system-skill';
import { ZOHO_FINANCE_SYSTEM_SKILLS } from './zoho-finance-system-skills';

export const ROUTING_SYSTEM_SKILLS = [
  {
    slug: 'airtable-router',
    name: 'Airtable Router',
    summary: 'Routes Airtable and synced Menhood data work to the exact specialist.',
    markdown: `# Airtable Router

Choose the smallest specialist set that proves the requested result.

- Settled Menhood order, customer, product, RTO, COD, campaign, or pincode analysis that needs SQL joins, aggregates, or cohorts → \`menhood-data\`.
- Current/latest Menhood facts or Airtable-only operational semantics → \`airtable-core\` against the live Orders table. A named product may also need \`menhood-data\` once to resolve its canonical SKU before filtering Airtable.
- A complete current/live calculation or artifact → the filtered \`airtable-core\` source plus \`divo-python-automation\` and the destination specialist. Keep pages in protected files; never scan the full Orders table before trying server-side filters.
- Ordinary Airtable records, comments, and CRUD → \`airtable-core\`.
- Bases, tables, fields, schemas, and views → \`airtable-schema-ops\`.
- Interfaces, forms, and automations → \`airtable-automation-ops\`.

Menhood live/export lifecycle:

1. Route from the full Lark prompt, including any hydrated quoted message or
   card text. A bare follow-up like "excel" or "send it to sheet" inherits the
   quoted/requested Menhood context.
2. Settled historical answer in chat: load \`menhood-data\` and stop there.
3. Current/live answer: use \`menhood-data\` only to resolve a named product's
   canonical SKU when needed, then answer from filtered live Airtable.
4. Current/live export or Google Sheet: load \`airtable-core\`,
   \`divo-python-automation\`, and \`google-sheets\`. Page the filtered live
   Airtable source in one local workflow, write the governed Sheet destination,
   and read it back before saying the export is complete.
5. Do not load \`create-edit-files\` for Lark or Google Sheets delivery; local
   files are only for Jan desktop file deliverables. Never use the retired
   export tool, candidate, or offer flow.

Airtable MCP is the one live record contract for previews and protected
file-backed pages. Prefer server-side filters and selected fields. Use the
company-managed reporting source for settled SQL analysis, not as a fallback
after an avoidable full-table Airtable scan.

Airtable and AITable are different products. Never route an AITable request here.
This router is instruction-only: loading it successfully means to load one specialist above next.`,
    toolIds: [],
    tags: ['airtable', 'menhood', 'router', 'records', 'analytics', 'schema', 'automation'],
    aliases: [
      'airtable',
      'airtable records',
      'airtable bases',
      'airtable automation',
      'customer queries',
      'query status',
      'record status counts',
      'menhood',
      'company airtable sync',
      'orders',
      'customers',
      'products',
      'sales analysis',
      'rto analysis',
      'cod analysis',
      'campaign analysis',
      'pincode analysis',
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
    slug: 'shopify-router',
    name: 'Shopify Router',
    summary: 'Routes Shopify sales, order, attribution, and customer analysis to the governed commerce specialist.',
    markdown: `# Shopify Router

Choose \`shopify-commerce\` for Shopify sales analytics, product and inventory performance, payment summaries, bounded order inspection, UTM/channel attribution, and protected customer metadata when granted.

The Shopify specialist is read-only and routes every request through governed Divo tools. Store credentials, connection access, RBAC, protected-data handling, and approval policy remain backend-owned.`,
    toolIds: [],
    tags: ['shopify', 'router', 'commerce', 'sales', 'orders', 'attribution'],
    aliases: ['shopify', 'shopify sales', 'store orders', 'shopify attribution', 'shopify customers'],
    sortOrder: 10,
  },
  {
    slug: 'data-router',
    name: 'Data Work Router',
    summary: 'Routes data work between connected providers, one scripted workflow, and destination tools.',
    markdown: `# Data Work Router

Choose exactly one specialist below. Loading this router is never permission to
process or export anything.

- Bounded lookup or preview → that provider's specialist; keep the answer in chat.
- The member wants a complete file, Sheet, or cross-product transformation →
  the source specialist plus \`${DIVO_LOCAL_PYTHON_SKILL_SLUG}\`, then the
  destination specialist. Use one persistent script and reconcile source,
  written, and read-back counts. If the source exposes no complete paging
  contract, say that plainly instead of calling a bounded preview complete.
- Read or look up a value from a pasted
  \`https://docs.google.com/spreadsheets/d/...\` or
  \`https://drive.google.com/file/d/...\` URL → \`google-drive\` first, with
  \`get_drive_file_content\` and the file ID from that URL. Never answer a pasted link from an
  earlier provider query.
- Edit as a native Sheet, add columns, or convert an Excel workbook to a Google
  Sheet from such a URL → \`google-sheets\`. Resolve the reference first: a URL
  alone proves only access, so ask what the member wants done next, and never
  request a download URL or import the workbook directly.
- Read or analyse a file already in the workspace → \`${READ_FILES_SKILL_SLUG}\`.

An opaque artifact handle belongs to one route and is never turned into
provider credentials or invented source IDs:

- \`destinationReferenceId\` for a **google_sheet** →
  \`google-sheets\`.

Examples, kept because each one is a boundary the bullets alone decide slowly:

- “Show me our best keywords” → research specialist, answer in chat.
- “Put the complete keyword result in a Sheet” → source paging in one local
  script, then \`google-sheets\`, with exact read-back evidence.
- “Combine invoices with Airtable owners and calculate totals” → the provider
  specialists plus \`${DIVO_LOCAL_PYTHON_SKILL_SLUG}\`, not an export.
- “Add a Notes column to that Sheet” after resolving its link → \`google-sheets\`
  with the same-run opaque destination reference and a read-back check.`,
    toolIds: [],
    tags: ['data', 'router', 'processing', 'analysis', 'export', 'python'],
    aliases: [
      'data processing', 'calculate data', 'analyze rows', 'export data', 'csv export',
      'move data', 'transfer records', 'sync between tools', 'python workflow',
      'excel workbook url', 'drive.google.com/file', 'convert excel to google sheet',
      'read spreadsheet link', 'check row in export',
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
- Build a slide deck or presentation → \`${DIVO_PRESENTATIONS_SYSTEM_SKILL.slug}\`.

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
- Official Semrush domain, keyword, ranking, or backlink data → \`divo-semrush-seo-research\`, which owns how many calls that takes and how bounded the answer is.
- Approved OMS publisher/site inventory → \`divo-oms-site-inventory\`.

Never substitute web search results for configured Semrush or OMS data.

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
Do not use public web search as a substitute for configured Semrush or OMS data, or for a file the user has already sent.`,
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
    targetSlugs: [
      MENHOOD_DATA_SYSTEM_SKILL.slug,
      DIVO_LOCAL_PYTHON_SKILL_SLUG,
      ...CONNECTED_PROVIDER_SYSTEM_SKILLS
        .filter(skill => skill.slug.startsWith('airtable-'))
        .map(skill => skill.slug),
    ],
  },
  {
    routerSlug: 'aitable-router',
    targetSlugs: CONNECTED_PROVIDER_SYSTEM_SKILLS
      .filter(skill => skill.slug.startsWith('aitable-'))
      .map(skill => skill.slug),
  },
  {
    routerSlug: 'shopify-router',
    targetSlugs: CONNECTED_PROVIDER_SYSTEM_SKILLS
      .filter(skill => skill.slug.startsWith('shopify-'))
      .map(skill => skill.slug),
  },
  {
    routerSlug: 'data-router',
    targetSlugs: [
      DIVO_LOCAL_PYTHON_SKILL_SLUG,
      'google-drive',
      'google-sheets',
      READ_FILES_SKILL_SLUG,
    ],
  },
  {
    routerSlug: 'files-router',
    targetSlugs: [
      ...FILES_AND_DOCUMENTS_SYSTEM_SKILLS.map(skill => skill.slug),
      /*
       * Provisioned for every company since it was written, listed in the
       * registry, and reachable by no router — a deck is a file the member
       * asked Divo to author, so it belongs behind the same router as every
       * other authored artifact.
       */
      DIVO_PRESENTATIONS_SYSTEM_SKILL.slug,
    ],
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
 * Every seeded skill a router could reach, tools or not, as slug plus the exact
 * body that ships to the model.
 *
 * One list, because two lists drift. `unroutedSeededSystemSkillSlugs` reads it,
 * and so does the guard that no skill teaches a removed call surface — which
 * was a separate hand-written array until four families turned out to be
 * missing from it, including the scheduler that kept a dead gateway protocol
 * through an entire sweep. A definition absent from here is exempt from both
 * checks at once, which is the only way it should ever be exempt from either.
 */
export const SEEDED_SYSTEM_SKILLS: readonly { slug: string; markdown: string }[] = [
  ...LARK_SYSTEM_SKILLS,
  ...GOOGLE_WORKSPACE_SYSTEM_SKILLS,
  ...CONNECTED_PROVIDER_SYSTEM_SKILLS,
  ...ZOHO_FINANCE_SYSTEM_SKILLS,
  ...MAIL_OPS_SYSTEM_SKILLS,
  ...FILES_AND_DOCUMENTS_SYSTEM_SKILLS,
  /*
   * Absent from this list, `unroutedSeededSystemSkillSlugs` returned [] while
   * `divo-presentations` sat unrouted — the guard was not passing, it could
   * not see the skill.
   */
  DIVO_PRESENTATIONS_SYSTEM_SKILL,
  DIVO_SEMRUSH_SYSTEM_SKILL,
  DIVO_OMS_SITE_DATA_SYSTEM_SKILL,
  MENHOOD_DATA_SYSTEM_SKILL,
  ...ROUTING_SYSTEM_SKILLS,
]
  .map(skill => ({ slug: skill.slug, markdown: skill.markdown }))
  .concat(
    { slug: SCHEDULE_DIVO_WORK_SKILL_SLUG, markdown: SCHEDULE_DIVO_WORK_SKILL_MARKDOWN },
    { slug: KNOWLEDGE_MANAGEMENT_SKILL_SLUG, markdown: KNOWLEDGE_MANAGEMENT_SKILL_MARKDOWN },
    { slug: DIVO_LOCAL_PYTHON_SKILL_SLUG, markdown: DIVO_LOCAL_PYTHON_SYSTEM_SKILL.markdown },
  );

export const ROUTABLE_SEEDED_SYSTEM_SKILL_SLUGS = SEEDED_SYSTEM_SKILLS.map(skill => skill.slug);

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
