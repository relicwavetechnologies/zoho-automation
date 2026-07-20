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
3. Never invent raw OMS columns, filters, operators, SQL, request bodies, headers, endpoint URLs, cookies, or credentials. The backend owns those provider details and validates every request.
4. Preflight the exact call before retrieval when configuration is uncertain. It checks the company connection and operation bounds without fetching site data.
5. Report result states honestly:
   - \`complete\`: the webhook returned fewer than its 100-row cap.
   - \`partial\`: the webhook returned 100 rows and has no pagination, so the shortlist may be incomplete.
   - \`empty\`: OMS returned a valid JSON empty array.
   - \`blocked\`: connection setup, the company kill switch, or OMS's ambiguous empty-body behavior prevented a reliable answer. Do not call it “no results.”
6. Summarize only the useful evidence in chat. If Divo returns a temporary CSV, identify it as a private, company-scoped 24-hour export rather than pasting all rows.

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
