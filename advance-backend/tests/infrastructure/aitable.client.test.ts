import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AitableClient,
  AitableError,
  AitablePartialWriteError,
  AITABLE_LIMITS,
} from '../../src/infrastructure/aitable/aitable.client.ts';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const client = (impl: typeof fetch) => new AitableClient('usk_test', 'https://aitable.example', { fetch: impl });

const failing = (status: number, body: unknown = { message: 'nope' }): typeof fetch =>
  (async () => json(body, status)) as unknown as typeof fetch;

describe('AitableClient', () => {
  it('sends the key as a bearer token to the configured host', async () => {
    let seenUrl = '';
    let seenAuth: string | null = null;
    const impl = (async (url: string | URL, init?: RequestInit) => {
      seenUrl = String(url);
      seenAuth = new Headers(init?.headers).get('authorization');
      return json({ success: true, data: { spaces: [{ id: 'spc1', name: 'Ops' }] } });
    }) as unknown as typeof fetch;

    const spaces = await client(impl).listSpaces();

    assert.equal(seenUrl, 'https://aitable.example/fusion/v1/spaces');
    assert.equal(seenAuth, 'Bearer usk_test');
    assert.deepEqual(spaces, [{ id: 'spc1', name: 'Ops' }]);
  });

  // A key that reaches no workspace is a working key whose owner has not been
  // added to one. Reporting it as a failure would send people rotating a
  // perfectly good key.
  it('treats an empty workspace list as a successful answer', async () => {
    const impl = (async () => json({ success: true, data: { spaces: [] } })) as unknown as typeof fetch;
    assert.deepEqual(await client(impl).listSpaces(), []);
  });

  it('tolerates a payload with no spaces key at all', async () => {
    const impl = (async () => json({ success: true, data: {} })) as unknown as typeof fetch;
    assert.deepEqual(await client(impl).listSpaces(), []);
  });

  // The distinction the whole connection lane rests on: 401 condemns the key,
  // 403 says the key is fine but was pointed somewhere it may not go. Marking a
  // working key dead because one datasheet was forbidden is a self-inflicted
  // outage.
  it('separates a dead key from a forbidden resource', async () => {
    await assert.rejects(
      client(failing(401)).listSpaces(),
      (e: AitableError) => e.code === 'invalid_key' && e.status === 401,
    );
    await assert.rejects(
      client(failing(403)).listSpaces(),
      (e: AitableError) => e.code === 'forbidden' && e.status === 403,
    );
  });

  it('classifies rate limiting and server faults apart from a bad request', async () => {
    await assert.rejects(client(failing(429)).listSpaces(), (e: AitableError) => e.code === 'rate_limited');
    await assert.rejects(client(failing(500)).listSpaces(), (e: AitableError) => e.code === 'unreachable');
    await assert.rejects(client(failing(503)).listSpaces(), (e: AitableError) => e.code === 'unreachable');
    await assert.rejects(client(failing(422)).listSpaces(), (e: AitableError) => e.code === 'bad_request');
  });

  it('reports a transport failure as unreachable, never as a bad key', async () => {
    const impl = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    await assert.rejects(
      client(impl).listSpaces(),
      (e: AitableError) => e.code === 'unreachable' && e.status === undefined,
    );
  });

  // Fusion answers 200 with success:false for some application errors, so the
  // HTTP status on its own is not proof the call did what it was asked.
  it('rejects a 200 that carries success:false', async () => {
    const impl = (async () => json({ success: false, message: 'Datasheet not found' })) as unknown as typeof fetch;
    await assert.rejects(
      client(impl).listSpaces(),
      (e: AitableError) => e.code === 'bad_request' && e.message === 'Datasheet not found',
    );
  });

  it('surfaces the upstream message but never a raw HTML error page', async () => {
    const htmlImpl = (async () => new Response('<html>502 Bad Gateway</html>', { status: 502 })) as unknown as typeof fetch;
    await assert.rejects(
      client(htmlImpl).listSpaces(),
      (e: AitableError) => e.code === 'unreachable' && !e.message.includes('<html>'),
    );
    await assert.rejects(
      client(failing(400, { message: 'Bad node id' })).listSpaces(),
      (e: AitableError) => e.message === 'Bad node id',
    );
  });

  // These are not in AITable's documentation — they come from the official
  // SDK's constants. The write batch cap in particular is the one that would
  // otherwise be discovered in production.
  it('pins the Fusion limits the client and later waves depend on', () => {
    assert.equal(AITABLE_LIMITS.qps, 5);
    assert.equal(AITABLE_LIMITS.maxPageSize, 1000);
    assert.equal(AITABLE_LIMITS.maxWriteBatch, 10);
  });
});

