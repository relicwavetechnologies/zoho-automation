import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildFinalCard, buildStatusCard, planFinalCards } from '../../src/infrastructure/channels/lark/lark-card.builder.ts';

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

function financeFixture(tableCount: number): string {
  const sections = ['# Finance Update', 'Here is the latest structured summary.'];
  for (let i = 1; i <= tableCount; i += 1) {
    sections.push(
      `## Bucket ${i}`,
      [
        '| Customer | Amount | Status |',
        '|---|---:|---|',
        `| Client ${i} | ₹${i * 1000} | Open |`,
        `| Client ${i + 10} | ₹${i * 2000} | Aging |`,
      ].join('\n'),
    );
  }
  return sections.join('\n\n');
}

function panelTitles(card: Record<string, unknown>): string[] {
  return bodyElements(card)
    .filter(e => e['tag'] === 'collapsible_panel')
    .map(e => ((e['header'] as { title: { content: string } }).title.content));
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

describe('lark-card.builder final reply planning', () => {
  it('keeps a one-card reply when native table count stays within the safe cap', () => {
    const segments = planFinalCards({
      markdown: financeFixture(2),
      branding: { departmentLabel: 'Finance', departmentColor: 'green' },
      executionTrace: '---\n**Trace**\n✓ Completed analysis',
    });

    assert.equal(segments.length, 1);
    assert.equal(segments[0]?.partCount, 1);
    const card = parseCard(segments[0]!.payload);
    assert.ok(panelTitles(card).includes('Execution trace'));
  });

  it('splits a table-heavy finance reply into multiple cards before hitting the Lark table limit', () => {
    const segments = planFinalCards({
      markdown: financeFixture(7),
      branding: { departmentLabel: 'Finance', departmentColor: 'green' },
      executionTrace: '---\n**Trace**\n✓ Completed analysis',
    });

    assert.equal(segments.length, 3);
    assert.ok(segments.every(segment => segment.tableCount <= 3));
    assert.ok(segments.every(segment => segment.payload.length <= 18_000));

    const firstCard = parseCard(segments[0]!.payload);
    const secondCard = parseCard(segments[1]!.payload);
    const thirdCard = parseCard(segments[2]!.payload);

    const firstSubtitle = (firstCard['header'] as { subtitle?: { content: string } }).subtitle?.content;
    const secondSubtitle = (secondCard['header'] as { subtitle?: { content: string } }).subtitle?.content;
    const thirdSubtitle = (thirdCard['header'] as { subtitle?: { content: string } }).subtitle?.content;

    assert.equal(firstSubtitle, 'Finance Update');
    assert.equal(secondSubtitle, 'Finance Update');
    assert.equal(thirdSubtitle, 'Finance Update');
  });

  it('keeps a heading attached to its following table when a new card starts', () => {
    const segments = planFinalCards({
      markdown: financeFixture(4),
      branding: { departmentLabel: 'Finance', departmentColor: 'green' },
    });

    assert.equal(segments.length, 2);
    assert.doesNotMatch(segments[0]!.markdown, /\*\*Bucket 4\*\*\s*$/);
    assert.match(segments[1]!.markdown, /\*\*Bucket 4\*\*\n\n\| Customer \| Amount \| Status \|/);
  });

  it('suppresses execution trace on split replies', () => {
    const segments = planFinalCards({
      markdown: financeFixture(5),
      executionTrace: '---\n**Trace**\n✓ Completed analysis',
    });

    assert.ok(segments.length > 1);
    for (const segment of segments) {
      const card = parseCard(segment.payload);
      assert.ok(!panelTitles(card).includes('Execution trace'));
    }
  });

  it('still builds a normal final card for a simple reply', () => {
    const payload = buildFinalCard({
      markdown: '# Done\n\nEverything completed successfully.',
      executionTrace: '---\n**Trace**\n✓ Completed analysis',
    });
    const card = parseCard(payload);
    const subtitle = (card['header'] as { subtitle?: { content: string } }).subtitle?.content;
    assert.equal(subtitle, 'Done');
    assert.ok(panelTitles(card).includes('Execution trace'));
  });
});
