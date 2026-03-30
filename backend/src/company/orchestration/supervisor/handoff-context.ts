export type SupervisorRecentTaskSummary = {
  summary: string;
  completedAt?: string;
  resolvedIds?: Record<string, string>;
};

export type SupervisorResolvedContext = Record<string, string>;

const KNOWN_RESOLVED_KEYS = [
  'recordId',
  'invoiceId',
  'invoiceNumber',
  'organizationId',
  'customerId',
  'contactId',
  'estimateId',
  'billId',
  'creditNoteId',
  'salesOrderId',
  'purchaseOrderId',
  'approvalId',
  'taskId',
  'threadId',
  'messageId',
  'recipientEmail',
  'email',
  'recipientName',
  'vendorName',
  'customerName',
  'amount',
  'totalAmount',
  'dueAmount',
  'closingBalance',
] as const;

const toCamelCase = (value: string): string =>
  value.replace(/[_-]([a-z])/gi, (_match, letter: string) => letter.toUpperCase());

const toSnakeCase = (value: string): string =>
  value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase();

const normalizeKeyVariants = (key: string): string[] => {
  const trimmed = key.trim();
  if (!trimmed) return [];
  return Array.from(new Set([trimmed, toCamelCase(trimmed), toSnakeCase(trimmed)]));
};

const setResolvedValue = (
  resolved: SupervisorResolvedContext,
  key: string,
  value: unknown,
): void => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return;
  }
  for (const variant of normalizeKeyVariants(key)) {
    if (!resolved[variant]) {
      resolved[variant] = value.trim();
    }
  }
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const extractFromText = (text: string, resolved: SupervisorResolvedContext): void => {
  if (!text.trim()) return;

  const emailMatch = text.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z]{2,}\b/i);
  if (emailMatch) {
    setResolvedValue(resolved, 'recipientEmail', emailMatch[0]);
  }

  const invoiceNumberMatch = text.match(/\bINV[- ]?\d+\b/i);
  if (invoiceNumberMatch) {
    setResolvedValue(resolved, 'invoiceNumber', invoiceNumberMatch[0].replace(/\s+/g, ''));
  }

  const labeledRecordId = text.match(/\b(?:recordId|record id|invoiceId|invoice id)\s*[:=#-]?\s*([0-9]{8,})\b/i);
  if (labeledRecordId) {
    setResolvedValue(resolved, 'recordId', labeledRecordId[1]);
    setResolvedValue(resolved, 'invoiceId', labeledRecordId[1]);
  }

  const invoiceWithId = text.match(/\binvoice\s+([0-9]{8,})\b/i);
  if (invoiceWithId) {
    setResolvedValue(resolved, 'recordId', invoiceWithId[1]);
    setResolvedValue(resolved, 'invoiceId', invoiceWithId[1]);
  }

  const orgIdMatch = text.match(/\borganization(?:Id| id)?\s*[:=#-]?\s*([0-9]{8,})\b/i);
  if (orgIdMatch) {
    setResolvedValue(resolved, 'organizationId', orgIdMatch[1]);
  }
};

export const collectResolvedContextFromUnknown = (
  value: unknown,
  resolved: SupervisorResolvedContext,
  depth = 0,
): void => {
  if (depth > 4 || value == null) {
    return;
  }
  if (typeof value === 'string') {
    extractFromText(value, resolved);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value.slice(0, 12)) {
      collectResolvedContextFromUnknown(entry, resolved, depth + 1);
    }
    return;
  }
  const record = asRecord(value);
  if (!record) {
    return;
  }

  for (const key of KNOWN_RESOLVED_KEYS) {
    setResolvedValue(resolved, key, record[key]);
  }
  for (const nested of Object.values(record).slice(0, 24)) {
    collectResolvedContextFromUnknown(nested, resolved, depth + 1);
  }
};

export const buildSupervisorResolvedContext = (input: {
  objective?: string;
  recentTaskSummaries?: SupervisorRecentTaskSummary[];
  threadSummary?: string;
  scopedContext?: string[];
  warmResolvedIds?: Record<string, string>;
  upstreamResults?: Array<{
    summary?: string;
    text?: string;
    data?: Record<string, unknown>;
    output?: Record<string, unknown>;
  }>;
}): SupervisorResolvedContext => {
  const resolved: SupervisorResolvedContext = {};

  for (const [key, value] of Object.entries(input.warmResolvedIds ?? {})) {
    setResolvedValue(resolved, key, value);
  }

  for (const entry of input.recentTaskSummaries ?? []) {
    for (const [key, value] of Object.entries(entry.resolvedIds ?? {})) {
      setResolvedValue(resolved, key, value);
    }
    collectResolvedContextFromUnknown(entry.summary, resolved);
  }

  collectResolvedContextFromUnknown(input.threadSummary ?? '', resolved);
  collectResolvedContextFromUnknown(input.objective ?? '', resolved);
  for (const snippet of input.scopedContext ?? []) {
    collectResolvedContextFromUnknown(snippet, resolved);
  }
  for (const upstream of input.upstreamResults ?? []) {
    collectResolvedContextFromUnknown(upstream.summary, resolved);
    collectResolvedContextFromUnknown(upstream.text, resolved);
    collectResolvedContextFromUnknown(upstream.data, resolved);
    collectResolvedContextFromUnknown(upstream.output, resolved);
  }

  return resolved;
};

export const formatSupervisorResolvedContext = (
  resolved: SupervisorResolvedContext,
): string =>
  Object.keys(resolved).length > 0
    ? JSON.stringify(resolved, null, 2)
    : 'None.';
