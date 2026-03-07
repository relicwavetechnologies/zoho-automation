const assert = require('node:assert/strict');
const test = require('node:test');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/app';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
process.env.CORS_ALLOWED_ORIGINS = process.env.CORS_ALLOWED_ORIGINS || 'http://localhost:5173';
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const { SearchReadAgent } = require('../dist/company/agents/implementations/search-read.agent');

const baseInput = {
  taskId: 'task-search-1',
  agentKey: 'search-read',
  objective: 'search example.com pricing',
  constraints: ['v1'],
  contextPacket: {},
  correlationId: 'corr-search-1',
};

test('SearchReadAgent returns formatted search results with exact-site context', async () => {
  const agent = new SearchReadAgent({
    search: async (input) => ({
      query: input.query,
      exactDomain: input.exactDomain,
      focusedSiteSearch: true,
      items: [
        {
          title: 'Pricing',
          link: 'https://example.com/pricing',
          domain: 'example.com',
          snippet: 'Pricing overview',
          source: 'site',
          pageContext: {
            excerpt: 'Example pricing starts at $99 per month.',
            fetched: true,
          },
        },
      ],
      sourceRefs: [{ source: 'web', id: 'https://example.com/pricing' }],
    }),
  });

  const result = await agent.invoke(baseInput);
  assert.equal(result.status, 'success');
  assert.equal(result.result.exactDomain, 'example.com');
  assert.equal(result.result.focusedSiteSearch, true);
  assert.match(result.message, /exact-site pass on example\.com/i);
  assert.match(result.message, /Example pricing starts at \$99 per month\./);
});

test('SearchReadAgent returns empty-result success when search returns nothing', async () => {
  const agent = new SearchReadAgent({
    search: async (input) => ({
      query: input.query,
      exactDomain: input.exactDomain,
      focusedSiteSearch: false,
      items: [],
      sourceRefs: [],
    }),
  });

  const result = await agent.invoke({
    ...baseInput,
    objective: 'search obscure thing',
  });

  assert.equal(result.status, 'success');
  assert.equal(result.result.items.length, 0);
  assert.match(result.message, /No web results found/i);
});
