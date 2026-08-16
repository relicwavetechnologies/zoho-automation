import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  WEB_ASK_CONTENT_KIND,
  WEB_RUN_CONTENT_KIND,
  askContent,
  askFor,
  webAsk,
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

describe('the files an ask carried', () => {
  it('reads back what it wrote', () => {
    const read = webAsk(askContent({
      text: 'what is the total?',
      attachments: [
        { name: 'q3.pdf', mime: 'application/pdf', bytes: 8_100, outcome: 'file' },
        { name: 'memo.m4a', mime: 'audio/mp4', bytes: 40, outcome: 'audio' },
      ],
    }));
    assert.equal(read?.text, 'what is the total?');
    assert.equal(read?.attachments.length, 2);
    assert.equal(read?.attachments[1]?.outcome, 'audio');
  });

  /* Both live on `contentJson`, so each has to leave the other alone: a run
     record read as an ask would put chips under an answer, and an ask read as a
     run would staple an empty work log to a question. */
  it('is not confused with a run record on the same field', () => {
    const run = { kind: WEB_RUN_CONTENT_KIND, ledger: [], elapsedMs: 12 };
    assert.equal(webAsk(run), undefined);
    assert.equal(webThreadRun(askContent({ attachments: [] })), undefined);
  });

  it('drops an entry it cannot name rather than showing an unnamed chip', () => {
    const read = webAsk({
      kind: WEB_ASK_CONTENT_KIND,
      attachments: [{ mime: 'application/pdf', bytes: 4 }, null, 'q3.pdf'],
    });
    assert.deepEqual(read?.attachments, []);
  });

  it('finds nothing in anything else', () => {
    assert.equal(webAsk(null), undefined);
    assert.equal(webAsk({ attachments: [{ name: 'q3.pdf' }] }), undefined);
  });
});

describe('what an ask is worth keeping beside its turn', () => {
  /* The common case, and the reason this is a decision rather than a write:
     somebody typed a sentence and sent it. The stored text already is the
     message, and a JSON copy of it on every turn of every conversation would
     restate what the column next to it says. */
  it('is nothing, when the message is already what was sent', () => {
    assert.equal(askFor({ text: 'hello', attachments: [] }, 'hello'), undefined);
    assert.equal(askFor(undefined, 'hello'), undefined);
  });

  /* The transcript of a recording is folded in ahead of the question before the
     model sees it. That belongs in memory and not in the reader's own bubble,
     which is the whole reason the two are stored separately. */
  it('keeps the person\'s words when the model was given something else', () => {
    const kept = askFor(
      { text: 'what did she say?', attachments: [] },
      '[Audio: "memo.m4a" …]\n\nwhat did she say?',
    );
    assert.equal(kept?.text, 'what did she say?');
  });

  it('keeps the files even when the words were passed through untouched', () => {
    const kept = askFor({
      text: 'read it',
      attachments: [{ name: 'q3.pdf', mime: 'application/pdf', bytes: 8_100, outcome: 'file' }],
    }, 'read it');
    assert.equal(kept?.text, undefined);
    assert.equal(kept?.attachments.length, 1);
  });
});
