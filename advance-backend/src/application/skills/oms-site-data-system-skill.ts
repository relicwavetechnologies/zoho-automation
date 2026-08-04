import type { Prisma, PrismaClient } from '../../generated/prisma';
import {
  provisionDivoProductivitySkillForExistingCompanies,
  provisionDivoProductivitySystemSkill,
  type DivoProductivitySystemSkillDefinition,
} from './divo-productivity-system-skills';

export const DIVO_OMS_SITE_DATA_SKILL_SLUG = 'divo-oms-site-inventory';

export const DIVO_OMS_SITE_DATA_SYSTEM_SKILL: DivoProductivitySystemSkillDefinition = {
  slug: DIVO_OMS_SITE_DATA_SKILL_SLUG,
  name: 'Divo OMS Site Inventory',
  summary: 'Search the approved OMS website inventory for site shortlists, profiles, and catalog values through a governed read-only capability.',
  markdown: `# Divo OMS Site Inventory

Use this skill only for the company-approved OMS website inventory capability.

## Operating rules

1. Resolve this skill before OMS inventory work. Use the returned Divo tool recipe exactly; never call the OMS webhook, database, curl, browser automation, or a local API key directly.
2. Use the operation that matches the request:
   - \`search_sites\` for a filtered shortlist by niche, content category, country, quality, classification, price, traffic, or authority.
   - \`get_site_profiles\` for 1–20 exact bare website hostnames.
   - \`list_catalog_values\` to inspect available values before narrowing a shortlist.
3. Apply the quality filters that link buyers actually care about, not just authority:
   - \`maxSpamScore\` excludes spammy inventory. Spam score is inverted, so lower is better; prefer it whenever the user asks for good, safe, or clean sites. OMS stores "never measured" as a negative spam score. Divo automatically excludes those rows when you set \`maxSpamScore\` or rank cleanest-first, so a shortlist never presents an unmeasured site as a clean one. Such a result covers only sites with a measured spam score, so say "measured spam score" rather than implying every site was checked. Ranking spammiest-first does not exclude them, and setting \`minSpamScore\` yourself overrides the exclusion.
   - \`minDomainRating\` is the Ahrefs-style authority counterpart to \`minDomainAuthority\`. Use both when the user wants a genuinely strong site.
   - Traffic filters name distinct metrics: \`minOrganicTraffic\` is Semrush **organic** traffic, \`minSemrushTraffic\` is Semrush **total** traffic, and \`minAhrefTraffic\` and \`minSimilarwebTraffic\` are separate vendor estimates. They disagree often, so filter on the metric the user actually named and never present one as the traffic figure.
   - Set \`sortBy\` whenever the user wants the best, top, strongest, or cheapest sites. It changes which rows the 100-row cap returns, not just their order. \`sortDirection\` defaults to DESC, except \`spamScore\`, \`sellingPrice\`, \`costPrice\` and \`turnAroundTime\`, which default to ASC because lower is better; pass it explicitly for the opposite.
   - \`search_sites\` accepts at most 20 criteria in one call. Drop the least important ones rather than splitting a single intent across calls.
4. Never invent raw OMS columns, filters, operators, SQL, request bodies, headers, endpoint URLs, cookies, or credentials. The backend owns those provider details and validates every request.
5. Preflight the exact call before retrieval when configuration is uncertain. It checks the company connection and operation bounds without fetching site data.
6. Report result states honestly:
   - \`complete\`: the webhook returned fewer than its 100-row cap. The central preview still labels OMS coverage \`provider_limited\` because the provider supplies neither pagination nor a total; describe it as the returned snapshot, not an exhaustive dataset.
   - \`partial\`: the webhook returned exactly 100 rows, which is its cap. OMS reports no total, so this cannot be distinguished from a result that genuinely has 100 matches: say completeness cannot be confirmed rather than asserting rows are missing. OMS sorts before it truncates, so with \`sortBy\` set this is a true top-100 ranking; without \`sortBy\` it is an arbitrary subset and must never be described as the best sites.
   - \`empty\`: OMS returned a valid JSON empty array.
   - \`blocked\`: connection setup, the company kill switch, or OMS's ambiguous empty-body behavior prevented a reliable answer. Do not call it “no results.”
7. OMS never paginates and never returns a total count. Never state or imply how many sites exist in total, and never claim a shortlist is exhaustive beyond what the row cap allows.
8. Site rows are per listing, not per domain, so the same website can appear more than once with different niche, price, or link attributes. Report the rows as returned rather than merging them.
9. Authority values are source data and are occasionally out of range, including values above 100. Pass them through as stored and do not silently correct them.
10. Summarize only the useful evidence in chat. The preview contains at most 25 rows. When the result contains \`exportCandidate\` and the member asks for Sheet, Excel, CSV, all rows, or a full export, call \`dataExport\` with \`op=plan\` using that candidate instead of reproducing rows. If the member did not ask for a file but the shortlist/profile result would be useful as a table, end with one soft follow-up asking whether to export it to Google Sheets, Excel, or CSV, unless the member explicitly said not to export, not now, or chat-only. Do not create a CSV, Excel file, local Python workflow, temporary download link, or rerun OMS yourself. The exported OMS snapshot may not be exhaustive.

OMS access is read-only and available only to active company administrators in this rollout.`,
  toolIds: ['omsSiteData'],
  tags: ['divo', 'oms', 'site inventory', 'publisher', 'outreach', 'seo'],
  aliases: ['oms', 'oms sites', 'website inventory', 'site shortlist', 'publisher sites', 'guest post sites', 'find websites'],
  sortOrder: 23,
};

export async function provisionDivoOmsSiteDataSystemSkill(
  db: Pick<Prisma.TransactionClient, 'skillFolder' | 'skill' | 'skillVersion' | 'skillRegistryRevision' | 'skillAccessGrant' | 'skillAlias'>,
  companyId: string,
) {
  return provisionDivoProductivitySystemSkill(db, companyId, DIVO_OMS_SITE_DATA_SYSTEM_SKILL);
}

export async function provisionDivoOmsSiteDataForExistingCompanies(
  db: Pick<PrismaClient, 'company' | 'skillFolder' | 'skill' | 'skillVersion' | 'skillRegistryRevision' | 'skillAccessGrant' | 'skillAlias'>,
) {
  return provisionDivoProductivitySkillForExistingCompanies(db, DIVO_OMS_SITE_DATA_SYSTEM_SKILL);
}
