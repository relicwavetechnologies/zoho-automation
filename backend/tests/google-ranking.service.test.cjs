const assert = require('node:assert/strict');
const test = require('node:test');

const withFetch = async (impl, fn) => {
  const originalFetch = global.fetch;
  global.fetch = impl;
  try {
    await fn();
  } finally {
    global.fetch = originalFetch;
  }
};

const loadService = () => {
  delete require.cache[require.resolve('../src/config/env.ts')];
  delete require.cache[require.resolve('../src/config/index.ts')];
  delete require.cache[
    require.resolve('../src/company/integrations/search/google-ranking.service.ts')
  ];
  return require('../src/company/integrations/search/google-ranking.service.ts')
    .GoogleRankingService;
};

test('GoogleRankingService falls back to input ordering when not configured', async () => {
  process.env.GOOGLE_CLOUD_PROJECT_ID = '';
  process.env.GOOGLE_RANKING_CONFIG = '';
  process.env.GOOGLE_CLOUD_ACCESS_TOKEN = '';
  const GoogleRankingService = loadService();
  const service = new GoogleRankingService();
  const ranked = await service.rerank(
    'pricing',
    [
      { id: 'a', content: 'First chunk', score: 0.9 },
      { id: 'b', content: 'Second chunk', score: 0.8 },
    ],
    1,
  );

  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].id, 'a');
});

test('GoogleRankingService maps API scores to reranked results', async () => {
  process.env.GOOGLE_CLOUD_PROJECT_ID = 'proj-1';
  process.env.GOOGLE_RANKING_CONFIG = 'default_ranking_config';
  process.env.GOOGLE_CLOUD_ACCESS_TOKEN = 'token-1';
  const GoogleRankingService = loadService();
  const service = new GoogleRankingService();

  await withFetch(
    async (url) => {
      if (String(url).includes(':rank')) {
        return new Response(
          JSON.stringify({
            records: [
              { id: 'b', score: 0.95 },
              { id: 'a', score: 0.6 },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error('unexpected fetch');
    },
    async () => {
      const ranked = await service.rerank(
        'pricing',
        [
          { id: 'a', content: 'First chunk', score: 0.3 },
          { id: 'b', content: 'Second chunk', score: 0.2 },
        ],
        2,
      );

      assert.deepEqual(
        ranked.map((item) => item.id),
        ['b', 'a'],
      );
      assert.equal(ranked[0].rerankScore, 0.95);
    },
  );

  process.env.GOOGLE_CLOUD_PROJECT_ID = '';
  process.env.GOOGLE_RANKING_CONFIG = '';
  process.env.GOOGLE_CLOUD_ACCESS_TOKEN = '';
});
