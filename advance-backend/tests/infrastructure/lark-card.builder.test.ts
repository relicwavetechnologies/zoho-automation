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

function markdownContents(card: Record<string, unknown>): string[] {
  return bodyElements(card)
    .filter(e => e['tag'] === 'markdown')
    .map(e => e['content'] as string);
}

function elementById(card: Record<string, unknown>, id: string): Record<string, unknown> | undefined {
  return bodyElements(card).find(e => e['element_id'] === id);
}

describe('lark-card.builder buildStatusCard (work ledger)', () => {
  const workingTimeline = {
    phase:       'Executing · 11 actions',
    state:       'working' as const,
    liveLabel:   'Attaching the PDF to the Lark task…',
    actionCount: 11,
    startedAtMs: Date.now() - 64_000,
    ledger: [
      { label: 'Zoho', count: 7, outcome: 'Created INV-1043', status: 'done' as const },
      { label: 'Lark', count: 1, outcome: 'Attaching the PDF', status: 'running' as const },
    ],
  };

  // The old header derived "Step N/M" from tool calls seen so far, which makes
  // numerator and denominator the same number for the whole run.
  it('counts actions up instead of inventing a denominator', () => {
    const card = parseCard(buildStatusCard({ timeline: workingTimeline }));
    const meta = elementById(card, 'run_meta')!['content'] as string;

    assert.match(meta, /11 actions · 1m 04s/);
    assert.doesNotMatch(meta, /11\/11/);
    assert.doesNotMatch(JSON.stringify(card), /Step \d+\/\d+/);
  });

  it('shows a fraction and a bar only when a checklist was declared', () => {
    const withoutPlan = parseCard(buildStatusCard({ timeline: workingTimeline }));
    assert.equal(elementById(withoutPlan, 'run_bar'), undefined);

    const withPlan = parseCard(buildStatusCard({
      timeline: {
        ...workingTimeline,
        declared: { done: 2, total: 5, current: 'Reconcile the payment', next: 'File the report' },
      },
    }));
    const meta = elementById(withPlan, 'run_meta')!['content'] as string;
    assert.match(meta, /Step 3 of 5/);
    assert.match(meta, /11 actions/, 'a stale checklist must not freeze the counter');
    assert.match(elementById(withPlan, 'run_bar')!['content'] as string, /▰▰▱▱▱/);
  });

  it('never renders a progress chart', () => {
    const card = parseCard(buildStatusCard({ timeline: { ...workingTimeline, progressPct: 88 } }));
    assert.equal(bodyElements(card).some(e => e['tag'] === 'chart'), false);
    assert.equal(findColumnSet(bodyElements(card)), undefined);
  });

  it('never renders a trace panel', () => {
    const card = parseCard(buildStatusCard({ timeline: workingTimeline }));
    assert.equal(bodyElements(card).some(e => e['tag'] === 'collapsible_panel'), false);
    assert.doesNotMatch(JSON.stringify(card), /Trace/i);
  });

  it('renders one ledger line per tool family with its outcome', () => {
    const card = parseCard(buildStatusCard({ timeline: workingTimeline }));
    const ledger = elementById(card, 'run_ledger')!['content'] as string;

    assert.match(ledger, /✓ \*\*Zoho · 7 calls\*\*.*Created INV-1043/);
    assert.match(ledger, /● \*\*Lark\*\*/);
    assert.equal(ledger.split('\n').length, 2);
  });

  it('counts older ledger groups instead of dropping them silently', () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({
      label: `Tool${i}`, count: 1, outcome: `Did ${i}`, status: 'done' as const,
    }));
    const card = parseCard(buildStatusCard({ timeline: { ...workingTimeline, ledger: rows } }));
    const ledger = elementById(card, 'run_ledger')!['content'] as string;

    assert.match(ledger, /\+ 3 earlier steps/);
    assert.match(ledger, /Tool7/);
    assert.doesNotMatch(ledger, /Tool0/);
  });

  it('carries the run state in the header title, not a constant', () => {
    const working = parseCard(buildStatusCard({ timeline: workingTimeline }));
    assert.equal((working['header'] as { title: { content: string } }).title.content, 'Working…');

    const writing = parseCard(buildStatusCard({
      timeline: { ...workingTimeline, state: 'writing' },
    }));
    assert.equal((writing['header'] as { title: { content: string } }).title.content, 'Writing your answer…');
  });

  it('marks a failed ledger row without claiming the run is over', () => {
    const card = parseCard(buildStatusCard({
      timeline: {
        ...workingTimeline,
        ledger: [{ label: 'Zoho', count: 1, outcome: '401 token expired', status: 'failed' }],
      },
    }));
    assert.match(elementById(card, 'run_ledger')!['content'] as string, /✗ \*\*Zoho\*\*.*401 token expired/);
    assert.ok(elementById(card, 'stop_run'), 'a failed step does not end the run');
  });

  it('wires Stop as a 2.0 callback and ships no unverified icon tokens', () => {
    const card = parseCard(buildStatusCard({ timeline: workingTimeline }));
    const stop = elementById(card, 'stop_run') as {
      text: { content: string };
      behaviors: Array<{ type: string; value: { action: string } }>;
    };
    assert.equal(stop.text.content, 'Stop');
    assert.equal(stop.behaviors[0]!.type, 'callback');
    assert.equal(stop.behaviors[0]!.value.action, 'interrupt_run');
    // An unrecognised standard_icon token makes Lark reject the whole card.
    assert.doesNotMatch(JSON.stringify(card), /standard_icon/);
  });

  it('titles the card with the request when one is known', () => {
    const card = parseCard(buildStatusCard({
      timeline: { ...workingTimeline, subject: 'Invoice for Acme Corp' },
    }));
    assert.equal((card['header'] as { title: { content: string } }).title.content, 'Invoice for Acme Corp');
  });

  // The Lark heartbeat re-renders the last snapshot, so a duration baked into
  // that snapshot would sit frozen through a four-minute tool call.
  it('recomputes elapsed time at render, not at snapshot time', () => {
    const startedAtMs = 1_000_000;
    const early = parseCard(buildStatusCard({ timeline: { ...workingTimeline, startedAtMs } }));
    assert.ok(typeof (elementById(early, 'run_meta')!['content']) === 'string');

    const counterOf = (card: Record<string, unknown>) =>
      (elementById(card, 'run_meta')!['content'] as string).match(/(\d+m \d+s|\d+s)/)?.[0];
    const first = counterOf(early);
    // Same timeline object, later wall clock — the rendered counter must move.
    const originalNow = Date.now;
    (Date as { now: () => number }).now = () => startedAtMs + 240_000;
    try {
      const later = parseCard(buildStatusCard({ timeline: { ...workingTimeline, startedAtMs } }));
      assert.notEqual(counterOf(later), first);
      assert.equal(counterOf(later), '4m 00s');
    } finally {
      (Date as { now: () => number }).now = originalNow;
    }
  });

  it('previews the run state in the notification summary', () => {
    const card = parseCard(buildStatusCard({ timeline: workingTimeline }));
    const config = card['config'] as { summary: { content: string } };
    assert.match(config.summary.content, /Working… — 11 actions/);
  });
});

describe('lark-card.builder final card actions', () => {
  // Card 2.0 dropped the `action` container and ignores 1.0's `value` on a
  // button — a final card built the old way rendered buttons that did nothing.
  it('emits 2.0 buttons with callback behaviors, not an action container', () => {
    const card = parseCard(buildFinalCard({
      markdown: '# Done\n\nInvoice created.',
      actions:  [{ label: 'Open in Zoho', value: 'open_zoho', style: 'primary' }],
    }));
    const elements = bodyElements(card);
    assert.equal(elements.some(e => e['tag'] === 'action'), false);

    const columns = (elementById(card, 'final_actions')!['columns'] as Array<{
      elements: Array<{ tag: string; type: string; behaviors: Array<{ type: string; value: { action: string } }> }>;
    }>);
    const button = columns[0]!.elements[0]!;
    assert.equal(button.tag, 'button');
    assert.equal(button.type, 'primary');
    assert.equal(button.behaviors[0]!.type, 'callback');
    assert.equal(button.behaviors[0]!.value.action, 'open_zoho');
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
