/**
 * Lark card schema v2 builder.
 * Ported from old backend lark.adapter.ts markdown helpers; extended with dynamic department branding.
 */

import type {
  ChannelBranding,
  ChannelPlanStep,
  ChannelTimeline,
  ChannelToolFamily,
  InteractiveAction,
} from '../../../domain/channel/outbound';

// ── Constants ────────────────────────────────────────────────────────────────

const CARD_TITLE       = 'Divo AI';
const MAX_ELEMENT_LEN  = 1200;
const MAX_ELEMENTS     = 30;
const MAX_TABLE_ROWS   = 15;
const MAX_CARD_BYTES   = 18_000;
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

const TOOL_FAMILY_LABEL: Record<ChannelToolFamily, string> = {
  zoho:          'ZOHO',
  lark:          'LARK',
  google:        'GOOGLE',
  context:       'CTX',
  orchestration: 'PLAN',
  other:         '',
};

function circularProgressElement(pct: number): Record<string, unknown> {
  const clamped = Math.max(0, Math.min(100, Math.round(pct)));
  const value   = clamped / 100;
  return {
    tag:          'chart',
    element_id:   'run_progress',
    height:       '72px',
    aspect_ratio: '1:1',
    preview:      false,
    color_theme:  'brand',
    chart_spec:   {
      type:         'circularProgress',
      data:         { values: [{ type: 'progress', value, text: `${clamped}%` }] },
      valueField:   'value',
      categoryField: 'type',
      seriesField:  'type',
      radius:       0.85,
      innerRadius:  0.62,
      title:        { visible: false },
      legends:      { visible: false },
      indicator:    {
        visible: true,
        title:   { visible: false },
        content: [{ visible: true, field: 'text' }],
      },
    },
  };
}

/** Header subtitle: step counter when the run has plan steps (e.g. "Step 2/5"). */
function statusHeaderSubtitle(timeline?: ChannelTimeline): string | undefined {
  const total = timeline?.totalSteps;
  if (!total || total <= 0) return undefined;
  const completed = timeline.completedSteps ?? 0;
  const hasRunning = timeline.plan?.some(s => s.status === 'running') ?? false;
  const current = hasRunning
    ? Math.min(completed + 1, total)
    : Math.max(completed, 1);
  return `Step ${current}/${total}`;
}

const SIDE_RAIL_MAX_CHARS = 24;

function shortStepLabel(step: ChannelPlanStep): string {
  const badge = step.toolFamily && step.toolFamily !== 'other'
    ? TOOL_FAMILY_LABEL[step.toolFamily]
    : '';
  const words = step.title.split(/\s+/).filter(Boolean).slice(0, 2).join(' ');
  const base  = badge ? `${badge} · ${words}` : words;
  return base.length > SIDE_RAIL_MAX_CHARS
    ? `${base.slice(0, SIDE_RAIL_MAX_CHARS - 1)}…`
    : base;
}

function normalizeLiveText(value: string): string {
  return value.replace(/…+$/u, '').trim().toLowerCase();
}

/** Compact todo rail from plan steps (● running, ○ next). */
function planToSideRail(plan: readonly ChannelPlanStep[]): string | undefined {
  const running = plan.find(s => s.status === 'running');
  const pending = plan.filter(s => s.status === 'pending').slice(0, 2);
  const lines: string[] = [];
  if (running) lines.push(`● ${shortStepLabel(running)}`);
  for (const step of pending) lines.push(`○ ${shortStepLabel(step)}`);
  const done = plan.filter(s => s.status === 'done').slice(-1);
  if (!running && done.length && lines.length < 3) {
    lines.unshift(`✓ ${shortStepLabel(done[0]!)}`);
  }
  return lines.length ? lines.join('\n') : undefined;
}

/** Fallback rail from recent trace lines when plan is not populated yet. */
function recentToSideRail(recent: readonly string[]): string | undefined {
  const lines: string[] = [];
  for (const raw of recent.slice(-3)) {
    const done = /^\[done\]/i.test(raw);
    const text = raw.replace(/^\[(run|done)\]\s*/i, '').trim();
    if (!text) continue;
    const short = text.length > SIDE_RAIL_MAX_CHARS
      ? `${text.slice(0, SIDE_RAIL_MAX_CHARS - 1)}…`
      : text;
    lines.push(done ? `✓ ${short}` : `● ${short}`);
  }
  return lines.length ? lines.join('\n') : undefined;
}

