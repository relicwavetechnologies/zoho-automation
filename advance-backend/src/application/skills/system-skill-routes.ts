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
import { MENHOOD_DATA_SYSTEM_SKILL } from './menhood-data-system-skill';
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
    summary: 'Routes Airtable and synced Menhood data work to the exact specialist.',
    markdown: `# Airtable Router

Choose the exact approved specialist returned by this router.

- Settled Menhood order, customer, product, RTO, COD, campaign, or pincode analysis that needs joins, aggregates, cohorts, broad filtering, or bulk analysis → \`menhood-data\`. This company-managed reporting source needs no Airtable connection ID and does not use local Python.
- Current/latest Menhood order counts, the current or previous month before reporting maturity, or questions that depend on Airtable-only view fields such as \`Order Status (Team)\`, \`Order Sub Status\`, Duplicate/TEST/Testing cleanup, or Regular Order filtering → \`airtable-core\` against the live Airtable Orders table. Route there immediately; do not first sample the reporting DB and do not ask whether to check Airtable. Use this for exact live reconciliation, not broad historical analysis.
- Ordinary Airtable records, comments, and CRUD → \`airtable-core\`.
- Bases, tables, fields, schemas, and views → \`airtable-schema-ops\`.
- Interfaces, forms, and automations → \`airtable-automation-ops\`.

Airtable MCP is for ordinary record work, schema work, discovery, and bounded
preview. Do not route broad historical analytics or full exports through
Airtable MCP pagination; use the company-managed Menhood data source when the
request is about settled synced Menhood data. Use live Airtable only for narrow
current/recent Menhood counts or Airtable-view semantics, and say plainly when a
bounded preview is not enough to prove a total. Otherwise ask for a bounded
preview or a backend replayable export source.

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
    summary: 'Routes data work between a scripted workflow, a governed export, and reading a file already in the workspace.',
    markdown: `# Data Work Router

Choose the exact approved specialist returned by this router.

- One bounded provider lookup or preview → load that provider's specialist.
  If its result contains \`exportCandidate\`, keep only that opaque candidate.
  If the member asks for Sheet/CSV/XLSX/all/full/export, call \`dataExport\`
  with \`op=plan\`; never rerun the provider query or create a local file.
  If the member did not ask for a file but the answer is a useful table,
  ranking, report, or diagnostic with \`exportCandidate\`, the specialist may
  ask one soft follow-up about exporting to Google Sheets, Excel, or CSV,
  unless the member explicitly said not to export, not now, or chat-only.
- Produce a governed complete-data artifact without a provider candidate →
  \`secure-data-export\`. Its direct recipes are only for backend-replayable
  sources with exact backend-resolved identifiers. Airtable MCP pagination is
  not a full-export source.
- Fetch across pages to calculate, group, join, reshape, or move data between
  connected products → \`${DIVO_LOCAL_PYTHON_SKILL_SLUG}\`. Write one script,
  run it, edit and rerun it.
- Read, inspect, or look up a row or value from an exact pasted
  \`https://docs.google.com/spreadsheets/d/...\` URL or
  \`https://drive.google.com/file/d/...\` URL → \`google-drive\` first. Use
  \`get_drive_file_content\` with the file ID from the URL or from
  \`RECENT DIVO EXPORTS\` \`artifactUrl\`. Never answer from an earlier
  provider query when the member references that link.
- Edit as a native Sheet, add columns, or convert an Excel workbook to Google
  Sheet from a pasted \`spreadsheets/d/...\` or \`drive.google.com/file/d/...\`
  URL → \`google-sheets\`. Resolve the reference first. A Sheet URL alone proves
  only metadata/access, so ask what the member wants to do next. A resolved Excel
  workbook prepares the Lark confirmation for a new Google Sheet copy; never
  request a download URL or import it directly.
- Read or analyse a file that is already in the workspace → \`${READ_FILES_SKILL_SLUG}\`.

Use the provider preview and governed export path for one source's complete
dataset. Use the scripted workflow only when the work needs pagination for a
calculation or transform, more than one connected product, or related writes.
Neither route carries a record set through the conversation.

Keep each opaque handle in its owning route:

- legacy \`preview.exportOfferId\` → Divo's verified Lark final-response card, then
  \`dataExport\` \`op=confirm\` for an explicit later natural-language format;
- \`exportCandidate\` → \`dataExport\` \`op=plan\`, then \`op=sample\` and
  \`op=confirm_sample\` if the backend requires review before the full run;
  never rebuild the provider request.
- \`destinationReferenceId\` or \`resourceRef\` for a **google_sheet** →
  \`google-sheets\` for the exact resolved or recent Sheet.
- \`RECENT DIVO EXPORTS\` **xlsx** or **csv** read/inspect → \`google-drive\`
  with \`get_drive_file_content\` and the file ID from \`artifactUrl\`.
- \`exportJobId\` → status and safe retry/resume only.

Never turn one of these handles into provider IDs, source rows, or Python input.

Examples:

- “Show me our best keywords” → research specialist and bounded preview.
- “Put the complete keyword result in a Sheet” → use the provider
  \`exportCandidate\` with \`dataExport op=plan\`.
- “Combine invoices with Airtable owners and calculate totals” → relevant
  provider specialists plus \`${DIVO_LOCAL_PYTHON_SKILL_SLUG}\`.
- A pasted spreadsheet or Drive file URL to **read or inspect** → \`google-drive\`
  and \`get_drive_file_content\`.
- A Sheet URL by itself with no read intent yet → \`google-sheets\`, resolve
  metadata, then ask what the member wants to do.
- “Add a Notes column to that Sheet” after a Divo export → \`google-sheets\`
  with its recent opaque resource reference and read-back verification.
- No eligible Google destination → let \`dataExport\` ask for an eligible
  account or Google connection; never choose an account yourself.

Never treat this router as permission to process or export data. Load the specialist first.`,
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
- Official Semrush domain, keyword, ranking, or backlink data → \`divo-semrush-seo-research\`. Prefer one main Semrush call and one main table (for example one \`backlinks_comparison\` for multi-domain ranking). Its bounded preview may return an \`exportCandidate\`; if the member asks for a file, use \`dataExport\` \`op=list_candidates\` when needed, then \`op=plan\` for the table you showed — never rerun the provider query, paginate in Pi, or use a local workflow.
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
      DATA_EXPORT_SYSTEM_SKILL.slug,
      'google-drive',
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
  MENHOOD_DATA_SYSTEM_SKILL,
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
