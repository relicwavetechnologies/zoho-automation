import type { Prisma, PrismaClient } from '../../generated/prisma';
import {
  provisionDivoProductivitySkillForExistingCompanies,
  provisionDivoProductivitySystemSkill,
  type DivoProductivitySystemSkillDefinition,
} from './divo-productivity-system-skills';

export const DIVO_SEMRUSH_SKILL_SLUG = 'divo-semrush-seo-research';

export const DIVO_SEMRUSH_SYSTEM_SKILL: DivoProductivitySystemSkillDefinition = {
  slug: DIVO_SEMRUSH_SKILL_SLUG,
  name: 'Divo Semrush SEO Research',
  summary: 'Run Semrush domain and organic-search research through backend-configured official API operations.',
  markdown: `# Divo Semrush SEO Research

Use this skill for read-only Semrush SEO research available through Divo's backend-configured capability.

## Operating rules

1. Resolve this skill before any Semrush research. Use the returned Semrush tool recipe exactly; do not call Semrush, browser automation, curl, or a local API key directly.
2. Use only documented operation arguments. Never invent endpoint paths, report names, headers, cookies, credentials, export columns, or raw provider filters.
3. Preflight the exact proposed call before invoking it. Preflight verifies backend configuration and operation support; it does not retrieve data.
4. Treat result states precisely:
   - \`complete\`: the returned official data covered this request.
   - \`empty\`: the request was valid but Semrush had no matching coverage.
   - \`partial\`: Semrush has another available page. State that limitation and use the next-page value if more data is needed.
   - \`blocked\` or an invocation error: explain whether configuration, permission, unsupported capability, or provider availability prevented the lookup. Never invent the missing data.
5. Summarize evidence in chat. If Divo returns a temporary CSV artifact, identify it as a temporary export and do not reproduce hundreds of rows in chat.

## Currently supported official operations

- \`domain_overview\`: one bare domain and a supported country database.
- \`organic_positions\`: one bare domain, supported database, and bounded pagination.

Other named SEO functions return an unavailable result until Divo has a verified official Semrush API contract for them. Do not silently substitute a different Semrush report for the requested one.`,
  toolIds: ['semrush'],
  tags: ['divo', 'seo', 'semrush', 'organic', 'rankings', 'domain'],
  aliases: ['semrush', 'seo research', 'organic rankings', 'domain overview'],
  sortOrder: 22,
};

export async function provisionDivoSemrushSystemSkill(
  db: Pick<Prisma.TransactionClient, 'skillFolder' | 'skill' | 'skillVersion' | 'skillRegistryRevision' | 'skillAccessGrant' | 'skillAlias'>,
  companyId: string,
) {
  return provisionDivoProductivitySystemSkill(db, companyId, DIVO_SEMRUSH_SYSTEM_SKILL);
}

export async function provisionDivoSemrushForExistingCompanies(
  db: Pick<PrismaClient, 'company' | 'skillFolder' | 'skill' | 'skillVersion' | 'skillRegistryRevision' | 'skillAccessGrant' | 'skillAlias'>,
) {
  return provisionDivoProductivitySkillForExistingCompanies(db, DIVO_SEMRUSH_SYSTEM_SKILL);
}
