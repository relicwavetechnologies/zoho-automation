import { actionPhrase, toolLabel } from '../../domain/tools/tool-labels';

/**
 * What a person is being asked to approve, in words.
 *
 * The Lark card printed the raw `toolId` and `actionGroup` and a summary string
 * built ad hoc at each call site, so the approver saw "googleGmail / send" and a
 * blob. An approver cannot judge what they cannot read — this is the one place
 * a tool call becomes a sentence, used by the card, the approval inbox and the
 * desktop composer alike.
 */
export interface ToolActionDescription {
  /** Product name — "Gmail". */
  readonly tool: string;
  /** What is being asked — "Send email". */
  readonly title: string;
  /** The specifics that make it judgeable, most identifying first. */
  readonly details: ReadonlyArray<{ readonly label: string; readonly value: string }>;
}

/**
 * Argument keys worth showing an approver, in the order they help. Anything
 * outside this list is noise on a decision screen — connection ids, cursors,
 * page sizes — and the full payload is still on the approval row for audit.
 */
const DETAIL_KEYS: ReadonlyArray<readonly [key: string, label: string]> = [
  ['to', 'To'],
  ['recipient', 'To'],
  ['recipients', 'To'],
  ['cc', 'Cc'],
  ['bcc', 'Bcc'],
  ['chatId', 'Chat'],
  ['subject', 'Subject'],
  ['title', 'Title'],
  ['name', 'Name'],
  ['module', 'Module'],
  ['table', 'Table'],
  ['tableId', 'Table'],
  ['baseId', 'Base'],
  ['recordId', 'Record'],
  ['fileId', 'File'],
  ['documentId', 'Document'],
  ['spreadsheetId', 'Spreadsheet'],
  ['calendarId', 'Calendar'],
  ['query', 'Query'],
  ['amount', 'Amount'],
  ['start', 'Starts'],
  ['end', 'Ends'],
  ['body', 'Body'],
  ['text', 'Message'],
  ['message', 'Message'],
  ['content', 'Content'],
  ['fields', 'Fields'],
  ['records', 'Records'],
];

const MAX_DETAILS = 6;
const MAX_VALUE = 160;

export function describeToolAction(toolId: string, action: string, args: unknown): ToolActionDescription {
  const { name } = toolLabel(toolId);
  const flat = flattenArgs(args);
  const operation = readString(flat['nativeTool']) ?? readString(flat['op']) ?? readString(flat['operation']);

  return {
    tool: name,
    title: operation && !isRedundant(operation, action)
      ? `${actionPhrase(toolId, action)} · ${humanise(operation)}`
      : actionPhrase(toolId, action),
    details: collectDetails(flat),
  };
}

/** One line, for places that can only show a string (Lark card, logs). */
export function summariseToolAction(toolId: string, action: string, args: unknown): string {
  const described = describeToolAction(toolId, action, args);
  const detail = described.details.map(d => `${d.label}: ${d.value}`).join(' · ');
  return detail ? `${described.title} — ${detail}` : described.title;
}

/**
 * MCP-shaped tools nest the real arguments under `input`, so the interesting
 * keys sit one level down. Flatten that one level; deeper nesting is payload,
 * not summary.
 */
function flattenArgs(args: unknown): Record<string, unknown> {
  if (!isRecord(args)) return {};
  const inner = isRecord(args['input']) ? args['input'] : {};
  return { ...args, ...inner };
}

function collectDetails(flat: Record<string, unknown>): ToolActionDescription['details'] {
  const details: Array<{ label: string; value: string }> = [];
  const seen = new Set<string>();
  for (const [key, label] of DETAIL_KEYS) {
    if (details.length >= MAX_DETAILS) break;
    if (seen.has(label)) continue;
    const value = formatValue(flat[key]);
    if (!value) continue;
    seen.add(label);
    details.push({ label, value });
  }
  return details;
}

function formatValue(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (Array.isArray(value)) {
    if (!value.length) return null;
    const items = value.slice(0, 3).map(item => formatValue(item) ?? '').filter(Boolean);
    if (!items.length) return null;
    return truncate(items.join(', ') + (value.length > 3 ? ` +${value.length - 3} more` : ''));
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>);
    return keys.length ? truncate(`${keys.length} field${keys.length === 1 ? '' : 's'}: ${keys.slice(0, 5).join(', ')}`) : null;
  }
  return truncate(String(value).replace(/\s+/g, ' ').trim()) || null;
}

function truncate(value: string): string {
  return value.length > MAX_VALUE ? `${value.slice(0, MAX_VALUE - 1)}…` : value;
}

function humanise(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[._-]+/g, ' ').toLowerCase().trim();
}

/** "send" adds nothing after "Send email". */
function isRedundant(operation: string, action: string): boolean {
  return humanise(operation).replace(/\s+/g, '') === action.toLowerCase();
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
