import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AirtableMcpClient } from '../../src/infrastructure/airtable/airtable-mcp.client.ts';

describe('AirtableMcpClient bulk record paging', () => {
  it('uses authenticated 100-row Web API pagination without exposing the bearer', async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const fetchFn = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({
        url,
        authorization: new Headers(init?.headers).get('authorization'),
      });
      return new Response(JSON.stringify({
        records: [{ id: 'rec1', fields: { Name: 'Order 1' } }],
        offset: 'itrNext/rec1',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const client = new AirtableMcpClient(
      'secret-token',
      { describe: async () => null } as any,
      undefined,
      fetchFn as typeof fetch,
    );

    const result = await client.listRecordsPage({
      baseId: 'app1',
      tableId: 'Orders / 2026',
      fieldIds: ['fldOrder', 'fldAmount'],
      offset: 'itrPrevious/rec0',
    });

    assert.deepEqual(result, {
      records: [{ id: 'rec1', fields: { Name: 'Order 1' } }],
      nextCursor: 'itrNext/rec1',
    });
    const requestUrl = new URL(requests[0]!.url);
    assert.equal(requestUrl.pathname, '/v0/app1/Orders%20%2F%202026');
    assert.equal(requestUrl.searchParams.get('pageSize'), '100');
    assert.equal(requestUrl.searchParams.get('offset'), 'itrPrevious/rec0');
    assert.deepEqual(requestUrl.searchParams.getAll('fields[]'), ['fldOrder', 'fldAmount']);
    assert.equal(requests[0]!.authorization, 'Bearer secret-token');
    assert.doesNotMatch(requests[0]!.url, /secret-token/);
  });
});
