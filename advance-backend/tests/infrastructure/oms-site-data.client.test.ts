import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OmsSiteDataClient } from '../../src/infrastructure/oms/oms-site-data.client.ts';
import { OmsSiteDataServiceError } from '../../src/application/oms/oms-site-data.types.ts';

describe('OmsSiteDataClient', () => {
  it('uses the fixed POST contract, exact op filter key, and no browser/session headers', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new OmsSiteDataClient({
      timeoutMs: 1_000,
      endpoint: 'https://oms.example.test/webhook/site_data_read_only',
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify([{ website: 'example.com', niche: 'Technology', domainAuthority: 72 }]), { status: 200 });
      },
    });

    const result = await client.fetch('never-log-this', {
      operation: 'search_sites',
      niche: 'Technology',
      minDomainAuthority: 50,
      sortBy: 'domainAuthority',
      sortDirection: 'DESC',
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, 'https://oms.example.test/webhook/site_data_read_only');
    const headers = calls[0]?.init?.headers as Record<string, string>;
    assert.equal(headers['X-API-Key'], 'never-log-this');
    assert.equal(headers.Cookie, undefined);
    assert.equal(headers.Authorization, undefined);
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    assert.deepEqual(body['filters'], [
      { field: 'niche', op: 'contains', value: 'Technology' },
      { field: 'domainAuthority', op: 'gte', value: 50 },
    ]);
    assert.equal(JSON.stringify(body).includes('operator'), false);
    assert.equal(result.status, 'complete');
    assert.equal(JSON.stringify(result).includes('never-log-this'), false);
  });

  it('sorts grouped catalog values locally and marks a provider-cap response partial', async () => {
    const rows = Array.from({ length: 100 }, (_, index) => ({ niche: index === 0 ? 'zeta' : `niche-${index}` }));
    const client = new OmsSiteDataClient({ timeoutMs: 1_000, fetchImpl: async () => new Response(JSON.stringify(rows), { status: 200 }) });
    const result = await client.fetch('key', { operation: 'list_catalog_values', field: 'niche' });
    assert.equal(result.status, 'partial');
    assert.equal(result.rows.length, 100);
    assert.equal(result.rows[0]?.niche, 'niche-1');
    assert.equal(result.coverage.possiblyTruncated, true);
  });

  it('does not misreport the provider empty-body ambiguity as no results', async () => {
    const client = new OmsSiteDataClient({ timeoutMs: 1_000, fetchImpl: async () => new Response('', { status: 200 }) });
    await assert.rejects(
      () => client.fetch('key', { operation: 'get_site_profiles', websites: ['example.com'] }),
      (error: unknown) => error instanceof OmsSiteDataServiceError && error.code === 'ambiguous_empty_response',
    );
  });

  it('maps an auth failure without retrying', async () => {
    let calls = 0;
    const client = new OmsSiteDataClient({ timeoutMs: 1_000, fetchImpl: async () => { calls += 1; return new Response('denied', { status: 403 }); } });
    await assert.rejects(
      () => client.fetch('key', { operation: 'get_site_profiles', websites: ['example.com'] }),
      (error: unknown) => error instanceof OmsSiteDataServiceError && error.code === 'provider_auth_failed',
    );
    assert.equal(calls, 1);
  });
});
