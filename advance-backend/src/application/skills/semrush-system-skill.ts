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

Read-only Semrush research through Divo's backend-configured capability. The
backend holds the Semrush web session; you never receive endpoint credentials,
cookies, or provider headers, so there is nothing to call directly. Never reach
for browser automation, curl, or a local API key instead.

## Choosing the call

- Multi-domain ranking, authority, or backlink comparison → **one**
  \`backlinks_comparison\` carrying every domain the member named. Do not also
  run \`domain_overview\` per domain unless they asked for overview fields such
  as organic keywords, traffic, or a rank snapshot.
- Where a domain stands overall → \`domain_overview\`.
- Where a keyword ranked and how it moved → \`keyword_position_trend\`.

Preflight the exact proposed call first. Preflight verifies configuration and
operation support; it retrieves no data.

Show one main table in chat. You may offer one follow-up, such as "Want domain
overview detail for any of these?" Add further Semrush calls only after the
member asks in the same thread.

## What each operation actually returns

- \`domain_overview\` takes one bare domain and answers with **one row per
  country database** Semrush holds it in, so a single call already covers
  "global and country-wise traffic". \`database\` chooses which country leads
  the table; the rest follow by organic traffic. For a one-country question,
  read the first row — do not call again per country.
- \`backlinks_comparison\` returns authority score, total backlinks, and
  referring domains for 1–10 targets in **one web request**. Compare the domains
  the member actually named; do not pad the list to look thorough.
- \`keyword_position_trend\` takes one domain and one keyword and returns a
  **dated series** of positions around the date you pass, not a single row. It
  is not a keyword list.
- \`database\` is a two-letter country code and defaults to \`in\`. There is no
  fixed list to choose from: the databases a domain actually has are the
  \`Database\` column of its own \`domain_overview\`, so run that first when the
  member names a country you have not seen for this domain. If Semrush does not
  recognise a code it says so, and that answer is reported rather than guessed
  around.

## The returned rows are the entire world this answer knows about

A country missing from \`domain_overview\` is one Semrush has **no record for**.
It is not a measured zero and not evidence of no presence. Never write that an
unreturned country is unindexed, has zero traffic, or has no visibility, and
never count how many markets a domain is missing from. If you name one as an
example, the same sentence must say this is Semrush having no record. Report the
countries that came back, say how many there were, and say plainly that Semrush
returned nothing for anywhere else — a member cannot tell an inference apart
from a finding.

A returned row with \`Organic Traffic\` 0 is the opposite case: that is measured,
and can be described as ranking without earning clicks.

The same distinction applies to backlinks. When \`coverage.missingTargets\` names
a target, that is no provider data, not zero.

Counts come from the rows, never from memory. Before writing how many countries
had zero traffic, count the returned rows whose \`Organic Traffic\` is 0.

## Reporting

The structured preview holds at most 25 rows. Summarize the useful evidence and
never pull bulk rows through model context. Treat a continuation as incomplete
coverage: \`partial\` means Semrush has another page, so say that rather than
presenting the preview as the whole picture. \`empty\` means the request was
valid and Semrush had no matching coverage. On \`blocked\` or an invocation
error, say whether configuration, permission, unsupported capability, or
provider availability stopped the lookup, and never invent the missing data.

If the member asks for something outside these three operations — a backlink
export, for instance — say it is not available through Divo Semrush yet. Never
substitute one report for another.`,
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
