import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GmailHistoryClient } from '../../src/infrastructure/google/gmail-history.client.ts';
import { mailRuleMatches } from '../../src/application/mail-ops/mail-rule.matcher.ts';

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

  it('hands back where it stopped, and holds the cursor while it has', async () => {
    // The stub's `historyId` is 5000 — the newest record in the mailbox. Using
    // it as the next cursor would skip every page beyond the tenth. Guessing
    // forward to the last record read was the old answer, and it made progress
    // only when a pass consumed something: ten pages Divo does not care about
    // advanced nothing, so the next pass read the same ten and failed the same
    // way, forever. Progress rides on the token instead, which is only valid
    // against the cursor it was issued under — so the cursor stays put.
    const { client } = gmailWith([endlessPage('120')]);

    const sync = await client.sync({ accessToken: 'token', historyId: '100' });

    assert.equal(sync.truncated, true);
    assert.equal(sync.nextPageToken, 'more');
    assert.equal(sync.nextHistoryId, '100');
  });

  it('resumes a walk from the token it was given', async () => {
    const { client, urls } = gmailWith([endlessPage('120')]);

    await client.sync({
      accessToken: 'token',
      historyId: '100',
      pageToken: 'page-11',
    });

    const first = urls.find(url => url.includes('/history?'))!;
    assert.match(first, /pageToken=page-11/);
    // Against the same cursor, which is the only one that token means anything
    // under.
    assert.match(first, /startHistoryId=100/);
  });

  it('leaves the cursor alone when a truncated pass consumed no record', async () => {
    // Repeating a pass is recoverable; guessing forward loses mail. This is the
    // case that used to stall permanently — it now carries a resume point.
    const { client } = gmailWith([{ historyId: '5000', nextPageToken: 'more' }]);

    const sync = await client.sync({ accessToken: 'token', historyId: '100' });

    assert.equal(sync.truncated, true);
    assert.equal(sync.nextHistoryId, '100');
    assert.equal(sync.nextPageToken, 'more');
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

/**
 * Stub whose `messages.get` can fail per message and which records how many
 * fetches are in flight at once.
 */
function gmailWithMessages(input: {
  readonly ids: readonly string[];
  readonly respond: (id: string) => { status: number; body: Json };
}) {
  let inFlight = 0;
  let peakInFlight = 0;
  const fetched: string[] = [];
  const fetchStub = (async (url: string) => {
    if (url.includes('/history?')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          historyId: '200',
          history: [{
            id: '150',
            messagesAdded: input.ids.map(id => ({ message: { id } })),
          }],
        }),
      };
    }
    if (url.includes('/messages/')) {
      const id = decodeURIComponent(url.split('/messages/')[1]!.split('?')[0]!);
      fetched.push(id);
      inFlight++;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, 1));
      inFlight--;
      const { status, body } = input.respond(id);
      return { ok: status < 400, status, json: async () => body };
    }
    return { ok: true, status: 200, json: async () => ({ historyId: '999' }) };
  }) as unknown as typeof fetch;
  return {
    client: new GmailHistoryClient(fetchStub),
    fetched,
    peak: () => peakInFlight,
  };
}

const okMessage = (id: string) => ({
  status: 200,
  body: {
    id,
    threadId: `t-${id}`,
    historyId: '1',
    internalDate: '0',
    payload: { headers: [], mimeType: 'text/plain' },
  } as Json,
});

