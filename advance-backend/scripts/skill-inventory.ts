/**
 * Read-only inventory of every seeded system skill.
 *
 * Touches no database and provisions nothing: it reads the definitions
 * themselves, which is the point — a rewrite wave needs to know the size and
 * routing of what it is about to change before it changes it, and reading the
 * DB would only report the last reconciliation rather than the source.
 *
 * Enumerated dynamically so a family added later cannot quietly stay out of
 * the count, which is how `divo-presentations` came to be provisioned for
 * every company while no router pointed at it.
 *
 * Usage: pnpm skills:inventory
 */
import { CONNECTED_PROVIDER_SYSTEM_SKILLS } from '../src/application/skills/connected-provider-system-skills';
import { DATA_EXPORT_SYSTEM_SKILL } from '../src/application/skills/data-export-system-skill';
import { DIVO_LOCAL_PYTHON_SYSTEM_SKILL } from '../src/application/skills/divo-local-python-system-skill';
import { DIVO_PRESENTATIONS_SYSTEM_SKILL } from '../src/application/skills/divo-presentations-system-skill';
import { FILES_AND_DOCUMENTS_SYSTEM_SKILLS } from '../src/application/skills/files-and-documents-system-skills';
import { GOOGLE_WORKSPACE_SYSTEM_SKILLS } from '../src/application/skills/google-workspace-system-skills';
import {
  KNOWLEDGE_MANAGEMENT_SKILL_MARKDOWN,
  KNOWLEDGE_MANAGEMENT_SKILL_SLUG,
} from '../src/application/skills/knowledge-system-skill';
import { LARK_SYSTEM_SKILLS } from '../src/application/skills/lark-system-skills';
import { MAIL_OPS_SYSTEM_SKILLS } from '../src/application/skills/mail-ops-system-skills';
import { MENHOOD_DATA_SYSTEM_SKILL } from '../src/application/skills/menhood-data-system-skill';
import { DIVO_OMS_SITE_DATA_SYSTEM_SKILL } from '../src/application/skills/oms-site-data-system-skill';
import {
  SCHEDULE_DIVO_WORK_SKILL_ALIASES,
  SCHEDULE_DIVO_WORK_SKILL_MARKDOWN,
  SCHEDULE_DIVO_WORK_SKILL_SLUG,
} from '../src/application/skills/scheduled-work-system-skill';
import { DIVO_SEMRUSH_SYSTEM_SKILL } from '../src/application/skills/semrush-system-skill';
import {
  ROUTING_SYSTEM_SKILLS,
  SYSTEM_SKILL_ROUTE_SEEDS,
} from '../src/application/skills/system-skill-routes';
import { ZOHO_FINANCE_SYSTEM_SKILLS } from '../src/application/skills/zoho-finance-system-skills';

interface InventoryRow {
  readonly slug: string;
  readonly markdown: string;
  readonly toolIds: readonly string[];
  readonly aliases?: readonly string[];
  readonly family: string;
}

type SkillLike = Omit<InventoryRow, 'family'>;

const withFamily = (family: string, skills: readonly SkillLike[]): InventoryRow[] =>
  skills.map(skill => ({ ...skill, family }));

const rows: InventoryRow[] = [
  ...withFamily('routing', ROUTING_SYSTEM_SKILLS),
  ...withFamily('google', GOOGLE_WORKSPACE_SYSTEM_SKILLS),
  ...withFamily('lark', LARK_SYSTEM_SKILLS),
  ...withFamily('zoho', ZOHO_FINANCE_SYSTEM_SKILLS),
  ...withFamily('provider', CONNECTED_PROVIDER_SYSTEM_SKILLS),
  ...withFamily('mail', MAIL_OPS_SYSTEM_SKILLS),
  ...withFamily('files', FILES_AND_DOCUMENTS_SYSTEM_SKILLS),
  ...withFamily('data', [DATA_EXPORT_SYSTEM_SKILL, MENHOOD_DATA_SYSTEM_SKILL]),
  ...withFamily('research', [DIVO_SEMRUSH_SYSTEM_SKILL, DIVO_OMS_SITE_DATA_SYSTEM_SKILL]),
  ...withFamily('productivity', [DIVO_LOCAL_PYTHON_SYSTEM_SKILL, DIVO_PRESENTATIONS_SYSTEM_SKILL]),
  /*
   * These two are assembled at provision time rather than exported as a
   * definition object, so the markdown constant is read directly. Omitting
   * them would understate the catalogue by two of its larger bodies.
   */
  {
    family: 'productivity',
    slug: SCHEDULE_DIVO_WORK_SKILL_SLUG,
    markdown: SCHEDULE_DIVO_WORK_SKILL_MARKDOWN,
    toolIds: [],
    aliases: SCHEDULE_DIVO_WORK_SKILL_ALIASES,
  },
  {
    family: 'memory',
    slug: KNOWLEDGE_MANAGEMENT_SKILL_SLUG,
    markdown: KNOWLEDGE_MANAGEMENT_SKILL_MARKDOWN,
    toolIds: [],
    aliases: [],
  },
];

const routersByTarget = new Map<string, string[]>();
for (const seed of SYSTEM_SKILL_ROUTE_SEEDS) {
  for (const target of seed.targetSlugs) {
    routersByTarget.set(target, [...(routersByTarget.get(target) ?? []), seed.routerSlug]);
  }
}
const routerSlugs = new Set(SYSTEM_SKILL_ROUTE_SEEDS.map(seed => seed.routerSlug));

console.log('| slug | family | bytes | ~tok | tools | aliases | routed by |');
console.log('| --- | --- | ---: | ---: | ---: | ---: | --- |');

let totalBytes = 0;
const unrouted: string[] = [];
for (const row of [...rows].sort((a, b) => b.markdown.length - a.markdown.length)) {
  totalBytes += row.markdown.length;
  const routers = routersByTarget.get(row.slug) ?? [];
  if (routers.length === 0 && !routerSlugs.has(row.slug)) unrouted.push(row.slug);
  const routedBy = routers.length > 0
    ? routers.join(', ')
    : routerSlugs.has(row.slug) ? '(is a router)' : '**UNROUTED**';
  console.log(
    `| ${row.slug} | ${row.family} | ${row.markdown.length} | `
    + `${Math.round(row.markdown.length / 4)} | ${row.toolIds.length} | `
    + `${row.aliases?.length ?? 0} | ${routedBy} |`,
  );
}

console.log(
  `\n${rows.length} skills, ${totalBytes.toLocaleString('en-IN')} bytes, `
  + `~${Math.round(totalBytes / 4).toLocaleString('en-IN')} tokens.`,
);

const duplicates = rows.map(row => row.slug).filter((slug, i, all) => all.indexOf(slug) !== i);
if (duplicates.length > 0) console.log(`duplicate slugs: ${duplicates.join(', ')}`);
if (unrouted.length > 0) console.log(`unrouted: ${unrouted.join(', ')}`);

console.log('\nrouters and their targets');
for (const seed of SYSTEM_SKILL_ROUTE_SEEDS) {
  console.log(`- ${seed.routerSlug} (${seed.targetSlugs.length}): ${seed.targetSlugs.join(', ')}`);
}
