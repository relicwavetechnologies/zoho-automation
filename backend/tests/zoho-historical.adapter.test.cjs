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
        if (path.includes('/Leads') && path.includes('page=1')) {
          return {
            data: [{ id: 'c1', name: 'Alice' }],
            info: { more_records: false, count: 1 },
          };
        }

        if (path.includes('/Contacts') && path.includes('page=1')) {
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
  assert.equal(first.records[0].sourceType, 'zoho_lead');
  assert.ok(first.nextCursor);

  const second = await client.fetchHistoricalPage({
    companyId: 'cmp-1',
    pageSize: 50,
    cursor: first.nextCursor,
  });
  assert.equal(second.records[0].sourceType, 'zoho_contact');
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

test('ZohoDataClient uses company-scoped api base via resolveCredentials when available', async () => {
  const defaultClient = {
    requestJson: async () => {
      throw new Error('default client should not be used');
    },
  };

  const scopedCalls = [];
  const scopedClient = {
    requestJson: async ({ path }) => {
      scopedCalls.push(path);
      return { data: [{ id: 'c1' }], info: { more_records: false, count: 1 } };
    },
  };

  const client = new ZohoDataClient({
    httpClient: defaultClient,
    tokenService: {
      getValidAccessToken: async () => 'token-1',
      forceRefresh: async () => 'token-2',
      resolveCredentials: async () => ({
        clientId: 'client-id',
        clientSecret: 'client-secret',
        redirectUri: 'http://localhost/callback',
        httpClient: scopedClient,
      }),
    },
  });

  const result = await client.fetchHistoricalPage({
    companyId: 'cmp-1',
    pageSize: 1,
  });

  assert.equal(result.records.length, 1);
  assert.equal(scopedCalls.length, 1);
  assert.match(scopedCalls[0], /\/crm\/v2\/Leads\?page=1&per_page=1/);
});

test('ZohoDataClient.fetchUserScopedRecords filters by requester email exactly after normalization', async () => {
  const client = new ZohoDataClient({
    tokenService: {
      getValidAccessToken: async () => 'token-1',
      forceRefresh: async () => 'token-2',
    },
    httpClient: {
      requestJson: async ({ path, body }) => {
        if (path.startsWith('/crm/v8/settings/fields')) {
          return {
            fields: [
              { api_name: 'Email', data_type: 'email' },
            ],
          };
        }

        if (path === '/crm/v8/coql') {
          const query = String(body.select_query);
          assert.ok(
            query.includes("Email = 'scope-validation@example.invalid'")
            || query.includes("Email = 'owner@example.com'"),
          );
          if (query.includes("Email = 'scope-validation@example.invalid'")) {
            return { data: [] };
          }
          return {
            data: [{ id: 'c1' }, { id: 'c2' }],
          };
        }

        if (path.endsWith('/Contacts/c1')) {
          return {
            data: [{ id: 'c1', Email: ' Owner@example.com ' }],
          };
        }

        if (path.endsWith('/Contacts/c2')) {
          return {
            data: [{ id: 'c2', Email: 'someoneelse@example.com' }],
          };
        }

        throw new Error(`Unexpected path ${path}`);
      },
    },
  });

  const result = await client.fetchUserScopedRecords({
    companyId: 'cmp-1',
    sourceType: 'zoho_contact',
    requesterEmail: 'owner@example.com',
    limit: 5,
    maxPages: 1,
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].sourceId, 'c1');
});

test('ZohoDataClient.fetchUserScopedRecords fails closed when module has no safe email predicates', async () => {
  const client = new ZohoDataClient({
    tokenService: {
      getValidAccessToken: async () => 'token-1',
      forceRefresh: async () => 'token-2',
    },
    httpClient: {
      requestJson: async ({ path }) => {
        if (path.startsWith('/crm/v8/settings/fields')) {
          return {
            fields: [{ api_name: 'Stage', data_type: 'picklist' }],
          };
        }
        throw new Error(`Unexpected path ${path}`);
      },
    },
  });

  await assert.rejects(
    () =>
      client.fetchUserScopedRecords({
        companyId: 'cmp-1',
        sourceType: 'zoho_deal',
        requesterEmail: 'owner@example.com',
        limit: 5,
        maxPages: 1,
      }),
    (error) => error && error.code === 'schema_mismatch',
  );
});
