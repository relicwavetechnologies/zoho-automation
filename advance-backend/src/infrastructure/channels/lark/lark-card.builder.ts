/**
 * Lark card schema v2 builder.
 * Ported from old backend lark.adapter.ts markdown helpers; extended with dynamic department branding.
 */

import type {
  ChannelBranding,
  ChannelLedgerRow,
  ChannelPlanStepStatus,
  ChannelRunState,
  ChannelTimeline,
  InteractiveAction,
} from '../../../domain/channel/outbound';

// ── Constants ────────────────────────────────────────────────────────────────

const CARD_TITLE       = 'Divo AI';
const MAX_ELEMENT_LEN  = 1200;
const MAX_ELEMENTS     = 30;
const MAX_TABLE_ROWS   = 15;
const MAX_CARD_BYTES   = 18_000;
const MAX_TABLES_PER_CARD = 3;
const SUMMARY_CAP      = 160;

// ── Department → chip color ─────────────────────────────────────────────────

const DEPT_COLORS: Array<[RegExp, ChannelBranding['departmentColor']]> = [
  [/finance|books|accounting/i,     'green'],
  [/sales|crm/i,                    'blue'],
  [/marketing|growth/i,             'purple'],
  [/engineering|tech|product/i,     'turquoise'],
  [/ops|operations|admin/i,         'orange'],
  [/hr|people/i,                    'red'],
];

export function pickDeptColor(label: string | undefined): ChannelBranding['departmentColor'] {
  if (!label) return 'grey';
  for (const [pattern, color] of DEPT_COLORS) {
    if (pattern.test(label)) return color;
  }
  return 'grey';
}

// ── Markdown helpers (direct port from old backend) ──────────────────────────

