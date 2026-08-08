import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  nextSemrushDpaRequestId,
  SemrushWebClient,
} from '../../src/infrastructure/semrush/semrush-web.client.ts';

describe('nextSemrushDpaRequestId', () => {
  it('matches the senior UUID-shaped DPA request_id format', () => {
    const id = nextSemrushDpaRequestId();
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    assert.notEqual(id, nextSemrushDpaRequestId());
  });
});

describe('SemrushWebClient credentials', () => {
  const okResponse = async (_url: unknown, init?: RequestInit) => {
    sentHeaders.push((init?.headers ?? {}) as Record<string, string>);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: [{ database: 'in', domain: 'a.com' }] }), { status: 200 });
  };
  let sentHeaders: Array<Record<string, string>> = [];
  const overview = { operation: 'domain_overview' as const, domain: 'a.com', database: 'in' as const };

  it('runs on the API key alone, with no cookie configured', async () => {
    sentHeaders = [];
    const client = new SemrushWebClient({ timeoutMs: 5_000, fetchImpl: okResponse });
    const data = await client.fetch({ apiKey: 'test-api-key', args: overview });
    assert.equal(data.status, 'complete');
    assert.equal(sentHeaders[0]!.Cookie, undefined, 'no Cookie header should be sent when none is configured');
  });

  it('still sends a cookie when one is configured, for the disabled analytics route', async () => {
    sentHeaders = [];
    const client = new SemrushWebClient({ cookie: 'PHPSESSID=abc', timeoutMs: 5_000, fetchImpl: okResponse });
    await client.fetch({ apiKey: 'test-api-key', args: overview });
    assert.equal(sentHeaders[0]!.Cookie, 'PHPSESSID=abc');
  });

  it('uses the key it is handed, so a rotated key reaches Semrush', async () => {
    const keysSent: string[] = [];
    const client = new SemrushWebClient({
      timeoutMs: 5_000,
      fetchImpl: async (_url, init) => {
        keysSent.push(String((JSON.parse(String(init?.body)).params as { apiKey: string }).apiKey));
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: [{ database: 'in' }] }), { status: 200 });
      },
    });
    await client.fetch({ apiKey: 'first-key', args: overview });
    await client.fetch({ apiKey: 'second-key', args: overview });
    assert.deepEqual(keysSent, ['first-key', 'second-key']);
  });

  it('refuses a call with no key, without mentioning a session', async () => {
    const client = new SemrushWebClient({ cookie: 'PHPSESSID=abc', timeoutMs: 5_000 });
    await assert.rejects(
      () => client.fetch({ apiKey: '  ', args: overview }),
      (error: unknown) => (error as { code?: string }).code === 'not_configured'
        && !/session|cookie/i.test((error as Error).message),
    );
  });
});

describe('SemrushWebClient domain overview', () => {
  // Shape and values taken from a live organic.overview call for emiactech.com,
  // which answered with 26 country databases in one request.
  const liveShape = [
    { database: 'us', domain: 'emiactech.com', rank: 10435549, organicPositions: 105, organicTraffic: 3 },
    { database: 'in', domain: 'emiactech.com', rank: 305836, organicPositions: 53, organicTraffic: 810 },
    { database: 'ca', domain: 'emiactech.com', rank: 4785795, organicPositions: 9, organicTraffic: 0 },
    { database: 'ru', domain: 'emiactech.com', rank: 2839423, organicPositions: 6, organicTraffic: 2 },
  ];
  const clientReturning = (result: unknown) => new SemrushWebClient({
    cookie: 'session=cookie', timeoutMs: 5_000,
    fetchImpl: async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 }),
  });

  it('keeps every country Semrush already returned', async () => {
    const data = await clientReturning(liveShape).fetch({
      apiKey: 'test-api-key',
      args: { operation: 'domain_overview', domain: 'emiactech.com', database: 'in' },
    });
    assert.equal(data.status, 'complete');
    assert.equal(data.rows.length, 4);
    assert.equal(data.coverage.databasesReturned, 4);
    assert.deepEqual(data.rows.map(row => row.Database), ['in', 'us', 'ru', 'ca']);
  });

  it('leads with the requested country so a one-country answer reads off row one', async () => {
    const data = await clientReturning(liveShape).fetch({
      apiKey: 'test-api-key',
      args: { operation: 'domain_overview', domain: 'emiactech.com', database: 'ca' },
    });
    assert.equal(data.rows[0]!.Database, 'ca');
    assert.equal(data.rows[0]!['Organic Keywords'], 9);
    // The remainder still ranks by the traffic that makes a row worth reading.
    assert.deepEqual(data.rows.slice(1).map(row => row.Database), ['in', 'us', 'ru']);
  });

  it('reports empty rather than inventing a row when Semrush holds nothing', async () => {
    const data = await clientReturning([]).fetch({
      apiKey: 'test-api-key',
      args: { operation: 'domain_overview', domain: 'example.com', database: 'in' },
    });
    assert.equal(data.status, 'empty');
    assert.deepEqual(data.rows, []);
  });
});

