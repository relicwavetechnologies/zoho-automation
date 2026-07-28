/**
 * Lark card schema v2 builder.
 * Ported from old backend lark.adapter.ts markdown helpers; extended with dynamic department branding.
 */

import type {
  ChannelBranding,
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

// ── Status card: honest counters + a grouped work ledger ─────────────────────

/** Visible ledger rows; older groups collapse into a counted note, never dropped silently. */
const LEDGER_VISIBLE_ROWS = 5;
const LEDGER_OUTCOME_MAX  = 72;

const RUN_STATE_WORD: Record<ChannelRunState, string> = {
  thinking: 'Thinking',
  planning: 'Planning',
  working:  'Working',
  writing:  'Writing your answer',
  done:     'Done',
  blocked:  'Blocked',
};

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const mins = Math.floor(total / 60);
  return `${mins}m ${String(total % 60).padStart(2, '0')}s`;
}

function actionsPhrase(count: number): string {
  return `${count} action${count === 1 ? '' : 's'}`;
}

/**
 * The counter, in the only three forms the run can prove:
 *   declared checklist → "Step 3 of 5"   (the model committed to the total)
 *   otherwise          → "11 actions"    (count-up; no denominator exists)
 *   terminal           → totals
 * Never "n/n", which is what counting tool calls into a total produces.
 */
export function statusCounterText(timeline: ChannelTimeline, now = Date.now()): string {
  const count   = timeline.actionCount ?? 0;
  const parts: string[] = [];

  if (timeline.declared && timeline.declared.total > 0) {
    const { done, total } = timeline.declared;
    parts.push(`Step ${Math.min(done + 1, total)} of ${total}`);
  }
  // Keep counting actions even beside a checklist: a model that adds todos and
  // forgets to update them would otherwise freeze the counter for a whole run.
  if (count > 0) parts.push(actionsPhrase(count));
  if (timeline.startedAtMs !== undefined) {
    parts.push(formatElapsed(Math.max(0, now - timeline.startedAtMs)));
  }

  return parts.join(' · ');
}

/**
 * Header title: what the user asked for, falling back to the run state. The bot's
 * name is printed above every card by the client, so repeating it here (the old
 * "Divo AI") spent the most prominent line on nothing.
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

function truncateOutcome(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > LEDGER_OUTCOME_MAX ? `${flat.slice(0, LEDGER_OUTCOME_MAX - 1)}…` : flat;
}

const LEDGER_MARKERS: Record<ChannelPlanStepStatus, string> = {
  pending: '○',
  running: '●',
  done:    '✓',
  failed:  '✗',
  skipped: '–',
};

/**
 * One line per tool family, newest last: "✓ **Zoho** · 7 calls — Created INV-1043".
 * Grouping is what keeps an eleven-call run three lines tall.
 */
function ledgerMarkdown(timeline: ChannelTimeline): string | undefined {
  const rows = timeline.ledger;
  if (!rows?.length) return undefined;

  const hidden  = Math.max(0, rows.length - LEDGER_VISIBLE_ROWS);
  const visible = hidden > 0 ? rows.slice(-LEDGER_VISIBLE_ROWS) : rows;
  const lines: string[] = [];

  if (hidden > 0) {
    lines.push(`<font color='grey'>+ ${hidden} earlier step${hidden === 1 ? '' : 's'}</font>`);
  }
  for (const row of visible) {
    const marker = LEDGER_MARKERS[row.status];
    const calls  = row.count > 1 ? ` · ${row.count} calls` : '';
    const label  = `**${row.label}${calls}**`;
    const tail   = row.outcome ? ` <font color='grey'>— ${truncateOutcome(row.outcome)}</font>` : '';
    lines.push(`${marker} ${label}${tail}`);
  }
  return lines.join('\n');
}

/** Meta line: what the run is doing right now, plus the honest counter. */
function statusMetaMarkdown(timeline: ChannelTimeline, now: number): string {
  const state  = timeline.state ?? 'working';
  const marker = state === 'blocked' ? '✗' : state === 'done' ? '✓' : '●';
  const word   = RUN_STATE_WORD[state];
  const counter = statusCounterText(timeline, now);
  return counter
    ? `${marker} **${word}**  <font color='grey'>·  ${counter}</font>`
    : `${marker} **${word}**`;
}

/** Text progress bar — only meaningful when a checklist was declared. */
function declaredBarMarkdown(timeline: ChannelTimeline): string | undefined {
  const declared = timeline.declared;
  if (!declared || declared.total <= 0) return undefined;
  const filled = Math.max(0, Math.min(declared.total, declared.done));
  const bar    = `${'▰'.repeat(filled)}${'▱'.repeat(declared.total - filled)}`;
  const label  = declared.current ?? declared.next;
  return label
    ? `<font color='blue'>${bar}</font>  <font color='grey'>${truncateOutcome(label)}</font>`
    : `<font color='blue'>${bar}</font>`;
}

/**
 * Phase names that the meta line already carries. When the live label is only
 * one of these, there is no activity to report and repeating it produced a card
 * that said "Working" twice.
 */
const PHASE_ECHO = new Set([
  'thinking', 'planning', 'working', 'working on your request',
  'preparing response', 'writing your answer', 'done', 'failed', 'blocked',
]);

function normalizeLive(value: string): string {
  return value.replace(/…+$/u, '').trim().toLowerCase();
}

