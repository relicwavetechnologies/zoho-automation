import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildFinalCard, buildStatusCard, foldRepeatedRows, planFinalCards } from '../../src/infrastructure/channels/lark/lark-card.builder.ts'
import type { ChannelLedgerRow } from '../../src/domain/channel/outbound.ts';

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

describe('lark-card.builder buildStatusCard', () => {
  const workingTimeline = {
    subject:     'Invoice for Acme Corp',
    phase:       'Executing',
    state:       'working' as const,
    liveLabel:   'Attaching the PDF to the Lark task…',
    actionCount: 11,
    startedAtMs: Date.now() - 64_000,
    ledger: [
      { label: 'Zoho', count: 7, outcome: 'Created INV-1043', status: 'done' as const },
      { label: 'Lark', count: 1, outcome: 'Attaching the PDF', status: 'running' as const },
    ],
  };

  const headerTitle = (card: Record<string, unknown>): string | undefined =>
    (card['header'] as { title?: { content: string } } | undefined)?.title?.content;

  const chips = (card: Record<string, unknown>): string[] =>
    ((card['header'] as { text_tag_list?: Array<{ text: { content: string } }> } | undefined)
      ?.text_tag_list ?? []).map(tag => tag.text.content);

  // The card this replaced said "Thinking…" in the header, "Understanding your
  // request" in the body, and "● Thinking · 13s" below it: one fact, three lines.
  it('states the run state exactly once, in the header chip', () => {
    const card = parseCard(buildStatusCard({ timeline: workingTimeline }));

    assert.deepEqual(chips(card), ['Working']);
    assert.equal(headerTitle(card), 'Invoice for Acme Corp');
    for (const content of markdownContents(card)) {
      assert.doesNotMatch(content, /\bWorking\b/);
    }
  });

  // Lark prints the sender name and its Agent badge directly above the card.
  it('never spends the header on the bot’s own name', () => {
    const card = parseCard(buildStatusCard({ timeline: workingTimeline }));
    assert.doesNotMatch(JSON.stringify(card['header']), /Divo/);
  });

  it('renders one activity line per step, newest last', () => {
    const card = parseCard(buildStatusCard({ timeline: workingTimeline }));
    const activity = (elementById(card, 'run_activity')!['content'] as string).split('\n');

    assert.equal(activity.length, 2);
    assert.match(activity[0]!, /^✓ \*\*Zoho\*\*.*×7.*Created INV-1043/);
    assert.match(activity[1]!, /^● \*\*Lark\*\*.*Attaching the PDF/);
  });

  it('indents a step’s children under it instead of promoting them to peers', () => {
    const card = parseCard(buildStatusCard({
      timeline: {
        ...workingTimeline,
        ledger: [{
          label: 'Subagents', count: 1, status: 'running' as const,
          children: [
            { label: 'scout', count: 1, outcome: 'reading the export', status: 'running' as const },
            { label: 'reviewer', count: 1, outcome: 'checking totals', status: 'done' as const },
          ],
        }],
      },
    }));
    const lines = (elementById(card, 'run_activity')!['content'] as string).split('\n');

    assert.equal(lines.length, 3);
    assert.match(lines[0]!, /^● \*\*Subagents\*\*/);
    assert.match(lines[1]!, /^　└ ● \*\*scout\*\*/);
    assert.match(lines[2]!, /^　└ ✓ \*\*reviewer\*\*/);
  });

  // A ✓ already says "done"; writing "Done" beside it is the padding this
  // layout exists to remove, so a row with no real outcome carries no tail.
  it('leaves a row bare when the step produced no outcome to report', () => {
    const card = parseCard(buildStatusCard({
      timeline: { ...workingTimeline, ledger: [{ label: 'Web search', count: 1, status: 'done' as const }] },
    }));
    assert.equal(elementById(card, 'run_activity')!['content'], '✓ **Web search**');
  });

  it('counts older activity rows instead of dropping them silently', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({
      label: `Tool${i}`, count: 1, outcome: `Did ${i}`, status: 'done' as const,
    }));
    const activity = parseCard(buildStatusCard({ timeline: { ...workingTimeline, ledger: rows } }));
    const content = elementById(activity, 'run_activity')!['content'] as string;

    assert.match(content, /\+3 earlier steps/);
    assert.match(content, /Tool11/);
    assert.doesNotMatch(content, /Tool0\b/);
  });

  // The header chip already says the state. A title that falls back to the same
  // word puts one fact in two places a centimetre apart — the exact doubling
  // this card was rebuilt to remove.
  it('leaves the header to the chip when the run has no subject', () => {
    const { subject: _drop, ...noSubject } = workingTimeline;
    const card = parseCard(buildStatusCard({ timeline: noSubject }));

    assert.equal(headerTitle(card), undefined);
    assert.deepEqual(chips(card), ['Working']);
  });

  it('suppresses the agent’s live sentence while a step is running', () => {
    const card = parseCard(buildStatusCard({ timeline: workingTimeline }));
    assert.equal(elementById(card, 'run_say'), undefined);
  });

  it('shows the agent’s live sentence when no step is running', () => {
    const card = parseCard(buildStatusCard({
      timeline: {
        ...workingTimeline,
        ledger: [{ label: 'Zoho', count: 1, outcome: 'Created INV-1043', status: 'done' as const }],
        liveLabel: 'Checking whether the payment already cleared',
      },
    }));
    assert.match(elementById(card, 'run_say')!['content'] as string, /payment already cleared/);
  });

  it('does not apply the compact activity-row limit to narration', () => {
    const queued = 'Your request is queued. I’ll start it as soon as your previous request finishes.';
    const card = parseCard(buildStatusCard({
      timeline: { state: 'queued' as const, liveLabel: queued },
    }));

    assert.match(elementById(card, 'run_say')!['content'] as string, new RegExp(queued));
  });

  it('drops a live sentence that only echoes the state chip', () => {
    for (const liveLabel of ['Thinking…', 'Understanding your request…', 'Continuing…']) {
      const card = parseCard(buildStatusCard({
        timeline: { subject: 'Invoice', state: 'thinking' as const, liveLabel },
      }));
      assert.equal(elementById(card, 'run_say'), undefined, liveLabel);
      assert.match(markdownContents(card).join('\n'), /Getting started/);
    }
  });

  it('folds the plan behind its own progress, and names the current step on the fold', () => {
    const card = parseCard(buildStatusCard({
      timeline: {
        ...workingTimeline,
        declared: {
          done: 1, total: 3, current: 'Reconcile the payment',
          items: [
            { title: 'Pull the invoice', status: 'done' as const },
            { title: 'Reconcile the payment', status: 'running' as const },
            { title: 'File the report', status: 'pending' as const },
          ],
        },
      },
    }));
    const panel = elementById(card, 'run_plan') as {
      tag: string;
      expanded: boolean;
      header: { title: { content: string } };
      elements: Array<{ content: string }>;
    };

    assert.equal(panel.tag, 'collapsible_panel');
    assert.equal(panel.expanded, false, 'the plan is context, not the headline');
    assert.match(panel.header.title.content, /\*\*Plan\*\*.*1 of 3 · Reconcile the payment/);
    assert.match(panel.elements[0]!.content, /○ File the report/);
  });

  // A panel that opens onto nothing is a worse version of a plain line.
  it('renders the plan as one line when its steps were never named', () => {
    const card = parseCard(buildStatusCard({
      timeline: { ...workingTimeline, declared: { done: 1, total: 3 } },
    }));
    const plan = elementById(card, 'run_plan')!;
    assert.equal(plan['tag'], 'markdown');
    assert.match(plan['content'] as string, /1 of 3/);
  });

  it('puts the counter and how to stop on one footer line', () => {
    const footer = elementById(parseCard(buildStatusCard({ timeline: workingTimeline })), 'run_count')!;

    assert.equal(footer['tag'], 'markdown');
    assert.match(footer['content'] as string, /11 steps · 1m 04s/);
    assert.match(footer['content'] as string, /`\/q` to stop/);
  });

  // The card is a message, not a control panel: a callback button is the one
  // affordance that stops working the moment the bubble scrolls away, and it
  // was a second way to say something `/q` already says.
  it('carries no buttons at all', () => {
    const card = parseCard(buildStatusCard({ timeline: workingTimeline }));

    assert.doesNotMatch(JSON.stringify(card), /"tag":"button"/);
    assert.doesNotMatch(JSON.stringify(card), /callback/);
  });

  // Naming `/q` on a run nobody can stop sends the user to a command that
  // answers "there is no active run" — queued included, since nothing has
  // registered an abort until the lane opens.
  it('names the stop command only while a run can actually be stopped', () => {
    for (const state of ['queued', 'done', 'blocked'] as const) {
      const card = parseCard(buildStatusCard({ timeline: { ...workingTimeline, state } }));
      assert.doesNotMatch(JSON.stringify(card), /to stop/, state);
    }
  });

  it('marks a failed step without claiming the run is over', () => {
    const card = parseCard(buildStatusCard({
      timeline: {
        ...workingTimeline,
        ledger: [{ label: 'Zoho', count: 1, outcome: '401 token expired', status: 'failed' as const }],
      },
    }));

    assert.match(elementById(card, 'run_activity')!['content'] as string, /✗ \*\*Zoho\*\*.*401 token expired/);
    assert.deepEqual(chips(card), ['Working']);
    assert.match(
      elementById(card, 'run_count')!['content'] as string,
      /to stop/,
      'a failed step does not end the run',
    );
  });

  it('never renders a progress chart', () => {
    const card = parseCard(buildStatusCard({ timeline: { ...workingTimeline, progressPct: 88 } }));
    assert.equal(bodyElements(card).some(e => e['tag'] === 'chart'), false);
    assert.doesNotMatch(JSON.stringify(card), /88/);
  });

  it('ships only the icon token the collapsible panel is known to accept', () => {
    const card = parseCard(buildStatusCard({
      timeline: {
        ...workingTimeline,
        declared: { done: 1, total: 2, items: [{ title: 'a', status: 'done' as const }] },
      },
    }));
    const tokens = [...JSON.stringify(card).matchAll(/"token":"([^"]+)"/g)].map(m => m[1]);
    assert.deepEqual([...new Set(tokens)], ['down-small-ccm_outlined']);
  });

  // The Lark heartbeat re-renders the last snapshot, so a duration baked into
  // that snapshot would sit frozen through a four-minute tool call.
  it('recomputes elapsed time at render, not at snapshot time', () => {
    const startedAtMs = 1_000_000;
    const counterOf = (card: Record<string, unknown>) =>
      (elementById(card, 'run_count')!['content'] as string).match(/(\d+m \d+s|\d+s)/)?.[0];

    const originalNow = Date.now;
    (Date as { now: () => number }).now = () => startedAtMs + 30_000;
    try {
      const early = parseCard(buildStatusCard({ timeline: { ...workingTimeline, startedAtMs } }));
      assert.equal(counterOf(early), '30s');
      (Date as { now: () => number }).now = () => startedAtMs + 240_000;
      const later = parseCard(buildStatusCard({ timeline: { ...workingTimeline, startedAtMs } }));
      assert.equal(counterOf(later), '4m 00s');
    } finally {
      (Date as { now: () => number }).now = originalNow;
    }
  });

  it('previews the run in the notification summary', () => {
    const card = parseCard(buildStatusCard({ timeline: workingTimeline }));
    const config = card['config'] as { summary: { content: string } };
    assert.match(config.summary.content, /Invoice for Acme Corp — Working… · 11 steps/);
  });
});

