import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildStatusCard } from '../../src/infrastructure/channels/lark/lark-card.builder.ts';

function parseCard(payload: string): Record<string, unknown> {
  const outer = JSON.parse(payload) as { card: string };
  return JSON.parse(outer.card) as Record<string, unknown>;
}

function bodyElements(card: Record<string, unknown>): Array<Record<string, unknown>> {
  const body = card['body'] as { elements: Array<Record<string, unknown>> };
  return body.elements;
}

function findColumnSet(elements: Array<Record<string, unknown>>): Record<string, unknown> | undefined {
  return elements.find(e => e['tag'] === 'column_set');
}

describe('lark-card.builder buildStatusCard (layout A)', () => {
  it('uses Step N/M in header, not Executing phase line', () => {
    const payload = buildStatusCard({
      branding: { departmentLabel: 'Finance', departmentColor: 'green' },
      timeline: {
        phase:          'Executing · 1/3',
        progressPct:    25,
        liveLabel:      'Updating Lark…',
        completedSteps: 0,
        totalSteps:     3,
        plan: [
          { status: 'running', title: 'Update task', toolFamily: 'lark' },
          { status: 'pending', title: 'List invoices', toolFamily: 'zoho' },
        ],
      },
    });
    const card = parseCard(payload);
    const header = card['header'] as { subtitle?: { content: string } };
    assert.equal(header.subtitle?.content, 'Step 1/3');

    const cols = findColumnSet(bodyElements(card))!['columns'] as Array<Record<string, unknown>>;
    const center = (cols[1]!['elements'] as Array<Record<string, unknown>>)[0]!['content'] as string;
    assert.ok(!center.includes('Executing'), 'center must not repeat phase name');
    assert.ok(center.includes('Updating Lark'), 'center shows live label only');
  });

  it('uses ring + main columns only (no side rail)', () => {
    const payload = buildStatusCard({
      timeline: {
        phase:       'Executing',
        progressPct: 25,
        liveLabel:   'Updating Lark…',
        plan: [
          { status: 'running', title: 'Update task', toolFamily: 'lark' },
          { status: 'pending', title: 'List invoices', toolFamily: 'zoho' },
        ],
        totalSteps:     2,
        completedSteps: 0,
      },
    });
    const card = parseCard(payload);
    const cols = findColumnSet(bodyElements(card))!['columns'] as Array<Record<string, unknown>>;
    assert.equal(cols.length, 2);

    const center = (cols[1]!['elements'] as Array<Record<string, unknown>>)[0]!['content'] as string;
    assert.ok(center.includes('Updating Lark'), 'main column shows live label');
    assert.match(center, /ZOHO next · List invoices/i, 'pending step shown as subline');
  });

  it('renders narration with done and active markers', () => {
    const payload = buildStatusCard({
      timeline: {
        liveLabel: 'Working…',
        narration:       ['Finding capabilities…', 'Building overdue invoice report…'],
        narrationActive: 'Searching the web…',
      },
    });
    const card = parseCard(payload);
    const cols = findColumnSet(bodyElements(card))!['columns'] as Array<Record<string, unknown>>;
    const center = (cols[1]!['elements'] as Array<Record<string, unknown>>)[0]!['content'] as string;
    assert.ok(center.includes('Working on your request'));
    assert.match(center, /✓ Finding capabilities/);
    assert.match(center, /● \*\*Searching the web/);
  });

  it('labels recent section Trace, not Recent', () => {
    const payload = buildStatusCard({
      timeline: {
        liveLabel: 'Working…',
        recent:    ['[run]  Reading Zoho Books'],
      },
    });
    const card = parseCard(payload);
    const panel = bodyElements(card).find(e => e['tag'] === 'collapsible_panel') as {
      header: { title: { content: string } };
    };
    assert.ok(panel.header.title.content.startsWith('Trace'));
    assert.ok(!panel.header.title.content.startsWith('Recent'));
  });

  it('shows only Trace collapsible when plan and recent are present', () => {
    const payload = buildStatusCard({
      timeline: {
        liveLabel: 'Working…',
        plan: [
          { status: 'running', title: 'Step one', toolFamily: 'zoho' },
        ],
        recent: ['[done] Finished step'],
      },
    });
    const card = parseCard(payload);
    const panels = bodyElements(card).filter(e => e['tag'] === 'collapsible_panel');
    assert.equal(panels.length, 1);
    assert.ok((panels[0] as { header: { title: { content: string } } }).header.title.content.startsWith('Trace'));
  });
});