/**
 * The live line exists to carry something the ledger cannot: a streamed sentence
 * from the model, or the current activity before any tool has run. When it would
 * only echo the phase name or the running ledger row, it is omitted — that
 * duplication is what made the old card feel padded.
 */
function liveLineMarkdown(timeline: ChannelTimeline): string | undefined {
  const active = timeline.narrationActive?.trim() || timeline.liveLabel?.trim();
  if (!active) return undefined;

  const headline = active.replace(/…+$/u, '').trim() || active;
  if (PHASE_ECHO.has(headline.toLowerCase())) return undefined;

  const runningRow = timeline.ledger?.find(r => r.status === 'running');
  if (runningRow && normalizeLive(runningRow.outcome) === normalizeLive(headline)) return undefined;

  return `**${headline}**`;
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

function softenHeadings(md: string): string {
  return md.replace(/^#{1,3}\s+(.+)$/gm, '**$1**');
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

function buildHeader(
  subtitle: string | undefined,
  branding: ChannelBranding | undefined,
): Record<string, unknown> {
  const label = branding?.departmentLabel ?? 'Divo';
  const color = branding?.departmentColor ?? pickDeptColor(branding?.departmentLabel);
  return {
    template: 'default',
    title:    { tag: 'plain_text', content: CARD_TITLE },
    ...(subtitle ? { subtitle: { tag: 'plain_text', content: subtitle } } : {}),
    text_tag_list: [{ tag: 'text_tag', text: { tag: 'plain_text', content: label }, color }],
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

interface BuildFinalCardResult {
  payload: string;
  tableCount: number;
  usedCondensedFallback: boolean;
}

function blocksToMarkdown(blocks: readonly FinalCardBodyBlock[]): string {
  return blocks.map(block => block.markdown).join('\n\n').trim();
}

function buildFinalSubtitle(title: string): string | undefined {
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
  subtitle: string | undefined,
  branding: ChannelBranding | undefined,
): string {
  const card = {
    schema: '2.0',
    config: { width_mode: 'fill', update_multi: true, enable_forward: true, summary: { content: summaryContent } },
    header: buildHeader(subtitle, branding),
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
          behaviors:  [{ type: 'callback', value: { action: a.value } }],
        }],
      })),
    });
  }

  const summaryContent = buildSummary(bodyTitle, normalizedBody);
  const subtitle = buildFinalSubtitle(bodyTitle);
  const serialized = serializeFinalCard(elements, summaryContent, subtitle, branding);
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
    payload: serializeFinalCard(fallbackElements, summaryContent, subtitle, branding),
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
  actions?:  Array<{ label: string; value: string }>;
}

/**
 * In-flight status card ("work ledger" layout).
 *
 * This is the canonical renderer. The legacy circular-progress/side-rail
 * template is deprecated because it presented inferred progress as fact.
 *
 * Body, top to bottom: the live line, the state + honest counter, an optional
 * declared-plan bar, then one ledger line per tool family. No progress ring (its
 * percentage was derived from a denominator the run cannot know) and no trace
 * panel — the ledger already says what happened, in plain language.
 */
export function buildStatusCard(input: StatusCardInput): string {
  const { branding, timeline, actions } = input;
  const now = Date.now();
  const elements: unknown[] = [];

  if (!timeline) {
    elements.push(mdElement('**Working…**'));
  } else {
    const live = liveLineMarkdown(timeline);
    if (live) elements.push(mdElement(live));

    // The anchor line: what state the run is in, and the honest counter.
    elements.push({
      tag:       'markdown',
      element_id: 'run_meta',
      content:   statusMetaMarkdown(timeline, now),
      text_size: 'normal',
    });

    const bar = declaredBarMarkdown(timeline);
    if (bar) {
      elements.push({ tag: 'markdown', element_id: 'run_bar', content: bar, text_size: 'notation' });
    }

    const ledger = ledgerMarkdown(timeline);
    if (ledger) {
      elements.push(hrElement('6px 0 0 0'));
      elements.push({
        tag:       'markdown',
        element_id: 'run_ledger',
        content:   ledger,
        text_size: 'notation',
      });
    }
  }

  if (actions?.length) {
    for (const a of actions) {
      elements.push({
        tag: 'button', text: { tag: 'plain_text', content: a.label },
        type: 'default', width: 'default', size: 'small',
        behaviors: [{ type: 'callback', value: { action: a.value } }],
      });
    }
  }

  if (timeline?.state !== 'done' && timeline?.state !== 'blocked') {
    elements.push({
      tag: 'button', element_id: 'stop_run',
      text: { tag: 'plain_text', content: 'Stop' },
      type: 'danger_text', width: 'default', size: 'small',
      behaviors: [{ type: 'callback', value: { action: 'interrupt_run' } }],
    });
  }

  const card = {
    schema: '2.0',
    config: {
      width_mode: 'fill',
      update_multi: true,
      enable_forward: false,
      summary: { content: statusSummary(timeline, now) },
    },
    header: buildStatusHeader(timeline, branding),
    body:   { vertical_spacing: '6px', padding: '12px 12px 12px 12px', elements },
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

function buildStatusHeader(
  timeline: ChannelTimeline | undefined,
  branding: ChannelBranding | undefined,
): Record<string, unknown> {
  // No header icon: an unrecognised standard_icon token makes Lark reject the
  // entire card, which would cost every run its status bubble. The state word in
  // the body already carries the ● / ✗ marker.
  return {
    ...buildHeader(undefined, branding),
    title: { tag: 'plain_text', content: statusHeaderTitle(timeline) },
  };
}
