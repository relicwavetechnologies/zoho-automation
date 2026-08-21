/**
 * A tool call, read as the object it is about to change.
 *
 * Every approval the product already had is a tool call: a toolId, an action
 * group, and the arguments the model proposed. That is enough to say which
 * product is involved and to draw the thing being written, so the branded card
 * does not wait for a new producer — the approvals flowing today gain a logo
 * and a preview the moment this runs.
 *
 * The shape is guessed from the arguments rather than declared per tool, and
 * that is the deliberate trade. A per-tool table would be more precise and
 * would be forty entries that drift; the argument keys are the same across
 * every provider because they describe the same six objects. A tool whose
 * arguments match nothing gets a subject with no preview, which draws as the
 * brand strip alone and is the honest result rather than an empty box.
 *
 * Pure. Everything here is a function over the row's own values, so the
 * projection can be asserted without a database or a provider.
 */
import { flattenArgs } from '../approval/describe-tool-action';
import { actionPhrase, toolLabel } from '../../domain/tools/tool-labels';
import type { DecisionPreview, DecisionSubject } from '../../domain/decision/decision-subject';

/** Rows listed in a table preview before the rest become a count. */
const MAX_PREVIEW_ROWS = 4;
/** Fields listed in a record preview. Beyond this it is a form, not a check. */
const MAX_PREVIEW_FIELDS = 6;
const MAX_BODY_CHARS = 600;

/**
 * Action groups whose result cannot be taken back.
 *
 * `delete` and `send` only. `create` and `update` are reversible in every
 * product Divo writes to, and marking them would put a warning on almost every
 * card, which is the same as having no warning at all.
 */
const IRREVERSIBLE_ACTIONS = new Set(['send', 'delete']);

export function subjectFromToolAction(
  toolId: string,
  action: string,
  args: unknown,
): DecisionSubject | undefined {
  const label = toolLabel(toolId);
  if (!label.brand) return undefined;

  const flat = flattenArgs(args);
  const preview = previewFrom(flat);
  const target = targetFrom(flat);

  return {
    brand: label.brand,
    action: actionPhrase(toolId, action),
    ...(target ? { target } : {}),
    ...(preview ? { preview } : {}),
    ...(IRREVERSIBLE_ACTIONS.has(action.toLowerCase()) ? { irreversible: true } : {}),
  };
}

/**
 * The most identifying thing in the arguments, as one phrase.
 *
 * Ordered by how much it tells an approver who is scanning rather than reading.
 * A subject line identifies an email better than a recipient does; a record id
 * identifies nothing on its own and is last.
 */
function targetFrom(flat: Record<string, unknown>): string | undefined {
  return str(flat['subject'])
    ?? str(flat['title'])
    ?? str(flat['name'])
    ?? str(flat['fileName'])
    ?? str(flat['range'])
    ?? str(flat['query'])
    ?? str(flat['orderId'])
    ?? str(flat['invoiceNumber'])
    ?? str(flat['recordId']);
}

/**
 * Ordered, and the order carries a rule: the more specific a shape's required
 * keys are, the earlier it is tried.
 *
 * `event` sits before `file` because a calendar create carries `title`, and
 * `file` accepts a bare title — so a meeting was rendering as a paperclip and
 * the words "New file". Anything sharing a key with a looser shape below it has
 * to be checked first.
 */
function previewFrom(flat: Record<string, unknown>): DecisionPreview | undefined {
  return message(flat) ?? money(flat) ?? table(flat) ?? event(flat) ?? record(flat) ?? file(flat);
}

function event(flat: Record<string, unknown>): DecisionPreview | undefined {
  const starts = str(flat['startTime']) ?? str(flat['start_time']) ?? str(flat['start']);
  if (!starts) return undefined;
  const title = str(flat['title']) ?? str(flat['summary']) ?? str(flat['subject']) ?? 'Untitled event';
  const ends = str(flat['endTime']) ?? str(flat['end_time']) ?? str(flat['end']);
  const location = str(flat['location']) ?? str(flat['meetingRoom']) ?? str(flat['venue']);
  const attendees = list(flat['attendees']) ?? list(flat['attendeeNames']) ?? list(flat['addNames']);
  return {
    kind: 'event',
    title,
    starts,
    ...(ends ? { ends } : {}),
    ...(location ? { location } : {}),
    ...(attendees?.length ? { attendees } : {}),
  };
}

function message(flat: Record<string, unknown>): DecisionPreview | undefined {
  const to = list(flat['to']) ?? list(flat['recipients']) ?? list(flat['recipient']);
  const body = str(flat['body']) ?? str(flat['text']) ?? str(flat['message']) ?? str(flat['content']);
  if (!to?.length || !body) return undefined;
  const cc = list(flat['cc']);
  const subject = str(flat['subject']);
  return {
    kind: 'message',
    to,
    ...(cc?.length ? { cc } : {}),
    ...(subject ? { subject } : {}),
    body: clamp(body, MAX_BODY_CHARS),
  };
}