/** A client whose throttle never actually waits, and that records every call. */
function recording(respond: (n: number) => Response) {
  const requests: { url: string; method: string; body: unknown }[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    requests.push({
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return respond(requests.length);
  }) as unknown as typeof fetch;
  const client = new AitableClient('usk_test', 'https://aitable.example', { fetch: impl, sleep: async () => {} });
  return { client, requests };
}

describe('AitableClient reads', () => {
  // The exact bug AITable's own MCP server shipped: it declared this parameter
  // in its input schema and then dropped it before the request, so the model
  // received unfiltered rows it believed were filtered.
  it('actually sends filterByFormula', async () => {
    const { client, requests } = recording(() => json({ success: true, data: { records: [] } }));

    await client.listRecords('dst1', { filterByFormula: '{Stage}="Open"' });

    const query = new URL(requests[0]!.url).searchParams;
    assert.equal(query.get('filterByFormula'), '{Stage}="Open"');
  });

  it('sends view, fields, sort and paging as Fusion expects them', async () => {
    const { client, requests } = recording(() => json({ success: true, data: { records: [] } }));

    await client.listRecords('dst1', {
      viewId: 'viw1',
      fields: ['Title', 'Score'],
      sort: [{ field: 'Score', order: 'desc' }],
      pageNum: 2,
      pageSize: 50,
    });

    const query = new URL(requests[0]!.url).searchParams;
    assert.equal(query.get('viewId'), 'viw1');
    assert.equal(query.get('fields'), 'Title,Score');
    assert.equal(query.get('sort'), '[{"field":"Score","order":"desc"}]');
    assert.equal(query.get('pageNum'), '2');
    assert.equal(query.get('pageSize'), '50');
    // fieldKey=name is what lets the model work in field names it can read,
    // rather than opaque field ids.
    assert.equal(query.get('fieldKey'), 'name');
  });

  it('clamps an over-large page size to the Fusion maximum', async () => {
    const { client, requests } = recording(() => json({ success: true, data: { records: [] } }));

    await client.listRecords('dst1', { pageSize: 99_999 });

    assert.equal(new URL(requests[0]!.url).searchParams.get('pageSize'), String(AITABLE_LIMITS.maxPageSize));
  });

  it('omits absent parameters rather than sending blanks', async () => {
    const { client, requests } = recording(() => json({ success: true, data: { records: [] } }));

    await client.listRecords('dst1');

    const query = new URL(requests[0]!.url).searchParams;
    assert.equal(query.has('viewId'), false);
    assert.equal(query.has('filterByFormula'), false);
  });

  it('uses the v2 route for node search, which is the only one that filters', async () => {
    const { client, requests } = recording(() => json({ success: true, data: { nodes: [] } }));

    await client.searchNodes('spc1', { type: 'Datasheet', query: 'budget' });

    assert.match(requests[0]!.url, /\/fusion\/v2\/spaces\/spc1\/nodes/);
    assert.equal(new URL(requests[0]!.url).searchParams.get('type'), 'Datasheet');
  });
});

describe('AitableClient writes', () => {
  // Not in AITable's documentation — only in the official SDK's constants.
  // Discovering it in production would mean silent truncation at 10.
  it('splits a write at the 10-record batch ceiling', async () => {
    const { client, requests } = recording(() => json({ success: true, data: { records: [] } }));
    const records = Array.from({ length: 25 }, (_, i) => ({ fields: { Title: `row ${i}` } }));

    await client.createRecords('dst1', records);

    assert.equal(requests.length, 3, '25 records must become 3 requests');
    assert.equal((requests[0]!.body as any).records.length, 10);
    assert.equal((requests[1]!.body as any).records.length, 10);
    assert.equal((requests[2]!.body as any).records.length, 5);
  });

  it('sends exactly one request at the boundary and two just past it', async () => {
    const ten = recording(() => json({ success: true, data: { records: [] } }));
    await ten.client.createRecords('dst1', Array.from({ length: 10 }, () => ({ fields: {} })));
    assert.equal(ten.requests.length, 1);

    const eleven = recording(() => json({ success: true, data: { records: [] } }));
    await eleven.client.createRecords('dst1', Array.from({ length: 11 }, () => ({ fields: {} })));
    assert.equal(eleven.requests.length, 2);
  });

  it('makes no request at all for an empty write', async () => {
    const { client, requests } = recording(() => json({ success: true, data: { records: [] } }));

    await client.createRecords('dst1', []);
    await client.deleteRecords('dst1', []);

    assert.equal(requests.length, 0);
  });

  it('refuses to update a record with no recordId', async () => {
    const { client, requests } = recording(() => json({ success: true, data: { records: [] } }));

    await assert.rejects(
      client.updateRecords('dst1', [{ fields: { Title: 'x' } }]),
      (e: AitableError) => e.code === 'bad_request',
    );
    assert.equal(requests.length, 0, 'nothing may be sent when the input is invalid');
  });

  // Reporting a plain failure would tell the caller nothing was written when
  // some of it was — and retrying on that basis duplicates rows.
  it('reports what already landed when a later batch fails', async () => {
    const { client } = recording(n => (n === 1
      ? json({ success: true, data: { records: [{ recordId: 'rec1', fields: {} }] } })
      : json({ message: 'boom' }, 500)));

    await assert.rejects(
      client.createRecords('dst1', Array.from({ length: 15 }, () => ({ fields: {} }))),
      (e: unknown) => e instanceof AitablePartialWriteError
        && e.written.length === 1
        && e.message.includes('1 record'),
    );
  });

  // Deletion is permanent. Telling a caller "it failed" while ten rows are
  // already gone is worse than telling them nothing.
  it('reports which records were already deleted when a later batch fails', async () => {
    const { client } = recording(n => (n === 1 ? json({ success: true, data: {} }) : json({ message: 'boom' }, 500)));
    const ids = Array.from({ length: 15 }, (_, i) => `rec${i}`);

    await assert.rejects(
      client.deleteRecords('dst1', ids),
      (e: unknown) => e instanceof AitablePartialWriteError
        && e.deleted.length === 10
        && e.deleted[0] === 'rec0'
        && /deleted 10 records/.test(e.message),
    );
  });

  // A batch can succeed without echoing its rows back. Keying "did anything
  // land?" on the returned rows reported that as a clean failure, and a retry
  // on that basis duplicates every row in the applied batch.
  it('reports a partial write even when the successful batch returned no rows', async () => {
    const { client } = recording(n => (n === 1
      ? json({ success: true, data: {} })
      : json({ message: 'boom' }, 500)));

    await assert.rejects(
      client.createRecords('dst1', Array.from({ length: 15 }, () => ({ fields: {} }))),
      (e: unknown) => e instanceof AitablePartialWriteError && /already applied part of this change/.test(e.message),
    );
  });

  it('reports an outright failure plainly when nothing landed', async () => {
    const { client } = recording(() => json({ message: 'boom' }, 500));

    await assert.rejects(
      client.createRecords('dst1', [{ fields: {} }]),
      (e: unknown) => e instanceof AitableError && !(e instanceof AitablePartialWriteError),
    );
  });

  it('spaces requests so the 5 QPS ceiling is not breached', async () => {
    // A fake clock the fake sleep advances, so the assertion is about the
    // throttle rather than about how long the test machine happened to take.
    let clock = 1_000_000;
    const startedAt: number[] = [];
    const impl = (async () => {
      startedAt.push(clock);
      return json({ success: true, data: { records: [] } });
    }) as unknown as typeof fetch;
    const client = new AitableClient('usk', 'https://aitable.example', {
      fetch: impl,
      now: () => clock,
      sleep: async ms => { clock += ms; },
    });
    const gap = 1000 / AITABLE_LIMITS.qps;

    // 30 records → 3 batches, which must not be fired together.
    await client.createRecords('dst1', Array.from({ length: 30 }, () => ({ fields: {} })));

    assert.equal(startedAt.length, 3);
    for (let i = 1; i < startedAt.length; i++) {
      assert.equal(startedAt[i]! - startedAt[i - 1]!, gap, `request ${i + 1} was not one slot after ${i}`);
    }
  });

  it('does not delay a call that arrives after the previous slot has passed', async () => {
    let clock = 1_000_000;
    let slept = 0;
    const impl = (async () => json({ success: true, data: { spaces: [] } })) as unknown as typeof fetch;
    const client = new AitableClient('usk', 'https://aitable.example', {
      fetch: impl,
      now: () => clock,
      sleep: async ms => { slept += ms; clock += ms; },
    });

    await client.listSpaces();
    clock += 5_000; // an idle gap between turns
    await client.listSpaces();

    assert.equal(slept, 0, 'an idle client must not pay a throttle debt');
  });
});
