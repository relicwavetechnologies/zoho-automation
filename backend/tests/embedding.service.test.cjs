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
  const [v1, v2] = await provider.embed(['hello', 'hello']);

  assert.equal(v1.length, provider.dimension);
  assert.deepEqual(v1, v2);
});

test('EmbeddingService batches inputs and preserves output ordering', async () => {
  const provider = {
    provider: 'fallback',
    dimension: 3,
    embed: async (texts) => texts.map((text) => [text.length, text.length + 1, text.length + 2]),
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
    embed: async () => [[1, 2]],
  };

  const service = new EmbeddingService({
    provider,
    batchSize: 2,
  });

  await assert.rejects(() => service.embed(['one', 'two']));
});