describe('GmailHistoryClient message loading', () => {
  it('does not fire one request per message at Gmail all at once', async () => {
    // A single history pass can name a thousand messages. Firing a thousand
    // concurrent fetches exhausts the per-user quota, throttles the batch, and
    // fails the sync — leaving the cursor where it was, so the next pass does
    // exactly the same thing.
    const ids = Array.from({ length: 40 }, (_, i) => `m${i}`);
    const gmail = gmailWithMessages({ ids, respond: okMessage });

    const sync = await gmail.client.sync({ accessToken: 'token', historyId: '100' });

    assert.equal(sync.events.length, 40);
    assert.ok(gmail.peak() <= 6, `peak concurrency was ${gmail.peak()}`);
  });

  it('skips a message that has vanished instead of wedging the cursor', async () => {
    // Deleted between the history record and the fetch. Nobody can ever deliver
    // it, and failing on it would make every later arrival queue behind a dead
    // message forever.
    const gmail = gmailWithMessages({
      ids: ['m1', 'gone', 'm3'],
      respond: id => id === 'gone'
        ? { status: 404, body: { error: { message: 'Not Found' } } }
        : okMessage(id),
    });

    const sync = await gmail.client.sync({ accessToken: 'token', historyId: '100' });

    assert.deepEqual(sync.events.map(e => e.providerMessageId), ['m1', 'm3']);
    assert.equal(sync.nextHistoryId, '200');
  });

  it('still fails the whole pass on a transient message error', async () => {
    // Skipping these would advance the cursor past mail nobody has read.
    const gmail = gmailWithMessages({
      ids: ['m1', 'flaky'],
      respond: id => id === 'flaky'
        ? { status: 500, body: { error: { message: 'Backend Error' } } }
        : okMessage(id),
    });

    await assert.rejects(
      gmail.client.sync({ accessToken: 'token', historyId: '100' }),
      /Backend Error/,
    );
  });
});

describe('GmailHistoryClient forward stamping', () => {
  it('stamps its own forwards and reads the stamp back off arriving mail', async () => {
    let sentRaw = '';
    const fetchStub = (async (url: string, init: any) => {
      if (url.includes('format=raw')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            raw: Buffer.from('Subject: Original\r\n\r\nbody').toString('base64url'),
          }),
        };
      }
      if (url.endsWith('/drafts')) {
        sentRaw = Buffer.from(JSON.parse(init.body).message.raw, 'base64url').toString('utf8');
        return { ok: true, status: 200, json: async () => ({ id: 'draft-1' }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }) as unknown as typeof fetch;

    const draftId = await new GmailHistoryClient(fetchStub).createForwardDraft({
      accessToken: 'token',
      destination: 'finance@example.com',
      mailboxEmail: 'owner@example.com',
      sourceMessageId: 'm1',
      source: {
        from: 'a@b.test',
        to: 'owner@example.com',
        subject: 'Original',
        snippet: '',
        bodyText: '',
        hasAttachment: false,
      },
      idempotencyKey: 'mail:idempotency',
      ruleId: 'rule-1',
    });

    assert.equal(draftId, 'draft-1');
    assert.match(sentRaw, /X-Divo-Mailops: rule-1/);
  });

  it('carries the stamp into event metadata so the loop can be broken', async () => {
    const fetchStub = (async (url: string) => {
      if (url.includes('/history?')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            historyId: '200',
            history: [{ id: '150', messagesAdded: [{ message: { id: 'm1' } }] }],
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'm1',
          threadId: 't1',
          historyId: '1',
          internalDate: '0',
          payload: {
            mimeType: 'text/plain',
            headers: [
              { name: 'From', value: 'owner@example.com' },
              { name: 'Subject', value: 'Fwd: Original' },
              { name: 'X-Divo-Mailops', value: 'rule-1' },
            ],
          },
        }),
      };
    }) as unknown as typeof fetch;

    const sync = await new GmailHistoryClient(fetchStub)
      .sync({ accessToken: 'token', historyId: '100' });

    assert.equal(sync.events[0]?.metadata.forwardedByRuleId, 'rule-1');
  });
});