describe('SemrushWebClient failure classification', () => {
  const client = (fetchImpl: typeof fetch) => new SemrushWebClient({
    cookie: 'session=cookie', timeoutMs: 5_000, fetchImpl,
  });
  const overview = { operation: 'domain_overview' as const, domain: 'example.com', database: 'in' as const };

  async function codeFor(fetchImpl: typeof fetch, args: Parameters<SemrushWebClient['fetch']>[0] = overview) {
    try {
      await client(fetchImpl).fetch({ apiKey: 'test-api-key', args });
      return 'no_error';
    } catch (error) {
      return (error as { code?: string }).code ?? 'unknown';
    }
  }

  it('treats a spent allowance as exhaustion, not as throttling', async () => {
    // Observed live: dpa/rpc answers HTTP 200 with this body once the key's
    // allowance is gone, and keeps answering it for hours.
    const code = await codeFor(async () => new Response(JSON.stringify({
      jsonrpc: '2.0', id: 1, error: { code: -32098, message: 'Limits exceeded' },
    }), { status: 200 }));
    assert.equal(code, 'provider_quota_exhausted');
  });

  it('treats an explicit throttle as retryable', async () => {
    assert.equal(
      await codeFor(async () => new Response('{}', { status: 429 })),
      'rate_limited',
    );
    assert.equal(
      await codeFor(async () => new Response(JSON.stringify({
        jsonrpc: '2.0', id: 1, error: { message: 'Too many requests, slow down' },
      }), { status: 200 })),
      'rate_limited',
    );
  });

  it('treats a refused key as a credential failure', async () => {
    // Observed live: the backlinks route answers 403 for a key Semrush no
    // longer accepts, while a different key answers 200 in the same second.
    assert.equal(
      await codeFor(
        async () => new Response(JSON.stringify({ status: 'Forbidden' }), { status: 403 }),
        { operation: 'backlinks_comparison', targets: ['example.com'] } as never,
      ),
      'provider_auth_failed',
    );
  });

  it('never blames the browser session in a member-facing message', async () => {
    for (const [status, body] of [[403, '{}'], [429, '{}']] as const) {
      try {
        await client(async () => new Response(body, { status })).fetch({ apiKey: 'test-api-key', args: overview });
        assert.fail('expected a failure');
      } catch (error) {
        assert.doesNotMatch((error as Error).message, /session|cookie/i);
      }
    }
  });
});

describe('SemrushWebClient DPA RPC', () => {
  it('generates a fresh params.request_id on every call', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const client = new SemrushWebClient({
      cookie: 'session=cookie',
      timeoutMs: 5_000,
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: bodies.at(-1)?.id,
          result: [{
            database: 'in',
            domain: 'example.com',
            rank: 1,
            organicPositions: 10,
            organicTraffic: 100,
            organicTrafficCost: 50,
            adsPositions: 0,
            adsTraffic: 0,
            adsTrafficCost: 0,
            plaPositions: 0,
            plaCopies: 0,
          }],
        }), { status: 200 });
      },
    });

    const args = { operation: 'domain_overview' as const, domain: 'example.com', database: 'in' as const };
    await client.fetch({ apiKey: 'test-api-key', args });
    await client.fetch({ apiKey: 'test-api-key', args });

    assert.equal(bodies.length, 2);
    const first = (bodies[0]!.params as Record<string, unknown>).request_id;
    const second = (bodies[1]!.params as Record<string, unknown>).request_id;
    assert.match(String(first), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    assert.match(String(second), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    assert.notEqual(first, second);
  });
});
