import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  WEB_THREAD_PAGE,
  askContent,
  webThreadPage,
  type WebThreadPageRow,
} from '../../src/domain/channel/web-thread';

/**
 * Rows exactly as the store hands them over: newest first, one more than a page.
 */
function rows(count: number, from = 1_000): WebThreadPageRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `m${from - i}`,
    sequence: from - i,
    role: i % 2 === 0 ? 'assistant' : 'user',
    contentText: `turn ${from - i}`,
    contentJson: null,
    createdAt: new Date(1_700_000_000_000 + (from - i) * 1_000),
  }));
}

describe('assembling one page of a conversation', () => {
  it('reads oldest first, however the store handed them over', () => {
    const { turns } = webThreadPage(rows(3));
    assert.deepEqual(turns.map(t => t.sequence), [998, 999, 1_000]);
  });

  it('shows the whole thread when the thread is shorter than a page', () => {
    const { turns, hasEarlier } = webThreadPage(rows(5));
    assert.equal(turns.length, 5);
    assert.equal(hasEarlier, false);
  });

  /*
   * The reason the store is asked for one row more than it shows.
   *
   * A thread of exactly `WEB_THREAD_PAGE` turns fills a page and has nothing
   * above it. Inferring "there is more" from a full page — the obvious way to
   * write this — offers that reader a control that fetches nothing, and it is
   * the one thread length where the bug appears.
   */
  it('knows a thread of exactly one page has nothing above it', () => {
    const { turns, hasEarlier } = webThreadPage(rows(WEB_THREAD_PAGE));
    assert.equal(turns.length, WEB_THREAD_PAGE);
    assert.equal(hasEarlier, false);
  });

  it('reports more above as soon as one extra row comes back', () => {
    const { turns, hasEarlier } = webThreadPage(rows(WEB_THREAD_PAGE + 1));
    assert.equal(hasEarlier, true);
    // The extra row is the evidence, never the content.
    assert.equal(turns.length, WEB_THREAD_PAGE);
  });

  /* The oldest turn shown is the cursor the next page is asked for, so it must
     be the oldest turn *shown* and not the extra row that proved there is more.
     Off by one here fetches a page that repeats a turn already on screen. */
  it('leaves the extra row out of the cursor the next page is asked for', () => {
    const { turns } = webThreadPage(rows(WEB_THREAD_PAGE + 1, 1_000));
    assert.equal(turns[0]!.sequence, 1_000 - WEB_THREAD_PAGE + 1);
  });

  it('has nothing to show for a thread nobody has spoken into', () => {
    assert.deepEqual(webThreadPage([]), { turns: [], hasEarlier: false });
  });

  /* A stored turn with no text is a run that failed before it said anything.
     It is still a turn that happened, and dropping it would renumber the
     conversation around it. */
  it('keeps a turn that has no text', () => {
    const [row] = rows(1);
    const { turns } = webThreadPage([{ ...row!, contentText: null }]);
    assert.deepEqual(turns.map(t => t.text), ['']);
  });

  /* Anything that is not a user turn is drawn as the agent's. The store is
     asked for only those two roles, so this is the guard for the day a third
     one arrives — it lands as an agent turn rather than as `undefined`, which
     the renderer would draw as neither. */
  it('never leaves a turn without a role', () => {
    const [row] = rows(1);
    const { turns } = webThreadPage([{ ...row!, role: 'tool' }]);
    assert.equal(turns[0]!.role, 'assistant');
  });
});

describe('an ask that carried files, read back', () => {
  const asked = (contentText: string, contentJson: unknown): WebThreadPageRow => ({
    id: 'm1', sequence: 1, role: 'user', contentText, contentJson,
    createdAt: new Date(1_700_000_000_000),
  });

  it('shows the person their own words, not the ones the model was given', () => {
    /* The seam this whole path exists for. The stored text is the model's
       memory — a transcript, then the question — and showing that back would
       quote somebody's message to them with two notices stapled to the front. */
    const { turns } = webThreadPage([asked(
      '[Audio: "memo.m4a" …]\n\nwhat did she say?',
      askContent({
        text: 'what did she say?',
        attachments: [{ name: 'memo.m4a', mime: 'audio/mp4', bytes: 40, outcome: 'audio' }],
      }),
    )]);

    assert.equal(turns[0]?.text, 'what did she say?');
    assert.equal(turns[0]?.attachments?.[0]?.name, 'memo.m4a');
  });

  it('leaves an ordinary message exactly as it was stored', () => {
    const { turns } = webThreadPage([asked('reconcile last month', null)]);
    assert.equal(turns[0]?.text, 'reconcile last month');
    assert.equal(turns[0]?.attachments, undefined);
  });
});