function normalizeMd(value: string): string {
  return (value ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

export function stripDecorators(value: string): string {
  return (value ?? '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_~`>#-]+/g, ' ')
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Strip inline markdown for Lark native table cells (data_type: text does not render **). */
export function stripMarkdownInline(value: string): string {
  let s = (value ?? '').trim();
  for (let i = 0; i < 4; i++) {
    s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
  }
  s = s.replace(/\*\*/g, '');
  s = s.replace(/__([^_]+)__/g, '$1');
  s = s.replace(/\*([^*]+)\*/g, '$1');
  s = s.replace(/_([^_]+)_/g, '$1');
  s = s.replace(/`([^`]+)`/g, '$1');
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  return s.replace(/\s+/g, ' ').trim();
}

function extractTitleAndBody(markdown: string): { title: string; body: string } {
  const normalized = normalizeMd(markdown);
  if (!normalized) return { title: CARD_TITLE, body: 'No content available.' };

  const lines = normalized.split('\n');
  const firstNonEmpty = lines.findIndex(l => l.trim().length > 0);
  if (firstNonEmpty === -1) return { title: CARD_TITLE, body: 'No content available.' };

  const firstLine = lines[firstNonEmpty]!.trim();
  const headingMatch = firstLine.match(/^#\s+(.+)$/);
  if (!headingMatch) return { title: CARD_TITLE, body: normalized };

  const body = lines
    .slice(0, firstNonEmpty)
    .concat(lines.slice(firstNonEmpty + 1))
    .join('\n')
    .trim();

  return {
    title: headingMatch[1]!.trim() || CARD_TITLE,
    body:  body || normalized,
  };
}

function buildSummary(title: string, body: string): string {
  const src = stripDecorators(body) || stripDecorators(title) || CARD_TITLE;
  return src.length <= SUMMARY_CAP ? src : `${src.slice(0, SUMMARY_CAP - 3)}...`;
}

function mdElement(content: string, opts?: { margin?: string }): Record<string, unknown> {
  return {
    tag:       'markdown',
    content,
    text_size: 'normal',
    ...(opts?.margin ? { margin: opts.margin } : {}),
  };
}

function hrElement(margin = '4px 0 0 0'): Record<string, unknown> {
  return { tag: 'hr', margin };
}

// ── Status card: one fact, one place ─────────────────────────────────────────

/**
 * The status card's whole design rule is that each fact appears exactly once:
 *
 *   what was asked  → header title
 *   run state       → header chip
 *   what's happening now → the single `●` activity row
 *   how much work   → footer counter
 *   the plan        → folded panel
 *
 * The card this replaced broke that rule in three places at once: the header
 * said "Thinking…", the body said "Understanding your request", and the meta
 * line said "● Thinking · 13s" — three lines carrying one fact. Anything added
 * here has to claim a cell of that table or it does not belong on the card.
 */

/**
 * Visible activity rows; older ones collapse into a counted note, never dropped
 * silently. The window counts what the model said as well as what it did, so it
 * is wider than the five it held when only tool calls could appear here — five
 * interleaved rows is barely two steps of context.
 */
const ACTIVITY_VISIBLE_ROWS = 9;
const ACTIVITY_DETAIL_MAX   = 64;
const ACTIVITY_SAY_MAX      = 200;
const TODO_VISIBLE_ROWS     = 8;

const RUN_STATE_WORD: Record<ChannelRunState, string> = {
  queued:   'Queued',
  thinking: 'Thinking',
  planning: 'Planning',
  working:  'Working',
  writing:  'Writing',
  done:     'Done',
  blocked:  'Stopped',
};

/**
 * Chip colours, kept deliberately flat: everything in flight is the same neutral
 * grey, and colour is spent only where it means something — finished, or failed.
 */
const RUN_STATE_CHIP: Record<ChannelRunState, string> = {
  queued:   'neutral',
  thinking: 'neutral',
  planning: 'neutral',
  working:  'neutral',
  writing:  'neutral',
  done:     'green',
  blocked:  'red',
};

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const mins = Math.floor(total / 60);
  return `${mins}m ${String(total % 60).padStart(2, '0')}s`;
}

function actionsPhrase(count: number): string {
  return `${count} step${count === 1 ? '' : 's'}`;
}

/**
 * The footer counter: how much work, and for how long. It deliberately carries
 * no fraction — a denominator only exists when a checklist was declared, and
 * that lives on the plan panel where the checklist itself is.
 */
export function statusCounterText(timeline: ChannelTimeline, now = Date.now()): string {
  const parts: string[] = [];
  const count = timeline.actionCount ?? 0;

  if (count > 0) parts.push(actionsPhrase(count));
  if (timeline.startedAtMs !== undefined) {
    parts.push(formatElapsed(Math.max(0, now - timeline.startedAtMs)));
  }
  return parts.join(' · ');
}

/**
 * Header title: what the user asked for. The state is a chip beside it and the
 * bot's name is printed above every card by the client, so neither belongs here
 * — the title is the one line that makes a chat full of Divo cards scannable.
 */
function statusHeaderTitle(timeline?: ChannelTimeline): string {
  const subject = timeline?.subject?.trim();
  if (subject) return subject;
  return statusStateTitle(timeline);
}

function statusStateTitle(timeline?: ChannelTimeline): string {
  const state = timeline?.state;
  if (!state) return CARD_TITLE;
  if (state === 'blocked') return 'Couldn’t finish';
  if (state === 'done')    return 'Done';
  return `${RUN_STATE_WORD[state]}…`;
}

/**
 * Text from a run, made safe to sit inside the card's own markup.
 *
 * Activity detail is now a bash command or a sentence the model wrote, and both
 * land inside a `<font color='grey'>` the card opened. An angle bracket in a
 * shell pipeline would close that tag early and take the rest of the card's
 * structure with it, so the two characters that can do it are removed; a
 * backtick is dropped for the same reason against code spans. Emphasis
 * characters are left alone — stripping them would rewrite `my_file.txt`, and
 * the worst they do is italicise part of a line.
 */
export function sanitizeRunText(value: string, maxLength: number): string {
  const flat = value
    .replace(/[<>`]/g, '')
    .replace(/\s+/g, ' ')
    // The model's final answer streams through the same channel as its
    // narration, so a line here can begin with that answer's opening heading.
    // Left alone, one sentence of a run log renders at heading size and the
    // rest of the card looks like its caption.
    .replace(/^\s*(?:#{1,6}|>|\*\*)\s*/, '')
    .trim();
  return flat.length > maxLength ? `${flat.slice(0, maxLength - 1)}…` : flat;
}

function truncateOutcome(value: string): string {
  return sanitizeRunText(value, ACTIVITY_DETAIL_MAX);
}

const STEP_MARKERS: Record<ChannelPlanStepStatus, string> = {
  pending: '○',
  running: '●',
  done:    '✓',
  failed:  '✗',
  skipped: '–',
};

/**
 * `✓ **Web search**  4 results` — marker, what ran, what it produced.
 *
 * A `say` row is the exception and carries none of that furniture: it is a
 * sentence the model wrote for the user, and putting a status marker and bold
 * label on it would dress a human sentence as a machine event. It is simply
 * the line, indented to sit under nothing.
 */
function activityLine(row: ChannelLedgerRow, indent: string): string {
  if (row.kind === 'say') {
    return `${indent}${sanitizeRunText(row.label, ACTIVITY_SAY_MAX)}`;
  }
  const marker = STEP_MARKERS[row.status];
  const calls  = row.count > 1 ? ` <font color='grey'>×${row.count}</font>` : '';
  const detail = row.outcome?.trim()
    ? `  <font color='grey'>${truncateOutcome(row.outcome)}</font>`
    : '';
  return `${indent}${marker} **${row.label}**${calls}${detail}`;
}

/**
 * Repeated identical steps, folded into one row that counts them.
 *
 * Paging a table nineteen times is one act, and printing it as nineteen rows
 * buries everything else the run did. Only rows that are *adjacent* and say the
 * same thing fold — a step that happened after the model spoke belongs after
 * what it said, and reordering it to join an earlier group would destroy the
 * chronology the log exists to show. Two calls to the same tool doing different
 * work stay apart, because they are not the same act.
 *
 * The merged status is the worst one present: a failure hidden inside a group
 * marked ✓ is exactly the thing a run log must not do.
 */
export function foldRepeatedRows(
  rows: readonly ChannelLedgerRow[],
): readonly ChannelLedgerRow[] {
  const folded: ChannelLedgerRow[] = [];
  for (const row of rows) {
    const last = folded[folded.length - 1];
    const mergeable = last
      && row.kind !== 'say' && last.kind !== 'say'
      && last.label === row.label
      && (last.outcome ?? '') === (row.outcome ?? '')
      && !last.children && !row.children;
    if (!mergeable) {
      folded.push(row);
      continue;
    }
    folded[folded.length - 1] = {
      ...last,
      count: last.count + row.count,
      status: last.status === 'failed' || row.status === 'failed'
        ? 'failed'
        : last.status === 'running' || row.status === 'running'
          ? 'running'
          : row.status,
    };
  }
  return folded;
}

/**
 * The activity list: one line per step, newest last, each child indented under
 * the step that farmed it out.
 *
 * Only the tail is shown. Older steps collapse into a count rather than being
 * dropped, because a card that silently forgets what it did is worse than a
 * card that admits it is showing the last five things.
 */
function activityMarkdown(timeline: ChannelTimeline): string | undefined {
  const rows = timeline.ledger?.length ? foldRepeatedRows(timeline.ledger) : undefined;
  if (!rows?.length) return undefined;

  const hidden  = Math.max(0, rows.length - ACTIVITY_VISIBLE_ROWS);
  const visible = hidden > 0 ? rows.slice(-ACTIVITY_VISIBLE_ROWS) : rows;
  const lines: string[] = [];

  if (hidden > 0) {
    lines.push(`<font color='grey'>+${hidden} earlier step${hidden === 1 ? '' : 's'}</font>`);
  }
  for (const row of visible) {
    lines.push(activityLine(row, ''));
    for (const child of row.children ?? []) {
      lines.push(activityLine(child, '　└ '));
    }
  }
  return lines.join('\n');
}

/**
 * The plan, folded.
 *
 * Its header already names where the run is, so the panel stays shut in the
 * normal case and the checklist costs one line. Opening it is for the user who
 * wants to see the rest, not something the card decides for them.
 */
function planPanel(timeline: ChannelTimeline): Record<string, unknown> | undefined {
  const declared = timeline.declared;
  if (!declared || declared.total <= 0) return undefined;

  const items = declared.items ?? [];
  const focus = declared.current ?? declared.next;
  const heading = [
    `**Plan**`,
    `<font color='grey'>${Math.min(declared.done, declared.total)} of ${declared.total}`
      + `${focus ? ` · ${truncateOutcome(focus)}` : ''}</font>`,
  ].join('  ');

  // With no named steps there is nothing behind the fold, so the plan is just a
  // line. A panel that opens onto its own title is a worse version of no panel.
  if (items.length === 0) {
    return { tag: 'markdown', element_id: 'run_plan', content: heading, text_size: 'notation' };
  }

  const hidden  = Math.max(0, items.length - TODO_VISIBLE_ROWS);
  const visible = hidden > 0 ? items.slice(0, TODO_VISIBLE_ROWS) : items;
  const body = [
    ...visible.map(item => {
      const title = item.status === 'done'
        ? `<font color='grey'>${item.title}</font>`
        : item.title;
      return `${STEP_MARKERS[item.status]} ${title}`;
    }),
    ...(hidden > 0 ? [`<font color='grey'>+${hidden} more</font>`] : []),
  ].join('\n');

  return {
    tag:        'collapsible_panel',
    element_id: 'run_plan',
    expanded:   false,
    padding:    '0px',
    header: {
      title:               { tag: 'markdown', content: heading },
      icon:                { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '12px 12px', color: 'grey' },
      icon_position:       'right',
      icon_expanded_angle: -180,
      width:               'auto_when_fold',
      padding:             '0px',
    },
    elements: [{
      tag: 'markdown', content: body, text_size: 'notation', margin: '4px 0 0 12px',
    }],
  };
}

/**
 * Phase words the header chip already carries. A live label that is only one of
 * these says nothing the chip has not said, and printing it is exactly the
 * "Thinking… / Thinking" doubling this card exists to remove.
 */
const PHASE_ECHO = new Set([
  'thinking', 'planning', 'working', 'working on your request', 'queued',
  'preparing response', 'preparing your response', 'writing', 'writing your answer',
  'continuing', 'understanding your request', 'getting things ready',
  'done', 'failed', 'blocked',
]);

function normalizeLive(value: string): string {
  return value.replace(/…+$/u, '').trim().toLowerCase();
}

/**
 * What the agent is saying right now.
 *
 * This is the one line that carries the model's own voice, so it is shown only
 * when no step is running — a running step already occupies that role, and the
 * two together is the same sentence twice in different words.
 */
function narrationMarkdown(timeline: ChannelTimeline): string | undefined {
  const active = timeline.narrationActive?.trim() || timeline.liveLabel?.trim();
  if (!active) return undefined;
  if (timeline.ledger?.some(row => row.status === 'running')) return undefined;

  const headline = active.replace(/…+$/u, '').trim() || active;
  if (PHASE_ECHO.has(normalizeLive(headline))) return undefined;
  return `<font color='grey'>${sanitizeRunText(headline, MAX_ELEMENT_LEN)}</font>`;
}

function collapsiblePanel(
  elementId: string,
  title: string,
  content: string,
  expanded: boolean,
): Record<string, unknown> {
  return {
    tag:      'collapsible_panel',
    element_id: elementId,
    expanded,
    header:   {
      title: { tag: 'plain_text', content: title },
      icon:  {
        tag:   'standard_icon',
        token: 'down-small-ccm_outlined',
        size:  '14px 14px',
      },
      icon_position:         'right',
      icon_expanded_angle:   -180,
    },
    padding:  '8px',
    elements: [{ tag: 'markdown', content, text_size: 'normal' }],
  };
}

interface ParsedMarkdownTable {
  columns: Array<{ name: string; display_name: string }>;
  rows:    Array<Record<string, string>>;
}

interface MarkdownBodyBlock {
  kind: 'markdown';
  markdown: string;
}

interface TableBodyBlock {
  kind: 'table';
  markdown: string;
  parsed: ParsedMarkdownTable;
  totalRows: number;
}

type FinalCardBodyBlock = MarkdownBodyBlock | TableBodyBlock;

function slugColumnName(header: string, index: number): string {
  const slug = header.replace(/\s+/g, '_').toLowerCase().replace(/[^a-z0-9_]/g, '');
  return slug || `col_${index}`;
}

function parseMarkdownTable(block: string): ParsedMarkdownTable | null {
  const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 3 || !lines[0]!.includes('|')) return null;
  if (!TABLE_SEP.test(lines[1] ?? '')) return null;

  const parseRow = (line: string) =>
    line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());

  const headers = parseRow(lines[0]!);
  const columns = headers.map((h, i) => ({
    name:         slugColumnName(stripMarkdownInline(h), i),
    display_name: stripMarkdownInline(h),
  }));

  const rows = lines.slice(2).map(line => {
    const cells = parseRow(line);
    const row: Record<string, string> = {};
    columns.forEach((col, i) => {
      row[col.name] = stripMarkdownInline(cells[i] ?? '');
    });
    return row;
  });

  if (rows.length === 0) return null;
  return { columns, rows };
}

function tableElement(parsed: ParsedMarkdownTable, elementId: string): Record<string, unknown> {
  return {
    tag:          'table',
    element_id:   elementId,
    page_size:    Math.min(10, Math.max(1, parsed.rows.length)),
    row_height:   'low',
    header_style: { bold: true, text_color: 'grey' },
    columns:      parsed.columns.map(c => ({
      name:         c.name,
      display_name: c.display_name,
      data_type:    'text',
      width:        'auto',
    })),
    rows: parsed.rows,
  };
}

/**
 * Lark's card markdown renders no `#` headings, so they are rewritten as bold.
 *
 * The capture is lazy and the trailing run is matched outside it because two
 * trailing spaces is markdown's hard line break — correct output from a model,
 * and greedily capturing it produced `**Title  **`, which CommonMark refuses to
 * close and Lark therefore printed with its asterisks showing.
 *
 * Depth goes to six, matching `stripDecorators` and `ensureTableSeparation`;
 * stopping at three left `#### Heading` on the card as literal hashes.
 */
function softenHeadings(md: string): string {
  return md.replace(/^#{1,6}[ \t]+(.+?)[ \t]*$/gm, '**$1**');
}

function ensureTableSeparation(text: string): string {
  return text.replace(
    /^(\*\*.+\*\*|#{1,6}\s+.+)\n(\|.+\|)/gm,
    '$1\n\n$2',
  );
}

function parseBodyBlocks(body: string): FinalCardBodyBlock[] {
  const normalized = normalizeMd(body);
  if (!normalized) return [{ kind: 'markdown', markdown: 'No content available.' }];

  const preprocessed = ensureTableSeparation(normalized);
  const blocks = preprocessed.split(/\n{2,}/).map(b => b.trim()).filter(Boolean);
  const parsedBlocks: FinalCardBodyBlock[] = [];

  for (const block of blocks) {
    if (isTable(block)) {
      const parsed = parseMarkdownTable(block);
      if (parsed) {
        parsedBlocks.push({
          kind: 'table',
          markdown: block,
          parsed,
          totalRows: parsed.rows.length,
        });
        continue;
      }
    }
    const softened = softenHeadings(block);
    const chunks = softened.length <= MAX_ELEMENT_LEN ? [softened] : splitMarkdown(softened);
    for (const chunk of chunks) {
      parsedBlocks.push({ kind: 'markdown', markdown: chunk });
    }
  }

  return parsedBlocks.length > 0 ? parsedBlocks : [{ kind: 'markdown', markdown: 'No content available.' }];
}

function bodyBlocksToElements(blocks: readonly FinalCardBodyBlock[]): { elements: Record<string, unknown>[]; tableCount: number } {
  const elements: Record<string, unknown>[] = [];
  let tableIdx = 0;

  for (const block of blocks) {
    if (block.kind === 'table') {
      const capped = block.totalRows > MAX_TABLE_ROWS
        ? { columns: block.parsed.columns, rows: block.parsed.rows.slice(0, MAX_TABLE_ROWS) }
        : block.parsed;
      elements.push(tableElement(capped, `data_table_${++tableIdx}`));
      if (block.totalRows > MAX_TABLE_ROWS) {
        elements.push(mdElement(
          `_Showing ${MAX_TABLE_ROWS} of ${block.totalRows} rows._`,
          { margin: '4px 0 0 0' },
        ));
      }
      continue;
    }
    elements.push(mdElement(block.markdown, elements.length > 0 ? { margin: '8px 0 0 0' } : undefined));
  }

  return {
    elements: elements.length > 0 ? elements : [mdElement('No content available.')],
    tableCount: tableIdx,
  };
}

function traceToCollapsible(trace: string): Record<string, unknown> {
  const content = trace
    .replace(/^---\s*\n?/m, '')
    .replace(/^\*\*Trace\*\*/m, '**Execution trace**')
    .trim();
  return collapsiblePanel('exec_trace', 'Execution trace', content, false);
}

// ── Markdown chunker (direct port from old backend) ──────────────────────────

const TABLE_SEP = /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/;

function isTable(block: string): boolean {
  const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
  return lines.length >= 3 && !!lines[0]?.includes('|') && TABLE_SEP.test(lines[1] ?? '');
}

function splitTable(block: string): string[] {
  const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 3) return [block];
  const [header, separator, ...rows] = lines;
  const prefix = `${header}\n${separator}`;
  if (prefix.length >= MAX_ELEMENT_LEN) return [block];
  const chunks: string[] = [];
  let current = prefix;
  for (const row of rows) {
    const candidate = `${current}\n${row}`;
    if (candidate.length <= MAX_ELEMENT_LEN) { current = candidate; continue; }
    chunks.push(current);
    current = `${prefix}\n${row}`;
  }
  if (current) chunks.push(current);
  return chunks;
}

export function splitMarkdown(content: string): string[] {
  const normalized = normalizeMd(content);
  if (!normalized) return ['No content available.'];

  const blocks = normalized.split(/\n{2,}/).map(b => b.trim()).filter(Boolean);
  if (blocks.length === 0) return [normalized];

  const chunks: string[] = [];
  let current = '';

  for (const block of blocks) {
    if (isTable(block)) {
      if (current) { chunks.push(current); current = ''; }
      chunks.push(...splitTable(block));
      continue;
    }
    const candidate = current ? `${current}\n\n${block}` : block;
    if (candidate.length <= MAX_ELEMENT_LEN) { current = candidate; continue; }
    if (current) { chunks.push(current); current = ''; }
    if (block.length <= MAX_ELEMENT_LEN) { current = block; continue; }

    const lines = block.split('\n');
    let lineChunk = '';
    for (const line of lines) {
      const next = lineChunk ? `${lineChunk}\n${line}` : line;
      if (next.length <= MAX_ELEMENT_LEN) { lineChunk = next; continue; }
      if (lineChunk) chunks.push(lineChunk);
      if (line.length <= MAX_ELEMENT_LEN) { lineChunk = line; continue; }
      for (let i = 0; i < line.length; i += MAX_ELEMENT_LEN) chunks.push(line.slice(i, i + MAX_ELEMENT_LEN));
      lineChunk = '';
    }
    if (lineChunk) current = lineChunk;
  }
  if (current) chunks.push(current);

  if (chunks.length <= MAX_ELEMENTS) return chunks;
  const kept = chunks.slice(0, MAX_ELEMENTS - 1);
  const overflow = chunks.slice(MAX_ELEMENTS - 1).join('\n\n');
  kept.push(`${overflow.slice(0, MAX_ELEMENT_LEN - 32)}\n\n_Continued in follow-up if needed._`);
  return kept;
}

// ── Card v2 header ────────────────────────────────────────────────────────────

/**
 * The department chip, and nothing else by default.
 *
 * Lark prints the sender's name and its Agent badge directly above every card,
 * so a header that says "Divo AI" and wears a "Divo" tag spends the widest line
 * of the card repeating what the client already rendered twice. The chip
 * survives only when a real department is set — which is information the client
 * does not have.
 */
function buildHeader(
  title: string | undefined,
  branding: ChannelBranding | undefined,
): Record<string, unknown> | undefined {
  const label = branding?.departmentLabel?.trim();
  const chip = label && label.toLowerCase() !== 'divo'
    ? [{
        tag:   'text_tag',
        text:  { tag: 'plain_text', content: label },
        color: branding?.departmentColor ?? pickDeptColor(label),
      }]
    : [];

  if (!title && chip.length === 0) return undefined;
  return {
    template: 'default',
    ...(title ? { title: { tag: 'plain_text', content: title } } : {}),
    ...(chip.length > 0 ? { text_tag_list: chip } : {}),
  };
}

// ── Final reply card ─────────────────────────────────────────────────────────

export interface FinalCardInput {
  markdown:        string;
  branding?:       ChannelBranding;
  actions?:        readonly InteractiveAction[];
  executionTrace?: string;
}

export interface FinalCardSegment {
  markdown: string;
  payload: string;
  partIndex: number;
  partCount: number;
  tableCount: number;
  usedCondensedFallback: boolean;
}

export interface CallbackCardAction {
  label: string;
  value: Record<string, unknown>;
  style?: 'default' | 'primary' | 'danger';
  confirm?: {
    title: string;
    text: string;
  };
}

export interface CallbackCardInput {
  title: string;
  template?: 'default' | 'blue' | 'green' | 'grey' | 'red' | 'orange' | 'purple' | 'turquoise';
  markdownBlocks: readonly string[];
  note?: string;
  actions?: readonly CallbackCardAction[];
}

/**
 * Builds interactive Card 2.0 payloads through the same markdown and action
 * primitives as ordinary Divo replies. Callback values are authenticated by
 * the webhook; this function owns presentation only.
 */
export function buildCallbackCard(input: CallbackCardInput): string {
  const elements: Record<string, unknown>[] = [];
  for (const block of input.markdownBlocks) {
    for (const chunk of splitMarkdown(softenHeadings(block))) {
      elements.push(mdElement(chunk, elements.length > 0 ? { margin: '8px 0 0 0' } : undefined));
    }
  }
  if (input.note?.trim()) {
    elements.push(mdElement(`_${input.note.trim()}_`, { margin: '12px 0 0 0' }));
  }
  if (input.actions?.length) {
    elements.push({
      tag: 'column_set',
      element_id: 'callback_actions',
      margin: '12px 0 0 0',
      flex_mode: 'flow',
      horizontal_spacing: '8px',
      columns: input.actions.map((action, index) => ({
        tag: 'column',
        width: 'auto',
        elements: [{
          tag: 'button',
          element_id: `callback_action_${index + 1}`,
          text: { tag: 'plain_text', content: action.label },
          type: action.style ?? 'default',
          behaviors: [{ type: 'callback', value: action.value }],
          ...(action.confirm ? {
            confirm: {
              title: { tag: 'plain_text', content: action.confirm.title },
              text: { tag: 'plain_text', content: action.confirm.text },
            },
          } : {}),
        }],
      })),
    });
  }

  const card = {
    schema: '2.0',
    config: {
      width_mode: 'fill',
      update_multi: true,
      enable_forward: false,
      summary: { content: buildSummary(input.title, input.markdownBlocks.join('\n\n')) },
    },
    header: {
      title: { tag: 'plain_text', content: input.title },
      template: input.template ?? 'default',
    },
    body: {
      vertical_spacing: '8px',
      padding: '12px 12px 12px 12px',
      elements,
    },
  };
  return JSON.stringify({ msg_type: 'interactive', card: JSON.stringify(card) });
}

interface BuildFinalCardResult {
  payload: string;
  tableCount: number;
  usedCondensedFallback: boolean;
}

function blocksToMarkdown(blocks: readonly FinalCardBodyBlock[]): string {
  return blocks.map(block => block.markdown).join('\n\n').trim();
}

/**
 * The heading the answer declared, promoted to the header title. When the reply
 * has no heading there is nothing to promote, and the card goes out headerless.
 */
function buildFinalTitle(title: string): string | undefined {
  return title !== CARD_TITLE ? title : undefined;
}

function isRuleSeparator(line: string): boolean {
  return /^-{3,}$/.test(line.trim());
}

function splitBodySections(body: string): string[] {
  const normalized = normalizeMd(body);
  if (!normalized) return ['No content available.'];

  const sections: string[] = [];
  let current: string[] = [];

  for (const line of normalized.split('\n')) {
    if (isRuleSeparator(line)) {
      if (current.length > 0) {
        sections.push(current.join('\n').trim());
        current = [];
      }
      current.push(line.trim());
      continue;
    }
    current.push(line);
  }

  if (current.length > 0) sections.push(current.join('\n').trim());
  return sections.map(section => section.trim()).filter(Boolean);
}

function isHeadingLikeMarkdown(markdown: string): boolean {
  const trimmed = markdown.trim();
  return !trimmed.includes('\n') && /^\*\*[^*].+\*\*$/.test(trimmed);
}

function buildPlanningUnits(blocks: readonly FinalCardBodyBlock[]): FinalCardBodyBlock[][] {
  const units: FinalCardBodyBlock[][] = [];

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]!;
    const nextBlock = blocks[index + 1];

    if (block.kind === 'markdown' && isHeadingLikeMarkdown(block.markdown) && nextBlock?.kind === 'table') {
      units.push([block, nextBlock]);
      index += 1;
      continue;
    }

    units.push([block]);
  }

  return units;
}

