import {
  provisionDivoProductivitySkillForExistingCompanies,
  provisionDivoProductivitySystemSkill,
  type DivoProductivitySystemSkillDefinition,
} from './divo-productivity-system-skills';
import {
  DATA_EXPORT_CSV_ROW_LIMIT,
  DATA_EXPORT_GOOGLE_SHEET_CELL_LIMIT,
  DATA_EXPORT_GOOGLE_SHEET_ROW_LIMIT,
  DATA_EXPORT_MENHOOD_SPOOL_MB_LIMIT,
  DATA_EXPORT_XLSX_CELL_LIMIT,
  DATA_EXPORT_XLSX_ROW_LIMIT,
} from '../data-export/data-export-limits';
import { DATA_EXPORT_SAMPLE_ROW_LIMIT } from '../data-export/export-candidate';

export const DATA_EXPORT_SYSTEM_SKILL: DivoProductivitySystemSkillDefinition = {
  slug: 'secure-data-export',
  name: 'Secure Data Export',
  summary: `Plan and run governed source exports without putting rows in model context; Divo chooses account, format, sample, and queue safely.`,
  markdown: `# Secure Data Export

In Lark, supported source tools return bounded chat evidence plus an
\`exportCandidate\` when the same backend-held recipe can be replayed as a
private file. Preserve that opaque candidate and do not mention its ID to the
member. If the member asks for Excel/XL/XLSX, CSV, Sheet, all rows, full data,
or an export artifact, call \`dataExport\` with \`op="plan"\` using the returned
candidate ID, requested format, and a clear title. Do not rerun the source
query, page source rows manually, build a local file, call Google tools, or
reconstruct provider filters.

If a source result has \`exportCandidate\` but the member did not ask for a
file, the provider skill may end with one concise follow-up such as “Want me to
export this to Google Sheets, Excel, or CSV?” Do not call \`dataExport\` until
the member says yes or names a format. Skip the follow-up for empty results,
errors, one-number answers, an explicit "do not export / not now / chat only"
instruction, or sources that have no backend-replayable export candidate.

\`dataExport op=plan\` is the only place that decides whether to queue the full
export, ask which writable Google account should own it, ask the member to
connect Google, or require a ${DATA_EXPORT_SAMPLE_ROW_LIMIT.toLocaleString('en-IN')}-row sample before the full run. If it returns
\`choose_destination\`, show the returned account labels/emails, ask which
Google account should own the file, and retry only with the exact returned
\`connectionId\` after the member picks one. Do not choose a saved, default, or
guessed account when the backend returned multiple choices. If it returns
\`sample_required\`, explain that Divo will make a private sample first, call
\`dataExport op=sample\` when the member agrees, and call
\`dataExport op=confirm_sample\` only after the member says the sample looks
right. The sample and final artifacts are created in Google Drive/Sheets; the
database stores only the control receipt and replay plan.

When \`dataExport\` queues a sample or full export, say it has started or been
queued; do not say the export is finished. The completion or failure card is
the source of truth for the final artifact. If the member asked for all rows or
a complete dataset, still say the queued export will run under the selected
format caps until the completion card reports final row coverage. If
\`dataExport\` or the final card
names a permanent source problem such as exhausted API units, rejected provider
credentials, or an expired web session, explain that reason and do not retry
the same export manually.

The file and the chat answer are not the same artifact, and you must not
describe them as if they were. Answer in whatever shape actually helps —
a summary, a ranking, a handful of highlighted rows — while the export carries
the underlying backend recipe behind that answer. Never say the file holds only
what is shown, and never invent a total row count: Divo reports the measured
rows, cap cause, and omitted rows after the worker runs.

Use a direct \`dataExport\` recipe only for a backend-replayable source when no
provider candidate was returned and the exact backend-resolved source
identifiers are already available. Never construct provider identifiers,
filters, account ownership, or rows from the conversation. Airtable MCP is not
a bulk-export source: use it only for discovery or a bounded preview. If an
Airtable request has no backend REST/connector replay path, ask for a bounded
preview or block the full export clearly.

Format limits are explicit: Excel ${DATA_EXPORT_XLSX_ROW_LIMIT.toLocaleString('en-IN')} rows/${DATA_EXPORT_XLSX_CELL_LIMIT.toLocaleString('en-IN')} cells, Google Sheets ${DATA_EXPORT_GOOGLE_SHEET_ROW_LIMIT.toLocaleString('en-IN')} rows/${DATA_EXPORT_GOOGLE_SHEET_CELL_LIMIT.toLocaleString('en-IN')} cells, and CSV/auto ${DATA_EXPORT_CSV_ROW_LIMIT.toLocaleString('en-IN')} rows. Menhood also stops before its spool exceeds ${DATA_EXPORT_MENHOOD_SPOOL_MB_LIMIT} MB. If the user asks for more or every row, state the applicable limit. Never claim that a capped artifact is complete; the completion card says when source rows were omitted.

1. Keep a provider \`exportCandidate\` opaque and let \`dataExport op=plan\`
   complete it; never reconstruct its query, pagination, filters, account, or
   rows.
2. One direct recipe exports exactly one dataset. If a supported backend export
   needs a table the member did not name, list the table names and ask one
   concise question. Never fan out one request into separate table exports.
3. Use a direct recipe only when the exact backend-resolved source identifiers
   are already available and the source did not provide a candidate. Never use
   Airtable MCP pagination as the replay mechanism for a full export.
4. A recipe is replayed later, so every filter that narrowed your answer must
   also be in it. Zoho Books bank transactions are scoped per account: pass
   \`accountId\` when reading them, and a status filter without one is refused
   rather than silently widened to every account in the organisation.
5. Use \`destination.format="google_sheet"\` for Sheet, \`"xlsx"\` for Excel,
   and \`"csv"\` for CSV. If the user did not name a format, ask which format
   they want before planning.
6. For mapping, filtering, renaming, flattening, or calculated columns, provide a row transform. It receives \`row\`, \`index\`, and \`args\`; return one object, an array of objects, or \`null\`. A transform shapes rows; it is not a substitute for a source filter the provider supports.
7. Never fetch source pages manually, paste bulk rows into model context, or invoke Google Drive/Sheets directly for the export.

When the user has one writable Google account, the export is created there and owned by that account. With multiple writable accounts, let Divo's verified card or confirmation result present the eligible choices; never guess an account. If no writable personal account is available, the backend may use the administrator-approved company export account and grant reader access only to the verified invoking user. Access changes are not supported. If asked to share an export with another user, group, department, company, domain, or public link, refuse clearly; do not call Google permission tools.

The backend re-checks dataExport permission, source read permission, invoker access to the exact source connection, the exact selected Google destination, the resulting owner-or-reader access, and artifact integrity.`,
  toolIds: ['dataExport'],
  tags: ['divo', 'data', 'export', 'google-drive', 'google-sheets'],
  aliases: [
    'export data',
    'full export',
    'complete export',
    'download csv',
    'excel export',
    'xlsx export',
    'large dataset',
    'google sheet export',
    'airtable export',
    'zoho books export',
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
