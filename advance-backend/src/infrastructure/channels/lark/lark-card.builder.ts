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

const CARD_TITLE     = 'Divo AI';
const MAX_ELEMENT_LEN = 1200;
const MAX_ELEMENTS    = 30;
const SUMMARY_CAP     = 160;

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

/** Header subtitle only when it adds step context (e.g. "Executing · 2/5"). */
function statusHeaderSubtitle(timeline?: ChannelTimeline): string | undefined {
  const phase = timeline?.phase;
  if (!phase?.includes('·')) return undefined;
  return phase;
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

/** ~2-word activity hint for the right column when there is no active todo rail. */
function twoWordActivitySummary(timeline: ChannelTimeline): string | undefined {
  const live = (timeline.liveLabel ?? '').replace(/…+$/u, '').trim();
  if (!live) return undefined;

  const presets: Array<[RegExp, string]> = [
    [/preparing response/i, 'Writing reply'],
    [/thinking/i,          'Thinking'],
    [/zoho|invoice|books/i,'Reading Zoho'],
    [/lark|task/i,          'Updating Lark'],
    [/google|gmail|email/i, 'Email ops'],
    [/plan|todo|schedul/i,  'Updating plan'],
    [/context|search/i,     'Searching'],
  ];
  for (const [pattern, label] of presets) {
    if (pattern.test(live)) return label;
  }

  const words = live.split(/\s+/).filter(Boolean).slice(0, 2);
  return words.length ? words.join(' ') : undefined;
}

/** Compact todo rail or 2-word summary for the right side of the live strip. */
function buildSideRailMarkdown(timeline: ChannelTimeline): string | undefined {
  const plan = timeline.plan;
  if (plan?.length) {
    const running = plan.find(s => s.status === 'running');
    const pending = plan.filter(s => s.status === 'pending').slice(0, 2);
    const lines: string[] = [];
    if (running) lines.push(`● ${shortStepLabel(running)}`);
    for (const step of pending) lines.push(`○ ${shortStepLabel(step)}`);
    if (lines.length) return lines.join('\n');
  }

  return twoWordActivitySummary(timeline);
}

/** Beside the progress ring — avoid repeating the same word as header + body. */
function liveStripMarkdown(timeline: ChannelTimeline): string {
  let live  = timeline.liveLabel ?? 'Working…';
  const phase = timeline.phase;

  if (
    phase?.includes('·')
    && timeline.totalSteps
    && timeline.completedSteps === timeline.totalSteps
    && /working/i.test(live)
  ) {
    live = 'Preparing response…';
  }

  if (!phase) return live;
  if (phase.includes('·')) return `**${phase}**\n${live}`;

  const stripEllipsis = (s: string) => s.replace(/…+$/u, '').trim().toLowerCase();
  if (stripEllipsis(phase) === stripEllipsis(live)) return live;

  return `**${phase}**\n${live}`;
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
      elements:        [{
        tag:       'markdown',
        content:   liveStripMarkdown(timeline),
        text_size: 'normal',
      }],
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

function stepStatusMarker(status: ChannelPlanStep['status']): string {
  switch (status) {
    case 'done':    return '✓';
    case 'running': return '●';
    case 'failed':  return '✗';
    case 'skipped': return '○';
    default:        return '○';
  }
}

function formatPlanMarkdown(plan: readonly ChannelPlanStep[]): string {
  return plan.map(step => {
    const badge = step.toolFamily && step.toolFamily !== 'other'
      ? `**${TOOL_FAMILY_LABEL[step.toolFamily]}** `
      : '';
    const sub = step.subtitle ? `\n   ${step.subtitle}` : '';
    return `${stepStatusMarker(step.status)} ${badge}${step.title}${sub}`;
  }).join('\n');
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

function bodyBlocksToElements(body: string): Record<string, unknown>[] {
  const normalized = normalizeMd(body);
  if (!normalized) return [mdElement('No content available.')];

  const blocks = normalized.split(/\n{2,}/).map(b => b.trim()).filter(Boolean);
  const elements: Record<string, unknown>[] = [];
  let tableIdx = 0;

  for (const block of blocks) {
    if (isTable(block)) {
      const parsed = parseMarkdownTable(block);
      if (parsed) {
        elements.push(tableElement(parsed, `data_table_${++tableIdx}`));
        continue;
      }
    }
    const chunks = block.length <= MAX_ELEMENT_LEN ? [block] : splitMarkdown(block);
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

  const card = {
    schema: '2.0',
    config: {
      width_mode:     'fill',
      update_multi:   true,
      enable_forward: true,
      summary:        { content: buildSummary(title, normalizedBody) },
    },
    header: buildHeader(title !== CARD_TITLE ? title : undefined, branding),
    body:   { vertical_spacing: '8px', padding: '12px 12px 12px 12px', elements },
  };

  return JSON.stringify({ msg_type: 'interactive', card: JSON.stringify(card) });
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

  if (timeline?.plan?.length) {
    const maxPlanDisplay = 10;
    const planItems = timeline.plan.length > maxPlanDisplay
      ? timeline.plan.slice(-maxPlanDisplay)
      : timeline.plan;
    elements.push(hrElement('8px 0 0 0'));
    elements.push(collapsiblePanel(
      'plan_panel',
      `Plan (${planItems.length})`,
      formatPlanMarkdown(planItems),
      false,
    ));
  }

  if (timeline?.recent?.length) {
    const recentBody = timeline.recent
      .map(line => line.replace(/^\[(run|done)\]\s*/i, ''))
      .join('\n');
    elements.push(collapsiblePanel(
      'recent_panel',
      `Recent (${timeline.recent.length})`,
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