/** Right column: mini todo rail (never a duplicate of the center live line). */
function buildSideRailMarkdown(timeline: ChannelTimeline): string | undefined {
  const plan = timeline.plan;
  if (plan?.length) {
    const rail = planToSideRail(plan);
    if (rail) return rail;
  }

  if (timeline.recent?.length) {
    const rail = recentToSideRail(timeline.recent);
    if (!rail) return undefined;
    const live = normalizeLiveText(timeline.liveLabel ?? '');
    const first = normalizeLiveText(rail.replace(/^[●○✓]\s*/, '').split('\n')[0] ?? '');
    if (live && first === live && !rail.includes('\n')) return undefined;
    return rail;
  }

  return undefined;
}

/** One primary line beside the ring (no separate "Executing" headline). */
function liveStripMarkdown(timeline: ChannelTimeline): string {
  let live = timeline.liveLabel ?? 'Working…';

  if (
    timeline.totalSteps
    && timeline.completedSteps === timeline.totalSteps
    && !timeline.plan?.some(s => s.status === 'running')
    && /working/i.test(live)
  ) {
    live = 'Preparing response…';
  }

  return live;
}

/** Optional second line: what's queued after the active step. */
function liveStripSubline(timeline: ChannelTimeline): string | undefined {
  const plan = timeline.plan;
  if (!plan?.length) return undefined;
  const pending = plan.find(s => s.status === 'pending');
  if (!pending) return undefined;
  const fam = pending.toolFamily && pending.toolFamily !== 'other'
    ? TOOL_FAMILY_LABEL[pending.toolFamily]
    : '';
  const hint = fam ? `${fam} next` : 'Next step';
  const words = pending.title.split(/\s+/).filter(Boolean).slice(0, 4).join(' ');
  return words ? `${hint} · ${words}` : hint;
}