function flattenPlanningUnits(units: readonly FinalCardBodyBlock[][]): FinalCardBodyBlock[] {
  return units.flatMap(unit => unit);
}

function serializeFinalCard(
  elements: readonly Record<string, unknown>[],
  summaryContent: string,
  title: string | undefined,
  branding: ChannelBranding | undefined,
): string {
  // A plain answer gets no header at all — the body is the whole message, and a
  // one-line reply under a title bar reads like a form, not a reply.
  const header = buildHeader(title, branding);
  const card = {
    schema: '2.0',
    config: { width_mode: 'fill', update_multi: true, enable_forward: true, summary: { content: summaryContent } },
    ...(header ? { header } : {}),
    body: { vertical_spacing: '8px', padding: '12px 12px 12px 12px', elements },
  };
  return JSON.stringify({ msg_type: 'interactive', card: JSON.stringify(card) });
}

function buildFinalCardResult(input: FinalCardInput & {
  bodyTitle?: string;
  bodyText?: string;
  bodyBlocks?: readonly FinalCardBodyBlock[];
  allowCondensedFallback?: boolean;
}): BuildFinalCardResult {
  const { markdown, branding, actions, executionTrace } = input;
  const { title, body } = extractTitleAndBody(markdown);
  const normalizedBody = input.bodyText ?? normalizeMd(input.bodyText ?? body);
  const bodyTitle = input.bodyTitle ?? title;
  const bodyBlocks = input.bodyBlocks ?? parseBodyBlocks(normalizedBody);
  const rendered = bodyBlocksToElements(bodyBlocks);
  const elements = [...rendered.elements];

  if (executionTrace) {
    elements.push(hrElement('12px 0 0 0'));
    elements.push(traceToCollapsible(executionTrace));
  }

  // Card 2.0 has no `action` container and ignores 1.0's `value` on a button —
  // callbacks must be declared through `behaviors`, buttons sit in `elements`.
  if (actions?.length) {
    elements.push({
      tag:                'column_set',
      element_id:         'final_actions',
      margin:             '8px 0 0 0',
      flex_mode:          'flow',
      horizontal_spacing: '8px',
      columns: actions.map((a, i) => ({
        tag:      'column',
        width:    'auto',
        elements: [{
          tag:        'button',
          element_id: `action_${i + 1}`,
          text:       { tag: 'plain_text', content: a.label },
          type:       a.style === 'primary' ? 'primary' : a.style === 'danger' ? 'danger' : 'default',
          size:       'small',
          behaviors:  a.url
            ? [{ type: 'open_url', default_url: a.url }]
            : [{ type: 'callback', value: { action: a.value } }],
        }],
      })),
    });
  }

  const summaryContent = buildSummary(bodyTitle, normalizedBody);
  const headerTitle = buildFinalTitle(bodyTitle);
  const serialized = serializeFinalCard(elements, summaryContent, headerTitle, branding);
  if (serialized.length <= MAX_CARD_BYTES) {
    return { payload: serialized, tableCount: rendered.tableCount, usedCondensedFallback: false };
  }
  if (input.allowCondensedFallback === false) {
    return { payload: serialized, tableCount: rendered.tableCount, usedCondensedFallback: true };
  }

  // Card too large — rebuild with text-only body (tables stripped, capped)
  const textOnly = normalizedBody
    .replace(/\|[^\n]+\|/g, '')
    .replace(/^[-:|\s]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 2000);
  const fallbackElements: Record<string, unknown>[] = [
    mdElement(`${textOnly}\n\n_Response condensed for card display._`),
  ];
  if (executionTrace) {
    fallbackElements.push(hrElement('12px 0 0 0'));
    fallbackElements.push(traceToCollapsible(executionTrace));
  }
  return {
    payload: serializeFinalCard(fallbackElements, summaryContent, headerTitle, branding),
    tableCount: rendered.tableCount,
    usedCondensedFallback: true,
  };
}

