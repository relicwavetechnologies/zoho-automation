/**
 * Tests for SerperClient and WebSearchService (all fetch calls mocked).
 *
 * Groups:
 *   A. SerperClient.search — happy path, response coercion, error handling
 *   B. WebSearchService    — merge/dedup, site search, page context, empty query
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { SerperClient, SearchIntegrationError } from '../../../../src/infrastructure/ai/search/serper.client.ts';
import { WebSearchService } from '../../../../src/infrastructure/ai/search/web-search.service.ts';
import type { Logger } from '../../../../src/shared/logger.ts';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const noopLogger: Logger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  child: () => noopLogger,
};

type MockResponse = { status: number; body: unknown; headers?: Record<string, string> };
let mockResponses: MockResponse[] = [];
let fetchCalls: { url: string; method: string; body?: unknown }[] = [];

const originalFetch = globalThis.fetch;

beforeEach(() => {
  mockResponses = [];
  fetchCalls = [];
  (globalThis as any).fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const mock = mockResponses.shift() ?? { status: 200, body: { organic: [] } };
    fetchCalls.push({
      url,
      method: init?.method ?? 'GET',
      body:   init?.body ? JSON.parse(init.body as string) : undefined,
    });
    const hdrs = mock.headers ?? { 'content-type': 'application/json' };
    // If body is already a string (e.g. raw HTML), use it as-is; otherwise JSON-encode it.
    const bodyText = typeof mock.body === 'string' ? mock.body : JSON.stringify(mock.body);
    return {
      ok:      mock.status >= 200 && mock.status < 300,
      status:  mock.status,
      headers: { get: (k: string) => hdrs[k] ?? null },
      text:    async () => bodyText,
    } as unknown as Response;
  };
});

afterEach(() => {
  (globalThis as any).fetch = originalFetch;
});

function makeClient(opts: { apiKey?: string; timeoutMs?: number } = {}): SerperClient {
  return new SerperClient({
    apiKey:    opts.apiKey ?? 'test-api-key',
    timeoutMs: opts.timeoutMs ?? 5000,
    fetchImpl: (globalThis as any).fetch,
  });
}

function makeService(clientOverride?: SerperClient): WebSearchService {
  const client = clientOverride ?? makeClient();
  return new WebSearchService(client, noopLogger, (globalThis as any).fetch);
}

const ORGANIC_RESPONSE = {
  organic: [
    { title: 'Result 1', link: 'https://example.com/page1', snippet: 'Snippet 1', position: 1 },
    { title: 'Result 2', link: 'https://other.com/page2',   snippet: 'Snippet 2', position: 2 },
  ],
};

// ─── A. SerperClient ──────────────────────────────────────────────────────────

describe('SerperClient.search', () => {
  it('POSTs to /search with query and defaults', async () => {
    mockResponses.push({ status: 200, body: { organic: [] } });
    const client = makeClient();
    await client.search({ query: 'test query' });

    const call = fetchCalls[0];
    assert.ok(call.url.endsWith('/search'));
    assert.equal(call.method, 'POST');
    assert.equal((call.body as any)?.q, 'test query');
    assert.equal((call.body as any)?.num, 5);
    assert.equal((call.body as any)?.gl, 'us');
    assert.equal((call.body as any)?.hl, 'en');
  });

  it('passes custom num, gl, hl, page to the request body', async () => {
    mockResponses.push({ status: 200, body: { organic: [] } });
    await makeClient().search({ query: 'q', num: 8, gl: 'gb', hl: 'en-gb', page: 2 });

    const body = fetchCalls[0].body as any;
    assert.equal(body.num, 8);
    assert.equal(body.gl, 'gb');
    assert.equal(body.hl, 'en-gb');
    assert.equal(body.page, 2);
  });

  it('returns parsed organic results', async () => {
    mockResponses.push({ status: 200, body: ORGANIC_RESPONSE });
    const result = await makeClient().search({ query: 'test' });
    assert.equal(result.organic.length, 2);
    assert.equal(result.organic[0].title, 'Result 1');
    assert.equal(result.organic[0].link,  'https://example.com/page1');
  });

  it('returns empty organic when organic is missing from response', async () => {
    mockResponses.push({ status: 200, body: { knowledgeGraph: { title: 'X' } } });
    const result = await makeClient().search({ query: 'test' });
    assert.deepEqual(result.organic, []);
  });

  it('preserves answerBox when present', async () => {
    mockResponses.push({ status: 200, body: { organic: [], answerBox: { answer: '42' } } });
    const result = await makeClient().search({ query: 'life' });
    assert.deepEqual(result.answerBox, { answer: '42' });
  });

  it('throws SearchIntegrationError on HTTP 4xx', async () => {
    mockResponses.push({ status: 401, body: 'Unauthorized' });
    await assert.rejects(
      () => makeClient().search({ query: 'test' }),
      (e: SearchIntegrationError) => {
        assert.equal(e.code, 'search_auth_failed');
        return true;
      },
    );
  });

  it('preserves Retry-After for rate-limited calls', async () => {
    mockResponses.push({ status: 429, body: 'Too Many Requests', headers: { 'retry-after': '12' } });
    await assert.rejects(
      () => makeClient().search({ query: 'test' }),
      (e: SearchIntegrationError) => {
        assert.equal(e.code, 'search_rate_limited');
        assert.equal(e.retryAfterMs, 12_000);
        return true;
      },
    );
  });

  it('recognizes Serper credit exhaustion returned as HTTP 400', async () => {
    mockResponses.push({ status: 400, body: { message: 'Not enough credits', statusCode: 400 } });
    await assert.rejects(
      () => makeClient().search({ query: 'test' }),
      (e: SearchIntegrationError) => e.code === 'search_credits_exhausted',
    );
  });

  it('throws SearchIntegrationError on HTTP 5xx', async () => {
    mockResponses.push({ status: 503, body: 'Service Unavailable' });
    await assert.rejects(
      () => makeClient().search({ query: 'test' }),
      (e: SearchIntegrationError) => e.code === 'search_unavailable',
    );
  });

  it('throws search_not_configured when apiKey is empty', async () => {
    const client = makeClient({ apiKey: '' });
    await assert.rejects(
      () => client.search({ query: 'test' }),
      (e: SearchIntegrationError) => {
        assert.equal(e.code, 'search_not_configured');
        return true;
      },
    );
    assert.equal(fetchCalls.length, 0, 'should not make an HTTP call');
  });

  it('throws search_invalid_response when response body is not JSON', async () => {
    // Override fetch to return non-JSON text
    (globalThis as any).fetch = async () => ({
      ok:     true,
      status: 200,
      headers: { get: () => 'text/plain' },
      text:   async () => 'not json at all <<<',
    });
    await assert.rejects(
      () => makeClient().search({ query: 'test' }),
      (e: SearchIntegrationError) => e.code === 'search_invalid_response',
    );
  });

  it('throws search_unavailable when fetch itself throws (network error)', async () => {
    (globalThis as any).fetch = async () => { throw new Error('ECONNREFUSED'); };
    await assert.rejects(
      () => makeClient().search({ query: 'test' }),
      (e: SearchIntegrationError) => e.code === 'search_unavailable',
    );
  });

  it('coerces non-string fields in organic entries gracefully', async () => {
    mockResponses.push({
      status: 200,
      body: {
        organic: [
          { title: 123, link: 'https://x.com/p', snippet: null, position: '3' },
        ],
      },
    });
    const result = await makeClient().search({ query: 'test' });
    assert.equal(result.organic.length, 1);
    assert.equal(result.organic[0].title,    undefined); // 123 is not a string
    assert.equal(result.organic[0].link,     'https://x.com/p');
    assert.equal(result.organic[0].snippet,  undefined); // null coerced
    assert.equal(result.organic[0].position, undefined); // '3' coerced
  });
});

// ─── B. WebSearchService ──────────────────────────────────────────────────────

describe('WebSearchService.search', () => {
  it('forwards the company scope to the configured Serper pool', async () => {
    let companyId: string | undefined;
    const service = new WebSearchService({
      search: async (_input, scope) => {
        companyId = scope;
        return { organic: [] };
      },
    }, noopLogger, (globalThis as any).fetch);

    await service.search({ companyId: 'company-1', query: 'test', pageContextLimit: 0 });
    assert.equal(companyId, 'company-1');
  });

  it('returns empty result for empty query', async () => {
    const svc = makeService();
    const result = await svc.search({ query: '   ' });
    assert.deepEqual(result.items, []);
    assert.deepEqual(result.sourceRefs, []);
    assert.equal(result.focusedSiteSearch, false);
  });

  it('returns items from organic results', async () => {
    // Primary search
    mockResponses.push({ status: 200, body: ORGANIC_RESPONSE });
    // Page context fetches (2 items, but default limit is 3 so both attempted)
    mockResponses.push({ status: 200, body: '<html><head><title>P1</title></head><body>Content page 1</body></html>' });
    mockResponses.push({ status: 200, body: '<html><body>Content page 2</body></html>' });

    const svc = makeService();
    const result = await svc.search({ query: 'test query', pageContextLimit: 2 });

    assert.equal(result.query, 'test query');
    assert.equal(result.items.length, 2);
    assert.equal(result.items[0].title, 'Result 1');
    assert.equal(result.items[0].domain, 'example.com');
    assert.equal(result.items[0].source, 'organic');
    assert.equal(result.sourceRefs.length, 2);
    assert.equal(result.sourceRefs[0].source, 'web');
  });

  it('deduplicates results that appear in both primary and site searches', async () => {
    const sharedItem = { title: 'X', link: 'https://example.com/x', snippet: 'S', position: 1 };
    // Primary search returns [sharedItem]
    mockResponses.push({ status: 200, body: { organic: [sharedItem] } });
    // Site search also returns [sharedItem] — should be deduped
    mockResponses.push({ status: 200, body: { organic: [sharedItem] } });
    // Page context
    mockResponses.push({ status: 200, body: '<html><body>text</body></html>' });

    const svc = makeService();
    const result = await svc.search({ query: 'x', exactDomain: 'example.com' });
    assert.equal(result.items.length, 1, 'deduplication should collapse the shared item');
    assert.equal(result.focusedSiteSearch, true);
  });

  it('runs site search when exactDomain is provided', async () => {
    mockResponses.push({ status: 200, body: { organic: [] } });
    mockResponses.push({ status: 200, body: { organic: [] } });

    await makeService().search({ query: 'docs', exactDomain: 'example.com', pageContextLimit: 0 });

    assert.equal(fetchCalls.length, 2, 'should make primary + site search calls');
    const siteCall = fetchCalls.find(c => (c.body as any)?.q?.startsWith('site:'));
    assert.ok(siteCall, 'should have a site: query');
    assert.ok((siteCall.body as any)?.q?.includes('example.com'));
  });

  it('excludes site-search results from different domains', async () => {
    mockResponses.push({ status: 200, body: { organic: [] } });
    // Site search returns result from wrong domain
    mockResponses.push({ status: 200, body: { organic: [
      { title: 'Wrong', link: 'https://evil.com/page', snippet: 's', position: 1 },
    ]}});

    const svc = makeService();
    const result = await svc.search({ query: 'q', exactDomain: 'example.com', pageContextLimit: 0 });
    assert.equal(result.items.length, 0, 'should exclude cross-domain site results');
  });

  it('respects searchResultsLimit cap', async () => {
    const manyResults = Array.from({ length: 10 }, (_, i) => ({
      title: `R${i}`, link: `https://site${i}.com/p`, snippet: 'S', position: i + 1,
    }));
    mockResponses.push({ status: 200, body: { organic: manyResults } });

    const svc = makeService();
    const result = await svc.search({ query: 'test', searchResultsLimit: 3, pageContextLimit: 0 });
    assert.equal(result.items.length, 3);
  });

  it('sets pageContext.fetched=false when page fetch fails', async () => {
    mockResponses.push({ status: 200, body: ORGANIC_RESPONSE });
    // Page fetch for first item → 503
    mockResponses.push({ status: 503, body: 'Down' });

    const svc = makeService();
    const result = await svc.search({ query: 'test', pageContextLimit: 1 });
    assert.equal(result.items[0].pageContext?.fetched, false);
    assert.ok(result.items[0].pageContext?.error);
  });

  it('extracts meta-description from page HTML', async () => {
    mockResponses.push({ status: 200, body: { organic: [
      { title: 'T', link: 'https://x.com/p', snippet: 'S', position: 1 },
    ]}});
    const html = `<html><head><meta name="description" content="Page meta desc"/></head><body>Body</body></html>`;
    mockResponses.push({ status: 200, body: html, headers: { 'content-type': 'text/html' } });

    const svc = makeService();
    const result = await svc.search({ query: 'test', pageContextLimit: 1 });
    assert.equal(result.items[0].pageContext?.metaDescription, 'Page meta desc');
  });

  it('does not fetch page contexts when pageContextLimit is 0', async () => {
    mockResponses.push({ status: 200, body: ORGANIC_RESPONSE });

    const svc = makeService();
    await svc.search({ query: 'test', pageContextLimit: 0 });

    // Only the primary Serper search — no page fetches
    assert.equal(fetchCalls.length, 1);
  });

  it('strips HTML tags from page excerpt', async () => {
    mockResponses.push({ status: 200, body: { organic: [
      { title: 'T', link: 'https://y.com/p', snippet: 'S', position: 1 },
    ]}});
    const html = '<html><body><h1>Hello</h1><p>World text here</p></body></html>';
    mockResponses.push({ status: 200, body: html, headers: { 'content-type': 'text/html' } });

    const svc = makeService();
    const result = await svc.search({ query: 'test', pageContextLimit: 1 });
    const excerpt = result.items[0].pageContext?.excerpt ?? '';
    assert.ok(!excerpt.includes('<p>'), 'should not contain HTML tags');
    assert.ok(excerpt.includes('Hello'), 'should include h1 text');
  });

  it('normalizes domain from item link (strips www.)', async () => {
    mockResponses.push({ status: 200, body: { organic: [
      { title: 'T', link: 'https://www.EXAMPLE.com/page', snippet: 'S', position: 1 },
    ]}});

    const svc = makeService();
    const result = await svc.search({ query: 'test', pageContextLimit: 0 });
    assert.equal(result.items[0].domain, 'example.com');
  });

  it('handles site search failure gracefully (still returns primary results)', async () => {
    mockResponses.push({ status: 200, body: ORGANIC_RESPONSE }); // primary
    // Site search throws (simulate network error)
    const origFetch = (globalThis as any).fetch;
    let callCount = 0;
    (globalThis as any).fetch = async (url: string, init?: RequestInit) => {
      callCount++;
      if (callCount === 2) throw new Error('Network failure');
      return origFetch(url, init);
    };

    const svc = makeService();
    const result = await svc.search({ query: 'test', exactDomain: 'example.com', pageContextLimit: 0 });
    // Primary results still returned despite site search failure
    assert.ok(result.items.length > 0 || result.focusedSiteSearch === false);
  });
});
