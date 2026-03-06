const assert = require('node:assert/strict');
const test = require('node:test');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost:5432/test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const { ZohoHttpClient } = require('../dist/company/integrations/zoho/zoho-http.client');

const jsonResponse = (payload, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

test('resilience(zoho): 429 is retried with bounded attempts and then succeeds', async () => {
  let attempts = 0;
  const client = new ZohoHttpClient({
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) {
        return jsonResponse({ message: 'rate limited' }, 429);
      }
      return jsonResponse({ data: [{ id: '1' }] }, 200);
    },
    retry: {
      maxAttempts: 3,
      baseDelayMs: 0,
    },
  });

  const payload = await client.requestJson({
    base: 'api',
    path: '/crm/v2/Contacts?page=1&per_page=1',
    method: 'GET',
  });

  assert.equal(attempts, 2);
  assert.equal(Array.isArray(payload.data), true);
});

test('resilience(zoho): repeated 5xx returns classified error after retry exhaustion', async () => {
  let attempts = 0;
  const client = new ZohoHttpClient({
    fetchImpl: async () => {
      attempts += 1;
      return jsonResponse({ message: 'upstream unavailable' }, 503);
    },
    retry: {
      maxAttempts: 2,
      baseDelayMs: 0,
    },
  });

  await assert.rejects(
    () =>
      client.requestJson({
        base: 'api',
        path: '/crm/v2/Deals?page=1&per_page=1',
        method: 'GET',
      }),
    (error) => {
      assert.equal(error.name, 'ZohoIntegrationError');
      assert.equal(error.code, 'unknown');
      assert.equal(error.retriable, true);
      assert.equal(error.statusCode, 503);
      return true;
    },
  );

  assert.equal(attempts, 2);
});
