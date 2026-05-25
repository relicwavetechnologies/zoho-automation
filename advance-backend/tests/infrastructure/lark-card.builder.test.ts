import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildFinalCard, buildStatusCard } from '../../src/infrastructure/channels/lark/lark-card.builder.ts';

function parseCard(payload: string): Record<string, unknown> {
  const outer = JSON.parse(payload) as { card: string };
  return JSON.parse(outer.card) as Record<string, unknown>;
}

function bodyElements(card: Record<string, unknown>): Array<Record<string, unknown>> {
  const body = card['body'] as { elements: Array<Record<string, unknown>> };
  return body.elements;
}

describe('lark-card.builder', () => {
  describe('buildStatusCard()', () => {
    it('shows Thinking once beside the ring, not in header', () => {
      const payload = buildStatusCard({
        timeline: { progressPct: 8, liveLabel: 'Thinking…' },
      });
      const card = parseCard(payload);
      const header = card['header'] as { subtitle?: { content: string } };
      assert.equal(header.subtitle, undefined);

      const elements = bodyElements(card);
      const cols = elements.find(e => e['tag'] === 'column_set')!['columns'] as Array<Record<string, unknown>>;
      const md = (cols[1]!['elements'] as Array<Record<string, unknown>>)[0]!['content'] as string;
      assert.equal(md, 'Thinking…');
    });

    it('uses column_set, chart, and collapsible plan panel', () => {
      const payload = buildStatusCard({
        branding: { departmentLabel: 'Finance', departmentColor: 'green' },
        timeline: {
          phase:       'Executing · 1/2',
          progressPct: 45,
          liveLabel:   'Fetching invoices from Zoho Books…',
          plan: [{
            status:     'running',
            title:      'Reading Zoho',
            subtitle:   'list_invoices',
            toolFamily: 'zoho',
          }],
          recent: ['✓ Plan — 3 steps'],
        },
      });

      const card     = parseCard(payload);
      const elements = bodyElements(card);
      const tags     = elements.map(e => e['tag']);

      assert.equal(card['schema'], '2.0');
      assert.ok(tags.includes('column_set'));
      assert.ok(tags.includes('collapsible_panel'));
      assert.ok(tags.includes('hr'));

      const columnSet = elements.find(e => e['tag'] === 'column_set')!;
      const columns   = columnSet['columns'] as Array<Record<string, unknown>>;
      const chartCol  = columns[0]!['elements'] as Array<Record<string, unknown>>;
      assert.equal(chartCol[0]!['tag'], 'chart');
      assert.equal(chartCol[0]!['element_id'], 'run_progress');

      const header = card['header'] as { subtitle?: { content: string } };
      assert.equal(header.subtitle?.content, 'Executing · 1/2');

      const liveCol = elements.find(e => e['tag'] === 'column_set')!['columns'] as Array<Record<string, unknown>>;
      const md = (liveCol[1]!['elements'] as Array<Record<string, unknown>>)[0]!['content'] as string;
      assert.ok(md.includes('Fetching'), md);
      assert.equal(md.includes('Executing'), md.split('\n').length > 1);
    });

    it('adds a compact todo rail in the right column', () => {
      const payload = buildStatusCard({
        timeline: {
          phase:       'Executing · 2/5',
          progressPct: 44,
          liveLabel:   'Fetching invoices…',
          plan: [
            { status: 'running', title: 'Reading Zoho Books', toolFamily: 'zoho' },
            { status: 'pending', title: 'Draft summary', toolFamily: 'lark' },
          ],
        },
      });

      const columnSet = bodyElements(parseCard(payload)).find(e => e['tag'] === 'column_set')!;
      const columns   = columnSet['columns'] as Array<Record<string, unknown>>;
      assert.equal(columns.length, 3);

      const sideMd = (columns[2]!['elements'] as Array<Record<string, unknown>>)[0]! as Record<string, unknown>;
      assert.equal(sideMd['text_size'], 'notation');
      const side = sideMd['content'] as string;
      assert.ok(side.includes('●'));
      assert.ok(side.includes('ZOHO'));
      assert.ok(side.includes('○'));
    });

    it('shows two-word summary in right column when no active todos', () => {
      const payload = buildStatusCard({
        timeline: { progressPct: 8, liveLabel: 'Thinking…' },
      });
      const columnSet = bodyElements(parseCard(payload)).find(e => e['tag'] === 'column_set')!;
      const columns   = columnSet['columns'] as Array<Record<string, unknown>>;
      assert.equal(columns.length, 3);
      const side = ((columns[2]!['elements'] as Array<Record<string, unknown>>)[0]! as Record<string, unknown>)['content'];
      assert.equal(side, 'Thinking');
    });
  });

  describe('buildFinalCard()', () => {
    it('renders markdown tables as native table components', () => {
      const payload = buildFinalCard({
        markdown: [
          '# Invoice summary',
          '',
          'Top overdue accounts:',
          '',
          '| Customer | Due | Amount |',
          '| --- | --- | --- |',
          '| Acme Corp | Overdue 45d | 1.1L |',
          '| Beta Ltd | Due in 5d | 82K |',
        ].join('\n'),
        executionTrace: '---\n**Trace** (2 steps, 4.2s)\n✓ Zoho — 12 invoices',
      });

      const elements = bodyElements(parseCard(payload));
      const table    = elements.find(e => e['tag'] === 'table');
      assert.ok(table);
      const rows = table!['rows'] as Array<Record<string, string>>;
      assert.equal(rows.length, 2);
      assert.equal(rows[0]!['customer'], 'Acme Corp');

      const tracePanel = elements.find(
        e => e['tag'] === 'collapsible_panel' && e['element_id'] === 'exec_trace',
      );
      assert.ok(tracePanel);
      assert.equal(tracePanel!['expanded'], false);
    });

    it('strips ** bold from native table cells', () => {
      const payload = buildFinalCard({
        markdown: [
          'Summary',
          '',
          '| Category | Total | Count |',
          '| --- | --- | --- |',
          '| **Office Supplies** | **₹5,600** | **11** |',
          '| **Total Q1 2026** | **₹1,37,300** | **11** |',
        ].join('\n'),
      });

      const table = bodyElements(parseCard(payload)).find(e => e['tag'] === 'table');
      const rows  = table!['rows'] as Array<Record<string, string>>;
      assert.equal(rows[0]!['category'], 'Office Supplies');
      assert.equal(rows[0]!['total'], '₹5,600');
      assert.equal(rows[0]!['count'], '11');
      assert.equal(rows[1]!['total'], '₹1,37,300');
      assert.ok(!JSON.stringify(rows).includes('**'));
    });
  });
});
