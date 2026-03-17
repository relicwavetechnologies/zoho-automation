const assert = require('node:assert/strict');
const test = require('node:test');

const {
  EmbeddingService,
} = require('../dist/company/integrations/embedding/embedding.service');
const {
  FallbackEmbeddingProvider,
} = require('../dist/company/integrations/embedding/embedding-provider');

test('FallbackEmbeddingProvider returns deterministic vectors with stable dimension', async () => {
  const provider = new FallbackEmbeddingProvider();
  const [v1, v2] = await provider.embedText(['hello', 'hello']);

  assert.equal(v1.length, provider.dimension);
  assert.deepEqual(v1, v2);
});

test('EmbeddingService batches inputs and preserves output ordering', async () => {
  const provider = {
    provider: 'fallback',
    dimension: 3,
    embedText: async (texts) => texts.map((text) => [text.length, text.length + 1, text.length + 2]),
  };

  const service = new EmbeddingService({
    provider,
    batchSize: 2,
  });

  const vectors = await service.embed(['a', 'bb', 'ccc']);
  assert.deepEqual(vectors, [
    [1, 2, 3],
    [2, 3, 4],
    [3, 4, 5],
  ]);
});

test('EmbeddingService throws when provider returns mismatched vector count', async () => {
  const provider = {
    provider: 'fallback',
    dimension: 2,
    embedText: async () => [[1, 2]],
  };

  const service = new EmbeddingService({
    provider,
    batchSize: 2,
  });

  await assert.rejects(() => service.embed(['one', 'two']));
});

test('EmbeddingService builds media summary embeddings through provider analyzeMedia', async () => {
  const provider = {
    provider: 'fallback',
    dimension: 3,
    embedText: async (texts) => texts.map((text) => [text.length, text.length + 1, text.length + 2]),
    analyzeMedia: async () => ({
      modality: 'image',
      summary: 'an indexed image summary',
      metadata: { mimeType: 'image/png' },
    }),
  };

  const service = new EmbeddingService({
    provider,
  });

  const result = await service.embedMediaSummary({
    mimeType: 'image/png',
    fileName: 'chart.png',
    buffer: Buffer.from('fake'),
  });

  assert.equal(result.modality, 'image');
  assert.equal(result.summary, 'an indexed image summary');
  assert.deepEqual(result.embedding, [22, 23, 24]);
});