describe('GmailHistoryClient message metadata', () => {
  const syncOneMessage = async (payload: unknown) => {
    const fetchStub = (async (url: string) => {
      if (url.includes('/history?')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            historyId: '200',
            history: [{ id: '150', messagesAdded: [{ message: { id: 'm1' } }] }],
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'm1', threadId: 't1', historyId: '1', internalDate: '0', payload,
        }),
      };
    }) as unknown as typeof fetch;
    const sync = await new GmailHistoryClient(fetchStub)
      .sync({ accessToken: 'token', historyId: '100' });
    return sync.events[0]!.metadata;
  };

  const filePart = (headers: Array<{ name: string; value: string }>) => ({
    mimeType: 'multipart/mixed',
    headers: [{ name: 'From', value: 'sender@example.com' }],
    parts: [
      { mimeType: 'text/plain', body: { data: '' } },
      { mimeType: 'image/png', filename: 'logo.png', headers },
    ],
  });

  it('does not call a signature logo an attachment', async () => {
    // An inline part is one the message draws itself with. Counting it made
    // `hasAttachment` true for most ordinary corporate mail.
    assert.equal(
      (await syncOneMessage(filePart([
        { name: 'Content-Disposition', value: 'inline; filename="logo.png"' },
      ]))).hasAttachment,
      false,
    );
    assert.equal(
      (await syncOneMessage(filePart([
        { name: 'Content-ID', value: '<logo@example>' },
      ]))).hasAttachment,
      false,
    );
    assert.equal(
      (await syncOneMessage(filePart([
        { name: 'Content-Disposition', value: 'attachment; filename="logo.png"' },
      ]))).hasAttachment,
      true,
    );
    // Gmail omits the disposition on plenty of genuine attachments, so a
    // filename with nothing contradicting it still counts.
    assert.equal((await syncOneMessage(filePart([]))).hasAttachment, true);
    // And some clients stamp a Content-ID on every part they emit. Saying
    // `attachment` outright settles it.
    assert.equal(
      (await syncOneMessage(filePart([
        { name: 'Content-Disposition', value: 'attachment; filename="report.pdf"' },
        { name: 'Content-ID', value: '<part1@example>' },
      ]))).hasAttachment,
      true,
    );
  });

  it('carries every header that says where the message was sent', async () => {
    const metadata = await syncOneMessage({
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: 'payroll@example.com' },
        { name: 'To', value: 'everyone@example.com' },
        { name: 'Cc', value: 'ana@example.com' },
        { name: 'Delivered-To', value: 'alias@example.com' },
      ],
    });

    assert.equal(metadata.cc, 'ana@example.com');
    assert.equal(metadata.deliveredTo, 'alias@example.com');
    assert.equal(metadata.bcc, undefined);
  });

  it('keeps every hop of a repeated trace header, not the last one', async () => {
    // An alias or group expansion adds one `Delivered-To` per hop, and the
    // address the member typed is on whichever hop the chain started at.
    // Keeping one made a rule on that alias fire or not depending on the
    // order Gmail happened to return the trace in — the silent never-fires
    // that reading `Delivered-To` at all exists to remove.
    const metadata = await syncOneMessage({
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: 'payroll@example.com' },
        { name: 'To', value: 'sales@example.com' },
        { name: 'Delivered-To', value: 'ana@example.com' },
        { name: 'Delivered-To', value: 'sales@example.com' },
      ],
    });

    assert.equal(metadata.deliveredTo, 'ana@example.com\nsales@example.com');
    assert.equal(
      mailRuleMatches({ to: 'ana@example.com' }, metadata),
      true,
    );
  });

  it('does not let one malformed hop swallow the hop that matters', async () => {
    // The instance the receiving server added is the one worth having, and it
    // arrives after whatever the sender wrote. Joined into a single string with
    // no boundary, an unterminated quote in the first would take the second
    // with it and the rule would silently never fire.
    const metadata = await syncOneMessage({
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: 'sender@evil.example' },
        { name: 'To', value: 'member@example.com' },
        { name: 'Delivered-To', value: '"poison' },
        { name: 'Delivered-To', value: 'alias@example.com' },
      ],
    });

    assert.equal(mailRuleMatches({ to: 'alias@example.com' }, metadata), true);

    // Ending the poisoned instance in a backslash is the one-character
    // variant: the escape would eat the separator and carry the open quote
    // across it.
    const escaped = await syncOneMessage({
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: 'sender@evil.example' },
        { name: 'To', value: 'member@example.com' },
        { name: 'Delivered-To', value: '"poison\\' },
        { name: 'Delivered-To', value: 'alias@example.com' },
      ],
    });

    assert.equal(mailRuleMatches({ to: 'alias@example.com' }, escaped), true);
  });

  it('keeps a folded value in one piece, boundary or no boundary', async () => {
    // The boundary above must be one only this client can create. A value
    // folded inside a quoted name would otherwise reset the parse mid-name and
    // discard an honest recipient, and the rule would silently stop firing.
    const metadata = await syncOneMessage({
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: 'sender@example.com' },
        { name: 'To', value: '"Smith,\r\n Ana" <ana@example.com>' },
      ],
    });

    assert.equal(mailRuleMatches({ to: 'ana@example.com' }, metadata), true);
  });

  it('folds the sender header in one piece too, since it is parsed the same way', async () => {
    const metadata = await syncOneMessage({
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: '"Doe,\r\n John" <j@example.com>' },
        { name: 'To', value: 'member@example.com' },
      ],
    });

    assert.equal(mailRuleMatches({ from: 'j@example.com' }, metadata), true);
  });
});

