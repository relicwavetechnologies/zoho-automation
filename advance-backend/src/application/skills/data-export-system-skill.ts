import {
  provisionDivoProductivitySkillForExistingCompanies,
  provisionDivoProductivitySystemSkill,
  type DivoProductivitySystemSkillDefinition,
} from './divo-productivity-system-skills';
/*
 * Only the Menhood spool cap is imported. The Excel/Sheets/CSV row and cell
 * caps are already stated by the registered `dataExport` tool's own parameter
 * docs, and a second copy here is one that can drift from the constants the
 * worker actually enforces.
 */
import { DATA_EXPORT_MENHOOD_SPOOL_MB_LIMIT } from '../data-export/data-export-limits';

export const DATA_EXPORT_SYSTEM_SKILL: DivoProductivitySystemSkillDefinition = {
  slug: 'secure-data-export',
  name: 'Secure Data Export',
  summary: `Complete an opaque backend-replayable provider exportCandidate through Divo's company-owned export destination.`,
  markdown: `# Secure Data Export

Finish a provider export the backend can replay. Shopify (\`shopify_snapshot\`),
Semrush, OMS, Menhood, Zoho Books, and Zoho CRM results carry an
\`exportCandidate\` when their recipe is replayable.

## Use when

The member names a format or asks for a file — Excel/XL/XLSX, CSV, Sheet, "all
rows", "full data", "the whole thing". Not before that.

If they asked for a file without naming a format, ask which of Sheet, Excel, or
CSV before planning. A plan has no "auto": you would be choosing for them, and
Excel is capped far lower than CSV, so a quiet guess is how a large result
arrives truncated in a format nobody picked.

## Workflow

1. Export the table you actually showed in your last answer, not every tool call
   in the run. Call \`op=list_candidates\` (scope \`run\` when the answer spans this
   turn) only when which table is meant is genuinely unclear.
2. \`op=plan\` with one dataset. Use several \`datasets[]\` only when the member
   asked for several tables earlier in the thread, and give each a \`tabName\`.
3. Say plainly what is being exported and where: "Exporting [what they saw] to
   Excel — Divo will send the file here when it is ready."
4. On \`ambiguous\`, repair your own plan. Never show the member a candidate ID, a
   shape key, or a dataset picker table.

Never rerun the source query, page the source yourself, build the file locally,
or call Google tools to produce the artifact.

## Offering an export

When a result carries \`exportCandidate\` and the member did not ask for a file,
the provider skill may end with one short offer: "Want this as a Google Sheet,
Excel, or CSV?" Skip the offer for an empty result, an error, a one-number
answer, an explicit "not now" or "chat only", and any source with no replayable
candidate.

## The file and the chat answer are different artifacts

Answer in whatever shape actually helps — a summary, a ranking, a few
highlighted rows. The export carries the backend recipe behind that answer, so
it normally holds more than you displayed. Never say the file contains only what
is on screen, and never state a total row count of your own: the completion card
reports measured rows, cap cause, and omitted rows.

## Queued is not finished

A queued export has started. The completion or failure card is the only source
of truth for the final artifact, including whether the format cap omitted rows,
so never call the export complete before it arrives. Menhood carries one cap the
tool does not name: it stops before its spool exceeds ${DATA_EXPORT_MENHOOD_SPOOL_MB_LIMIT} MB.
Some failures arrive before any card does: \`op=plan\` can come back \`blocked\`
with a reason of its own, and a revoked grant or a stale replay candidate never
produces a card at all. When either \`dataExport\` itself or the card names a
permanent problem — a revoked permission, a stale candidate, exhausted API
units, rejected provider credentials, an expired web session — explain that
reason and do not retry the same export by hand.

## Direct recipes

Use a direct recipe only when a backend-replayable source returned no candidate
and the exact backend-resolved identifiers are already in hand. Never build
provider identifiers, filters, account ownership, or rows out of the
conversation, and never fan one request out into separate per-table exports.

One direct recipe exports exactly one dataset. If the source needs a table the
member never named, list the table names and ask one short question rather than
picking one.

A recipe is replayed later, so every filter that narrowed your answer must also
be in it. Zoho Books bank transactions are scoped per account: pass
\`accountId\`, because a status filter without one is refused rather than
silently widened to every account in the organisation.

Airtable MCP is not a bulk-export source. Use it for discovery or a bounded
preview only; when an Airtable request has no backend REST/connector replay
path, offer a bounded preview or say plainly that the full export is blocked.

## Access is not yours to arrange

Never start personal Google OAuth, choose an account, or call a Google
permission tool for an export. If \`op=plan\` reports the company export
destination is unavailable, say an administrator must configure or reconnect it.
If asked to share an export with another person, group, department, company,
domain, or a public link, refuse plainly: access is fixed when the file is made.`,
  toolIds: ['dataExport'],
  tags: ['divo', 'data', 'export', 'google-drive', 'google-sheets'],
  aliases: [
    'export candidate',
    'provider export candidate',
    'semrush export',
    'oms export',
    'menhood export',
    'shopify export',
  ],
  sortOrder: 29,
};

export const provisionDataExportSystemSkill = (
  db: Parameters<typeof provisionDivoProductivitySystemSkill>[0],
  companyId: string,
) => provisionDivoProductivitySystemSkill(db, companyId, DATA_EXPORT_SYSTEM_SKILL);

export const provisionDataExportSystemSkillForExistingCompanies = (
  db: Parameters<typeof provisionDivoProductivitySkillForExistingCompanies>[0],
) => provisionDivoProductivitySkillForExistingCompanies(db, DATA_EXPORT_SYSTEM_SKILL);
