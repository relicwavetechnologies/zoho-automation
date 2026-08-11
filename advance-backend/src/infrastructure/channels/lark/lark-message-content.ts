const MAX_CARD_TEXT_CHARS = 4_000;
const MAX_CARD_DEPTH = 20;
const MAX_CARD_NODES = 500;

interface CardTextState {
  readonly parts: string[];
  readonly visited: WeakSet<object>;
  textLength: number;
  visitedNodes: number;
  stopped: boolean;
}

/**
 * Extract only text a person can see on a Lark interactive card.
 *
 * Traversal is allowlisted so action values, URLs, IDs, tokens, and other
 * hidden card state never reach the model.
 */
export function extractInteractiveCardText(card: Record<string, unknown>): string {
  const state: CardTextState = {
    parts: [],
    visited: new WeakSet<object>(),
    textLength: 0,
    visitedNodes: 0,
    stopped: false,
  };
  collectCardText(card, state, 0);
  return state.parts.join('\n');
}

function collectCardText(
  value: unknown,
  state: CardTextState,
  depth: number,
): void {
  if (state.stopped || depth > MAX_CARD_DEPTH) return;
  state.visitedNodes += 1;
  if (state.visitedNodes > MAX_CARD_NODES) {
    state.stopped = true;
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectCardText(entry, state, depth + 1);
      if (state.stopped) break;
    }
    return;
  }

  const record = recordValue(value);
  if (!record || state.visited.has(record)) return;
  state.visited.add(record);

  const tag = stringValue(record['tag']);
  if (tag === 'markdown' || tag === 'lark_md' || tag === 'plain_text') {
    addText(state, record['content']);
    return;
  }
  if (tag === 'text') {
    addText(state, record['content']);
    addText(state, record['text']);
    return;
  }

  if (tag === 'div' || tag === 'button' || tag === 'confirm') {
    collectCardText(record['text'], state, depth + 1);
  }
  if (tag === 'table') {
    collectCardText(record['columns'], state, depth + 1);
    collectTableRows(record['rows'], state, depth + 1);
    return;
  }

  for (const key of [
    'header', 'title', 'body', 'elements', 'fields', 'columns',
    'rows', 'cells', 'extra', 'confirm', 'actions', 'config', 'summary',
    'text_tag_list',
  ] as const) {
    collectCardText(record[key], state, depth + 1);
    if (state.stopped) break;
  }

  addText(state, record['display_name']);
}

function collectTableRows(value: unknown, state: CardTextState, depth: number): void {
  if (!Array.isArray(value)) return;
  for (const row of value) {
    if (state.stopped) break;
    const record = recordValue(row);
    if (!record) continue;
    for (const cell of Object.values(record)) {
      if (state.stopped) break;
      if (typeof cell === 'string' || typeof cell === 'number' || typeof cell === 'boolean') {
        addText(state, String(cell));
        continue;
      }
      collectCardText(cell, state, depth + 1);
    }
  }
}

function addText(state: CardTextState, value: unknown): void {
  const text = stringValue(value).trim();
  if (!text || state.parts[state.parts.length - 1] === text) return;

  const separatorLength = state.parts.length > 0 ? 1 : 0;
  const remaining = MAX_CARD_TEXT_CHARS - state.textLength - separatorLength;
  if (remaining <= 0) {
    state.stopped = true;
    return;
  }

  const visible = text.slice(0, remaining);
  state.parts.push(visible);
  state.textLength += separatorLength + visible.length;
  if (state.textLength >= MAX_CARD_TEXT_CHARS) state.stopped = true;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
