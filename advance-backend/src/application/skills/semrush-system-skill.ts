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
  summary: 'Run Semrush domain and organic-search research through backend-configured Semrush operations.',
  markdown: `# Divo Semrush SEO Research

Use this skill for read-only Semrush SEO research available through Divo's backend-configured capability. The backend may use official Semrush APIs or a backend-owned Semrush web session; the model never receives endpoint credentials, cookies, API keys, or raw provider headers.

## Operating rules

1. Resolve this skill before any Semrush research. Use the returned Semrush tool recipe exactly; do not call Semrush, browser automation, curl, or a local API key directly.
2. Use only documented operation arguments. Never invent endpoint paths, report names, headers, cookies, credentials, export columns, or raw provider filters.
3. Preflight the exact proposed call before invoking it. Preflight verifies backend configuration and operation support; it does not retrieve data.
4. Treat result states precisely:
   - \`complete\`: the returned Semrush data covered this request.
   - \`empty\`: the request was valid but Semrush had no matching coverage.
   - \`partial\`: Semrush has another available page. State that limitation for the chat preview.
   - \`blocked\` or an invocation error: explain whether configuration, permission, unsupported capability, or provider availability prevented the lookup. Never invent the missing data.
5. Summarize useful evidence in chat; the structured preview contains at most 25 rows. When \`exportCandidate\` is present and the member asks for Sheet, Excel, CSV, all rows, or a full export, call \`dataExport\` with \`op=plan\` using that candidate instead of reproducing rows. If the member did not ask for a file but the result is a useful table, ranking, gap, or comparison with \`exportCandidate\`, end with one soft follow-up asking whether to export it to Google Sheets, Excel, or CSV, unless the member explicitly said not to export, not now, or chat-only. Do not manually follow \`nextPage\`, create or upload a CSV/XLSX/Sheet, run Python or a local workflow, or rerun the provider query after the member chooses a format. The central governed export owns provider pagination, sample/full decisions, destination access, and artifact creation. It retrieves current Semrush data, so describe it as a current export rather than an immutable copy of the preview.

## Supported backend operations

- \`domain_overview\`: one bare domain and a supported country database. A single snapshot row.
- \`organic_positions\`: which keywords a domain ranks for right now, with bounded pagination.
- \`organic_position_trend\`: monthly authority and traffic history, newest first. This answers "is it growing", not "where does it rank today".
- \`keyword_research\`: volume, CPC, competition and 12-month trend for up to 25 keywords in one request.
- \`domain_comparison\`: keywords two to five domains share, each domain's position in its own column.
- \`keyword_gap\`: what competitors rank for and you do not. **The first target is the domain you own** and is excluded from the result; the rest are the competitors. Reversing that order silently answers the opposite question, so confirm which domain is the user's before calling it.
- \`backlinks_comparison\`: authority score, total backlinks and referring domains per target.

## Cost and honesty rules for these operations

1. \`backlinks_comparison\` costs one billed Semrush request per target. Compare the domains the user actually named; do not pad the list to be thorough.
2. \`keyword_research\` silently omits keywords Semrush has no data for. Compare \`coverage.requestedKeywords\` with \`coverage.returnedKeywords\` and name the missing keywords as "no Semrush data" rather than "zero volume".
3. A comparison of domains that share no keywords returns \`empty\`. That is a real answer — report it as no overlap, not as a Semrush failure.
4. Never substitute one report for another. If the user asked for a gap and only a comparison is appropriate, say so rather than quietly returning the overlap.`,
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
