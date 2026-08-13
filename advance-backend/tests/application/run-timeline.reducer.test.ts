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
      // the call rather than parsing the English label back into a vendor.
      { kind: 'tool', label: 'Terminal', count: 1, status: 'done', outcome: 'ls -la', toolName: 'bash' },
    ]);
    assert.equal(run.timeline().startedAtMs, STARTED_AT);
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
