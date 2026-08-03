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

export const DATA_EXPORT_SYSTEM_SKILL: DivoProductivitySystemSkillDefinition = {
  slug: 'secure-data-export',
  name: 'Secure Data Export',
  summary: `Export up to ${DATA_EXPORT_CSV_ROW_LIMIT.toLocaleString('en-IN')} governed source rows without putting them in model context; verified Lark cards own provider offers.`,
  markdown: `# Secure Data Export

In Lark, a source result containing \`preview.exportOfferId\` already creates
Divo's verified Google Sheet, CSV, and Excel buttons on the final response.
Preserve the opaque offer only until the turn completes. Do not mention its ID,
ask a second export question, load or call \`dataExport\` for that offer, or
choose an account. The card callback owns format selection, eligible-account
selection, queueing, connect-and-resume, progress, and final delivery.

The file and the chat answer are not the same artifact, and you must not
describe them as if they were. Answer in whatever shape actually helps —
a summary, a ranking, a handful of highlighted rows — while the export carries
the underlying rows behind that answer. When several tool calls contribute to
one answer, they all feed one export covering every row, so never say the file
holds only what is shown, and never state a row count of your own: Divo appends
the number it measured. If a result carries \`preview.exportWithdrawn\`, this
request mixes datasets that cannot share one file — say no export is available
and offer to rerun for the single dataset the user wants.

Use a direct \`dataExport\` recipe only for an explicit Lark export from the
supported Airtable or Zoho Books sources when no provider offer was returned
and the exact backend-resolved source identifiers are already available. Never
construct provider identifiers, filters, account ownership, or rows from the
conversation.

Format limits are explicit: Excel ${DATA_EXPORT_XLSX_ROW_LIMIT.toLocaleString('en-IN')} rows/${DATA_EXPORT_XLSX_CELL_LIMIT.toLocaleString('en-IN')} cells, Google Sheets ${DATA_EXPORT_GOOGLE_SHEET_ROW_LIMIT.toLocaleString('en-IN')} rows/${DATA_EXPORT_GOOGLE_SHEET_CELL_LIMIT.toLocaleString('en-IN')} cells, and CSV/auto ${DATA_EXPORT_CSV_ROW_LIMIT.toLocaleString('en-IN')} rows. Menhood also stops before its spool exceeds ${DATA_EXPORT_MENHOOD_SPOOL_MB_LIMIT} MB. If the user asks for more or every row, state the applicable limit. Never claim that a capped artifact is complete; the completion card says when source rows were omitted.

1. Keep a provider offer opaque and let Divo's Lark card complete it; never
   reconstruct its query, pagination, filters, account, or rows.
2. One direct recipe exports exactly one dataset. If a supported Airtable export
   needs a table the member did not name, list the table names and ask one
   concise question. Never fan out one request into separate table exports.
3. Use a direct Airtable or Zoho Books recipe only when the exact
   backend-resolved source identifiers are already available and the source did
   not provide an offer.
4. Use \`destination.format="auto"\` unless the user explicitly requests CSV, Excel, or Google Sheets. Use \`xlsx\` for Excel; if the dataset exceeds 5,000 rows or 100,000 cells, explain that CSV is required.
5. For mapping, filtering, renaming, flattening, or calculated columns, provide a row transform. It receives \`row\`, \`index\`, and \`args\`; return one object, an array of objects, or \`null\`.
6. Never fetch source pages manually, paste bulk rows into model context, or invoke Google Drive/Sheets directly for the export.

When the user has one writable Google account, the export is created there and owned by that account. With multiple writable accounts, let Divo's verified card present the eligible choices; never guess or repeat the question in chat. If no writable personal account is available, the backend may use the administrator-approved company export account and grant reader access only to the verified invoking user. Access changes are not supported. If asked to share an export with another user, group, department, company, domain, or public link, refuse clearly; do not call Google permission tools.

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