function money(flat: Record<string, unknown>): DecisionPreview | undefined {
  const amount = str(flat['amount']) ?? num(flat['amount']) ?? str(flat['total']) ?? num(flat['total']);
  if (!amount) return undefined;
  const party = str(flat['customerName'])
    ?? str(flat['customer'])
    ?? str(flat['vendorName'])
    ?? str(flat['party'])
    ?? str(flat['contactName'])
    ?? 'Not named';
  const lines = lineItems(flat['lineItems'] ?? flat['line_items'] ?? flat['items']);
  const due = str(flat['dueDate']) ?? str(flat['due_date']) ?? str(flat['due']);
  return {
    kind: 'money',
    amount,
    party,
    lines,
    ...(due ? { due } : {}),
  };
}

function lineItems(value: unknown): { label: string; value: string }[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_PREVIEW_FIELDS).flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const label = str(entry['name']) ?? str(entry['description']) ?? str(entry['item']);
    const amount = str(entry['amount']) ?? num(entry['amount']) ?? str(entry['rate']) ?? num(entry['rate']);
    return label && amount ? [{ label, value: amount }] : [];
  });
}

/**
 * A rectangular write, drawn as the grid it is.
 *
 * `values` is the Sheets shape and `rows` is everybody else's. The first row is
 * treated as a header only when every cell in it is a non-empty string, because
 * a sheet append whose first row is data would otherwise lose that row into the
 * header and show an approver one row fewer than is being written.
 */
function table(flat: Record<string, unknown>): DecisionPreview | undefined {
  const raw = flat['values'] ?? flat['rows'];
  if (!Array.isArray(raw) || !raw.length) return undefined;
  const grid = raw.filter(Array.isArray).map((row) => (row as unknown[]).map(cell));
  if (!grid.length) return undefined;

  const headed = grid.length > 1 && grid[0]!.every((value) => value.length > 0);
  const columns = headed ? grid[0]! : grid[0]!.map((_, index) => `Column ${index + 1}`);
  const body = headed ? grid.slice(1) : grid;
  const shown = body.slice(0, MAX_PREVIEW_ROWS);
  const range = str(flat['range']) ?? str(flat['a1Range']);

  return {
    kind: 'table',
    ...(range ? { range } : {}),
    columns,
    rows: shown,
    ...(body.length > shown.length ? { more: body.length - shown.length } : {}),
  };
}

function record(flat: Record<string, unknown>): DecisionPreview | undefined {
  const fields = flat['fields'] ?? flat['record'] ?? flat['data'];
  const entries = fieldEntries(fields);
  if (!entries.length) return undefined;
  const collection = str(flat['table'])
    ?? str(flat['tableName'])
    ?? str(flat['module'])
    ?? str(flat['datasheetName'])
    ?? 'Record';
  return { kind: 'record', collection, fields: entries };
}

function fieldEntries(value: unknown): { name: string; value: string }[] {
  if (isRecord(value)) {
    return Object.entries(value)
      .slice(0, MAX_PREVIEW_FIELDS)
      .map(([name, entry]) => ({ name, value: cell(entry) }))
      .filter((entry) => entry.value.length > 0);
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_PREVIEW_FIELDS)
      .flatMap((entry) => {
        if (!isRecord(entry)) return [];
        const name = str(entry['name']) ?? str(entry['field']);
        const raw = entry['value'] ?? entry['newValue'];
        return name && raw !== undefined ? [{ name, value: cell(raw) }] : [];
      });
  }
  return [];
}

/**
 * Last, and the loosest, so it only sees what nothing above it claimed.
 *
 * `title` is deliberately still accepted — a Drive create names its file that
 * way — but by the time this runs, anything with a start time has already left
 * as an event.
 */
function file(flat: Record<string, unknown>): DecisionPreview | undefined {
  const name = str(flat['fileName']) ?? str(flat['name']) ?? str(flat['title']);
  if (!name) return undefined;
  const mimeType = str(flat['mimeType']);
  const size = str(flat['size']) ?? num(flat['size']);
  const detail = [mimeType, size].filter(Boolean).join(' · ') || 'New file';
  const sharedWith = list(flat['shareWith']) ?? list(flat['emailAddress']) ?? list(flat['permissions']);
  return {
    kind: 'file',
    name,
    detail,
    ...(sharedWith?.length ? { sharedWith } : {}),
  };
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function num(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined;
}

function list(value: unknown): string[] | undefined {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : undefined;
  if (!Array.isArray(value)) return undefined;
  const items = value.map((entry) => str(entry) ?? (isRecord(entry) ? str(entry['email']) : undefined))
    .filter((entry): entry is string => Boolean(entry));
  return items.length ? items : undefined;
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return clamp(value.replace(/\s+/g, ' ').trim(), 80);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return clamp(JSON.stringify(value), 80);
}

function clamp(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