describe('lark-card.builder activity log', () => {
  // A run that only shows its tool calls reads as a machine grinding. What the
  // model says between them is the one thing on the card written for a person.
  it('interleaves what the model said with what it did, in order', () => {
    const card = parseCard(buildStatusCard({
      timeline: {
        state: 'working' as const,
        ledger: [
          { kind: 'say' as const, label: 'Let me see which Airtable bases you can reach.', count: 1, status: 'done' as const },
          { kind: 'tool' as const, label: 'Terminal', count: 1, outcome: 'airtable list-bases', status: 'done' as const },
          { kind: 'say' as const, label: 'Found 3. Profiling the largest.', count: 1, status: 'done' as const },
          { kind: 'tool' as const, label: 'Files', count: 1, outcome: 'bases.json', status: 'running' as const },
        ],
      },
    }));

    assert.equal(elementById(card, 'run_activity')!['content'], [
      'Let me see which Airtable bases you can reach.',
      "✓ **Terminal**  <font color='grey'>airtable list-bases</font>",
      'Found 3. Profiling the largest.',
      "● **Files**  <font color='grey'>bases.json</font>",
    ].join('\n'));
  });

  // Detail is now a shell command or a sentence the model wrote, and it lands
  // inside a <font> tag the card opened. A pipeline containing an angle bracket
  // would close that tag early and take the card's structure with it.
  it('will not let a redirect in a command close the card markup', () => {
    const card = parseCard(buildStatusCard({
      timeline: {
        state: 'working' as const,
        ledger: [{ label: 'Terminal', count: 1, outcome: 'echo hi > /tmp/f && cat <x>', status: 'done' as const }],
      },
    }));
    const activity = elementById(card, 'run_activity')!['content'] as string;

    assert.match(activity, /echo hi \/tmp\/f && cat x/);
    // Exactly the one opening and one closing tag the builder wrote itself.
    assert.equal((activity.match(/</g) ?? []).length, 2);
  });
});

