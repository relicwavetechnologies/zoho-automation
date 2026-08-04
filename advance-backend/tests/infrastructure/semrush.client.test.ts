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
    const calls: URL[] = [];
    const client = new SemrushClient({
      timeoutMs: 1_000,
      fetchImpl: async (url) => {
        calls.push(new URL(String(url)));
        return new Response('Ph;Po;Nq\nupi gateway;3;1000\npayment api;5;900\n', { status: 200 });
      },
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
    assert.equal(calls[0]?.searchParams.get('display_limit'), '2');
    assert.equal(
      calls[0]?.searchParams.get('export_columns'),
      'Ph,Po,Pp,Pd,Nq,Cp,Ur,Tr,Tc,Co,Nr,Td,Fk,Fp',
    );
  });

  it('does not invent a continuation when the provider returns no look-ahead row', async () => {
    const client = new SemrushClient({
      timeoutMs: 1_000,
      fetchImpl: async () => new Response('Ph;Po;Nq\nupi gateway;3;1000\n', { status: 200 }),
    });
    const result = await client.fetch({
      apiKey: 'secret-key',
      args: { operation: 'organic_positions', domain: 'decentro.tech', database: 'in', limit: 1, offset: 0 },
    });
    assert.equal(result.status, 'complete');
    assert.equal(result.nextPage, undefined);
  });

  it('treats Semrush end-of-data offset rejection as clean exhaustion', async () => {
    const client = new SemrushClient({
      timeoutMs: 1_000,
      fetchImpl: async () => new Response('ERROR 605 :: Invalid display_offset parameter', { status: 400 }),
    });
    const result = await client.fetch({
      apiKey: 'secret-key',
      args: { operation: 'organic_positions', domain: 'decentro.tech', database: 'in', limit: 1_000, offset: 1_000 },
    });
    assert.equal(result.status, 'empty');
    assert.deepEqual(result.rows, []);
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

  it('still refuses an operation with no mapped API surface', async () => {
    // The guard is what stops a future operation being tunnelled to Semrush
    // before its contract is verified, so it must survive all seven shipping.
    const client = new SemrushClient({ timeoutMs: 1_000, fetchImpl: async () => { throw new Error('must not call'); } });
    await assert.rejects(
      () => client.fetch({ apiKey: 'key', args: { operation: 'not_a_real_operation' } as never }),
      (error: unknown) => error instanceof SemrushServiceError && error.code === 'capability_unavailable',
    );
  });

  it('reads monthly history newest-first for a position trend', async () => {
    const calls: URL[] = [];
    const client = new SemrushClient({
      timeoutMs: 1_000,
      fetchImpl: async (url) => {
        calls.push(new URL(String(url)));
        return new Response('Date;Rank;Organic Keywords\n20260615;288510;46\n20260515;291952;31\n', { status: 200 });
      },
    });
    const result = await client.fetch({ apiKey: 'k', args: { operation: 'organic_position_trend', domain: 'example.com', database: 'in' } });
    assert.equal(calls[0]?.searchParams.get('type'), 'domain_rank_history');
    assert.equal(result.status, 'complete');
    assert.equal(result.rows.length, 2);
    assert.equal(result.coverage.months, 2);
  });

  it('batches keyword research into one call and reports what came back', async () => {
    const calls: URL[] = [];
    const client = new SemrushClient({
      timeoutMs: 1_000,
      fetchImpl: async (url) => {
        calls.push(new URL(String(url)));
        return new Response('Keyword;Search Volume\nseo services;18100\n', { status: 200 });
      },
    });
    const result = await client.fetch({
      apiKey: 'k',
      args: { operation: 'keyword_research', keywords: ['seo services', 'link building'], database: 'in' },
    });
    assert.equal(calls.length, 1, 'batched phrases must not fan out into one call each');
    assert.equal(calls[0]?.searchParams.get('type'), 'phrase_these');
    assert.equal(calls[0]?.searchParams.get('phrase'), 'seo services;link building');
    // Semrush drops phrases it has no data for, so the gap has to be visible.
    assert.equal(result.coverage.requestedKeywords, 2);
    assert.equal(result.coverage.returnedKeywords, 1);
  });

  it('excludes the first target for a keyword gap but includes it for a comparison', async () => {
    const calls: URL[] = [];
    const client = new SemrushClient({
      timeoutMs: 1_000,
      fetchImpl: async (url) => {
        calls.push(new URL(String(url)));
        return new Response('Keyword;Search Volume;b.com;a.com\nseo;100;3;0\n', { status: 200 });
      },
    });

    await client.fetch({ apiKey: 'k', args: { operation: 'keyword_gap', targets: ['a.com', 'b.com', 'c.com'], database: 'us' } });
    // The leading sign is the operator: `-` excludes, so the caller's own
    // domain is the excluded one and the result is what it does not rank for.
    assert.equal(calls[0]?.searchParams.get('domains'), '*|or|b.com|*|or|c.com|-|or|a.com');
    assert.equal(calls[0]?.searchParams.get('export_columns'), 'Ph,Nq,Cp,Co,P0,P1,P2');

    await client.fetch({ apiKey: 'k', args: { operation: 'domain_comparison', targets: ['a.com', 'b.com'], database: 'us' } });
    assert.equal(calls[1]?.searchParams.get('domains'), '*|or|a.com|*|or|b.com');
  });

  it('bills one backlinks request per target and presents the blank target column', async () => {
    const calls: URL[] = [];
    const client = new SemrushClient({
      timeoutMs: 1_000,
      fetchImpl: async (url) => {
        calls.push(new URL(String(url)));
        // The provider really does return an empty leading `target` field.
        return new Response('target;ascore;domains_num\n;73;126236\n', { status: 200 });
      },
    });
    const result = await client.fetch({ apiKey: 'k', args: { operation: 'backlinks_comparison', targets: ['a.com', 'b.com'] } });

    assert.equal(calls.length, 2, 'the backlinks host takes one target per call');
    assert.equal(calls[0]?.toString().split('?')[0], 'https://api.semrush.com/analytics/v1/');
    assert.equal(result.coverage.requestsBilled, 2);
    // Without the stamp both rows would be indistinguishable.
    assert.deepEqual(result.rows.map(row => row.Target), ['a.com', 'b.com']);
    assert.deepEqual(result.rows.map(row => row['Provider Data Status']), ['Returned', 'Returned']);
    assert.equal(result.rows[0]?.['Authority Score'], '73');
    assert.equal(result.rows[0]?.['Referring Domains'], '126236');
  });

  it('names a requested backlinks target with no provider data without inventing zero metrics', async () => {
    let request = 0;
    const client = new SemrushClient({
      timeoutMs: 1_000,
      fetchImpl: async () => {
        request += 1;
        return request === 1
          ? new Response('target;ascore\n;73\n', { status: 200 })
          : new Response('ERROR 50 :: NOTHING FOUND', { status: 200 });
      },
    });

    const result = await client.fetch({ apiKey: 'k', args: { operation: 'backlinks_comparison', targets: ['a.com', 'b.com'] } });

    assert.equal(result.status, 'complete');
    assert.deepEqual(result.coverage.missingTargets, ['b.com']);
    assert.deepEqual(result.rows, [
      { Target: 'a.com', 'Authority Score': '73', 'Provider Data Status': 'Returned' },
      { Target: 'b.com', 'Provider Data Status': 'No provider data' },
    ]);
  });

  it('preserves every requested backlinks target when none has provider data', async () => {
    const client = new SemrushClient({
      timeoutMs: 1_000,
      fetchImpl: async () => new Response('ERROR 50 :: NOTHING FOUND', { status: 200 }),
    });

    const result = await client.fetch({ apiKey: 'k', args: { operation: 'backlinks_comparison', targets: ['a.com', 'b.com'] } });

    assert.equal(result.status, 'complete');
    assert.deepEqual(result.coverage.missingTargets, ['a.com', 'b.com']);
    assert.deepEqual(result.rows, [
      { Target: 'a.com', 'Provider Data Status': 'No provider data' },
      { Target: 'b.com', 'Provider Data Status': 'No provider data' },
    ]);
  });

  it('treats NOTHING FOUND as an empty result rather than a provider failure', async () => {
    // Two domains that share no keywords return this routinely; calling it a
    // failure would report "Semrush failed" for a question with no answer.
    const client = new SemrushClient({
      timeoutMs: 1_000,
      fetchImpl: async () => new Response('ERROR 50 :: NOTHING FOUND', { status: 200 }),
    });
    const result = await client.fetch({ apiKey: 'k', args: { operation: 'domain_comparison', targets: ['a.com', 'b.com'] } });
    assert.equal(result.status, 'empty');
    assert.deepEqual(result.rows, []);
  });

  it('does not parse a prose error body as a data row', async () => {
    for (const body of ['Validation Error : target', 'Internal Server Error']) {
      const client = new SemrushClient({ timeoutMs: 1_000, fetchImpl: async () => new Response(body, { status: 200 }) });
      await assert.rejects(
        () => client.fetch({ apiKey: 'k', args: { operation: 'domain_overview', domain: 'example.com' } }),
        (error: unknown) => error instanceof SemrushServiceError && error.code === 'provider_failure',
        `${body} must not be parsed as CSV`,
      );
    }
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

  for (const [status, body] of [[401, 'denied'], [403, 'ERROR 120 :: WRONG KEY - ID PAIR'], [400, 'ERROR 122 :: WRONG FORMAT OR EMPTY KEY']] as const) {
    it(`maps a ${status} bad-key response to provider_auth_failed without retrying`, async () => {
      let calls = 0;
      const client = new SemrushClient({
        timeoutMs: 1_000,
        fetchImpl: async () => { calls += 1; return new Response(body, { status }); },
      });
      await assert.rejects(
        () => client.fetch({ apiKey: 'key', args: { operation: 'domain_overview', domain: 'example.com' } }),
        (error: unknown) => error instanceof SemrushServiceError && error.code === 'provider_auth_failed',
      );
      assert.equal(calls, 1);
    });
  }

  it('does not misreport an unexplained HTTP 403 or exhausted units as a bad key', async () => {
    for (const [body, code] of [['forbidden', 'provider_failure'], ['ERROR 132 :: API UNITS BALANCE IS ZERO', 'provider_insufficient_units']] as const) {
      const client = new SemrushClient({ timeoutMs: 1_000, fetchImpl: async () => new Response(body, { status: 403 }) });
      await assert.rejects(
        () => client.fetch({ apiKey: 'key', args: { operation: 'domain_overview', domain: 'example.com' } }),
        (error: unknown) => error instanceof SemrushServiceError && error.code === code,
      );
    }
  });

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
