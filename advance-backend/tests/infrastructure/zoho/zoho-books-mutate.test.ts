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
  it('settles the token once and sends that one', async () => {
    // Resolving again inside the request would put a second lookup between
    // deciding to write and writing — and a failure there throws a plain error
    // that reads as "the write may have landed" when nothing was sent.
    let resolveCalls = 0;
    const tokenService = {
      getValidConnectionAuth: async () => {
        resolveCalls += 1;
        if (resolveCalls > 1) throw new Error('Zoho connection lookup failed');
        return { accessToken: 'settled-token', apiBaseUrl: 'https://www.zohoapis.com' };
      },
      getValidToken: async () => { throw new Error('company token must never be used for a write'); },
    };
    const client = new ZohoBooksPaginatedClient(tokenService as any);

    const originalFetch = globalThis.fetch;
    const sent: any[] = [];
    globalThis.fetch = (async (url: any, init: any) => {
      sent.push({ url: String(url), init });
      return { ok: true, json: async () => ({ invoice: { invoice_id: 'inv-1' } }) };
    }) as any;

    try {
      await client.mutate({
        companyId: 'co-1', userId: 'user-1', connectionId: 'conn-1',
        method: 'POST', path: '/invoices', organizationId: 'org-7',
        body: { customer_id: '1' },
      });
      assert.equal(resolveCalls, 1, 'the token must be resolved exactly once');
      assert.equal(sent[0].init.headers['Authorization'], 'Zoho-oauthtoken settled-token');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('refuses to write when the connection exposes no organisation', async () => {
    // resolveOrganizationId answers a failed lookup with the companyId, which is
    // harmless for a read and would dispatch a write at an organisation that
    // does not exist.
    const tokenService = {
      getValidConnectionAuth: async () => ({ accessToken: 'tok', apiBaseUrl: 'https://www.zohoapis.com' }),
      getValidToken: async () => { throw new Error('unused'); },
    };
    const client = new ZohoBooksPaginatedClient(tokenService as any);

    const originalFetch = globalThis.fetch;
    const paths: string[] = [];
    globalThis.fetch = (async (url: any) => {
      paths.push(String(url));
      return { ok: false, status: 503, statusText: 'Service Unavailable', text: async () => '' };
    }) as any;

    try {
      await assert.rejects(
        client.mutate({
          companyId: 'co-1', userId: 'user-1', connectionId: 'conn-1',
          method: 'POST', path: '/invoices', body: { customer_id: '1' },
        }),
        /no organisation/,
      );
      assert.equal(paths.some(path => path.includes('/invoices')), false, 'nothing may be posted');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

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
