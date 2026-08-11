import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ZohoBooksPaginatedClient } from '../../../src/infrastructure/zoho/zoho-books-paginated.client';
import { ZohoCrmPaginatedClient } from '../../../src/infrastructure/zoho/zoho-crm-paginated.client';
import type { ZohoTokenService } from '../../../src/infrastructure/zoho/zoho-token.service';

function regionalTokenService(): ZohoTokenService {
  return {
    async getValidConnectionAuth(input: { connectionId: string }) {
      const india = input.connectionId === 'india';
      return {
        accessToken: india ? 'in-token' : 'com-token',
        accountsBaseUrl: india ? 'https://accounts.zoho.in' : 'https://accounts.zoho.com',
        apiBaseUrl: india ? 'https://www.zohoapis.in' : 'https://www.zohoapis.com',
      };
    },
    async getValidToken() {
      return 'legacy-token';
    },
  } as unknown as ZohoTokenService;
}

describe('Zoho per-connection regional routing', () => {
  it('routes Books requests using the selected connection data centre', async () => {
    const seen: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ organizations: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    try {
      const client = new ZohoBooksPaginatedClient(regionalTokenService());
      await client.listOrganizations('company-1', { userId: 'user-1', connectionId: 'india' });
      await client.listOrganizations('company-1', { userId: 'user-1', connectionId: 'global' });

      assert.match(seen[0]!, /^https:\/\/www\.zohoapis\.in\/books\/v3\/organizations/);
      assert.match(seen[1]!, /^https:\/\/www\.zohoapis\.com\/books\/v3\/organizations/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('routes CRM requests using the selected connection data centre', async () => {
    const seen: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      seen.push(String(url));
      return new Response(null, { status: 204 });
    };

    try {
      const client = new ZohoCrmPaginatedClient(regionalTokenService());
      await client.listRecords({
        companyId: 'company-1', userId: 'user-1', connectionId: 'india', module: 'Deals', page: 1,
      });
      await client.listRecords({
        companyId: 'company-1', userId: 'user-1', connectionId: 'global', module: 'Deals', pageToken: 'next-token',
      });

      assert.match(seen[0]!, /^https:\/\/www\.zohoapis\.in\/crm\/v6\/Deals/);
      assert.match(seen[1]!, /^https:\/\/www\.zohoapis\.com\/crm\/v6\/Deals/);
      assert.match(seen[1]!, /page_token=next-token/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('uses Zoho native word search with caller-owned pagination', async () => {
    const seen: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      seen.push(String(url));
      return new Response(JSON.stringify({
        data: [{ id: 'deal-401', Deal_Name: 'North renewal' }],
        info: { page: 3, per_page: 200, more_records: true },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    try {
      const client = new ZohoCrmPaginatedClient(regionalTokenService());
      const result = await client.searchByText({
        companyId: 'company-1',
        userId: 'user-1',
        connectionId: 'india',
        module: 'Deals',
        query: 'North renewal',
        page: 3,
        perPage: 200,
      });

      const url = new URL(seen[0]!);
      assert.equal(url.origin, 'https://www.zohoapis.in');
      assert.equal(url.pathname, '/crm/v6/Deals/search');
      assert.equal(url.searchParams.get('word'), 'North renewal');
      assert.equal(url.searchParams.get('page'), '3');
      assert.equal(url.searchParams.get('per_page'), '200');
      assert.equal(result.page, 3);
      assert.equal(result.hasMore, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not turn a Zoho search failure into an empty result', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('expired', { status: 401 });

    try {
      const client = new ZohoCrmPaginatedClient(regionalTokenService());
      await assert.rejects(
        client.searchByText({
          companyId: 'company-1',
          userId: 'user-1',
          connectionId: 'india',
          module: 'Deals',
          query: 'North renewal',
        }),
        /Zoho CRM 401/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
