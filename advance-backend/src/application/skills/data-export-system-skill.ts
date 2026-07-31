import {
  provisionDivoProductivitySkillForExistingCompanies,
  provisionDivoProductivitySystemSkill,
  type DivoProductivitySystemSkillDefinition,
} from './divo-productivity-system-skills';
import { DATA_EXPORT_ROW_LIMIT } from '../data-export/data-export.types';

export const DATA_EXPORT_SYSTEM_SKILL: DivoProductivitySystemSkillDefinition = {
  slug: 'secure-data-export',
  name: 'Secure Data Export',
  summary: `Export up to ${DATA_EXPORT_ROW_LIMIT.toLocaleString('en-IN')} Airtable or Zoho Books rows to invoker-only Google artifacts without putting rows in model context.`,
  markdown: `# Secure Data Export

Use \`dataExport\` when the user asks for all rows, a complete export, a CSV, a Google Sheet, or when a source preview reports more data.

The current system cap is ${DATA_EXPORT_ROW_LIMIT.toLocaleString('en-IN')} rows per export. If the user asks for more or for every row, state this limit clearly. Never claim that a capped artifact is complete; the completion card will say when additional source rows were omitted.

1. Resolve the exact source connection and dataset identifiers first.
2. One call exports exactly one dataset. If an Airtable base has multiple tables and the user did not name one, list the table names and ask one concise question. Never fan out one request into separate table exports.
3. Call \`dataExport\` with an approved Airtable or Zoho Books source.
4. Use \`destination.format="auto"\` unless the user explicitly requests CSV or Google Sheets.
5. For mapping, filtering, renaming, flattening, or calculated columns, provide a row transform. It receives \`row\`, \`index\`, and \`args\`; return one object, an array of objects, or \`null\`.
6. Never fetch source pages manually, paste bulk rows into model context, or invoke Google Drive/Sheets directly for the export.

Every artifact is owned by the administrator-approved Google export account and shared as reader with the verified invoking user only. Access changes are not supported. If asked to share an export with another user, group, department, company, domain, or public link, refuse clearly; do not call Google permission tools.

The backend re-checks dataExport permission, source read permission, invoker access to the exact source connection, the configured Google export account, the invoker-only reader permission, and artifact integrity.`,
  toolIds: ['dataExport'],
  tags: ['divo', 'data', 'export', 'google-drive', 'google-sheets'],
  aliases: [
    'export data',
    'full export',
    'complete export',
    'download csv',
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
