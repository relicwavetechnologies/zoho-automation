import type { ToolSet } from 'ai';
import type { DynamicAgentDescriptor } from '../../../agents/dynamic-agent-descriptor';
import type { AgentRunCtx } from '../agent-run-ctx';

export interface AgentHookContext {
  readonly agent: DynamicAgentDescriptor;
  readonly task: string;
  readonly ctx: AgentRunCtx;
  readonly depth: number;
  readonly path: readonly string[];
}

export interface AgentHookPreResult {
  readonly modifiedTask?: string;
  readonly additionalTools?: ToolSet;
  readonly additionalSystemPrompt?: string;
  readonly shortCircuitResult?: string;
}

export interface AgentHook {
  preExecute?(ctx: AgentHookContext): Promise<AgentHookPreResult>;
  postExecute?(ctx: AgentHookContext, result: string): Promise<string>;
}

class ZohoReadHook implements AgentHook {
  async preExecute(ctx: AgentHookContext): Promise<AgentHookPreResult> {
    const intent = extractZohoIntent(ctx.task);
    return {
      additionalSystemPrompt: [
        'Zoho read hook:',
        `- Parsed intent: ${JSON.stringify(intent)}`,
        '- Use the parsed intent to choose Zoho CRM versus Zoho Books tools precisely.',
        '- For reads, fetch matching records before summarizing and call out empty result sets plainly.',
        '- Respect resultLimit, sourceTypes, dateRange, and scope when present.',
        '- Do not invent CRM, Books, user, amount, date, or status fields that were not returned by tools.',
        '- For single-ID lookups, call get/read operations directly before explaining.',
        '',
        'DATA PROCESSING RULES (critical for grouping/aggregation/analysis):',
        '- When the task requires grouping, aggregation, ranking, averaging, comparison, or any analysis across records:',
        '  Call dataProcessor with zohoSource instead of calling zohoBooks separately.',
        '  dataProcessor fetches ALL records internally (exhaustive pagination) and runs your script on them.',
        '  Example: dataProcessor({ zohoSource: { module: "bills", filters: { from_date: "2025-04-01", to_date: "2026-03-31" } }, script: "...group/filter/aggregate..." })',
        '  This avoids passing large datasets through your context — you only see the processed result.',
        '- For simple lookups/browsing (show invoices, get contact, check balance), call zohoBooks directly — no dataProcessor needed.',
        '- If the user specifies a limit (top 5, last 10), respect it in your script — do not fetch everything.',
        '- dataProcessor scripts must return an array or object. formatAmount(cents, currency) and formatDate(iso) are available in the sandbox.',
        '- For CSV exports, set exportCsv=true on the dataProcessor call and provide csvColumns for column ordering.',
        `Original task: ${ctx.task}`,
      ].join('\n'),
    };
  }

  async postExecute(_ctx: AgentHookContext, result: string): Promise<string> {
    return formatZohoResult(result);
  }
}

class LarkDocHook implements AgentHook {
  async preExecute(ctx: AgentHookContext): Promise<AgentHookPreResult> {
    const operation = inferLarkDocOperation(ctx.task);
    const strategy = inferLarkDocStrategy(ctx.task);
    return {
      additionalSystemPrompt: [
        'Lark document hook:',
        `- Operation: ${operation}`,
        `- Edit strategy: ${strategy}`,
        '- Preserve user-provided titles, headings, and requested document structure.',
        '- For updates, inspect or identify the target document before editing.',
        '- For append operations, keep existing structure and add content at the requested location.',
        '- For replace/delete operations, avoid broad destructive edits unless the target section is explicit.',
        '- Format created or edited document content as clean markdown.',
        `Original task: ${ctx.task}`,
      ].join('\n'),
    };
  }

  async postExecute(_ctx: AgentHookContext, result: string): Promise<string> {
    return cleanupMarkdown(result);
  }
}

class OutreachReadHook implements AgentHook {
  async preExecute(ctx: AgentHookContext): Promise<AgentHookPreResult> {
    const filters = extractOutreachFilters(ctx.task);
    if (filters.length === 0) return {};
    return {
      modifiedTask: `Structured outreach filters:\n${filters.join('\n')}\n\nUser task:\n${ctx.task}`,
    };
  }

