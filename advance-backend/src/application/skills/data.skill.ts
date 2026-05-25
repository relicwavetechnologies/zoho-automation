import type { Skill } from './skill.types';

export const dataSkill: Skill = {
  id: 'data',
  name: 'Data Processing',
  description: 'CSV export, data processing, tabular formatting',
  toolIds: ['dataProcessor'],
  instructions: `DATA PROCESSING AND EXPORT:
- Transform raw data into structured formats: CSV, tables, summaries.
- When processing tabular data, preserve all columns unless user explicitly asks to filter.
- Multi-currency values must stay grouped by currency. Never merge different currencies.
- Numbers are exact — never round or estimate unless user explicitly asks.
- For large datasets, prefer CSV export over inline display.
- When generating CSV: include headers, use proper escaping for commas/quotes in values.
- Date formatting: ISO 8601 (YYYY-MM-DD) by default, or user's requested format.
- Amount formatting: use locale-appropriate separators with currency symbol.`,
};
