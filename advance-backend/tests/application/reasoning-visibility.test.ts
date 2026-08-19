import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseProgressEvent } from '../../src/application/runtime/lark-pi-runtime.service.ts';
import { createRunTimelineReducer } from '../../src/application/channels/run-timeline.reducer.ts';
import { runTranscript, shownOnCard } from '../../src/infrastructure/channels/lark/lark-card.builder.ts';
import type { ChannelLedgerRow } from '../../src/domain/channel/outbound.ts';

/*
 * The model's reasoning used to stop at the container, on the grounds that a
 * Lark status card is read by everyone in the chat. That was a true fact about
 * a *card*, enforced at the wrong end — it also withheld the reasoning from the
 * web thread, which is one person reading their own conversation.
 *
 * So it now crosses, marked, and the card drops it. These tests hold both ends
 * of that: the reasoning has to arrive, and it must not reach a card.
 */
describe('reasoning on the way in', () => {
  it('carries a thought through as its own kind', () => {
    assert.deepEqual(
      parseProgressEvent({ type: 'thought', index: 1, text: 'The invoices are the unpaid ones.' }),
      { type: 'thought', index: 1, text: 'The invoices are the unpaid ones.' },
    );
  });

  /* Still model output, so still bounded — the container is trusted to run the
     work, not to decide how much of a payload it may fill. But bounded as a
     paragraph rather than as a sentence: reasoning accumulates from the start
     and is cut from the front, so a `say`'s 200 would freeze a thought at its
     first two sentences and it would never move again. */
  it('gives a thought a paragraph of room, and still bounds it', () => {
    const long = parseProgressEvent({ type: 'thought', index: 0, text: 'x'.repeat(4_000) });
    assert.equal(long?.type === 'thought' && long.text.length, 1_200);

    const said = parseProgressEvent({ type: 'say', index: 0, text: 'x'.repeat(4_000) });
    assert.equal(said?.type === 'say' && said.text.length, 200);
  });

  it('ignores a thought with nothing in it', () => {
    assert.equal(parseProgressEvent({ type: 'thought', index: 0, text: '   ' }), undefined);
  });
});

describe('live answer deltas on the way in', () => {
  it('preserves exact Markdown whitespace', () => {
    assert.deepEqual(
      parseProgressEvent({ type: 'answer_delta', index: 1, delta: ' **there**\n' }),
      { type: 'answer_delta', index: 1, delta: ' **there**\n' },
    );
  });

  it('carries an explicit retry reset without turning it into a timeline row', () => {
    assert.deepEqual(parseProgressEvent({ type: 'answer_reset' }), { type: 'answer_reset' });
    const run = createRunTimelineReducer({ startedAtMs: 1_700_000_000_000 });
    run.apply({ type: 'answer_reset' });
    assert.equal(run.timeline().ledger, undefined);
  });

  it('does not add answer prose to the neutral timeline', () => {
    const run = createRunTimelineReducer({ startedAtMs: 1_700_000_000_000 });
    run.apply({ type: 'answer_delta', index: 0, delta: 'Hello' });
    assert.equal(run.timeline().ledger, undefined);
  });
});

describe('reasoning in the run log', () => {
  it('keeps thinking and talking apart, in the order they happened', () => {
    const run = createRunTimelineReducer({ startedAtMs: 1_700_000_000_000 });
    run.apply({ type: 'thought', index: 0, text: 'Unpaid means status is overdue.' });
    run.apply({ type: 'say', index: 0, text: 'Let me check the invoices.' });

    assert.deepEqual(run.timeline().ledger, [
      // The thought is settled, not open: the model stopped reasoning by
      // starting to talk, and the row it left behind says so.
      { id: 'thought:0:0', kind: 'thought', label: 'Unpaid means status is overdue.', count: 1, status: 'done' },
      { id: 'say:0:0', kind: 'say', label: 'Let me check the invoices.', count: 1, status: 'done' },
    ]);
  });

  /* A thought and a sentence can carry the same block index inside one message.
     Sharing a key would have one silently replace the other. */
  it('does not let a thought and a sentence at the same index overwrite each other', () => {
    const run = createRunTimelineReducer({ startedAtMs: 1_700_000_000_000 });
    run.apply({ type: 'thought', index: 0, text: 'Thinking about it.' });
    run.apply({ type: 'say', index: 0, text: 'Talking about it.' });
    assert.equal(run.timeline().ledger?.length, 2);
  });

  /* The reducer erases its whole log the moment a protected read starts, and
     reasoning is exactly the kind of text that quotes the record it just read. */
  it('erases reasoning when the run touches protected data', () => {
    const run = createRunTimelineReducer({ startedAtMs: 1_700_000_000_000 });
    run.apply({ type: 'thought', index: 0, text: 'Ada Lovelace ordered twice this month.' });
    run.apply({ type: 'tool_start', callId: 'c1', toolName: 'divo_shopify_customers', toolId: 'shopifyCustomers' });

    // Not an empty list — no list at all. An erased log is omitted rather than
    // sent as `[]`, so there is no row for a surface to render and nothing that
    // could survive as a stale frame.
    assert.equal(run.timeline().ledger, undefined);
    assert.equal(run.timeline().liveLabel, 'Working…');
  });
});

describe('what a Lark card is allowed to show', () => {
  const ledger: ChannelLedgerRow[] = [
    { kind: 'thought', label: 'The customer is probably Ada.', count: 1, status: 'done' },
    { kind: 'say', label: 'Checking that now.', count: 1, status: 'done' },
    { kind: 'tool', label: 'Zoho Books', count: 1, status: 'done', outcome: 'List invoices' },
  ];

  /* The reason the original rule existed, kept: a card is read by a whole chat,
     and the model reasoning to itself is not addressed to a room. */
  it('drops the reasoning and keeps everything else', () => {
    assert.deepEqual(shownOnCard(ledger), [ledger[1], ledger[2]]);
  });

  it('keeps reasoning out of the trace panel too', () => {
    const trace = runTranscript(ledger) ?? '';
    assert.equal(trace.includes('Ada'), false);
    assert.equal(trace.includes('Checking that now.'), true);
    assert.equal(trace.includes('Zoho Books'), true);
  });

  /* A run whose log is nothing but reasoning has no card-worthy log at all —
     and must not produce a panel that opens onto nothing. */
  it('offers no trace panel for a run that only thought', () => {
    assert.equal(
      runTranscript([{ kind: 'thought', label: 'Hmm.', count: 1, status: 'done' }]),
      undefined,
    );
  });
});
