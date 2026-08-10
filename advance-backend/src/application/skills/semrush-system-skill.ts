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
  summary: 'Run Semrush domain and organic-search research through backend-configured Semrush web operations.',
  markdown: `# Divo Semrush SEO Research

Use this skill for read-only Semrush SEO research available through Divo's backend-configured capability. The backend uses a backend-owned Semrush web session (\`www.semrush.com\` only — never \`api.semrush.com\`); the model never receives endpoint credentials, cookies, API keys, or raw provider headers.

## Backend environment (ops only — never expose to members)

- \`SEMRUSH_WEB_API_KEY\` — the only credential the wired operations use
- \`SEMRUSH_WEB_COOKIE\` — optional; read by no wired operation
- \`SEMRUSH_TIMEOUT_MS\` (default 15000 ms)

## Senior curl mapping

| # | Senior curl | Divo operation | Status |
| --- | --- | --- | --- |
| 1 | \`POST /backlinks/webapi2/\` · \`type=backlinks_comparison\` | \`backlinks_comparison\` | Callable |
| 2 | \`GET /analytics/backlinks/webapi2\` · \`action=export\` · \`type=backlinks\` | — | **Excluded** — live probe \`403 ERROR 130 API DISABLED\`; do not call or implement |
| 3 | \`POST /dpa/rpc\` · \`ranks.Ranks\` · \`organic.overview\` | \`domain_overview\` | Callable |
| 4 | \`POST /dpa/rpc\` · \`organic.KeywordPositionTrend\` · \`organic.positions\` | \`keyword_position_trend\` | Callable |

Only the three **Callable** operations below may be invoked through the \`semrush\` tool.

## Operating rules

1. Resolve this skill before any Semrush research. Use the returned Semrush tool recipe exactly; do not call Semrush, browser automation, curl, or a local API key directly.
2. Use only documented operation arguments. Never invent endpoint paths, report names, headers, cookies, credentials, export columns, or raw provider filters.
3. Preflight the exact proposed call before invoking it. Preflight verifies backend configuration and operation support; it does not retrieve data.
4. Treat result states precisely:
   - \`complete\`: the returned Semrush data covered this request.
   - \`empty\`: the request was valid but Semrush had no matching coverage.
   - \`partial\`: Semrush has another available page. State that limitation for the chat preview.
   - \`blocked\` or an invocation error: explain whether configuration, permission, unsupported capability, or provider availability prevented the lookup. Never invent the missing data.
5. Summarize useful evidence in chat; the structured preview contains at most 25 rows. Present **one main table** when one operation is enough. Treat a continuation as incomplete coverage and never pull bulk rows through model context.

## Shy answering (default)

- Multi-domain ranking, authority comparison, or backlinks comparison → **one** \`backlinks_comparison\` with all domains the member named (up to the operation limit). Do not also call \`domain_overview\` per domain unless the member asked for overview-specific fields such as organic keywords, traffic, or rank snapshot.
- Show one main table in chat. You may offer one follow-up: "Want domain overview detail for any of these?"
- Add extra Semrush calls only after explicit member follow-up in the same thread.

## Supported backend operations (3 callable)

- \`domain_overview\`: one bare domain. Semrush answers with **one row per country database** it holds that domain in, so a single call already covers "global and country-wise traffic". \`database\` chooses which country leads the table; the rest follow by organic traffic. For a one-country question, read the first row and say so — do not call the operation again per country.
  **The returned rows are the entire world this answer knows about.** Prefer not to name a country Semrush did not return; if you do name one as an example, the same sentence must say that this is Semrush having no record, **not** the domain having no presence. Never write that an unreturned country is unindexed, has zero traffic, or has no visibility — Semrush did not measure it, and a member cannot tell an inference apart from a finding.
- \`backlinks_comparison\`: authority score, total backlinks and referring domains per target (1–10 domains in one request).
- \`keyword_position_trend\`: one domain and one keyword, returned as a **dated series** of positions around the date you pass — not one row. Use it for "where did this keyword rank" and for how that rank moved over the returned window. Not for full keyword lists.
- \`database\` is a two-letter Semrush country code and defaults to \`in\`. There is no fixed list to choose from: the databases a domain actually has are the \`Database\` column of a \`domain_overview\` for that domain, so run that first when the member names a country you have not seen for this domain. If Semrush does not recognise a code it says so, and that answer is reported rather than guessed around.

## Cost and honesty rules for these operations

1. \`backlinks_comparison\` is **one web request** for all listed targets (1–10). Compare the domains the user actually named; do not pad the list or fan out \`domain_overview\` per target to be thorough.
2. If Semrush has no backlink overview for a requested target, \`coverage.missingTargets\` and the export name it as no provider data rather than zero.
3. \`domain_overview\` returns a row per country Semrush holds the domain in, and nothing at all about the countries it does not. A country missing from that list is one Semrush has no record for — **not** a measured zero, and not evidence of no presence. Never write that an absent country is unindexed, has zero traffic, or has no visibility, and never count how many markets the domain is missing from. If you name one as an example, say in the same sentence that Semrush has no record of it. Report the countries that came back, say how many there were, and say plainly that Semrush returned no data for anywhere else. A row present with \`Organic Traffic\` 0 is different: that is measured, and can be described as ranking without earning clicks.
4. Counts must come from the rows, not from memory. If you say how many countries had zero traffic, that number is the count of returned rows whose \`Organic Traffic\` is 0 — check it against the rows before writing it.
5. Never substitute one report for another. If the user asked for something outside these three operations (including senior curl #2 backlink export), say it is not available through Divo Semrush yet.`,
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