describe('lark-card.builder heading softening', () => {
  // Two trailing spaces is markdown's hard line break, so a model writing
  // correct markdown produced `**Title  **` — a bold run CommonMark will not
  // close. The card printed the asterisks to the user.
  it('bolds a heading that ends in trailing whitespace', () => {
    const card = parseCard(buildFinalCard({
      markdown: '## CFO Receivables Review  \n\nZoho Books shows 153 invoices.',
    }));

    assert.equal(markdownContents(card)[0], '**CFO Receivables Review**');
  });

  it('softens headings deeper than three, which used to reach the card as hashes', () => {
    const card = parseCard(buildFinalCard({ markdown: '#### Ageing buckets\n\nDetail.' }));

    assert.equal(markdownContents(card)[0], '**Ageing buckets**');
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

  it('emits direct connection links as open-url buttons', () => {
    const card = parseCard(buildFinalCard({
      markdown: 'Connect Google to continue.',
      actions: [{
        label: 'Connect Google',
        url: 'https://accounts.google.com/o/oauth2/auth?state=opaque',
        style: 'primary',
      }],
    }));
    const columns = (elementById(card, 'final_actions')!['columns'] as Array<{
      elements: Array<{ behaviors: Array<{ type: string; default_url: string }> }>;
    }>);

    assert.deepEqual(columns[0]!.elements[0]!.behaviors, [{
      type: 'open_url',
      default_url: 'https://accounts.google.com/o/oauth2/auth?state=opaque',
    }]);
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

    const titleOf = (card: Record<string, unknown>) =>
      (card['header'] as { title?: { content: string } } | undefined)?.title?.content;

    assert.equal(titleOf(firstCard), 'Finance Update');
    assert.equal(titleOf(secondCard), 'Finance Update');
    assert.equal(titleOf(thirdCard), 'Finance Update');
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
    const header = card['header'] as { title?: { content: string } } | undefined;
    assert.equal(header?.title?.content, 'Done');
    assert.ok(panelTitles(card).includes('Execution trace'));
  });
});

describe('lark-card.builder final card header', () => {
  // Lark already prints "Divo | Agent" above every bubble, so a header reading
  // "Divo AI" with a "Divo" chip spent the widest line of the card saying the
  // name a third time. A plain answer now goes out headerless.
  it('omits the header entirely for a reply with no heading of its own', () => {
    const card = parseCard(buildFinalCard({ markdown: 'Hi there! How can I help you today?' }));

    assert.equal(card['header'], undefined);
    assert.doesNotMatch(JSON.stringify(card), /Divo/);
  });

  it('promotes the reply’s own heading to the header title', () => {
    const card = parseCard(buildFinalCard({ markdown: '# Finance Update\n\nAll reconciled.' }));
    const header = card['header'] as { title: { content: string }; subtitle?: unknown };

    assert.equal(header.title.content, 'Finance Update');
    assert.equal(header.subtitle, undefined, 'the heading is the title, not a subtitle under a constant');
  });

  it('keeps a real department chip, which the client cannot show on its own', () => {
    const card = parseCard(buildFinalCard({
      markdown: 'Reconciled.',
      branding: { departmentLabel: 'Finance', departmentColor: 'green' },
    }));
    const header = card['header'] as { text_tag_list: Array<{ text: { content: string }; color: string }> };

    assert.equal(header.text_tag_list[0]!.text.content, 'Finance');
    assert.equal(header.text_tag_list[0]!.color, 'green');
  });

  it('drops a department chip that only repeats the bot name', () => {
    const card = parseCard(buildFinalCard({
      markdown: 'Reconciled.',
      branding: { departmentLabel: 'Divo' },
    }));
    assert.equal(card['header'], undefined);
  });
});

// Paging a table nineteen times is one act. Printed as nineteen rows it buries
// everything else the run did.
describe('lark-card.builder repeated step folding', () => {
  const step = (label: string, outcome?: string, status: 'done' | 'running' | 'failed' = 'done') =>
    ({ kind: 'tool' as const, label, count: 1, status, ...(outcome ? { outcome } : {}) });
  const said = (label: string) => ({ kind: 'say' as const, label, count: 1, status: 'done' as const });

  const labels = (rows: readonly ChannelLedgerRow[]) =>
    foldRepeatedRows(rows).map(r => `${r.label}${r.count > 1 ? `×${r.count}` : ''}:${r.status}`);

  it('counts identical adjacent steps as one row', () => {
    assert.deepEqual(
      labels([step('Airtable', 'Records'), step('Airtable', 'Records'), step('Airtable', 'Records')]),
      ['Airtable×3:done'],
    );
  });

  // Two calls to the same tool doing different work are not the same act.
  it('keeps the same tool apart when it did different things', () => {
    assert.deepEqual(
      labels([step('Airtable', 'Records'), step('Airtable', 'Schema')]),
      ['Airtable:done', 'Airtable:done'],
    );
  });

  // The whole point of the log is the order things happened in.
  it('will not reorder a step across something the model said', () => {
    assert.deepEqual(
      labels([step('Airtable', 'Records'), said('Found 3.'), step('Airtable', 'Records')]),
      ['Airtable:done', 'Found 3.:done', 'Airtable:done'],
    );
  });

  it('surfaces a failure hidden inside a group instead of marking it done', () => {
    assert.deepEqual(
      labels([step('Airtable', 'Records'), step('Airtable', 'Records', 'failed'), step('Airtable', 'Records')]),
      ['Airtable×3:failed'],
    );
    assert.deepEqual(
      labels([step('Airtable', 'Records'), step('Airtable', 'Records', 'running')]),
      ['Airtable×2:running'],
    );
  });

  it('renders the count the card has always had a renderer for', () => {
    const card = parseCard(buildStatusCard({
      timeline: { state: 'working' as const, ledger: [step('Airtable', 'Records'), step('Airtable', 'Records')] },
    }));

    assert.match(elementById(card, 'run_activity')!['content'] as string, /✓ \*\*Airtable\*\* .*×2/);
  });
});
