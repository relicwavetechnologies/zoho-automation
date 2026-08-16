import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OmsSiteDataClient } from '../../src/infrastructure/oms/oms-site-data.client.ts';
import { OmsSiteDataServiceError, OmsSiteDataToolArgsSchema, SEARCH_SORT_FIELDS, buildOmsProviderRequest, sanitizeOmsWebsiteInputs } from '../../src/application/oms/oms-site-data.types.ts';

describe('OmsSiteDataClient', () => {
  it('sanitizes pasted emails, URLs, and hostnames into OMS-ready websites', () => {
    const rows = sanitizeOmsWebsiteInputs([
      'Sales@Example.COM',
      'https://example.com/path?utm=1',
      'www.partner.co.in/',
      'blog.example.com/articles',
      'not-a-domain',
    ]);

    assert.deepEqual(rows, [
      { input: 'Sales@Example.COM', status: 'sanitized', inputKind: 'email', hostname: 'example.com', website: 'www.example.com' },
      { input: 'https://example.com/path?utm=1', status: 'sanitized', inputKind: 'url', hostname: 'example.com', website: 'www.example.com' },
      { input: 'www.partner.co.in/', status: 'sanitized', inputKind: 'url', hostname: 'www.partner.co.in', website: 'www.partner.co.in' },
      { input: 'blog.example.com/articles', status: 'sanitized', inputKind: 'url', hostname: 'blog.example.com', website: 'blog.example.com' },
      { input: 'not-a-domain', status: 'invalid', reason: 'No URL, email, or hostname found.' },
    ]);
  });

  it('handles real pasted email and URL shapes without following embedded URLs', () => {
    const rows = sanitizeOmsWebsiteInputs([
      ' <Sales@Example.COM>, ',
      'mailto:support@Example.org?subject=Hi',
      'HTTP://WWW.Example.NET./path?utm=1',
      'example.com:443/path',
      'example.com/path?redirect=https://evil.com',
      'sales@example.com, admin@test.co.in; https://foo.com/a',
    ]);

    assert.deepEqual(rows, [
      { input: 'Sales@Example.COM', status: 'sanitized', inputKind: 'email', hostname: 'example.com', website: 'www.example.com' },
      { input: 'mailto:support@Example.org?subject=Hi', status: 'sanitized', inputKind: 'email', hostname: 'example.org', website: 'www.example.org' },
      { input: 'HTTP://WWW.Example.NET./path?utm=1', status: 'sanitized', inputKind: 'url', hostname: 'www.example.net', website: 'www.example.net' },
      { input: 'example.com:443/path', status: 'sanitized', inputKind: 'url', hostname: 'example.com', website: 'www.example.com' },
      { input: 'example.com/path?redirect=https://evil.com', status: 'sanitized', inputKind: 'url', hostname: 'example.com', website: 'www.example.com' },
      { input: 'sales@example.com', status: 'sanitized', inputKind: 'email', hostname: 'example.com', website: 'www.example.com' },
      { input: 'admin@test.co.in', status: 'sanitized', inputKind: 'email', hostname: 'test.co.in', website: 'www.test.co.in' },
      { input: 'https://foo.com/a', status: 'sanitized', inputKind: 'url', hostname: 'foo.com', website: 'www.foo.com' },
    ]);
  });

  it('rejects unsafe or malformed website inputs instead of guessing a host', () => {
    const rows = sanitizeOmsWebsiteInputs([
      'john@@example.com',
      'https://user:pass@example.com/path',
      'https://example.com@evil.com/path',
      'ftp://example.com/file',
      'javascript://example.com/%0aalert',
      'https://127.0.0.1',
      'http://localhost:3000',
      'www.-bad.com',
      'foo..com',
    ]);

    assert.deepEqual(rows, [
      { input: 'john@@example.com', status: 'invalid', reason: 'URLs with usernames or passwords are not accepted.' },
      { input: 'https://user:pass@example.com/path', status: 'invalid', reason: 'URLs with usernames or passwords are not accepted.' },
      { input: 'https://example.com@evil.com/path', status: 'invalid', reason: 'URLs with usernames or passwords are not accepted.' },
      { input: 'ftp://example.com/file', status: 'invalid', reason: 'Only http and https URLs are accepted.' },
      { input: 'javascript://example.com/%0aalert', status: 'invalid', reason: 'Only http and https URLs are accepted.' },
      { input: 'https://127.0.0.1', status: 'invalid', reason: 'Hostname must be a public domain, not an IP, localhost, or malformed value.' },
      { input: 'http://localhost:3000', status: 'invalid', reason: 'Hostname must be a public domain, not an IP, localhost, or malformed value.' },
      { input: 'www.-bad.com', status: 'invalid', reason: 'Hostname must be a public domain, not an IP, localhost, or malformed value.' },
      { input: 'foo..com', status: 'invalid', reason: 'Hostname must be a public domain, not an IP, localhost, or malformed value.' },
    ]);
  });

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

  it('translates the quality filters into the documented provider operators', async () => {
    const calls: Array<{ init?: RequestInit }> = [];
    const client = new OmsSiteDataClient({
      timeoutMs: 1_000,
      fetchImpl: async (_url, init) => {
        calls.push({ init });
        return new Response(JSON.stringify([{ website: 'example.com' }]), { status: 200 });
      },
    });

    await client.fetch('key', {
      operation: 'search_sites',
      minDomainAuthority: 70,
      maxSpamScore: 2,
      minDomainRating: 60,
      minAhrefTraffic: 1_000,
      minSimilarwebTraffic: 500,
    });

    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    assert.deepEqual(body['filters'], [
      { field: 'domainAuthority', op: 'gte', value: 70 },
      { field: 'domainRating', op: 'gte', value: 60 },
      // Guard against the unmeasured spam-score sentinel, added automatically.
      { field: 'spamScore', op: 'gte', value: 0 },
      { field: 'spamScore', op: 'lte', value: 2 },
      { field: 'ahrefTraffic', op: 'gte', value: 1_000 },
      { field: 'similarwebTraffic', op: 'gte', value: 500 },
    ]);
    // Every filterable metric must also be selected, or the shortlist hides
    // the very fields it was filtered on.
    const columns = body['columns'] as string[];
    for (const column of ['spamScore', 'domainRating', 'similarwebTraffic']) {
      assert.equal(columns.includes(column), true, `${column} missing from search columns`);
    }
    assert.equal(columns.length <= 25, true, 'provider allows at most 25 columns');
  });

  it('rejects a search that would exceed the provider 20-filter cap', async () => {
    const base: Record<string, unknown> = {
      operation: 'search_sites',
      niche: 'SaaS', contentCategory: 'Tech', language: 'English', country: 'US',
      websiteStatus: 'Normal', siteClassification: 'Normal', priceCategory: 'Paid',
      linkAttribute: 'DoFollow', websiteType: 'Default', websiteQuality: 'Pure',
      minDomainAuthority: 50, maxDomainAuthority: 90,
      minPageAuthority: 30, maxPageAuthority: 80,
      minDomainRating: 40, maxDomainRating: 95,
      minSpamScore: 0, maxSpamScore: 3,
      minOrganicTraffic: 1, maxOrganicTraffic: 9_000_000,
    };
    // Exactly 20 criteria stays within the documented provider ceiling.
    assert.equal(OmsSiteDataToolArgsSchema.safeParse(base).success, true);
    const built = buildOmsProviderRequest(OmsSiteDataToolArgsSchema.parse(base) as never);
    assert.equal(built.filters?.length, 20);

    // A 21st criterion would be silently rejected by OMS with an empty 200
    // body, which is indistinguishable from "no matches".
    const overLimit = OmsSiteDataToolArgsSchema.safeParse({ ...base, minAhrefTraffic: 1 });
    assert.equal(overLimit.success, false);

    // Dropping the explicit floor makes the guard fire, and it occupies a real
    // provider slot: 20 caller criteria plus the guard is 21.
    const guarded = { ...base, minSpamScore: undefined, minSemrushTraffic: 1 };
    const withGuard = OmsSiteDataToolArgsSchema.safeParse(guarded);
    assert.equal(withGuard.success, false);
    if (withGuard.success) return;
    // The message must explain the reserved slot, or it reads as false to an
    // agent that counted exactly 20 criteria of its own.
    assert.match(withGuard.error.issues.map(i => i.message).join(' '), /reserves one of them/i);

    // One fewer criterion leaves room for the guard, emitting exactly 20.
    const fits = OmsSiteDataToolArgsSchema.safeParse({ ...guarded, minSemrushTraffic: undefined });
    assert.equal(fits.success, true);
    if (!fits.success) return;
    assert.equal(buildOmsProviderRequest(fits.data as never).filters?.length, 20);
  });

  it('defaults sort direction per field so lower-is-better metrics are not inverted', () => {
    // OMS sorts before truncating, so a blanket DESC on spamScore would return
    // the 100 spammiest sites and discard every clean one.
    for (const [field, direction] of [
      ['spamScore', 'ASC'], ['sellingPrice', 'ASC'], ['costPrice', 'ASC'], ['turnAroundTime', 'ASC'],
      ['domainAuthority', 'DESC'], ['domainRating', 'DESC'], ['semrushOrganicTraffic', 'DESC'],
    ] as const) {
      const built = buildOmsProviderRequest({ operation: 'search_sites', niche: 'Tech', sortBy: field } as never);
      assert.deepEqual(built.orderBy, [{ field, direction }], `${field} default direction`);
    }
    // An explicit direction always wins over the per-field default.
    const explicit = buildOmsProviderRequest({ operation: 'search_sites', niche: 'Tech', sortBy: 'spamScore', sortDirection: 'DESC' } as never);
    assert.deepEqual(explicit.orderBy, [{ field: 'spamScore', direction: 'DESC' }]);
  });

  it('excludes the unmeasured spam-score sentinel from spam-constrained searches', () => {
    // OMS stores "never measured" as -1, which satisfies any maxSpamScore
    // bound and sorts first under ASC, so unmeasured sites would otherwise be
    // returned as the cleanest ones.
    const bounded = buildOmsProviderRequest({ operation: 'search_sites', niche: 'Tech', maxSpamScore: 2 } as never);
    assert.deepEqual(bounded.filters, [
      { field: 'niche', op: 'contains', value: 'Tech' },
      { field: 'spamScore', op: 'gte', value: 0 },
      { field: 'spamScore', op: 'lte', value: 2 },
    ]);

    const ranked = buildOmsProviderRequest({ operation: 'search_sites', niche: 'Tech', sortBy: 'spamScore' } as never);
    assert.deepEqual(ranked.filters, [
      { field: 'niche', op: 'contains', value: 'Tech' },
      { field: 'spamScore', op: 'gte', value: 0 },
    ]);

    // An explicit floor is the caller's decision and suppresses the guard, so
    // exactly one spamScore gte filter is emitted rather than two.
    const explicit = buildOmsProviderRequest(
      OmsSiteDataToolArgsSchema.parse({ operation: 'search_sites', niche: 'Tech', minSpamScore: 0, maxSpamScore: 2 }) as never,
    );
    assert.equal(explicit.filters?.filter(f => f.field === 'spamScore' && f.op === 'gte').length, 1);

    // A negative floor is not reachable through the schema at all.
    assert.equal(
      OmsSiteDataToolArgsSchema.safeParse({ operation: 'search_sites', niche: 'Tech', minSpamScore: -5 }).success,
      false,
    );

    // Ranking spammiest-first is not a cleanliness query, so no guard is added.
    const worst = buildOmsProviderRequest({ operation: 'search_sites', niche: 'Tech', sortBy: 'spamScore', sortDirection: 'DESC' } as never);
    assert.equal(worst.filters?.some(f => f.field === 'spamScore'), false);
  });

  it('keeps every sortable field inside the selected columns and within the provider column cap', () => {
    // A sort field the provider did not select is an invalid request, so this
    // invariant must hold for any field added to the sort enum later.
    const columns = buildOmsProviderRequest({ operation: 'search_sites', niche: 'Tech' } as never).columns as readonly string[];
    for (const field of SEARCH_SORT_FIELDS) {
      assert.equal(columns.includes(field), true, `${field} is sortable but not selected`);
    }
    assert.equal(columns.length <= 25, true, 'provider allows at most 25 columns');
  });

  it('does not treat a non-auth rejection envelope as a bad API key', async () => {
    // provider_auth_failed disables the company connection for 15 minutes and
    // pages admins, so only a genuine auth reason may trigger it.
    const client = new OmsSiteDataClient({
      timeoutMs: 1_000,
      fetchImpl: async () => new Response(
        JSON.stringify({ success: false, error: 'Validation failed', message: 'contact support with your API key' }),
        { status: 200 },
      ),
    });
    await assert.rejects(
      () => client.fetch('key', { operation: 'get_site_profiles', websites: ['example.com'] }),
      (error: unknown) => error instanceof OmsSiteDataServiceError
        && error.code === 'provider_failure'
        && /Validation failed/.test(error.message),
    );
  });

  it('classifies the HTTP 200 unauthorized envelope as an auth failure, not a contract violation', async () => {
    // The webhook returns 200 with an error object for a rejected key, so
    // status-code-only classification reports a misleading generic failure.
    const client = new OmsSiteDataClient({
      timeoutMs: 1_000,
      fetchImpl: async () => new Response(
        JSON.stringify({ success: false, error: 'Unauthorized', message: 'Missing or invalid API key.' }),
        { status: 200 },
      ),
    });
    await assert.rejects(
      () => client.verifyKey('wrong-key'),
      (error: unknown) => error instanceof OmsSiteDataServiceError && error.code === 'provider_auth_failed',
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
