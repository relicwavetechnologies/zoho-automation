const assert = require('node:assert/strict');
const test = require('node:test');

const { QdrantAdapter } = require('../dist/company/integrations/vector/qdrant.adapter');

const jsonResponse = (payload, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const withFetch = async (impl, fn) => {
  const originalFetch = global.fetch;
  global.fetch = impl;
  try {
    await fn();
  } finally {
    global.fetch = originalFetch;
  }
};

test('QdrantAdapter.upsertVectors ensures collection and upserts deterministic point ids', async () => {
  const calls = [];
  const adapter = new QdrantAdapter();

  await withFetch(async (url, init) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) {
      return new Response('not found', { status: 404 });
    }

    return jsonResponse({ status: 'ok' });
  }, async () => {
    await adapter.upsertVectors([
      {
        companyId: 'cmp-1',
        connectionId: 'conn-1',
        sourceType: 'zoho_contact',
        sourceId: 'src-1',
        chunkIndex: 0,
        contentHash: 'hash-1',
        payload: { text: 'hello' },
        embedding: [0.1, 0.2, 0.3],
      },
    ]);
  });

  assert.ok(calls.length >= 3);
  const upsertCall = calls.find((call) => call.url.includes('/points?wait=true'));
  assert.ok(upsertCall);
  const upsertBody = JSON.parse(upsertCall.init.body);
  assert.equal(Array.isArray(upsertBody.points), true);
  assert.equal(typeof upsertBody.points[0].id, 'string');
  assert.match(
    upsertBody.points[0].id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.equal(upsertBody.points[0].payload.companyId, 'cmp-1');
  assert.equal(upsertBody.points[0].payload.sourceId, 'src-1');
});

test('QdrantAdapter.search scopes by company and maps payloads', async () => {
  const adapter = new QdrantAdapter();

  await withFetch(async (url, init) => {
    const parsedUrl = String(url);
    if (parsedUrl.includes('/index?wait=true')) {
      return jsonResponse({ status: 'ok' });
    }
    if (parsedUrl.includes('/points/search')) {
      const body = JSON.parse(init.body);
      assert.equal(Array.isArray(body.filter.should), true);
      assert.equal(body.filter.should.length >= 1, true);

      return jsonResponse({
        result: [
          {
            id: 'pt-1',
            score: 0.88,
            payload: {
              sourceType: 'zoho_deal',
              sourceId: 'deal-1',
              chunkIndex: 2,
              title: 'Deal 1',
            },
          },
        ],
      });
    }

    return jsonResponse({ status: 'ok' });
  }, async () => {
    const result = await adapter.search({
      companyId: 'cmp-1',
      vector: [0.1, 0.2, 0.3],
      limit: 3,
    });

    assert.equal(result.length, 1);
    assert.equal(result[0].sourceType, 'zoho_deal');
    assert.equal(result[0].sourceId, 'deal-1');
  });
});

test('QdrantAdapter.search adds requester email payload filter when strict user scope is enabled', async () => {
  const adapter = new QdrantAdapter();

  await withFetch(async (url, init) => {
    const parsedUrl = String(url);
    if (parsedUrl.includes('/index?wait=true')) {
      return jsonResponse({ status: 'ok' });
    }
    if (parsedUrl.includes('/points/search')) {
      const body = JSON.parse(init.body);
      const must = Array.isArray(body.filter.must) ? body.filter.must : [];
      const emailClause = must.find((clause) => clause?.key === 'referenceEmails');
      assert.ok(emailClause);
      assert.deepEqual(emailClause.match.any, ['owner@example.com']);

      return jsonResponse({ result: [] });
    }
    return jsonResponse({ status: 'ok' });
  }, async () => {
    const result = await adapter.search({
      companyId: 'cmp-1',
      requesterEmail: 'owner@example.com',
      enforceEmailMatch: true,
      vector: [0.1, 0.2, 0.3],
      limit: 3,
    });
    assert.equal(Array.isArray(result), true);
  });
});

test('QdrantAdapter.countByCompany returns exact count from qdrant response', async () => {
  const adapter = new QdrantAdapter();

  await withFetch(async (_url, _init) => jsonResponse({ result: { count: 7 } }), async () => {
    const count = await adapter.countByCompany('cmp-1');
    assert.equal(count, 7);
  });
});
