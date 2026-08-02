import {
  provisionDivoProductivitySkillForExistingCompanies,
  provisionDivoProductivitySystemSkill,
  type DivoProductivitySystemSkillDefinition,
} from './divo-productivity-system-skills';
import { DATA_EXPORT_ROW_LIMIT } from '../data-export/data-export.types';

export const DATA_EXPORT_SYSTEM_SKILL: DivoProductivitySystemSkillDefinition = {
  slug: 'secure-data-export',
  name: 'Secure Data Export',
  summary: `Export up to ${DATA_EXPORT_ROW_LIMIT.toLocaleString('en-IN')} rows from a governed provider offer to an invoker-only Google artifact without putting rows in model context.`,
  markdown: `# Secure Data Export

Use \`dataExport\` after a source specialist returns \`preview.exportOfferId\`
and the user explicitly chooses a complete export, CSV, Excel file, or Google
Sheet. Do not construct a provider export from the conversation when the source
can first produce a governed preview and offer.

When a source result contains \`preview.exportOfferId\`, explain briefly that more rows are available and ask whether the user wants the offered export. After an explicit confirmation, call \`dataExport\` with \`{ "offerId": "<preview.exportOfferId>" }\`. If that exact confirmation returns eligible Google account choices, ask once and retry with only the same \`offerId\` plus the chosen \`destinationConnectionId\`. Never reconstruct the source query, source connection, filters, title, company, or user from the conversation.

The current system cap is ${DATA_EXPORT_ROW_LIMIT.toLocaleString('en-IN')} rows per export. If the user asks for more or for every row, state this limit clearly. Never claim that a capped artifact is complete; the completion card will say when additional source rows were omitted.

1. Keep the source result's opaque offer ID; never reconstruct its query,
   pagination, filters, account, or rows.
2. One offer exports exactly one dataset. If a supported direct Airtable export
   needs a table the member did not name, list the table names and ask one
   concise question. Never fan out one request into separate table exports.
3. Call \`dataExport\` with the offer ID. Use a direct Airtable or Zoho Books
   recipe only when the exact backend-resolved source identifiers are already
   available and the source does not provide an offer.
4. Use \`destination.format="auto"\` unless the user explicitly requests CSV, Excel, or Google Sheets. Use \`xlsx\` for Excel; if the dataset exceeds 5,000 rows or 100,000 cells, explain that CSV is required.
5. For mapping, filtering, renaming, flattening, or calculated columns, provide a row transform. It receives \`row\`, \`index\`, and \`args\`; return one object, an array of objects, or \`null\`.
6. Never fetch source pages manually, paste bulk rows into model context, or invoke Google Drive/Sheets directly for the export.

When the user has one writable Google account, the export is created there and owned by that account. With multiple writable accounts, use the backend choices and ask once; never guess. If no writable personal account is available, the backend may use the administrator-approved company export account and grant reader access only to the verified invoking user. Access changes are not supported. If asked to share an export with another user, group, department, company, domain, or public link, refuse clearly; do not call Google permission tools.

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
