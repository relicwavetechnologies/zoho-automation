import type { Skill } from './skill.types';
import { DATA_EXPORT_ROW_LIMIT } from '../data-export/data-export.types';

export const dataSkill: Skill = {
  id: 'data',
  name: 'Data Processing',
  description: 'CSV export, data processing, tabular formatting',
  toolIds: ['dataProcessor', 'dataExport'],
  instructions: `DATA PROCESSING AND EXPORT:
- Transform raw data into structured formats: CSV, tables, summaries.
- For large source datasets, call dataExport. It currently exports at most ${DATA_EXPORT_ROW_LIMIT.toLocaleString('en-IN')} rows; state that cap whenever the user asks for more or for all rows. Never claim a capped artifact is complete.
- dataExport accepts only registered source adapters, runs row transforms in a networkless sandbox, and delivers a verified invoker-only Google reader link.
- Export access is fixed to the invoker. Refuse requests to change, broaden, or make that access public.
- When processing tabular data, preserve all columns unless user explicitly asks to filter.
- Multi-currency values must stay grouped by currency. Never merge different currencies.
- Numbers are exact — never round or estimate unless user explicitly asks.
- Let dataExport choose Google Sheets for manageable results and CSV in Drive for large results.
- When generating CSV: include headers, use proper escaping for commas/quotes in values.
- Date formatting: ISO 8601 (YYYY-MM-DD) by default, or user's requested format.
- Amount formatting: use locale-appropriate separators with currency symbol.`,
};
