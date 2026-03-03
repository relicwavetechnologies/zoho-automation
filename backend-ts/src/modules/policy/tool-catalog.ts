export const TOOL_CATALOG = [
  'chat.message.send',
  'chat.context.add',
  'chat.voice.input',
  'get_current_time',
  'zoho.clients.read',
  'zoho.invoices.read',
  'zoho.invoice.write',
] as const;

export type ToolKey = (typeof TOOL_CATALOG)[number];
