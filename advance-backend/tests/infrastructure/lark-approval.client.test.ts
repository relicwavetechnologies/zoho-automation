import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { LarkApprovalClient } from '../../src/infrastructure/channels/lark/clients/lark-approval.client.ts';
import { LarkApiError } from '../../src/infrastructure/channels/lark/clients/lark-http.client.ts';
import { TOKEN_RESPONSE, buildMockFetch, errorMock } from '../helpers/mock-fetch.ts';

const DEPS = { appId: 'app1', appSecret: 'secret1' };
const TOKEN_HANDLER = { match: (url: string) => url.includes('tenant_access_token'), response: TOKEN_RESPONSE };
const APPROVAL_CODE = 'approval-xyz-001';
const INSTANCE_CODE = 'instance-abc-123';

describe('LarkApprovalClient', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  // ── listInstances ──────────────────────────────────────────────────────────

  describe('listInstances', () => {
    it('GETs /approval/v4/instances with approval_code param', async () => {
      const { fetch, calls } = buildMockFetch([
        TOKEN_HANDLER,
        {
          match: (url, m) => m === 'GET' && url.includes('/approval/v4/instances'),
          response: {
            code: 0,
            data: {
              items: [
                { instance_code: 'inst-1', approval_code: APPROVAL_CODE, status: 'PENDING', title: 'Leave Request' },
                { instance_code: 'inst-2', approval_code: APPROVAL_CODE, status: 'APPROVED', title: 'Equipment' },
              ],
            },
          },
        },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkApprovalClient(DEPS);
      const items = await client.listInstances(APPROVAL_CODE) as Array<Record<string, unknown>>;

      assert.equal(items.length, 2);
      assert.equal(items[0]?.['instanceCode'], 'inst-1');
      assert.equal(items[0]?.['status'], 'PENDING');
      assert.equal(items[1]?.['instanceCode'], 'inst-2');
      assert.equal(items[1]?.['status'], 'APPROVED');

      const apiCall = calls.find(c => c.url.includes('/approval/v4/instances'));
      assert.ok(apiCall?.url.includes(`approval_code=${APPROVAL_CODE}`), 'should pass approval_code');
    });

    it('passes page_size param when limit is given', async () => {
      const { fetch, calls } = buildMockFetch([
        TOKEN_HANDLER,
        { match: () => true, response: { code: 0, data: { items: [] } } },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkApprovalClient(DEPS);
      await client.listInstances(APPROVAL_CODE, 5);

      const apiCall = calls.find(c => c.url.includes('/approval/v4/instances'));
      assert.ok(apiCall?.url.includes('page_size=5'), 'should pass page_size=5');
    });

    it('defaults to page_size=20 when no limit given', async () => {
      const { fetch, calls } = buildMockFetch([
        TOKEN_HANDLER,
        { match: () => true, response: { code: 0, data: { items: [] } } },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkApprovalClient(DEPS);
      await client.listInstances(APPROVAL_CODE);

      const apiCall = calls.find(c => c.url.includes('/approval/v4/instances'));
      assert.ok(apiCall?.url.includes('page_size=20'), 'should default to page_size=20');
    });

    it('returns empty array when no items', async () => {
      const { fetch } = buildMockFetch([
        TOKEN_HANDLER,
        { match: () => true, response: { code: 0, data: {} } },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkApprovalClient(DEPS);
      const items = await client.listInstances(APPROVAL_CODE);
      assert.deepEqual(items, []);
    });

    it('normalizes instance fields: uses title/reason/name as title fallback', async () => {
      const { fetch } = buildMockFetch([
        TOKEN_HANDLER,
        {
          match: () => true,
          response: {
            code: 0,
            data: {
              items: [
                { instance_code: 'i1', reason: 'Annual leave', status: 'PENDING' },
              ],
            },
          },
        },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkApprovalClient(DEPS);
      const items = await client.listInstances(APPROVAL_CODE) as Array<Record<string, unknown>>;
      assert.equal(items[0]?.['title'], 'Annual leave', 'should fall back to reason as title');
    });
  });

  // ── getInstance ────────────────────────────────────────────────────────────

  describe('getInstance', () => {
    it('GETs /approval/v4/instances/{instanceCode}', async () => {
      const { fetch, calls } = buildMockFetch([
        TOKEN_HANDLER,
        {
          match: (url, m) => m === 'GET' && url.includes(`/instances/${INSTANCE_CODE}`),
          response: {
            code: 0,
            data: {
              instance: {
                instance_code: INSTANCE_CODE,
                approval_code: APPROVAL_CODE,
                status: 'APPROVED',
                title: 'Travel Expense',
              },
            },
          },
        },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkApprovalClient(DEPS);
      const instance = await client.getInstance(APPROVAL_CODE, INSTANCE_CODE) as Record<string, unknown>;

      assert.equal(instance['instanceCode'], INSTANCE_CODE);
      assert.equal(instance['status'], 'APPROVED');
      assert.equal(instance['title'], 'Travel Expense');

      const apiCall = calls.find(c => c.url.includes('/instances/'));
      assert.ok(apiCall?.url.includes(INSTANCE_CODE), 'URL should include instanceCode');
    });

    it('URL-encodes instanceCode', async () => {
      const { fetch, calls } = buildMockFetch([
        TOKEN_HANDLER,
        {
          match: () => true,
          response: { code: 0, data: { instance: { instance_code: 'x' } } },
        },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkApprovalClient(DEPS);
      await client.getInstance(APPROVAL_CODE, 'inst/with/slashes');

      const apiCall = calls.find(c => c.url.includes('/approval/v4/instances'));
      assert.ok(apiCall?.url.includes('inst%2Fwith%2Fslashes'), 'should URL-encode instanceCode');
    });

    it('throws LarkApiError when instance not found', async () => {
      globalThis.fetch = errorMock('instance not found', 1390002);
      const client = new LarkApprovalClient(DEPS);
      await assert.rejects(() => client.getInstance(APPROVAL_CODE, 'missing'), LarkApiError);
    });
  });

  // ── createInstance ─────────────────────────────────────────────────────────

  describe('createInstance', () => {
    it('POSTs to /approval/v4/instances and returns instanceCode', async () => {
      const { fetch } = buildMockFetch([
        TOKEN_HANDLER,
        {
          match: (url, m) => m === 'POST' && url.includes('/approval/v4/instances'),
          response: { code: 0, data: { instance_code: 'new-instance-789' } },
        },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkApprovalClient(DEPS);
      const result = await client.createInstance(APPROVAL_CODE, { reason: 'Sick leave', days: 3 });

      assert.equal(result.instanceCode, 'new-instance-789');
    });

    it('sends approval_code in request body', async () => {
      const { fetch, calls } = buildMockFetch([
        TOKEN_HANDLER,
        {
          match: (url, m) => m === 'POST' && url.includes('/approval/v4/instances'),
          response: { code: 0, data: { instance_code: 'inst-1' } },
        },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkApprovalClient(DEPS);
      await client.createInstance(APPROVAL_CODE, { field1: 'value1' });

      const apiCall = calls.find(c => c.method === 'POST' && (c.url as string).includes('/approval/v4/instances'));
      const body = apiCall?.body as Record<string, unknown>;
      assert.equal(body?.['approval_code'], APPROVAL_CODE);
    });

    it('serializes formValues as JSON string in form field', async () => {
      const { fetch, calls } = buildMockFetch([
        TOKEN_HANDLER,
        {
          match: (url, m) => m === 'POST',
          response: { code: 0, data: { instance_code: 'i1' } },
        },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkApprovalClient(DEPS);
      await client.createInstance(APPROVAL_CODE, { reason: 'Annual leave', duration: '3 days' });

      const apiCall = calls.find(c => c.method === 'POST' && !c.url.includes('tenant_access_token'));
      const body = apiCall?.body as Record<string, unknown>;
      assert.equal(typeof body?.['form'], 'string', 'form field should be JSON string');

      const formParsed = JSON.parse(body['form'] as string) as Array<{ id: string; value: unknown }>;
      assert.ok(Array.isArray(formParsed), 'parsed form should be array');
      assert.ok(formParsed.some(f => f.id === 'reason' && f.value === 'Annual leave'));
      assert.ok(formParsed.some(f => f.id === 'duration' && f.value === '3 days'));
    });

    it('throws LarkApiError on API error', async () => {
      globalThis.fetch = errorMock('approval code not found', 1390001);
      const client = new LarkApprovalClient(DEPS);
      await assert.rejects(() => client.createInstance('bad-code', {}), LarkApiError);
    });
  });
});
