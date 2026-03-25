const assert = require('node:assert/strict');
const test = require('node:test');

const { QdrantAdapter } = require('../src/company/integrations/vector/qdrant.adapter.ts');

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

  await withFetch(
    async (url, init) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) {
        return new Response('not found', { status: 404 });
      }

      return jsonResponse({ status: 'ok' });
    },
    async () => {
      await adapter.upsertVectors([
        {
          companyId: 'cmp-1',
          connectionId: 'conn-1',
          sourceType: 'zoho_contact',
          sourceId: 'src-1',
          chunkIndex: 0,
          documentKey: 'cmp-1:zoho_contact:src-1',
          contentHash: 'hash-1',
          payload: { text: 'hello', chunkText: 'hello' },
          denseEmbedding: [0.1, 0.2, 0.3],
        },
      ]);
    },
  );

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
  assert.deepEqual(upsertBody.points[0].vector.dense_text_v2, [0.1, 0.2, 0.3]);
  assert.equal(upsertBody.points[0].payload.companyId, 'cmp-1');
  assert.equal(upsertBody.points[0].payload.sourceId, 'src-1');
  assert.equal(upsertBody.points[0].payload.documentKey, 'cmp-1:zoho_contact:src-1');
});

test('QdrantAdapter.search scopes by company and returns grouped payloads', async () => {
  const adapter = new QdrantAdapter();

  await withFetch(
    async (url, init) => {
      const parsedUrl = String(url);
      if (parsedUrl.includes('/index?wait=true')) {
        return jsonResponse({ status: 'ok' });
      }
      if (parsedUrl.includes('/points/query/groups')) {
        const body = JSON.parse(init.body);
        assert.equal(Array.isArray(body.prefetch), true);
        assert.equal(body.prefetch.length, 2);
        assert.equal(body.group_by, 'documentKey');
        assert.equal(body.group_size, 2);
        assert.equal(Array.isArray(body.prefetch[0].filter.should), true);
        assert.equal(body.prefetch[0].filter.should.length >= 1, true);

        return jsonResponse({
          result: {
            groups: [
              {
                id: 'cmp-1:zoho_deal:deal-1',
                hits: [
                  {
                    id: 'pt-1',
                    score: 0.88,
                    payload: {
                      documentKey: 'cmp-1:zoho_deal:deal-1',
                      sourceType: 'zoho_deal',
                      sourceId: 'deal-1',
                      chunkIndex: 2,
                      title: 'Deal 1',
                    },
                  },
                ],
              },
            ],
          },
        });
      }

      return jsonResponse({ status: 'ok' });
    },
    async () => {
      const result = await adapter.search({
        companyId: 'cmp-1',
        denseVector: [0.1, 0.2, 0.3],
        lexicalQueryText: 'deal renewal',
        limit: 3,
        groupSize: 2,
      });

      assert.equal(result.length, 1);
      assert.equal(result[0].groupValue, 'cmp-1:zoho_deal:deal-1');
      assert.equal(result[0].hits[0].sourceType, 'zoho_deal');
      assert.equal(result[0].hits[0].sourceId, 'deal-1');
    },
  );
});

test('QdrantAdapter.search pushes fileAssetId into the filter before retrieval', async () => {
  const adapter = new QdrantAdapter();

  await withFetch(
    async (url, init) => {
      const parsedUrl = String(url);
      if (parsedUrl.includes('/index?wait=true')) {
        return jsonResponse({ status: 'ok' });
      }
      if (parsedUrl.includes('/points/query/groups')) {
        const body = JSON.parse(init.body);
        const must = Array.isArray(body.prefetch[0].filter.must)
          ? body.prefetch[0].filter.must
          : [];
        const fileClause = must.find((clause) => clause?.key === 'fileAssetId');
        assert.ok(fileClause);
        assert.equal(fileClause.match.value, 'file-1');
        return jsonResponse({
          result: {
            groups: [],
          },
        });
      }

      return jsonResponse({ status: 'ok' });
    },
    async () => {
      const result = await adapter.search({
        companyId: 'cmp-1',
        denseVector: [0.1, 0.2, 0.3],
        lexicalQueryText: 'pricing terms',
        fileAssetId: 'file-1',
        retrievalProfile: 'file',
        sourceTypes: ['file_document'],
        limit: 3,
      });

      assert.deepEqual(result, []);
    },
  );
});

test('QdrantAdapter.search adds requester email payload filter when strict user scope is enabled', async () => {
  const adapter = new QdrantAdapter();

  await withFetch(
    async (url, init) => {
      const parsedUrl = String(url);
      if (parsedUrl.includes('/index?wait=true')) {
        return jsonResponse({ status: 'ok' });
      }
      if (parsedUrl.includes('/points/query/groups')) {
        const body = JSON.parse(init.body);
        const must = Array.isArray(body.prefetch[0].filter.must)
          ? body.prefetch[0].filter.must
          : [];
        const emailClause = must.find((clause) => clause?.key === 'relationEmails');
        assert.ok(emailClause);
        assert.deepEqual(emailClause.match.any, ['owner@example.com']);

        return jsonResponse({ result: { groups: [] } });
      }
      return jsonResponse({ status: 'ok' });
    },
    async () => {
      const result = await adapter.search({
        companyId: 'cmp-1',
        requesterEmail: 'owner@example.com',
        enforceEmailMatch: true,
        denseVector: [0.1, 0.2, 0.3],
        lexicalQueryText: 'owner pipeline',
        limit: 3,
      });
      assert.equal(Array.isArray(result), true);
    },
  );
});

test('QdrantAdapter.countByCompany returns exact count from qdrant response', async () => {
  const adapter = new QdrantAdapter();

  await withFetch(
    async (_url, _init) => jsonResponse({ result: { count: 7 } }),
    async () => {
      const count = await adapter.countByCompany('cmp-1');
      assert.equal(count, 7);
    },
  );
});
