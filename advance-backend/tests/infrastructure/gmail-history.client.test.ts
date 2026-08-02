import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GmailHistoryClient } from '../../src/infrastructure/google/gmail-history.client.ts';

/**
 * The page cap used to throw, which wedged busy mailboxes permanently: the
 * cursor never moved, so the same oversized range failed on every retry. These
 * cover the replacement, and specifically the part that is easy to get wrong —
 * a truncated pass must report the position it actually reached, not the
 * mailbox's newest history ID, or the untouched pages are skipped for good.
 */

type Json = Record<string, unknown>;

/** Minimal Gmail stub: N history pages, then whatever `messages.get` needs. */
function gmailWith(pages: Json[]) {
  const urls: string[] = [];
  let page = 0;
  const fetchStub = (async (url: string) => {
    urls.push(url);
    if (url.includes('/history?')) {
      const body = pages[Math.min(page, pages.length - 1)]!;
      page++;
      return { ok: true, status: 200, json: async () => body };
    }
    if (url.includes('/messages/')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'm1',
          threadId: 't1',
          historyId: '1',
          internalDate: '0',
          payload: { headers: [], mimeType: 'text/plain' },
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ historyId: '999' }) };
  }) as unknown as typeof fetch;
  return { client: new GmailHistoryClient(fetchStub), urls };
}

/** A page that always offers another, so the cap is the only thing that stops it. */
const endlessPage = (recordId: string): Json => ({
  historyId: '5000',
  nextPageToken: 'more',
  history: [{ id: recordId, messagesAdded: [{ message: { id: 'm1' } }] }],
});

describe('GmailHistoryClient history draining', () => {
  it('stops at the page cap instead of throwing', async () => {
    const { client } = gmailWith([endlessPage('120')]);

    const sync = await client.sync({ accessToken: 'token', historyId: '100' });

    assert.equal(sync.truncated, true);
    assert.equal(sync.events.length, 1);
  });

  it('reports the last record it read, not the mailbox head', async () => {
    // The stub's `historyId` is 5000 — the newest record in the mailbox. Using
    // it as the next cursor would skip every page beyond the tenth.
    const { client } = gmailWith([endlessPage('120')]);

    const sync = await client.sync({ accessToken: 'token', historyId: '100' });

    assert.equal(sync.nextHistoryId, '120');
  });

  it('leaves the cursor alone when a truncated pass consumed no record', async () => {
    // Repeating a pass is recoverable; guessing forward loses mail.
    const { client } = gmailWith([{ historyId: '5000', nextPageToken: 'more' }]);

    const sync = await client.sync({ accessToken: 'token', historyId: '100' });

    assert.equal(sync.truncated, true);
    assert.equal(sync.nextHistoryId, '100');
  });

  it('uses the mailbox head once the backlog is fully drained', async () => {
    const { client } = gmailWith([{
      historyId: '5000',
      history: [{ id: '120', messagesAdded: [{ message: { id: 'm1' } }] }],
    }]);

    const sync = await client.sync({ accessToken: 'token', historyId: '100' });

    assert.equal(sync.truncated, false);
    assert.equal(sync.nextHistoryId, '5000');
  });

  it('reads no more than the bounded number of pages', async () => {
    const { client, urls } = gmailWith([endlessPage('120')]);

    await client.sync({ accessToken: 'token', historyId: '100' });

    assert.equal(urls.filter(url => url.includes('/history?')).length, 10);
  });
});
