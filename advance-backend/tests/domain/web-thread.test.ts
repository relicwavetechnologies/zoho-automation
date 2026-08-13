import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  WEB_RUN_CONTENT_KIND,
  webThreadRun,
  webThreadTitle,
} from '../../src/domain/channel/web-thread';

describe('web thread run record', () => {
  it('reads back a record it wrote', () => {
    const record = webThreadRun({
      kind: WEB_RUN_CONTENT_KIND,
      ledger: [{ label: 'Gmail', count: 2, status: 'done' }],
      elapsedMs: 4200,
    });
    assert.equal(record?.elapsedMs, 4200);
    assert.equal(record?.ledger[0]?.label, 'Gmail');
    assert.equal(record?.failure, undefined);
  });

  it('carries a failure so a reader learns why nothing came back', () => {
    const record = webThreadRun({
      kind: WEB_RUN_CONTENT_KIND,
      ledger: [],
      elapsedMs: 900,
      failure: { code: 'controller_unreachable', message: 'Divo could not start.' },
    });
    assert.deepEqual(record?.failure, {
      code: 'controller_unreachable',
      message: 'Divo could not start.',
    });
  });

  /* Anything unrecognised is dropped rather than guessed at. An answer with no
     work log is true; an invented one is a claim about work that never
     happened. */
  it('refuses to invent a run out of anything else', () => {
    assert.equal(webThreadRun(null), undefined);
    assert.equal(webThreadRun('web_run'), undefined);
    assert.equal(webThreadRun({ ledger: [] }), undefined);
    assert.equal(webThreadRun({ kind: 'something_else', ledger: [] }), undefined);
  });

  it('survives a record whose fields went missing', () => {
    const record = webThreadRun({ kind: WEB_RUN_CONTENT_KIND });
    assert.deepEqual(record, { ledger: [], elapsedMs: 0 });
  });
});

describe('web thread title', () => {
  it('is the opening ask when the ask is short', () => {
    assert.equal(webThreadTitle('  Reconcile   last month  '), 'Reconcile last month');
  });

  it('cuts on a word boundary rather than mid-word', () => {
    const ask = 'Reconcile every unpaid invoice against the bank statement and tell me what is missing';
    const title = webThreadTitle(ask);
    assert.ok(title.length <= 61, title);
    assert.ok(title.endsWith('…'));
    // The kept part must be whole words of the original — so the next
    // character in the ask is the space the cut was made at.
    const kept = title.slice(0, -1);
    assert.ok(ask.startsWith(kept), `not a prefix: ${kept}`);
    assert.equal(ask[kept.length], ' ');
  });

  /* A long unbroken string has no boundary to cut on, and refusing to cut it
     would let one paste push every list row off the screen. */
  it('still cuts a string with no spaces in it', () => {
    const title = webThreadTitle('x'.repeat(200));
    assert.equal(title.length, 61);
  });

  it('names an empty ask rather than showing nothing', () => {
    assert.equal(webThreadTitle('   '), 'New chat');
  });
});
