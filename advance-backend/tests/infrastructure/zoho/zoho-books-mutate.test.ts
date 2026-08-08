/**
 * The write path's fail-closed guarantee.
 *
 * ZohoBooksPaginatedClient.request() falls back to a company-level token when a
 * connection is missing, and that fallback never sees `minimumAccess`. If mutate()
 * ever accepted a write without a connection, the per-connection read_write check
 * would be skipped silently — so these assertions are the guard, not a formality.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ZohoBooksPaginatedClient } from '../../../src/infrastructure/zoho/zoho-books-paginated.client.ts';

function makeClient(capture: { auth?: any } = {}) {
  const tokenService = {
    getValidConnectionAuth: async (input: any) => {
      capture.auth = input;
      return { accessToken: 'connection-token', apiBaseUrl: 'https://www.zohoapis.com' };
    },
    getValidToken: async () => {
      throw new Error('company-level token must never be used for a write');
    },
  };
  return new ZohoBooksPaginatedClient(tokenService as any);
}

describe('ZohoBooksPaginatedClient.mutate', () => {
  it('refuses a write with no connection instead of borrowing the company token', async () => {
    const client = makeClient();
    await assert.rejects(
      client.mutate({
        companyId: 'co-1',
        userId: 'user-1',
        connectionId: '',
        method: 'POST',
        path: '/invoices',
        organizationId: 'org-1',
        body: { customer_id: '1' },
      }),
      /require an exact connection/,
    );
  });

  it('refuses a write with no acting member', async () => {
    const client = makeClient();
    await assert.rejects(
      client.mutate({
        companyId: 'co-1',
        userId: '',
        connectionId: 'conn-1',
        method: 'POST',
        path: '/invoices',
        organizationId: 'org-1',
        body: { customer_id: '1' },
      }),
      /require an exact connection/,
    );
  });

  it('asks for read_write access on every write', async () => {
    const capture: { auth?: any } = {};
    const client = makeClient(capture);
    const originalFetch = globalThis.fetch;
    const requests: any[] = [];
    globalThis.fetch = (async (url: any, init: any) => {
      requests.push({ url: String(url), init });
      return {
        ok: true,
        json: async () => ({ invoice: { invoice_id: 'inv-1' } }),
      };
    }) as any;

    try {
      const result = await client.mutate({
        companyId: 'co-1',
        userId: 'user-1',
        connectionId: 'conn-1',
        method: 'POST',
        path: '/invoices',
        organizationId: 'org-7',
        params: { ignore_auto_number_generation: 'true' },
        body: { customer_id: '1' },
      });

      assert.equal(capture.auth.minimumAccess, 'read_write');
      assert.equal(result.organizationId, 'org-7');
      assert.equal((result.payload as any).invoice.invoice_id, 'inv-1');
      assert.match(requests[0].url, /organization_id=org-7/);
      assert.match(requests[0].url, /ignore_auto_number_generation=true/);
      assert.equal(requests[0].init.method, 'POST');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('leaves Content-Type to fetch for a multipart upload so the boundary survives', async () => {
    const client = makeClient();
    const originalFetch = globalThis.fetch;
    const requests: any[] = [];
    globalThis.fetch = (async (url: any, init: any) => {
      requests.push({ url: String(url), init });
      return { ok: true, json: async () => ({}) };
    }) as any;

    try {
      await client.mutate({
        companyId: 'co-1',
        userId: 'user-1',
        connectionId: 'conn-1',
        method: 'POST',
        path: '/invoices/inv-1/attachment',
        organizationId: 'org-7',
        multipart: {
          field: 'attachment',
          fileName: 'acme.pdf',
          mimeType: 'application/pdf',
          content: Buffer.from('%PDF-1.4'),
        },
      });

      const headers = requests[0].init.headers;
      assert.equal(headers['Content-Type'], undefined);
      assert.equal(requests[0].init.body instanceof FormData, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
