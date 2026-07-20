import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SemrushClient } from '../../src/infrastructure/semrush/semrush.client.ts';
import { SemrushServiceError } from '../../src/application/semrush/semrush.types.ts';

describe('SemrushClient', () => {
  it('uses the fixed official v3 endpoint and never sends browser-session headers', async () => {
    const calls: Array<{ url: URL; init?: RequestInit }> = [];
    const client = new SemrushClient({
      timeoutMs: 1_000,
      fetchImpl: async (url, init) => {
        calls.push({ url: new URL(String(url)), init });
        return new Response('Db;Dn;Or\nin;example.com;10\n', { status: 200 });
      },
    });

    const result = await client.fetch({
      apiKey: 'never-log-this',
      args: { operation: 'domain_overview', domain: 'example.com', database: 'in' },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url.toString().split('?')[0], 'https://api.semrush.com/');
    assert.equal(calls[0]?.url.searchParams.get('type'), 'domain_ranks');
    assert.equal(calls[0]?.url.searchParams.get('domain'), 'example.com');
    assert.equal(calls[0]?.url.searchParams.get('database'), 'in');
    assert.equal(calls[0]?.url.searchParams.get('key'), 'never-log-this');
    assert.equal((calls[0]?.init?.headers as Record<string, string>)['Cookie'], undefined);
    assert.equal((calls[0]?.init?.headers as Record<string, string>)['Authorization'], undefined);
    assert.equal(JSON.stringify(result).includes('never-log-this'), false);
    assert.equal(result.status, 'complete');
    assert.deepEqual(result.rows, [{ Db: 'in', Dn: 'example.com', Or: '10' }]);
  });

  it('parses a bounded official v3 organic response and exposes a continuation', async () => {
    const client = new SemrushClient({
      timeoutMs: 1_000,
      fetchImpl: async () => new Response('Ph;Po;Nq\nupi gateway;3;1000\npayment api;5;900\n', { status: 200 }),
    });
    const result = await client.fetch({
      apiKey: 'secret-key',
      args: { operation: 'organic_positions', domain: 'decentro.tech', database: 'in', limit: 1, offset: 0 },
    });
    assert.equal(result.rows.length, 1);
    assert.deepEqual(result.rows[0], { Ph: 'upi gateway', Po: '3', Nq: '1000' });
    assert.equal(JSON.stringify(result).includes('secret-key'), false);
    assert.equal(result.status, 'partial');
    assert.equal(result.nextPage, '1');
  });

  it('returns empty for a valid v3 table without result rows', async () => {
    const client = new SemrushClient({
      timeoutMs: 1_000,
      fetchImpl: async () => new Response('Db;Dn;Or\n', { status: 200 }),
    });
    const result = await client.fetch({
      apiKey: 'key',
      args: { operation: 'domain_overview', domain: 'example.com' },
    });
    assert.equal(result.status, 'empty');
    assert.deepEqual(result.rows, []);
  });

  it('rejects a capability that does not have an official contract', async () => {
    const client = new SemrushClient({ timeoutMs: 1_000, fetchImpl: async () => new Response('', { status: 200 }) });
    await assert.rejects(
      () => client.fetch({ apiKey: 'key', args: { operation: 'backlinks_comparison', targets: ['a.com', 'b.com'] } }),
      (error: unknown) => error instanceof SemrushServiceError && error.code === 'capability_unavailable',
    );
  });

  it('does not retry a provider rate-limit response', async () => {
    let calls = 0;
    const client = new SemrushClient({
      timeoutMs: 1_000,
      fetchImpl: async () => { calls += 1; return new Response('slow down', { status: 429 }); },
    });
    await assert.rejects(
      () => client.fetch({ apiKey: 'key', args: { operation: 'domain_overview', domain: 'example.com' } }),
      (error: unknown) => error instanceof SemrushServiceError && error.code === 'rate_limited',
    );
    assert.equal(calls, 1);
  });

  for (const status of [401, 403]) {
    it(`maps HTTP ${status} to provider_auth_failed without retrying`, async () => {
      let calls = 0;
      const client = new SemrushClient({
        timeoutMs: 1_000,
        fetchImpl: async () => { calls += 1; return new Response('denied', { status }); },
      });
      await assert.rejects(
        () => client.fetch({ apiKey: 'key', args: { operation: 'domain_overview', domain: 'example.com' } }),
        (error: unknown) => error instanceof SemrushServiceError && error.code === 'provider_auth_failed',
      );
      assert.equal(calls, 1);
    });
  }

  it('maps provider failures and ambiguous timeouts without retrying', async () => {
    const unavailable = new SemrushClient({ timeoutMs: 1_000, fetchImpl: async () => new Response('unavailable', { status: 503 }) });
    await assert.rejects(
      () => unavailable.fetch({ apiKey: 'key', args: { operation: 'domain_overview', domain: 'example.com' } }),
      (error: unknown) => error instanceof SemrushServiceError && error.code === 'provider_failure',
    );

    let calls = 0;
    const timeout = new SemrushClient({
      timeoutMs: 1_000,
      fetchImpl: async () => { calls += 1; throw new DOMException('aborted', 'AbortError'); },
    });
    await assert.rejects(
      () => timeout.fetch({ apiKey: 'key', args: { operation: 'domain_overview', domain: 'example.com' } }),
      (error: unknown) => error instanceof SemrushServiceError && error.code === 'timeout',
    );
    assert.equal(calls, 1);
  });
});