  async postExecute(_ctx: AgentHookContext, result: string): Promise<string> {
    return formatOutreachResult(result);
  }
}

function extractOutreachFilters(task: string): string[] {
  const filters: string[] = [];
  const patterns: Array<[RegExp, string]> = [
    [/\bDA\s*(?:>=|>|over|above)?\s*(\d{1,3})\b/i, 'domainAuthority'],
    [/\bDR\s*(?:>=|>|over|above)?\s*(\d{1,3})\b/i, 'domainRating'],
    [/\b(?:price|cost)\s*(?:<=|<|under|below)?\s*\$?(\d+(?:\.\d+)?)\b/i, 'maxPrice'],
    [/\b(?:country|geo|location)\s*[:=]?\s*([A-Za-z][A-Za-z -]{1,40})\b/i, 'country'],
    [/\b(?:niche|vertical)\s*[:=]?\s*([A-Za-z][A-Za-z -]{1,40})\b/i, 'niche'],
  ];

  for (const [pattern, key] of patterns) {
    const match = task.match(pattern);
    if (match?.[1]) filters.push(`- ${key}: ${match[1].trim()}`);
  }

  return filters;
}

interface ZohoIntent {
  readonly sourceTypes: string[];
  readonly resultLimit: number | null;
  readonly dateRange: string | null;
  readonly scope: 'company-wide' | 'user-scoped' | 'unspecified';
  readonly operation: 'read' | 'create' | 'update' | 'delete' | 'report';
}

function extractZohoIntent(task: string): ZohoIntent {
  const text = task.toLowerCase();
  const sourceTypes = new Set<string>();
  const sourcePatterns: Array<[RegExp, string]> = [
    [/\b(deal|deals|pipeline|opportunit(?:y|ies))\b/i, 'Deal'],
    [/\b(lead|leads)\b/i, 'Lead'],
    [/\b(contact|contacts|customer|customers)\b/i, 'Contact'],
    [/\b(account|accounts|company|companies)\b/i, 'Account'],
    [/\b(ticket|tickets|case|cases)\b/i, 'Ticket'],
    [/\b(invoice|invoices)\b/i, 'Invoice'],
    [/\b(payment|payments)\b/i, 'Payment'],
    [/\b(expense|expenses)\b/i, 'Expense'],
    [/\b(bill|bills)\b/i, 'Bill'],
    [/\b(vendor|vendors)\b/i, 'Vendor'],
  ];

  for (const [pattern, source] of sourcePatterns) {
    if (pattern.test(task)) sourceTypes.add(source);
  }
  if (sourceTypes.size === 0) {
    if (/\b(crm|sales|pipeline)\b/i.test(task)) sourceTypes.add('CRM');
    if (/\b(books|finance|revenue|overdue|invoice|expense|payment)\b/i.test(task)) sourceTypes.add('Books');
  }

  return {
    sourceTypes: [...sourceTypes],
    resultLimit: extractResultLimit(task),
    dateRange: extractDateRange(task),
    scope: inferZohoScope(text),
    operation: inferZohoOperation(text),
  };
}

function extractResultLimit(task: string): number | null {
  const patterns = [
    /\b(?:last|top|first|show|list|get|limit)\s+(\d{1,3})\b/i,
    /\b(\d{1,3})\s+(?:deals|leads|contacts|accounts|invoices|payments|expenses|records)\b/i,
  ];
  for (const pattern of patterns) {
    const match = task.match(pattern);
    const value = match?.[1] ? Number(match[1]) : NaN;
    if (Number.isInteger(value) && value > 0) return Math.min(value, 100);
  }
  return null;
}

