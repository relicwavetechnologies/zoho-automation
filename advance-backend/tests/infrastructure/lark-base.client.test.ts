import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { LarkBaseClient } from '../../src/infrastructure/channels/lark/clients/lark-base.client.ts';
import { LarkApiError } from '../../src/infrastructure/channels/lark/clients/lark-http.client.ts';
import { TOKEN_RESPONSE, buildMockFetch, errorMock } from '../helpers/mock-fetch.ts';

const DEPS = { appId: 'app1', appSecret: 'secret1' };
const TOKEN_HANDLER = { match: (url: string) => url.includes('tenant_access_token'), response: TOKEN_RESPONSE };
const APP_TOKEN = 'bascABC123';
const TABLE_ID = 'tblDEF456';

const BASE_PATH = `/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/records`;

describe('LarkBaseClient', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  // ── listRecords ───────────────────────────────────────────────────────────

  describe('listRecords', () => {
    it('GETs records from the bitable API', async () => {
      const { fetch } = buildMockFetch([
        TOKEN_HANDLER,
        {
          match: (url, m) => m === 'GET' && url.includes(BASE_PATH) && !url.includes('/records/'),
          response: {
            code: 0,
            data: {
              items: [
                { record_id: 'r1', fields: { Name: 'Alice', Score: 95 } },
                { record_id: 'r2', fields: { Name: 'Bob', Score: 87 } },
              ],
            },
          },
        },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkBaseClient(DEPS);
      const records = await client.listRecords(APP_TOKEN, TABLE_ID) as unknown[];
      assert.equal(records.length, 2);
    });

    it('passes page_size query param', async () => {
      const { fetch, calls } = buildMockFetch([
        TOKEN_HANDLER,
        { match: () => true, response: { code: 0, data: { items: [] } } },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkBaseClient(DEPS);
      await client.listRecords(APP_TOKEN, TABLE_ID, 25);

      const apiCall = calls.find(c => c.url.includes('page_size=25'));
      assert.ok(apiCall, 'should pass page_size param');
    });

    it('returns empty array when no items', async () => {
      const { fetch } = buildMockFetch([
        TOKEN_HANDLER,
        { match: () => true, response: { code: 0, data: {} } },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkBaseClient(DEPS);
      const records = await client.listRecords(APP_TOKEN, TABLE_ID);
      assert.deepEqual(records, []);
    });
  });

  // ── getRecord ─────────────────────────────────────────────────────────────

  describe('getRecord', () => {
    it('GETs a specific record by id', async () => {
      const { fetch } = buildMockFetch([
        TOKEN_HANDLER,
        {
          match: (url, m) => m === 'GET' && url.includes('/records/rec-1'),
          response: {
            code: 0,
            data: { record: { record_id: 'rec-1', fields: { Name: 'Charlie', Status: 'Active' } } },
          },
        },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkBaseClient(DEPS);
      const record = await client.getRecord(APP_TOKEN, TABLE_ID, 'rec-1') as Record<string, unknown>;
      assert.equal(record['record_id'], 'rec-1');
    });

    it('throws LarkApiError when record not found', async () => {
      globalThis.fetch = errorMock('record not found', 1254700);
      const client = new LarkBaseClient(DEPS);
      await assert.rejects(() => client.getRecord(APP_TOKEN, TABLE_ID, 'missing'), LarkApiError);
    });
  });

  // ── createRecord ──────────────────────────────────────────────────────────

  describe('createRecord', () => {
    it('POSTs and returns recordId', async () => {
      const { fetch } = buildMockFetch([
        TOKEN_HANDLER,
        {
          match: (url, m) => m === 'POST' && url.includes(BASE_PATH),
          response: { code: 0, data: { record: { record_id: 'rec-new', fields: { Name: 'Dave' } } } },
        },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkBaseClient(DEPS);
      const result = await client.createRecord(APP_TOKEN, TABLE_ID, { Name: 'Dave', Score: 100 });
      assert.equal(result.recordId, 'rec-new');
    });

    it('sends fields in the request body', async () => {
      const { fetch, calls } = buildMockFetch([
        TOKEN_HANDLER,
        {
          match: (url, m) => m === 'POST',
          response: { code: 0, data: { record: { record_id: 'rec1' } } },
        },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkBaseClient(DEPS);
      await client.createRecord(APP_TOKEN, TABLE_ID, { Project: 'Alpha', Priority: 'High' });

      const apiCall = calls.find(c => c.method === 'POST' && !c.url.includes('tenant_access_token'));
      const body = apiCall?.body as Record<string, unknown>;
      const fields = body?.['fields'] as Record<string, unknown>;
      assert.equal(fields?.['Project'], 'Alpha');
      assert.equal(fields?.['Priority'], 'High');
    });
  });

  // ── updateRecord ──────────────────────────────────────────────────────────

  describe('updateRecord', () => {
    it('PUTs to /records/{id} with fields', async () => {
      const { fetch, calls } = buildMockFetch([
        TOKEN_HANDLER,
        { match: (url, m) => m === 'PUT', response: { code: 0, data: { record: { record_id: 'rec-u' } } } },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkBaseClient(DEPS);
      await client.updateRecord(APP_TOKEN, TABLE_ID, 'rec-u', { Status: 'Done' });

      const apiCall = calls.find(c => c.method === 'PUT');
      assert.ok(apiCall?.url.includes('rec-u'));
      const body = apiCall?.body as Record<string, unknown>;
      const fields = body?.['fields'] as Record<string, unknown>;
      assert.equal(fields?.['Status'], 'Done');
    });
  });

  // ── deleteRecord ──────────────────────────────────────────────────────────

  describe('deleteRecord', () => {
    it('sends DELETE to /records/{id}', async () => {
      const { fetch, calls } = buildMockFetch([
        TOKEN_HANDLER,
        { match: (url, m) => m === 'DELETE', response: { code: 0, data: {} } },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkBaseClient(DEPS);
      await client.deleteRecord(APP_TOKEN, TABLE_ID, 'rec-del');

      const apiCall = calls.find(c => c.method === 'DELETE');
      assert.ok(apiCall?.url.includes('rec-del'));
    });

    it('throws on API error', async () => {
      globalThis.fetch = errorMock('record not found', 1254700);
      const client = new LarkBaseClient(DEPS);
      await assert.rejects(() => client.deleteRecord(APP_TOKEN, TABLE_ID, 'gone'), LarkApiError);
    });
  });

  // ── searchRecords ─────────────────────────────────────────────────────────

  describe('searchRecords', () => {
    it('POSTs to /records/search with filter body', async () => {
      const { fetch, calls } = buildMockFetch([
        TOKEN_HANDLER,
        {
          match: (url, m) => m === 'POST' && url.includes('/search'),
          response: {
            code: 0,
            data: { items: [{ record_id: 'r1', fields: { Name: 'Match' } }] },
          },
        },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkBaseClient(DEPS);
      const results = await client.searchRecords(APP_TOKEN, TABLE_ID, 'Match', 10) as unknown[];

      assert.equal(results.length, 1);
      const apiCall = calls.find(c => c.method === 'POST' && c.url.includes('/search'));
      assert.ok(apiCall, 'should POST to /search');
    });

    it('passes limit in query', async () => {
      const { fetch, calls } = buildMockFetch([
        TOKEN_HANDLER,
        { match: (url, m) => m === 'POST' && url.includes('/search'), response: { code: 0, data: { items: [] } } },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkBaseClient(DEPS);
      await client.searchRecords(APP_TOKEN, TABLE_ID, 'term', 5);

      const apiCall = calls.find(c => c.method === 'POST' && c.url.includes('/search'));
      assert.ok(apiCall?.url.includes('page_size=5'));
    });

    it('returns empty array when no results', async () => {
      const { fetch } = buildMockFetch([
        TOKEN_HANDLER,
        { match: () => true, response: { code: 0, data: {} } },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkBaseClient(DEPS);
      const results = await client.searchRecords(APP_TOKEN, TABLE_ID, 'nothing');
      assert.deepEqual(results, []);
    });
  });
});