export function buildFinalCard(input: FinalCardInput): string {
  return buildFinalCardResult(input).payload;
}

export function planFinalCards(
  input: FinalCardInput,
  opts?: { maxTablesPerCard?: number },
): FinalCardSegment[] {
  const { title, body } = extractTitleAndBody(input.markdown);
  const normalizedBody = normalizeMd(body);
  const blocks = parseBodyBlocks(normalizedBody);
  const maxTables = opts?.maxTablesPerCard ?? MAX_TABLES_PER_CARD;

  const fullCard = buildFinalCardResult({
    ...input,
    bodyTitle: title,
    bodyText: normalizedBody,
    bodyBlocks: blocks,
    allowCondensedFallback: false,
  });

  if (fullCard.tableCount <= maxTables && !fullCard.usedCondensedFallback) {
    return [{
      markdown: input.markdown,
      payload: buildFinalCardResult({
        ...input,
        bodyTitle: title,
        bodyText: normalizedBody,
        bodyBlocks: blocks,
      }).payload,
      partIndex: 1,
      partCount: 1,
      tableCount: fullCard.tableCount,
      usedCondensedFallback: false,
    }];
  }

  const planningUnits: FinalCardBodyBlock[][] = [];
  for (const sectionText of splitBodySections(normalizedBody)) {
    const sectionBlocks = parseBodyBlocks(sectionText);
    const sectionBuild = buildFinalCardResult({
      markdown: title !== CARD_TITLE ? `# ${title}\n\n${sectionText}` : sectionText,
      ...(input.branding ? { branding: input.branding } : {}),
      bodyTitle: title,
      bodyText: sectionText,
      bodyBlocks: sectionBlocks,
      allowCondensedFallback: false,
    });

    if (sectionBuild.tableCount <= maxTables && !sectionBuild.usedCondensedFallback) {
      planningUnits.push(sectionBlocks);
      continue;
    }

    planningUnits.push(...buildPlanningUnits(sectionBlocks));
  }

  const tentativeSegments: FinalCardBodyBlock[][] = [];
  let currentUnits: FinalCardBodyBlock[][] = [];

  for (const unit of planningUnits) {
    const candidateUnits = [...currentUnits, unit];
    const candidateBlocks = flattenPlanningUnits(candidateUnits);
    const candidateBody = blocksToMarkdown(candidateBlocks);
    const candidateBuild = buildFinalCardResult({
      markdown: title !== CARD_TITLE ? `# ${title}\n\n${candidateBody}` : candidateBody,
      ...(input.branding ? { branding: input.branding } : {}),
      bodyTitle: title,
      bodyText: candidateBody,
      bodyBlocks: candidateBlocks,
      allowCondensedFallback: false,
    });

    if (currentUnits.length > 0 && (candidateBuild.tableCount > maxTables || candidateBuild.usedCondensedFallback)) {
      tentativeSegments.push(flattenPlanningUnits(currentUnits));
      currentUnits = [unit];
      continue;
    }

    currentUnits = candidateUnits;
  }

  if (currentUnits.length > 0) tentativeSegments.push(flattenPlanningUnits(currentUnits));
  const partCount = tentativeSegments.length;

  return tentativeSegments.map((segmentBlocks, index) => {
    const bodyText = blocksToMarkdown(segmentBlocks);
    const segmentMarkdown = title !== CARD_TITLE ? `# ${title}\n\n${bodyText}` : bodyText;
    const result = buildFinalCardResult({
      markdown: segmentMarkdown,
      ...(input.branding ? { branding: input.branding } : {}),
      ...(index === partCount - 1 && input.actions ? { actions: input.actions } : {}),
      // No execution trace on a split reply, deliberately: the split happened
      // because the answer already fills a card, and a trace on top of that
      // buys a folded panel at the risk of condensing the answer itself.
      bodyTitle: title,
      bodyText,
      bodyBlocks: segmentBlocks,
      allowCondensedFallback: false,
    });

    return {
      markdown: segmentMarkdown,
      payload: result.payload,
      partIndex: index + 1,
      partCount,
      tableCount: result.tableCount,
      usedCondensedFallback: result.usedCondensedFallback,
    };
  });
}