function liveStatusColumnSet(timeline: ChannelTimeline): Record<string, unknown> {
  const sideRail = buildSideRailMarkdown(timeline);
  const mainWeight = sideRail ? 2 : 3;

  const columns: Record<string, unknown>[] = [
    {
      tag:             'column',
      width:           'weighted',
      weight:          1,
      vertical_align:  'center',
      elements:        [circularProgressElement(timeline.progressPct ?? 10)],
    },
    {
      tag:             'column',
      width:           'weighted',
      weight:          mainWeight,
      vertical_align:  'center',
      elements:        (() => {
        const main = liveStripMarkdown(timeline);
        const sub  = liveStripSubline(timeline);
        const headline = main.replace(/…+$/u, '').trim() || main;
        const content = sub ? `**${headline}**\n${sub}` : main;
        return [{
          tag:       'markdown',
          content,
          text_size: 'normal',
        }];
      })(),
    },
  ];

  if (sideRail) {
    columns.push({
      tag:             'column',
      width:           'weighted',
      weight:          2,
      vertical_align:  'top',
      horizontal_align: 'right',
      elements:        [{
        tag:       'markdown',
        content:   sideRail,
        text_size: 'notation',
        text_align: 'right',
      }],
    });
  }

  return {
    tag:                 'column_set',
    element_id:          'live_strip',
    flex_mode:           'none',
    horizontal_spacing:  '8px',
    columns,
  };
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

function bodyBlocksToElements(body: string): Record<string, unknown>[] {
  const normalized = normalizeMd(body);
  if (!normalized) return [mdElement('No content available.')];

  const preprocessed = ensureTableSeparation(normalized);
  const blocks = preprocessed.split(/\n{2,}/).map(b => b.trim()).filter(Boolean);
  const elements: Record<string, unknown>[] = [];
  let tableIdx = 0;

  for (const block of blocks) {
    if (isTable(block)) {
      const parsed = parseMarkdownTable(block);
      if (parsed) {
        const totalRows = parsed.rows.length;
        const capped = totalRows > MAX_TABLE_ROWS
          ? { columns: parsed.columns, rows: parsed.rows.slice(0, MAX_TABLE_ROWS) }
          : parsed;
        elements.push(tableElement(capped, `data_table_${++tableIdx}`));
        if (totalRows > MAX_TABLE_ROWS) {
          elements.push(mdElement(
            `_Showing ${MAX_TABLE_ROWS} of ${totalRows} rows._`,
            { margin: '4px 0 0 0' },
          ));
        }
        continue;
      }
    }
    const softened = softenHeadings(block);
    const chunks = softened.length <= MAX_ELEMENT_LEN ? [softened] : splitMarkdown(softened);
    for (const chunk of chunks) {
      elements.push(mdElement(chunk, elements.length > 0 ? { margin: '8px 0 0 0' } : undefined));
    }
  }

  return elements.length > 0 ? elements : [mdElement('No content available.')];
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

export function buildFinalCard(input: FinalCardInput): string {
  const { markdown, branding, actions, executionTrace } = input;
  const { title, body } = extractTitleAndBody(markdown);
  const normalizedBody = normalizeMd(body);

  const elements: Record<string, unknown>[] = bodyBlocksToElements(normalizedBody);

  if (executionTrace) {
    elements.push(hrElement('12px 0 0 0'));
    elements.push(traceToCollapsible(executionTrace));
  }

  if (actions?.length) {
    elements.push({
      tag:    'action',
      margin: '8px 0 0 0',
      actions: actions.map((a, i) => ({
        tag:        'button',
        element_id: `action_${i + 1}`,
        text:       { tag: 'plain_text', content: a.label },
        value:      { action: a.value },
        type:       a.style === 'primary' ? 'primary' : a.style === 'danger' ? 'danger' : 'default',
      })),
    });
  }

  const headerObj = buildHeader(title !== CARD_TITLE ? title : undefined, branding);
  const summaryContent = buildSummary(title, normalizedBody);

  const serialize = (els: Record<string, unknown>[]) => {
    const c = {
      schema: '2.0',
      config: { width_mode: 'fill', update_multi: true, enable_forward: true, summary: { content: summaryContent } },
      header: headerObj,
      body: { vertical_spacing: '8px', padding: '12px 12px 12px 12px', elements: els },
    };
    return JSON.stringify({ msg_type: 'interactive', card: JSON.stringify(c) });
  };

  const serialized = serialize(elements);
  if (serialized.length <= MAX_CARD_BYTES) return serialized;

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
  return serialize(fallbackElements);
}

// ── Status card (in-flight during a run) ─────────────────────────────────────

export interface StatusCardInput {
  branding?: ChannelBranding;
  timeline?: ChannelTimeline;
  actions?:  Array<{ label: string; value: string }>;
}

export function buildStatusCard(input: StatusCardInput): string {
  const { branding, timeline, actions } = input;
  const elements: unknown[] = [];

  if (timeline) {
    elements.push(liveStatusColumnSet(timeline));
  } else {
    elements.push(mdElement('Working…'));
  }

  if (timeline?.recent?.length) {
    const recentBody = timeline.recent
      .map(line => line.replace(/^\[(run|done)\]\s*/i, ''))
      .join('\n');
    const traceTitle = timeline.plan?.length
      ? `Trace (${timeline.recent.length})`
      : `Trace (${timeline.recent.length}) — tap to expand`;
    elements.push(hrElement('8px 0 0 0'));
    elements.push(collapsiblePanel(
      'recent_panel',
      traceTitle,
      recentBody,
      false,
    ));
  }

  if (actions?.length) {
    for (const [i, a] of actions.entries()) {
      elements.push({
        tag: 'button', text: { tag: 'plain_text', content: a.label },
        type: 'default', width: 'default',
        behaviors: [{ type: 'callback', value: { action: a.value } }],
      });
    }
  }
  elements.push({
    tag: 'button', text: { tag: 'plain_text', content: '⏹ Stop' },
    type: 'danger_text', width: 'default', size: 'small',
    behaviors: [{ type: 'callback', value: { action: 'interrupt_run' } }],
  });

  const card = {
    schema: '2.0',
    config: { width_mode: 'fill', update_multi: true, enable_forward: false },
    header: buildHeader(statusHeaderSubtitle(timeline), branding),
    body:   { vertical_spacing: '8px', padding: '12px 12px 12px 12px', elements },
  };

  return JSON.stringify({ msg_type: 'interactive', card: JSON.stringify(card) });
}
