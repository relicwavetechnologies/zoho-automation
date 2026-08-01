/**
 * Human-readable one-line summaries of tool arguments.
 *
 * Used for approval cards and run traces: a manager approving an action, or
 * someone reading a trace afterwards, needs to see *what* was going to happen
 * without reading raw JSON. Kept deliberately total — a summary must never be
 * the thing that fails a tool call, hence the blanket catch.
 */

import { formatAmount, formatDate } from '../zoho/zoho-format.utils';
import { googleWorkspaceProductByToolId } from '../google/google-workspace-mcp-manifest';

export function buildArgsSummary(toolId: string, action: string, args: unknown): string {
  try {
    const a = args as Record<string, unknown>;
    if (googleWorkspaceProductByToolId(toolId)) return buildGoogleWorkspaceArgsSummary(toolId, action, a);
    if (toolId === 'knowledge' && a['operation'] === 'apply') {
      const scope = String(a['scope'] ?? 'unknown');
      const kind = String(a['kind'] ?? 'knowledge');
      const content = a['content'] && typeof a['content'] === 'object' && !Array.isArray(a['content'])
        ? a['content'] as Record<string, unknown>
        : {};
      if (kind === 'memory' && Array.isArray(content['facts'])) {
        const facts = content['facts'].filter((fact): fact is string => typeof fact === 'string');
        return [`Publish ${facts.length} reviewed ${facts.length === 1 ? 'fact' : 'facts'} to ${scope} memory`, ...facts.map((fact, index) => `${index + 1}. ${fact}`)].join('\n');
      }
      if (kind === 'skill' && typeof content['name'] === 'string') {
        return `Publish reviewed procedure “${content['name']}” to ${scope}`;
      }
      if (kind === 'file' && typeof content['fileName'] === 'string') {
        return `Share file “${content['fileName']}” with ${scope}`;
      }
      return `Apply reviewed ${kind} change to ${scope}`;
    }
    const parts: string[] = [`${toolId}.${action}`];
    // Append the most human-readable fields if present
    for (const key of ['to', 'subject', 'title', 'name', 'query', 'module', 'chatId', 'calendarId']) {
      if (a[key] !== undefined) {
        const val = String(a[key]).slice(0, 80);
        parts.push(`${key}=${val}`);
      }
    }
    if (toolId === 'zohoBooks') {
      const fields = a['fields'] && typeof a['fields'] === 'object' && !Array.isArray(a['fields'])
        ? a['fields'] as Record<string, unknown>
        : {};
      const merged = { ...fields, ...a };
      const currency = typeof merged['currency_code'] === 'string' ? merged['currency_code'] : 'USD';
      for (const key of ['customer_name', 'vendor_name', 'invoice_id', 'bill_id', 'expense_id']) {
        if (merged[key] !== undefined) parts.push(`${key}=${String(merged[key]).slice(0, 80)}`);
      }
      for (const key of ['amount', 'total', 'balance']) {
        const raw = merged[key];
        const amount = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
        if (Number.isFinite(amount)) parts.push(`${key}=${formatAmount(amount, currency)}`);
      }
      for (const key of ['date', 'due_date', 'payment_date']) {
        if (typeof merged[key] === 'string') parts.push(`${key}=${formatDate(merged[key])}`);
      }
    }
    return parts.join(' | ');
  } catch {
    return `${toolId}.${action}`;
  }
}

function buildGoogleWorkspaceArgsSummary(
  toolId: string,
  action: string,
  args: Record<string, unknown>,
): string {
  const nativeTool = typeof args['nativeTool'] === 'string' ? args['nativeTool'] : action;
  const input = args['input'] && typeof args['input'] === 'object' && !Array.isArray(args['input'])
    ? args['input'] as Record<string, unknown>
    : {};
  const parts = [`${toolId}.${nativeTool}`];
  for (const key of [
    'to', 'cc', 'bcc', 'subject', 'title', 'name', 'query', 'calendar_id',
    'event_id', 'document_id', 'spreadsheet_id', 'presentation_id', 'form_id',
  ]) {
    if (input[key] === undefined) continue;
    const value = Array.isArray(input[key]) ? input[key].join(', ') : String(input[key]);
    parts.push(`${key}=${value.replace(/\s+/g, ' ').slice(0, 120)}`);
  }
  const body = input['body'] ?? input['body_text'] ?? input['text'];
  if (typeof body === 'string' && body.trim()) {
    parts.push(`preview=${body.replace(/\s+/g, ' ').slice(0, 180)}`);
  }
  return parts.join(' | ');
}