// ── Status card (in-flight during a run) ─────────────────────────────────────

export interface StatusCardInput {
  branding?: ChannelBranding;
  timeline?: ChannelTimeline;
}

/**
 * The in-flight status card.
 *
 * Body, top to bottom: what the agent is saying (only when no step is running),
 * the activity list with its subagent children, the folded plan, then a footer
 * rule carrying the counter.
 *
 * The card carries no controls. Stopping a run is `/q` in the conversation —
 * one way to say it, in the same place every other instruction to Divo is
 * typed, and it works whether or not this particular bubble is still on screen.
 *
 * There is no progress ring and no state line. The ring's percentage came from
 * a denominator the run cannot know, and the state already sits in the header
 * chip; both were confident-looking restatements of something said elsewhere.
 */
export function buildStatusCard(input: StatusCardInput): string {
  const { branding, timeline } = input;
  const now = Date.now();
  const elements: unknown[] = [];

  if (!timeline) {
    elements.push(mdElement(`<font color='grey'>Getting started…</font>`));
  } else {
    const narration = narrationMarkdown(timeline);
    if (narration) {
      elements.push({
        tag: 'markdown', element_id: 'run_say', content: narration, text_size: 'normal',
      });
    }

    const activity = activityMarkdown(timeline);
    if (activity) {
      elements.push({
        tag: 'markdown', element_id: 'run_activity', content: activity, text_size: 'normal',
      });
    }

    const plan = planPanel(timeline);
    if (plan) elements.push(plan);

    // An empty body reads as a broken card, so the run always says something.
    // Deliberately not the state word: the header chip already holds that, and
    // this line exists precisely for the moment before there is anything else.
    if (!narration && !activity && !plan) {
      elements.push(mdElement(`<font color='grey'>Getting started…</font>`));
    }
  }

  // The footer is one line of text now, so it needs no column set to hold a
  // button beside it. A running card also says how to stop it — the command is
  // useless to someone who has never been told it exists, and this is the only
  // moment they are looking for it.
  const counter = timeline ? statusCounterText(timeline, now) : '';
  // Queued is deliberately excluded: nothing has registered an abort yet, so
  // `/q` would answer "there is no active run" to someone the card had just
  // told to send it.
  const RUNNING: readonly ChannelRunState[] = ['thinking', 'planning', 'working', 'writing'];
  const stoppable = timeline?.state !== undefined && RUNNING.includes(timeline.state);
  const footer = [counter, ...(stoppable ? ['send `/q` to stop'] : [])]
    .filter(Boolean)
    .join('  ·  ');

  if (footer) {
    elements.push(hrElement('8px 0 0 0'));
    elements.push({
      tag:        'markdown',
      element_id: 'run_count',
      content:    `<font color='grey'>${footer}</font>`,
      text_size:  'notation',
      margin:     '2px 0 0 0',
    });
  }

  const statusHeader = buildStatusHeader(timeline, branding);
  const card = {
    schema: '2.0',
    config: {
      width_mode: 'fill',
      update_multi: true,
      enable_forward: false,
      summary: { content: statusSummary(timeline, now) },
    },
    ...(statusHeader ? { header: statusHeader } : {}),
    body:   { vertical_spacing: '6px', padding: '12px 12px 10px 12px', elements },
  };

  return JSON.stringify({ msg_type: 'interactive', card: JSON.stringify(card) });
}

