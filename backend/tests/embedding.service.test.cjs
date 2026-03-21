const assert = require('node:assert/strict');
const test = require('node:test');

const { EmbeddingService } = require('../src/company/integrations/embedding/embedding.service.ts');
const {
  FallbackEmbeddingProvider,
} = require('../src/company/integrations/embedding/embedding-provider.ts');

test('FallbackEmbeddingProvider returns deterministic vectors with stable dimension', async () => {
  const provider = new FallbackEmbeddingProvider();
  const [v1, v2] = await provider.embedDocuments([{ text: 'hello' }, { text: 'hello' }]);

  assert.equal(v1.length, provider.dimension);
  assert.deepEqual(v1, v2);
});

test('EmbeddingService batches inputs and preserves output ordering', async () => {
  const provider = {
    provider: 'fallback',
    dimension: 3,
    embedDocuments: async (texts) =>
      texts.map((text) => [text.text.length, text.text.length + 1, text.text.length + 2]),
    embedQueries: async (texts) =>
      texts.map((text) => [text.length, text.length + 1, text.length + 2]),
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
    embedDocuments: async () => [[1, 2]],
    embedQueries: async () => [[1, 2]],
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
    embedDocuments: async (texts) =>
      texts.map((text) => [text.text.length, text.text.length + 1, text.text.length + 2]),
    embedQueries: async (texts) =>
      texts.map((text) => [text.length, text.length + 1, text.length + 2]),
    embedMultimodalDocuments: async (texts) =>
      texts.map((text) => [text.text.length, text.text.length + 1, text.text.length + 2]),
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
  assert.deepEqual(result.embedding, [24, 25, 26]);
});

test('EmbeddingService routes query embeddings through embedQueries', async () => {
  let queryCalls = 0;
  const provider = {
    provider: 'fallback',
    dimension: 2,
    embedDocuments: async (texts) => texts.map(() => [1, 1]),
    embedQueries: async (texts) => {
      queryCalls += 1;
      return texts.map((text) => [text.length, 99]);
    },
  };

  const service = new EmbeddingService({ provider });
  const vector = await service.embedQuery('deals this week');

  assert.deepEqual(vector, [15, 99]);
  assert.equal(queryCalls, 1);
});
