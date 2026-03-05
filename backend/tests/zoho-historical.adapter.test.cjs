const assert = require('node:assert/strict');
const test = require('node:test');

const { ZohoDataClient } = require('../dist/company/integrations/zoho/zoho-data.client');
const { ZohoIntegrationError } = require('../dist/company/integrations/zoho/zoho.errors');

test('ZohoDataClient.fetchHistoricalPage paginates module pages then advances modules', async () => {
  const calls = [];
  const client = new ZohoDataClient({
    tokenService: {
      getValidAccessToken: async () => 'token-1',
      forceRefresh: async () => 'token-2',
    },
    httpClient: {
      requestJson: async ({ path }) => {
        calls.push(path);
        if (path.includes('/Contacts') && path.includes('page=1')) {
          return {
            data: [{ id: 'c1', name: 'Alice' }],
            info: { more_records: false, count: 1 },
          };
        }

        if (path.includes('/Deals') && path.includes('page=1')) {
          return {
            data: [{ id: 'd1', deal_name: 'Deal A' }],
            info: { more_records: false, count: 1 },
          };
        }

        return {
          data: [],
          info: { more_records: false, count: 0 },
        };
      },
    },
  });

  const first = await client.fetchHistoricalPage({
    companyId: 'cmp-1',
    pageSize: 50,
  });
  assert.equal(first.records[0].sourceType, 'zoho_contact');
  assert.ok(first.nextCursor);

  const second = await client.fetchHistoricalPage({
    companyId: 'cmp-1',
    pageSize: 50,
    cursor: first.nextCursor,
  });
  assert.equal(second.records[0].sourceType, 'zoho_deal');
  assert.ok(second.nextCursor);
  assert.equal(calls.length, 2);
});

test('ZohoDataClient retries once after auth_failed by forcing token refresh', async () => {
  let callCount = 0;
  let refreshed = false;

  const client = new ZohoDataClient({
    tokenService: {
      getValidAccessToken: async () => 'stale-token',
      forceRefresh: async () => {
        refreshed = true;
        return 'fresh-token';
      },
    },
    httpClient: {
      requestJson: async ({ headers }) => {
        callCount += 1;
        if (callCount === 1) {
          throw new ZohoIntegrationError({
            message: 'Unauthorized',
            code: 'auth_failed',
            retriable: false,
          });
        }

        assert.equal(headers.Authorization, 'Zoho-oauthtoken fresh-token');
        return { data: [{ id: 'c1' }], info: { more_records: false } };
      },
    },
  });

  const result = await client.fetchHistoricalPage({
    companyId: 'cmp-1',
    pageSize: 1,
  });

  assert.equal(refreshed, true);
  assert.equal(result.records.length, 1);
  assert.equal(callCount, 2);
});