function extractDateRange(task: string): string | null {
  const lower = task.toLowerCase();
  if (/\btoday\b/.test(lower)) return 'today';
  if (/\byesterday\b/.test(lower)) return 'yesterday';
  if (/\blast week\b/.test(lower)) return 'last_week';
  if (/\bthis week\b/.test(lower)) return 'this_week';
  if (/\blast month\b/.test(lower)) return 'last_month';
  if (/\bthis month\b/.test(lower)) return 'this_month';
  if (/\blast quarter\b/.test(lower)) return 'last_quarter';

  const quarter = lower.match(/\bq([1-4])(?:\s+|\s*-\s*)?(\d{4})?\b/);
  if (quarter?.[1]) {
    return `q${quarter[1]}${quarter[2] ? `_${quarter[2]}` : ''}`;
  }

  const since = task.match(/\bsince\s+([A-Za-z]+(?:\s+\d{1,2})?(?:,?\s+\d{4})?|\d{4}-\d{2}-\d{2})\b/i);
  if (since?.[1]) return `since ${since[1].trim()}`;

  const after = task.match(/\b(?:after|from)\s+([A-Za-z]+(?:\s+\d{1,2})?(?:,?\s+\d{4})?|\d{4}-\d{2}-\d{2})\b/i);
  if (after?.[1]) return `from ${after[1].trim()}`;

  return null;
}

function inferZohoScope(text: string): ZohoIntent['scope'] {
  if (/\b(my|mine|assigned to me|owned by me)\b/.test(text)) return 'user-scoped';
  if (/\b(company|all|everyone|team-wide|org-wide|organization)\b/.test(text)) return 'company-wide';
  return 'unspecified';
}

function inferZohoOperation(text: string): ZohoIntent['operation'] {
  if (/\b(create|add|new)\b/.test(text)) return 'create';
  if (/\b(update|edit|change|mark)\b/.test(text)) return 'update';
  if (/\b(delete|remove)\b/.test(text)) return 'delete';
  if (/\b(report|summary|summarize|dashboard|overdue|total)\b/.test(text)) return 'report';
  return 'read';
}

function formatZohoResult(result: string): string {
  const trimmed = result.trim();
  if (!trimmed) return 'No Zoho result was returned.';
  return trimmed
    .replace(/\bou_[a-z0-9_]+\b/gi, match => `Lark user ${match}`)
    .replace(/\n{3,}/g, '\n\n');
}

function inferLarkDocOperation(task: string): 'create' | 'read' | 'update' | 'share' {
  const text = task.toLowerCase();
  if (/\b(share|permission|access|invite)\b/.test(text)) return 'share';
  if (/\b(create|draft|write|new doc|new document)\b/.test(text)) return 'create';
  if (/\b(append|update|edit|replace|delete|remove|patch|insert|add)\b/.test(text)) return 'update';
  return 'read';
}

function inferLarkDocStrategy(task: string): 'append' | 'replace' | 'patch' | 'delete' | 'create' | 'read' | 'share' {
  const operation = inferLarkDocOperation(task);
  const text = task.toLowerCase();
  if (operation === 'create' || operation === 'read' || operation === 'share') return operation;
  if (/\b(append|add to|insert at end|continue)\b/.test(text)) return 'append';
  if (/\b(replace|rewrite|overwrite)\b/.test(text)) return 'replace';
  if (/\b(delete|remove)\b/.test(text)) return 'delete';
  return 'patch';
}

function cleanupMarkdown(result: string): string {
  return result
    .trim()
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

function formatOutreachResult(result: string): string {
  const trimmed = result.trim();
  if (!trimmed) return 'No outreach results were returned.';
  return trimmed
    .replace(/\bDA\s*[:=]\s*(\d{1,3})\b/gi, 'DA: $1')
    .replace(/\bDR\s*[:=]\s*(\d{1,3})\b/gi, 'DR: $1')
    .replace(/\b(?:price|cost)\s*[:=]\s*\$?(\d+(?:\.\d+)?)\b/gi, 'Price: $$$1')
    .replace(/\n{3,}/g, '\n\n');
}

const HOOK_REGISTRY: Record<string, AgentHook> = {
  'zoho-read':     new ZohoReadHook(),
  'lark-doc':      new LarkDocHook(),
  'outreach-read': new OutreachReadHook(),
};

export function resolveAgentHook(hookId: string | null): AgentHook | null {
  if (!hookId) return null;
  return HOOK_REGISTRY[hookId] ?? null;
}