describe('GmailHistoryClient stale-cursor recovery', () => {
  function recoveringGmail(totalMessages: number) {
    const queries: string[] = [];
    let served = 0;
    const fetchStub = (async (url: string) => {
      if (url.includes('/history?')) {
        return { ok: false, status: 404, json: async () => ({ error: { message: 'Not Found' } }) };
      }
      if (url.includes('/profile')) {
        return { ok: true, status: 200, json: async () => ({ historyId: '900' }) };
      }
      if (url.includes('/messages?')) {
        queries.push(url);
        const size = Math.min(100, totalMessages - served);
        const page = Array.from({ length: Math.max(0, size) }, (_, i) => ({ id: `m${served + i}` }));
        served += page.length;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            messages: page,
            ...(served < totalMessages ? { nextPageToken: `p${served}` } : {}),
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'm', threadId: 't', historyId: '1', internalDate: '0',
          payload: { headers: [], mimeType: 'text/plain' },
        }),
      };
    }) as unknown as typeof fetch;
    return { client: new GmailHistoryClient(fetchStub), queries };
  }

  it('sweeps the week the cursor could have missed, not one day of it', async () => {
    // Gmail keeps roughly a week of history, so a cursor is only rejected after
    // a gap of about that long. Looking back a single day threw the rest away
    // with no record that it had happened.
    const gmail = recoveringGmail(250);

    const sync = await gmail.client.sync({ accessToken: 'token', historyId: 'stale' });

    assert.equal(sync.staleCursorRecovered, true);
    assert.equal(sync.recoveredMessageCount, 250);
    assert.equal(sync.recoveryTruncated, false);
    assert.ok(gmail.queries[0]?.includes(encodeURIComponent('newer_than:7d')));
    // Paginated rather than one oversized request.
    assert.equal(gmail.queries.length, 3);
  });

  it('stops asking when the window keeps handing back empty pages', async () => {
    // A filtered messages.list can return nothing while still issuing a
    // next-page token — the same provider behaviour the history pass has to
    // survive. Counting only messages meant those pages advanced nothing and
    // the loop kept asking, holding the mailbox claim indefinitely.
    let calls = 0;
    const fetchStub = (async (url: string) => {
      if (url.includes('/history?')) {
        return { ok: false, status: 404, json: async () => ({ error: { message: 'Not Found' } }) };
      }
      if (url.includes('/profile')) {
        return { ok: true, status: 200, json: async () => ({ historyId: '900' }) };
      }
      calls++;
      return {
        ok: true,
        status: 200,
        json: async () => ({ messages: [], nextPageToken: `p${calls}` }),
      };
    }) as unknown as typeof fetch;

    const sync = await new GmailHistoryClient(fetchStub)
      .sync({ accessToken: 'token', historyId: 'stale' });

    assert.equal(calls, 20);
    assert.equal(sync.recoveredMessageCount, 0);
    assert.equal(sync.recoveryTruncated, true);
  });

  it('says so when the window held more than one recovery will read', async () => {
    const gmail = recoveringGmail(900);

    const sync = await gmail.client.sync({ accessToken: 'token', historyId: 'stale' });

    assert.equal(sync.recoveredMessageCount, 500);
    assert.equal(sync.recoveryTruncated, true);
  });
});

