export const TOOL_CATALOG = [
  'get_current_time',
  'zoho.clients.read',
  'zoho.invoices.read',
  'zoho.invoice.write',
] as const;

export type ToolKey = (typeof TOOL_CATALOG)[number];