/** Notification preview text — the run's subject and state, not a generic "Divo AI". */
function statusSummary(timeline: ChannelTimeline | undefined, now: number): string {
  const title   = statusHeaderTitle(timeline);
  const state   = statusStateTitle(timeline);
  const counter = timeline ? statusCounterText(timeline, now) : '';
  const tail    = [title === state ? '' : state, counter].filter(Boolean).join(' · ');
  return tail ? `${title} — ${tail}` : title;
}

/**
 * Title is the subject; the state is a chip beside it.
 *
 * The department chip is dropped while a state chip is present — two chips on
 * one header line is where a status card starts looking like a dashboard, and
 * the department does not change during a run, so it is the one that can go.
 *
 * No header icon: an unrecognised `standard_icon` token makes Lark reject the
 * whole card, which would cost every run its status bubble.
 */
function buildStatusHeader(
  timeline: ChannelTimeline | undefined,
  branding: ChannelBranding | undefined,
): Record<string, unknown> | undefined {
  const state = timeline?.state;
  if (!state) return buildHeader(timeline?.subject?.trim(), branding);
  const subject = timeline.subject?.trim();
  return {
    template: 'default',
    // No title unless the run has a subject. The only other thing to put there
    // is the state, which is the chip sitting immediately beside it — and
    // "Working… | Working" is the one-fact-twice this card exists to remove.
    ...(subject ? { title: { tag: 'plain_text', content: subject } } : {}),
    text_tag_list: [{
      tag:   'text_tag',
      text:  { tag: 'plain_text', content: RUN_STATE_WORD[state] },
      color: RUN_STATE_CHIP[state],
    }],
  };
}