describe('GmailHistoryClient draft send', () => {
  function draftGmail(draftStatus: number) {
    const calls: string[] = [];
    const fetchStub = (async (url: string) => {
      calls.push(url);
      if (url.includes('/drafts/send')) {
        return { ok: true, status: 200, json: async () => ({ id: 'sent-1' }) };
      }
      if (url.includes('/drafts/')) {
        return {
          ok: draftStatus < 400,
          status: draftStatus,
          json: async () => draftStatus < 400
            ? { id: 'draft-1' }
            : { error: { message: 'Not Found' } },
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }) as unknown as typeof fetch;
    return { client: new GmailHistoryClient(fetchStub), calls };
  }

  it('reports a live draft as proof no send completed', async () => {
    const gmail = draftGmail(200);
    assert.equal(
      await gmail.client.forwardDraftPending({ accessToken: 't', draftId: 'draft-1' }),
      true,
    );
  });

  it('reads a missing draft as proof the mail went out', async () => {
    // Gmail consumes a draft when it sends it, so 404 is the answer this whole
    // path exists to get — and unlike the search index it replaced, it is not
    // eventually consistent.
    const gmail = draftGmail(404);
    assert.equal(
      await gmail.client.forwardDraftPending({ accessToken: 't', draftId: 'draft-1' }),
      false,
    );
  });

  it('does not read any other draft error as a completed send', async () => {
    const gmail = draftGmail(500);
    await assert.rejects(
      gmail.client.forwardDraftPending({ accessToken: 't', draftId: 'draft-1' }),
    );
  });

  it('sends a staged draft by ID', async () => {
    const gmail = draftGmail(200);
    assert.equal(
      await gmail.client.sendForwardDraft({ accessToken: 't', draftId: 'draft-1' }),
      'sent-1',
    );
  });
});

describe('GmailHistoryClient error reasons', () => {
  const failWith = (status: number, body: unknown) => new GmailHistoryClient(
    (async () => ({
      ok: false,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    })) as unknown as typeof fetch,
  );

  const reasonOf = async (status: number, body: unknown): Promise<string | undefined> => {
    try {
      await failWith(status, body).watch({
        accessToken: 't',
        topicName: 'projects/divo/topics/gmail',
      });
    } catch (error) {
      return (error as { reason?: string }).reason;
    }
    throw new Error('The call should have failed.');
  };

  it('prefers the precise reason Google puts in details over the catch-all one', async () => {
    // A real scope loss can arrive with `errors[0].reason: "forbidden"` — the
    // one word we refuse to read as a scope problem, because a Pub/Sub topic
    // Divo owns raises it too. Read only that, and the member who actually did
    // revoke a grant is never told to reconnect.
    assert.equal(
      await reasonOf(403, {
        error: {
          code: 403,
          message: 'Request had insufficient authentication scopes.',
          errors: [{ message: 'Insufficient Permission', reason: 'forbidden' }],
          status: 'PERMISSION_DENIED',
          details: [{
            '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
            reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT',
          }],
        },
      }),
      'ACCESS_TOKEN_SCOPE_INSUFFICIENT',
    );
  });

  it('reads the legacy reason when there are no details', async () => {
    assert.equal(
      await reasonOf(403, {
        error: {
          code: 403,
          message: 'Error sending test message to Cloud PubSub.',
          errors: [{ message: 'Forbidden', reason: 'forbidden' }],
        },
      }),
      'forbidden',
    );
  });

  it('falls back to the status when Google names no reason at all', async () => {
    assert.equal(
      await reasonOf(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED' } }),
      'RESOURCE_EXHAUSTED',
    );
  });
});
