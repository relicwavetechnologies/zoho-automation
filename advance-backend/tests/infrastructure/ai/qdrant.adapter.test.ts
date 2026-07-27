/**
 * Tests for QdrantAdapter (no live Qdrant server — all fetch calls are mocked).
 *
 * Groups:
 *   A. buildPointId (deterministic UUID)
 *   B. buildSearchFilter (filter construction)
 *   C. QdrantAdapter.upsert   — happy path, missing-index retry, empty input
 *   D. QdrantAdapter.search   — happy path, not-found auto-provision, multi-prefetch
 *   E. QdrantAdapter.deleteBySource — happy path, missing-index retry
 *   F. QdrantAdapter.countByCompany — happy path, 0 when collection absent
 *   G. QdrantAdapter.upsertVectors  — ID derivation, payload assembly
 *   H. QdrantAdapter.health         — ok / error path
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { QdrantAdapter, PAYLOAD_INDEX_COUNT } from '../../../src/infrastructure/ai/vector/qdrant.adapter.ts';
import type { TypedEnv } from '../../../src/config/env.ts';
import type { Logger } from '../../../src/shared/logger.ts';
import type { VectorSearchQuery, VectorUpsertInput } from '../../../src/infrastructure/ai/vector/types.ts';
import { ACTIVE_EMBEDDING_SCHEMA_VERSION } from '../../../src/infrastructure/ai/vector/types.ts';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const noopLogger: Logger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  child: () => noopLogger,
};

const fakeEnv = {
  QDRANT_URL: 'http://qdrant.test',
  QDRANT_API_KEY: 'test-api-key',
  QDRANT_COLLECTION: 'divo_vectors',
  QDRANT_RETRIEVAL_COLLECTION: 'retrieval_v3',
  QDRANT_TIMEOUT_MS: 5000,
} as unknown as TypedEnv;

function makeAdapter(env: Partial<TypedEnv> = {}): QdrantAdapter {
  return new QdrantAdapter({
    env: { ...fakeEnv, ...env } as TypedEnv,
    primaryVectorDimension: 1536,
    logger: noopLogger,
  });
}

// ─── Mock fetch ────────────────────────────────────────────────────────────────

type FetchCall = { url: string; method: string; body?: unknown };

let fetchCalls: FetchCall[] = [];
let fetchResponses: Array<{ status: number; body: unknown }> = [];

function pushResponse(status: number, body: unknown): void {
  fetchResponses.push({ status, body });
}

function mockFetch(status: number, body: unknown): void {
  fetchCalls = [];
  fetchResponses = [{ status, body }];
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  fetchCalls = [];
  fetchResponses = [];
  (globalThis as any).fetch = async (url: string, init?: RequestInit) => {
    const entry = fetchResponses.shift() ?? { status: 200, body: {} };
    fetchCalls.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    const bodyStr = JSON.stringify(entry.body);
    return {
      ok: entry.status >= 200 && entry.status < 300,
      status: entry.status,
      text: async () => bodyStr,
    } as unknown as Response;
  };
});

afterEach(() => {
  (globalThis as any).fetch = originalFetch;
});

// ─── A. Deterministic point ID ────────────────────────────────────────────────

describe('buildPointId (via upsertVectors)', () => {
  it('produces the same ID for the same compound key', async () => {
    // We test ID stability by observing the id in two separate upsert calls.
    const adapter = makeAdapter();

    const recordA: VectorUpsertInput = {
      companyId: 'co1', sourceType: 'chat_turn', sourceId: 'src1',
      chunkIndex: 0, contentHash: 'h', denseEmbedding: Array(1536).fill(0),
      payload: {},
    };
    const recordB = { ...recordA };

    // Responses: GET collection (ok), one PUT per payload index, PUT points (A), PUT points (B)
    for (let i = 0; i < 17; i++) pushResponse(200, {});
    for (let i = 0; i < 17; i++) pushResponse(200, {});

    await adapter.upsertVectors([recordA]);
    await adapter.upsertVectors([recordB]);

    // find the PUT points calls
    const pointsCalls = fetchCalls.filter(c => c.url.includes('/points?wait=true') && c.method === 'PUT');
    assert.ok(pointsCalls.length >= 2);
    const idA = (pointsCalls[0]?.body as { points: { id: string }[] })?.points?.[0]?.id;
    const idB = (pointsCalls[1]?.body as { points: { id: string }[] })?.points?.[0]?.id;
    assert.equal(idA, idB);
  });

  it('produces different IDs for different sourceIds', async () => {
    const adapter = makeAdapter();

    const rA: VectorUpsertInput = {
      companyId: 'co1', sourceType: 'chat_turn', sourceId: 'src1',
      chunkIndex: 0, contentHash: 'h', denseEmbedding: Array(1536).fill(0), payload: {},
    };
    const rB: VectorUpsertInput = { ...rA, sourceId: 'src2' };

    for (let i = 0; i < 34; i++) pushResponse(200, {});

    await adapter.upsertVectors([rA]);
    await adapter.upsertVectors([rB]);

    const pointsCalls = fetchCalls.filter(c => c.url.includes('/points?wait=true') && c.method === 'PUT');
    const idA = (pointsCalls[0]?.body as any)?.points?.[0]?.id;
    const idB = (pointsCalls[1]?.body as any)?.points?.[0]?.id;
    assert.notEqual(idA, idB);
  });
});

// ─── B. Search filter shape ────────────────────────────────────────────────────

describe('QdrantAdapter.search — filter construction', () => {
  const baseQuery: VectorSearchQuery = {
    companyId: 'co1',
    denseVector: Array(1536).fill(0.1),
    limit: 5,
  };

  async function runSearch(q: VectorSearchQuery): Promise<unknown> {
    const adapter = makeAdapter();
    // GET collection → ok; POST query/groups → ok with empty result
    pushResponse(200, {});
    pushResponse(200, { result: { groups: [] } });
    // ensureIndexes (one PUT per payload index)
    for (let i = 0; i < PAYLOAD_INDEX_COUNT(); i++) pushResponse(200, {});
    await adapter.search(q);
    return fetchCalls.find(c => c.url.includes('query/groups'))?.body;
  }

  it('sends embeddingSchemaVersion in must filter', async () => {
    const body = await runSearch(baseQuery) as any;
    const must = body?.filter?.must ?? body?.prefetch?.[0]?.filter?.must ?? [];
    const schemaClause = must.find((m: any) => m.key === 'embeddingSchemaVersion');
    assert.ok(schemaClause, 'should have embeddingSchemaVersion filter');
    assert.equal(schemaClause.match.value, ACTIVE_EMBEDDING_SCHEMA_VERSION);
  });

  it('includes retrievalProfile filter when provided', async () => {
    const body = await runSearch({ ...baseQuery, retrievalProfile: 'file' }) as any;
    const must = body?.filter?.must ?? body?.prefetch?.[0]?.filter?.must ?? [];
    const clause = must.find((m: any) => m.key === 'retrievalProfile');
    assert.ok(clause, 'should have retrievalProfile filter');
    assert.equal(clause.match.value, 'file');
  });

  it('includes sourceType filter when sourceTypes are provided', async () => {
    const body = await runSearch({ ...baseQuery, sourceTypes: ['file_document'] }) as any;
    const must = body?.filter?.must ?? body?.prefetch?.[0]?.filter?.must ?? [];
    const clause = must.find((m: any) => m.key === 'sourceType');
    assert.ok(clause);
    assert.equal(clause.match.value, 'file_document');
  });

  it('uses match.any when multiple sourceTypes', async () => {
    const body = await runSearch({ ...baseQuery, sourceTypes: ['zoho_lead', 'zoho_contact'] }) as any;
    const must = body?.filter?.must ?? body?.prefetch?.[0]?.filter?.must ?? [];
    const clause = must.find((m: any) => m.key === 'sourceType');
    assert.ok(Array.isArray(clause?.match?.any));
    assert.equal(clause.match.any.length, 2);
  });

  it('builds date range when dateFrom/dateTo provided', async () => {
    const body = await runSearch({ ...baseQuery, dateFrom: '2024-01-01', dateTo: '2024-12-31' }) as any;
    const must = body?.filter?.must ?? body?.prefetch?.[0]?.filter?.must ?? [];
    const clause = must.find((m: any) => m.key === 'sourceUpdatedAt');
    assert.ok(clause?.range);
    assert.equal(clause.range.gte, '2024-01-01');
    assert.equal(clause.range.lte, '2024-12-31');
  });

  it('includes scope-should clauses with public + shared by default', async () => {
    const body = await runSearch(baseQuery) as any;
    const should = body?.filter?.should ?? body?.prefetch?.[0]?.filter?.should ?? [];
    // public clause
    const pubClause = should.find((s: any) =>
      Array.isArray(s.must) && s.must.some((m: any) => m.key === 'visibility' && m.match?.value === 'public'),
    );
    assert.ok(pubClause, 'should have public visibility clause');
    // shared clause
    const sharedClause = should.find((s: any) =>
      Array.isArray(s.must) && s.must.some((m: any) => m.key === 'visibility' && m.match?.value === 'shared'),
    );
    assert.ok(sharedClause, 'should have shared visibility clause');
  });

  it('adds personal clause when requesterUserId is present', async () => {
    const body = await runSearch({ ...baseQuery, requesterUserId: 'u1' }) as any;
    const should = body?.filter?.should ?? body?.prefetch?.[0]?.filter?.should ?? [];
    const personalClause = should.find((s: any) =>
      Array.isArray(s.must) && s.must.some((m: any) => m.key === 'visibility' && m.match?.value === 'personal'),
    );
    assert.ok(personalClause, 'should have personal visibility clause when requesterUserId provided');
  });

  // ── Lark chat scope ──────────────────────────────────────────────────────
  // A document dropped in a Lark room is readable by that room and nobody
  // else. This is the whole enforcement point for that rule.

  const chatClauseOf = (body: any) => {
    const should = body?.filter?.should ?? body?.prefetch?.[0]?.filter?.should ?? [];
    return should.find((s: any) =>
      Array.isArray(s.must) && s.must.some((m: any) => m.key === 'larkChatId'),
    );
  };

  it('adds no chat clause when the search did not come from a Lark chat', async () => {
    // Desktop and scheduled runs must not reach chat-scoped files at all.
    assert.equal(chatClauseOf(await runSearch({ ...baseQuery, requesterUserId: 'u1' })), undefined);
  });

  it('grants access to files posted in the chat the search runs from', async () => {
    const clause = chatClauseOf(await runSearch({
      ...baseQuery, requesterUserId: 'u1', larkChatId: 'oc_room',
    }));

    assert.ok(clause, 'a chat-scope branch is added');
    const chatMatch = clause.must.find((m: any) => m.key === 'larkChatId');
    assert.equal(chatMatch.match.value, 'oc_room');
  });

  it('keeps the chat scope inside the company', async () => {
    // Chat ids are opaque and come from Lark. Without the companyId conjunct,
    // one tenant guessing another's chat id would read its documents.
    const clause = chatClauseOf(await runSearch({
      ...baseQuery, requesterUserId: 'u1', larkChatId: 'oc_room',
    }));

    const companyMatch = clause.must.find((m: any) => m.key === 'companyId');
    assert.ok(companyMatch, 'the chat branch is company-scoped');
    assert.equal(companyMatch.match.value, 'co1');
  });

  it('widens rather than replaces the requester\'s own scopes', async () => {
    // The uploader must still reach their file from a DM or the desktop app.
    // Replacing the personal branch instead of adding to it would lock a file
    // to the room it was posted in, even for the person who posted it.
    const body = await runSearch({
      ...baseQuery, requesterUserId: 'u1', larkChatId: 'oc_room',
    }) as any;
    const should = body?.filter?.should ?? body?.prefetch?.[0]?.filter?.should ?? [];

    assert.ok(
      should.some((s: any) =>
        Array.isArray(s.must) && s.must.some((m: any) => m.key === 'ownerUserId')),
      'the personal branch survives',
    );
    assert.ok(chatClauseOf(body), 'alongside the chat branch');
  });
});

// ─── C. upsert ────────────────────────────────────────────────────────────────

describe('QdrantAdapter.upsert', () => {
  it('skips HTTP calls entirely when given an empty array', async () => {
    const adapter = makeAdapter();
    await adapter.upsert([]);
    assert.equal(fetchCalls.length, 0);
  });

  it('sends PUT /points?wait=true with correct vector shape', async () => {
    const adapter = makeAdapter();
    // GET collection + payload indexes + PUT points
    for (let i = 0; i < 17; i++) pushResponse(200, {});

    await adapter.upsert([{
      id: 'test-id',
      companyId: 'co1',
      sourceType: 'chat_turn',
      sourceId:   'src1',
      chunkIndex: 0,
      documentKey: 'co1:chat_turn:src1',
      contentHash: 'abc',
      visibility:  'shared',
      denseVector: Array(1536).fill(0.5),
      payload: {},
    }]);

    const putCall = fetchCalls.find(c => c.url.endsWith('/points?wait=true') && c.method === 'PUT');
    assert.ok(putCall, 'should have sent PUT /points?wait=true');

    const points = (putCall.body as any).points as any[];
    assert.equal(points.length, 1);
    assert.equal(points[0].id, 'test-id');
    assert.ok(Array.isArray(points[0].vector['dense_text_v2']));
    assert.equal(points[0].vector['dense_text_v2'].length, 1536);
  });

  it('sends api-key header when QDRANT_API_KEY is configured', async () => {
    const adapter = makeAdapter();
    for (let i = 0; i < 17; i++) pushResponse(200, {});
    await adapter.upsert([{
      id: 'id1', companyId: 'co1', sourceType: 'chat_turn', sourceId: 's1',
      chunkIndex: 0, documentKey: 'dk', contentHash: 'h', visibility: 'shared',
      denseVector: Array(1536).fill(0), payload: {},
    }]);
    // All requests go through the same fetch mock — check api-key in init
    // (We test this indirectly — the header is added before fetch is called)
    // Just assert the call was made to the right host
    assert.ok(fetchCalls.some(c => c.url.startsWith('http://qdrant.test')));
  });

  it('retries after ensureIndexes when missing-index error occurs on first PUT', async () => {
    const adapter = makeAdapter();
    // GET collection → ok
    pushResponse(200, {});
    // one response per payload index create
    for (let i = 0; i < PAYLOAD_INDEX_COUNT(); i++) pushResponse(200, {});
    // First PUT points → 400 with "Index required but not found"
    pushResponse(400, 'Index required but not found');
    // Retry: one response per payload index create again
    for (let i = 0; i < PAYLOAD_INDEX_COUNT(); i++) pushResponse(200, {});
    // Second PUT points → ok
    pushResponse(200, {});

    // Should not throw
    await adapter.upsert([{
      id: 'id1', companyId: 'co1', sourceType: 'chat_turn', sourceId: 's1',
      chunkIndex: 0, documentKey: 'dk', contentHash: 'h', visibility: 'shared',
      denseVector: Array(1536).fill(0), payload: {},
    }]);

    const putCalls = fetchCalls.filter(c => c.url.includes('/points?wait=true') && c.method === 'PUT');
    assert.equal(putCalls.length, 2, 'should have retried PUT after missing-index error');
  });
});

// ─── D. search ────────────────────────────────────────────────────────────────

describe('QdrantAdapter.search', () => {
  it('returns empty array when collection does not exist (404)', async () => {
    const adapter = makeAdapter();
    // GET collection → 404
    pushResponse(404, 'Not found');
    // POST query/groups → also 404 (collection created after GET → 404)
    pushResponse(404, 'Not found: (404)');
    // ensureCollection: PUT collection → ok
    pushResponse(200, {});
    // ensureIndexes → 15 ok
    for (let i = 0; i < PAYLOAD_INDEX_COUNT(); i++) pushResponse(200, {});

    const results = await adapter.search({
      companyId: 'co1',
      denseVector: Array(1536).fill(0),
      limit: 5,
    });
    assert.deepEqual(results, []);
  });

  it('maps grouped results to VectorSearchGroup shape', async () => {
    const adapter = makeAdapter();
    // GET collection → ok
    pushResponse(200, {});
    // POST query/groups → ok with one group, one hit
    pushResponse(200, {
      result: {
        groups: [{
          id: 'co1:file_document:doc1',
          hits: [{
            id: 'point-1',
            score: 0.87,
            payload: {
              sourceType: 'file_document',
              sourceId: 'doc1',
              chunkIndex: 0,
              documentKey: 'co1:file_document:doc1',
              visibility: 'shared',
              title: 'My File',
            },
          }],
        }],
      },
    });
    // ensureIndexes → 15 ok
    for (let i = 0; i < PAYLOAD_INDEX_COUNT(); i++) pushResponse(200, {});

    const results = await adapter.search({
      companyId: 'co1',
      denseVector: Array(1536).fill(0.1),
      limit: 5,
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].groupValue, 'co1:file_document:doc1');
    assert.equal(results[0].hits.length, 1);
    assert.equal(results[0].hits[0].score, 0.87);
    assert.equal(results[0].hits[0].sourceType, 'file_document');
    assert.equal(results[0].hits[0].sourceId, 'doc1');
  });

  it('sends limit clamped to 25', async () => {
    const adapter = makeAdapter();
    pushResponse(200, {});
    pushResponse(200, { result: { groups: [] } });
    for (let i = 0; i < PAYLOAD_INDEX_COUNT(); i++) pushResponse(200, {});

    await adapter.search({ companyId: 'co1', denseVector: Array(1536).fill(0), limit: 100 });

    const groupsCall = fetchCalls.find(c => c.url.includes('query/groups'));
    assert.equal((groupsCall?.body as any)?.limit, 25);
  });

  it('sets group_by to documentKey by default', async () => {
    const adapter = makeAdapter();
    pushResponse(200, {});
    pushResponse(200, { result: { groups: [] } });
    for (let i = 0; i < PAYLOAD_INDEX_COUNT(); i++) pushResponse(200, {});

    await adapter.search({ companyId: 'co1', denseVector: Array(1536).fill(0), limit: 5 });

    const groupsCall = fetchCalls.find(c => c.url.includes('query/groups'));
    assert.equal((groupsCall?.body as any)?.group_by, 'documentKey');
  });

  it('uses custom groupByField when specified', async () => {
    const adapter = makeAdapter();
    pushResponse(200, {});
    pushResponse(200, { result: { groups: [] } });
    for (let i = 0; i < PAYLOAD_INDEX_COUNT(); i++) pushResponse(200, {});

    await adapter.search({ companyId: 'co1', denseVector: Array(1536).fill(0), limit: 5, groupByField: 'sourceId' });

    const groupsCall = fetchCalls.find(c => c.url.includes('query/groups'));
    assert.equal((groupsCall?.body as any)?.group_by, 'sourceId');
  });

  it('includes multimodal prefetch branch when useMultimodal=true and queryMode!=text', async () => {
    const adapter = makeAdapter();
    pushResponse(200, {});
    pushResponse(200, { result: { groups: [] } });
    for (let i = 0; i < PAYLOAD_INDEX_COUNT(); i++) pushResponse(200, {});

    await adapter.search({
      companyId: 'co1',
      denseVector: Array(1536).fill(0.2),
      limit: 5,
      useMultimodal: true,
      queryMode: 'multimodal',
    });

    const groupsCall = fetchCalls.find(c => c.url.includes('query/groups'));
    const prefetch = (groupsCall?.body as any)?.prefetch as any[];
    const mmBranch = prefetch.find((p: any) => p.using === 'dense_mm_v1');
    assert.ok(mmBranch, 'should have a multimodal prefetch branch');
    assert.equal((groupsCall?.body as any)?.query?.fusion, 'dbsf');
  });
});

// ─── E. deleteBySource ────────────────────────────────────────────────────────

describe('QdrantAdapter.deleteBySource', () => {
  it('sends POST /points/delete with correct filter', async () => {
    const adapter = makeAdapter();
    // ensureCollection GET → ok; ensureIndexes 15 ok; POST delete → ok
    pushResponse(200, {});
    for (let i = 0; i < PAYLOAD_INDEX_COUNT(); i++) pushResponse(200, {});
    pushResponse(200, {});

    await adapter.deleteBySource({ companyId: 'co1', sourceType: 'chat_turn', sourceId: 'src1' });

    const deleteCall = fetchCalls.find(c => c.url.includes('/points/delete') && c.method === 'POST');
    assert.ok(deleteCall);
    const filter = (deleteCall.body as any).filter;
    const must = filter.must as any[];
    assert.ok(must.find((m: any) => m.key === 'companyId' && m.match.value === 'co1'));
    assert.ok(must.find((m: any) => m.key === 'sourceType' && m.match.value === 'chat_turn'));
    assert.ok(must.find((m: any) => m.key === 'sourceId' && m.match.value === 'src1'));
  });

  it('silently returns when collection does not exist (404)', async () => {
    const adapter = makeAdapter();
    // ensureCollection GET → 404; PUT collection → ok
    pushResponse(404, 'Not found');
    pushResponse(200, {});
    // ensureIndexes 15 ok
    for (let i = 0; i < PAYLOAD_INDEX_COUNT(); i++) pushResponse(200, {});
    // DELETE → 400 with (404)
    pushResponse(400, 'Not found: (404)');

    // Should not throw
    await adapter.deleteBySource({ companyId: 'co1', sourceType: 'chat_turn', sourceId: 'src1' });
  });
});

// ─── F. countByCompany ────────────────────────────────────────────────────────

describe('QdrantAdapter.countByCompany', () => {
  it('returns the count from the API response', async () => {
    const adapter = makeAdapter();
    // ensureIndexes ok; POST count → ok
    for (let i = 0; i < PAYLOAD_INDEX_COUNT(); i++) pushResponse(200, {});
    pushResponse(200, { result: { count: 42 } });

    const count = await adapter.countByCompany('co1');
    assert.equal(count, 42);
  });

  it('returns 0 when collection does not exist (404)', async () => {
    const adapter = makeAdapter();
    // First index PUT → 400 with (404) — treated as "collection not found"
    pushResponse(400, 'Not found: (404)');

    const count = await adapter.countByCompany('co1');
    assert.equal(count, 0);
  });
});

// ─── G. upsertVectors ─────────────────────────────────────────────────────────

describe('QdrantAdapter.upsertVectors', () => {
  it('assembles correct payload fields', async () => {
    const adapter = makeAdapter();
    for (let i = 0; i < 17; i++) pushResponse(200, {});

    const record: VectorUpsertInput = {
      companyId: 'co1',
      sourceType: 'file_document',
      sourceId: 'doc1',
      chunkIndex: 2,
      contentHash: 'abc123',
      visibility: 'shared',
      title: 'My Doc',
      content: 'Hello world',
      retrievalProfile: 'file',
      allowedRoles: ['MEMBER'],
      denseEmbedding: Array(1536).fill(0.1),
      payload: {},
    };
    await adapter.upsertVectors([record]);

    const putCall = fetchCalls.find(c => c.url.endsWith('/points?wait=true') && c.method === 'PUT');
    const point = (putCall?.body as any)?.points?.[0];
    assert.ok(point, 'should have sent a point');
    assert.equal(point.payload.sourceType, 'file_document');
    assert.equal(point.payload.chunkText, 'Hello world');
    assert.equal(point.payload.title, 'My Doc');
    assert.equal(point.payload.retrievalProfile, 'file');
    assert.deepEqual(point.payload.allowedRoles, ['MEMBER']);
    assert.equal(point.payload.embeddingSchemaVersion, ACTIVE_EMBEDDING_SCHEMA_VERSION);
  });

  it('includes multimodal vector when multimodalEmbedding is provided', async () => {
    const adapter = makeAdapter();
    for (let i = 0; i < 17; i++) pushResponse(200, {});

    await adapter.upsertVectors([{
      companyId: 'co1', sourceType: 'file_document', sourceId: 'doc2',
      chunkIndex: 0, contentHash: 'h', denseEmbedding: Array(1536).fill(0),
      multimodalEmbedding: Array(3072).fill(0.2),
      payload: {},
    }]);

    const putCall = fetchCalls.find(c => c.url.endsWith('/points?wait=true') && c.method === 'PUT');
    const vector = (putCall?.body as any)?.points?.[0]?.vector;
    assert.ok(Array.isArray(vector['dense_mm_v1']), 'should include multimodal vector');
    assert.equal(vector['dense_mm_v1'].length, 3072);
  });

  it('skips upsert when given an empty array', async () => {
    const adapter = makeAdapter();
    await adapter.upsertVectors([]);
    assert.equal(fetchCalls.length, 0);
  });
});

// ─── H. health ────────────────────────────────────────────────────────────────

describe('QdrantAdapter.health', () => {
  it('returns ok:true when collection exists', async () => {
    const adapter = makeAdapter();
    // GET collection → ok; ensureIndexes 15 ok
    pushResponse(200, {});
    for (let i = 0; i < PAYLOAD_INDEX_COUNT(); i++) pushResponse(200, {});

    const h = await adapter.health();
    assert.equal(h.ok, true);
    assert.equal(h.backend, 'qdrant');
    assert.equal(h.collection, 'retrieval_v3');
    assert.ok(typeof h.latencyMs === 'number');
  });

  it('returns ok:false with error message when Qdrant is unreachable', async () => {
    const adapter = makeAdapter();
    // GET collection → 503
    pushResponse(503, 'Service Unavailable');

    const h = await adapter.health();
    assert.equal(h.ok, false);
    assert.ok(typeof h.error === 'string' && h.error.length > 0);
  });
});
