const assert = require('node:assert/strict');
const test = require('node:test');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost:5432/test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const { QdrantAdapter } = require('../dist/company/integrations/vector/qdrant.adapter');

const withFetch = async (impl, fn) => {
  const originalFetch = global.fetch;
  global.fetch = impl;
  try {
    await fn();
  } finally {
    global.fetch = originalFetch;
  }
};

test('resilience(qdrant): timeout is classified as vector_timeout', async () => {
  const adapter = new QdrantAdapter();

  await withFetch(async () => {
    const timeoutError = new Error('request timed out');
    timeoutError.name = 'TimeoutError';
    throw timeoutError;
  }, async () => {
    await assert.rejects(
      () =>
        adapter.search({
          companyId: 'cmp-res-1',
          vector: [0.1, 0.2, 0.3],
          limit: 3,
        }),
      (error) => {
        assert.equal(error.code, 'vector_timeout');
        return true;
      },
    );
  });
});

test('resilience(qdrant): service unavailable is classified as vector_unavailable', async () => {
  const adapter = new QdrantAdapter();

  await withFetch(async () => new Response('qdrant down', { status: 503 }), async () => {
    await assert.rejects(
      () =>
        adapter.search({
          companyId: 'cmp-res-1',
          vector: [0.1, 0.2, 0.3],
          limit: 3,
        }),
      (error) => {
        assert.equal(error.code, 'vector_unavailable');
        return true;
      },
    );
  });
});

test('resilience(qdrant): health endpoint degrades instead of throwing', async () => {
  const adapter = new QdrantAdapter();

  await withFetch(async () => {
    const networkError = new Error('connect ECONNREFUSED');
    networkError.code = 'ECONNREFUSED';
    throw networkError;
  }, async () => {
    const health = await adapter.health();
    assert.equal(health.ok, false);
    assert.equal(health.backend, 'qdrant');
    assert.ok(typeof health.error === 'string' && health.error.length > 0);
  });
});
