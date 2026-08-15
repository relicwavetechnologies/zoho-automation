import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRunTimelineReducer } from '../../src/application/channels/run-timeline.reducer.ts';

const STARTED_AT = 1_700_000_000_000;

const reducer = () => createRunTimelineReducer({ startedAtMs: STARTED_AT });

describe('run timeline reducer', () => {
  // The whole point of lifting this out of the Lark webhook: what it produces
  // must be renderable by a surface it has never heard of.
  it('describes a run without naming a channel', () => {
    const run = reducer();
    run.apply({ type: 'tool_start', callId: 'c1', toolName: 'bash', detail: 'ls -la' });
    run.apply({ type: 'tool_end', callId: 'c1', toolName: 'bash', isError: false });

    assert.deepEqual(run.timeline().ledger, [
      // `toolName` rides along so a surface that draws vendor marks can key off
      // the call rather than parsing the English label back into a vendor, and
      // `id` so it can tell this row from the same row one frame later.
      { id: 'c1', kind: 'tool', label: 'Terminal', count: 1, status: 'done', outcome: 'ls -la', toolName: 'bash' },
    ]);
    assert.equal(run.timeline().startedAtMs, STARTED_AT);
  });

  /* Every row keeps one identity for the whole run. A surface redraws from a
     fresh snapshot several times a second, and without this the only way to
     match a row against the one it was last tick is its position — which is not
     identity, because rows get inserted above other rows. */
  it('gives every row an identity that survives the next snapshot', () => {
    const run = reducer();
    run.apply({ type: 'thought', index: 0, text: 'Where are the invoices?' });
    run.apply({ type: 'say', index: 0, text: 'Checking Zoho Books.' });
    run.apply({ type: 'tool_start', callId: 'call-9', toolName: 'read' });

    const before = run.timeline().ledger?.map(row => row.id);
    run.apply({ type: 'tool_end', callId: 'call-9', toolName: 'read', isError: false });

    assert.deepEqual(before, ['thought:0:0', 'say:0:0', 'call-9']);
    assert.deepEqual(run.timeline().ledger?.map(row => row.id), before);
  });

  /* A thought has no end event of its own — the model stops thinking by doing
     something else, and this is the only place that sees it do so. A surface
     guessing from position instead flipped a thought between its live window
     and its folded line whenever the list was reshaped for other reasons. */
  describe('when the model stops thinking', () => {
    const stillThinking = (run: ReturnType<typeof reducer>) =>
      run.timeline().ledger?.filter(row => row.kind === 'thought' && row.status === 'running').length;

    it('leaves the newest thought open while nothing has followed it', () => {
      const run = reducer();
      run.apply({ type: 'thought', index: 0, text: 'Two things to check.' });

      assert.equal(stillThinking(run), 1);
    });

    it('settles it the moment the model talks, calls a tool, or thinks again', () => {
      for (const next of [
        { type: 'say', index: 1, text: 'Checking now.' },
        { type: 'tool_start', callId: 'c1', toolName: 'read' },
        { type: 'thought', index: 1, text: 'Actually, three things.' },
      ] as const) {
        const run = reducer();
        run.apply({ type: 'thought', index: 0, text: 'Two things to check.' });
        run.apply(next);

        // One open thought at most — the new one, where the event was a thought.
        assert.equal(stillThinking(run), next.type === 'thought' ? 1 : 0, next.type);
        assert.equal(run.timeline().ledger?.[0]?.status, 'done', next.type);
      }
    });

    // A run whose record was written mid-thought would replay as one forever.
    it('settles it when the run moves on to writing its reply', () => {
      const run = reducer();
      run.apply({ type: 'thought', index: 0, text: 'Two things to check.' });
      run.finishing();

      assert.equal(stillThinking(run), 0);
    });
  });

  /* Which sentences are asides is the run's own knowledge: it said them and
     then carried on working. A surface guessing instead — by watching whether
     the live answer stream happened to be empty — watched the backend clear
     that stream on every tool call, and moved the same sentence between the
     work log and the answer, and back, several times a turn. */
  describe('what the model said on the way', () => {
    it('claims nothing about a sentence while the run may still end on it', () => {
      const run = reducer();
      run.apply({ type: 'say', index: 0, text: 'Three invoices are overdue.' });

      assert.equal(run.timeline().ledger?.[0]?.aside, undefined);
    });

    it('marks it an aside once the model goes on working', () => {
      const run = reducer();
      run.apply({ type: 'say', index: 0, text: 'Let me check Zoho Books.' });
      run.apply({ type: 'tool_start', callId: 'c1', toolName: 'read' });

      assert.equal(run.timeline().ledger?.[0]?.aside, true);
    });

    it('leaves what it said after the last tool call as the reply', () => {
      const run = reducer();
      run.apply({ type: 'say', index: 0, text: 'Let me check Zoho Books.' });
      run.apply({ type: 'tool_start', callId: 'c1', toolName: 'read' });
      run.apply({ type: 'tool_end', callId: 'c1', toolName: 'read', isError: false });
      run.apply({ type: 'say', index: 0, text: 'Three invoices are overdue.' });

      assert.deepEqual(
        run.timeline().ledger?.filter(row => row.kind === 'say').map(row => [row.label, row.aside]),
        [['Let me check Zoho Books.', true], ['Three invoices are overdue.', undefined]],
      );
    });

    /* The sentence a reader is looking at has just changed what it means.
       Holding that for the next throttled frame leaves it drawn as the reply
       for up to a second after it stopped being one. */
    it('asks to be shown immediately when a sentence changes meaning', () => {
      const run = reducer();
      run.apply({ type: 'say', index: 0, text: 'Let me check Zoho Books.' });
      assert.equal(run.apply({ type: 'tool_start', callId: 'c1', toolName: 'read' }), 'immediate');
      // A tool call with nothing to reclassify is the ordinary throttled case.
      assert.equal(run.apply({ type: 'tool_start', callId: 'c2', toolName: 'read' }), 'throttled');
    });
  });

  // A fraction counted from "tool calls so far" has no denominator, because the
  // total is unknowable until the run ends. Only a declared checklist has one.
  it('reports a fraction only when the run declared a checklist', () => {
    const run = reducer();
    run.apply({ type: 'tool_start', callId: 'c1', toolName: 'read' });
    assert.equal(run.timeline().totalSteps, undefined);
    assert.equal(run.timeline().progressPct, undefined);

    run.apply({
      type: 'tool_progress',
      callId: 'c1',
      toolName: 'divo_todos',
      todos: [
        { title: 'Pull invoices', status: 'done' },
        { title: 'Reconcile', status: 'running' },
        { title: 'Report', status: 'pending' },
      ],
    });

    const t = run.timeline();
    assert.deepEqual(
      [t.completedSteps, t.totalSteps, t.progressPct],
      [1, 3, 33],
    );
    assert.equal(t.declared?.current, 'Reconcile');
  });

  it('keeps a failed step visible as failed rather than dropping it', () => {
    const run = reducer();
    run.apply({ type: 'tool_start', callId: 'c1', toolName: 'read' });
    run.apply({ type: 'tool_end', callId: 'c1', toolName: 'read', isError: true });

    assert.equal(run.timeline().ledger?.[0]?.status, 'failed');
  });


  // A cold container can take tens of seconds. A reader watching a label that
  // never changes cannot tell booting from hung, so the run's own words for the
  // stage it is in are the most useful thing on screen at that moment.
  it('says what the run is doing while it starts, in the run\'s own words', () => {
    const run = reducer();
    run.apply({ type: 'starting', stage: 'container', label: 'Starting your workspace' });

    assert.equal(run.timeline().liveLabel, 'Starting your workspace');
    assert.equal(run.timeline().state, 'queued');
  });

  it('falls back to a plain label when the run names no stage', () => {
    const run = reducer();
    run.apply({ type: 'starting', stage: 'workspace', label: '  ' });

    assert.equal(run.timeline().liveLabel, 'Starting…');
  });

  describe('protected data', () => {
    const shopifyCustomerRead = {
      type: 'tool_start',
      callId: 'c2',
      toolName: 'divo_shopifyCustomers',
      toolId: 'shopifyCustomers',
      detail: 'alice@example.test',
    } as const;

    // Tool arguments, outcomes and declared plans can all carry customer data,
    // so what was already collected goes too — not just what comes after.
    it('erases the log it had already built when a protected read starts', () => {
      const run = reducer();
      run.apply({ type: 'say', index: 0, text: 'Looking up the customer.' });
      run.apply({ type: 'tool_start', callId: 'c1', toolName: 'bash', detail: 'grep alice' });
      assert.equal(run.timeline().ledger?.length, 2);

      run.apply(shopifyCustomerRead);

      const t = run.timeline();
      assert.equal(t.ledger, undefined);
      assert.equal(t.declared, undefined);
      assert.equal(t.actionCount, 0);
      assert.equal(t.liveLabel, 'Working…');
      assert.equal(run.protectedDataUsed, true);
    });

    it('stays erased for the rest of the run', () => {
      const run = reducer();
      run.apply(shopifyCustomerRead);
      run.apply({ type: 'say', index: 0, text: 'Alice ordered 4 items on 2 March.' });
      run.apply({ type: 'tool_start', callId: 'c3', toolName: 'write', detail: 'alice.csv' });

      assert.equal(run.timeline().ledger, undefined);
    });

    // The redaction is what the reader is waiting on; making it wait out the
    // throttle would leave the unredacted card up for another second.
    it('asks to be shown immediately, not on the next throttle tick', () => {
      const run = reducer();
      assert.equal(run.apply({ type: 'tool_start', callId: 'c1', toolName: 'bash' }), 'throttled');
      assert.equal(run.apply(shopifyCustomerRead), 'immediate');
    });

    // The runtime finds some only at the end, and one flag with two writers is
    // one flag someone forgets to set.
    it('accepts protected data the run only reported at the end', () => {
      const run = reducer();
      assert.equal(run.protectedDataUsed, false);
      run.observedProtectedData();
      assert.equal(run.protectedDataUsed, true);
    });
  });
});
