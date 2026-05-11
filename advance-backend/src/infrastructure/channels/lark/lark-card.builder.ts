/**
 * Lark card schema v2 builder.
 * Ported from old backend lark.adapter.ts markdown helpers; extended with dynamic department branding.
 */

import type { ChannelBranding, ChannelTimeline, InteractiveAction } from '../../../domain/channel/outbound';

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

  const elements: Record<string, unknown>[] = splitMarkdown(normalizedBody).map(
    (chunk, i) => mdElement(chunk, i > 0 ? { margin: '8px 0 0 0' } : undefined),
  );

  if (executionTrace) {
    elements.push(mdElement(executionTrace, { margin: '12px 0 0 0' }));
  }

  if (actions?.length) {
    elements.push(mdElement('---', { margin: '8px 0 4px 0' }));
    elements.push(...actions.map((a, i) => ({
      tag:        'button',
      element_id: `action_${i + 1}`,
      text:       { tag: 'plain_text', content: a.label },
      value:      { action: a.value },
      type:       a.style === 'primary' ? 'primary' : a.style === 'danger' ? 'danger' : 'default',
    })));
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
  const lines: string[] = [];

  if (timeline?.plan?.length) {
    const maxPlanDisplay = 10;
    const planItems = timeline.plan.length > maxPlanDisplay
      ? timeline.plan.slice(-maxPlanDisplay)
      : timeline.plan;
    for (const item of planItems) {
      const marker =
        item.status === 'done'    ? '✓' :
        item.status === 'running' ? '●' :
        item.status === 'failed'  ? '✗' :
        item.status === 'skipped' ? '○' : '○';
      lines.push(`${marker}  ${item.title}`);
    }
    lines.push('');
  }

  if (timeline?.recent?.length) {
    lines.push('**Recent activity**');
    lines.push(...timeline.recent);
    lines.push('');
  }

  lines.push(timeline?.liveLabel ?? 'Working…');

  const bodyText = lines.join('\n').trim();

  const elements: unknown[] = [mdElement(bodyText)];
  if (actions?.length) {
    elements.push({
      tag: 'action',
      actions: actions.map(a => ({
        tag:   'button',
        text:  { tag: 'plain_text', content: a.label },
        value: { action: a.value },
        type:  'default',
      })),
    });
  }

  const card = {
    schema: '2.0',
    config: { width_mode: 'fill', update_multi: true, enable_forward: false },
    header: buildHeader(undefined, branding),
    body:   { vertical_spacing: '8px', padding: '12px 12px 12px 12px', elements },
  };

  return JSON.stringify({ msg_type: 'interactive', card: JSON.stringify(card) });
}
