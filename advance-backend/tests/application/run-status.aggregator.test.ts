import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  RunStatusAggregator,
  dispatchedToolId,
  parseDeclaredTodos,
} from '../../src/application/orchestration/run-status.aggregator.ts';
import { summarizeRequest } from '../../src/application/orchestration/engine/core.ts';

describe('RunStatusAggregator — ledger labels', () => {
  // Production sends almost everything through the call_tool dispatcher, so the
  // ledger used to read "Tool · 4 calls" for a run that touched two vendors.
  it('names the dispatched vendor, not the dispatcher', () => {
    const agg = new RunStatusAggregator();
    agg.recordCall('discover_skill', {});
    agg.recordResult('discover_skill', 'Found 4 matching capabilities');
    agg.recordCall('call_tool', { toolId: 'zohoBooks', args: { op: 'list_invoices' } });
    agg.recordResult('call_tool', '12 overdue invoices');
    agg.recordCall('call_tool', { toolId: 'zohoBooks', args: { op: 'list_customers' } });
    agg.recordResult('call_tool', 'Top overdue: Acme Corp');
    agg.recordCall('call_tool', { toolId: 'airtableRecords', args: { op: 'list_bases' } });
    agg.recordResult('call_tool', '3 bases available');

    const rows = agg.snapshot().ledger!;
    assert.deepEqual(rows.map(r => `${r.label}x${r.count}`), ['Skillsx1', 'Zohox2', 'Airtablex1']);
    assert.equal(rows[1]!.outcome, 'Top overdue: Acme Corp');
  });

  it('settles a dispatched result on the step it started', () => {
    const agg = new RunStatusAggregator();
    agg.recordCall('call_tool', { toolId: 'zohoBooks' });
    agg.recordFailure('call_tool', '401 token expired');

    const rows = agg.snapshot().ledger!;
    assert.equal(rows[0]!.label, 'Zoho');
    assert.equal(rows[0]!.status, 'failed');
  });

  it('reads the tool id through a nested payload, and ignores everything else', () => {
    assert.equal(dispatchedToolId('call_tool', { toolId: 'larkTask' }), 'larkTask');
    assert.equal(dispatchedToolId('call_tool', { input: { toolId: 'googleGmail' } }), 'googleGmail');
    assert.equal(dispatchedToolId('call_tool', { toolId: '  ' }), undefined);
    assert.equal(dispatchedToolId('call_tool', undefined), undefined);
    assert.equal(dispatchedToolId('manageTodos', { toolId: 'nope' }), undefined);
  });
});

describe('RunStatusAggregator — declared checklist', () => {
  const listing = (...lines: string[]) => lines.join('\n');

  // manageTodos is chat-scoped for 24h, so a second request in the same chat
  // would otherwise inherit an earlier request's completed items and open at
  // "Step 4 of 4" having done nothing.
  it('ignores items completed before this run looked at the list', () => {
    const agg = new RunStatusAggregator();
    agg.recordCall('manageTodos', {});
    agg.recordResult('manageTodos', listing(
      'Added todo: "Pull revenue" (id:d4)',
      '[done] 1. Old task A (id:d1)',
      '[done] 2. Old task B (id:d2)',
      '[done] 3. Old task C (id:d3)',
      '[pending] 4. Pull revenue (id:d4)',
    ));

    assert.deepEqual(agg.snapshot().declared, { done: 0, total: 1, next: 'Pull revenue' });
  });

  it('counts progress on the items this run declared', () => {
    const agg = new RunStatusAggregator();
    agg.recordCall('manageTodos', {});
    agg.recordResult('manageTodos', listing(
      'Added todo: "B" (id:n2)',
      '[pending] 1. A (id:n1)',
      '[pending] 2. B (id:n2)',
    ));
    agg.recordCall('manageTodos', {});
    agg.recordResult('manageTodos', listing(
      'Updated "A" → done',
      '[done] 1. A (id:n1)',
      '[in_progress] 2. B (id:n2)',
    ));

    assert.deepEqual(agg.snapshot().declared, { done: 1, total: 2, current: 'B' });
  });

  it('parses every manageTodos op, and nothing else', () => {
    assert.deepEqual(
      parseDeclaredTodos('[done] 1. A (id:a)\n[pending] 2. B (id:b)'),
      [{ status: 'done', title: 'A' }, { status: 'pending', title: 'B' }],
    );
    assert.deepEqual(parseDeclaredTodos('Todos cleared.'), []);
    assert.deepEqual(parseDeclaredTodos('No todos for this chat.'), []);
    assert.equal(parseDeclaredTodos('error: title is required for add'), undefined);
    assert.equal(parseDeclaredTodos({ not: 'a string' }), undefined);
    // A line truncated mid-id is not a checklist item and must not become one.
    assert.equal(parseDeclaredTodos('[pending] 1. Half a line (id:'), undefined);
  });
});

describe('summarizeRequest', () => {
  it('skips a greeting to title the card with the actual request', () => {
    assert.equal(
      summarizeRequest('Hi. Pull the overdue invoices and mail finance.'),
      'Pull the overdue invoices and mail finance',
    );
  });

  it('strips markup that a plain_text header would render literally', () => {
    const subject = summarizeRequest('**Create** an invoice for <b>Acme</b> right now')!;
    assert.doesNotMatch(subject, /[*<>]/);
    assert.equal(subject, 'Create an invoice for Acme right now');
  });

  it('returns nothing when the message is only a mention', () => {
    assert.equal(summarizeRequest('@_user_1 '), undefined);
    assert.equal(summarizeRequest(''), undefined);
  });

  it('cuts long requests on a word boundary', () => {
    const subject = summarizeRequest(
      'Check Zoho Books for our overdue invoices and then reconcile them against Airtable',
    )!;
    assert.ok(subject.length <= 53, `too long: ${subject.length}`);
    assert.ok(subject.endsWith('…'));
    assert.doesNotMatch(subject, /\s…$/, 'no dangling space before the ellipsis');
  });
});
