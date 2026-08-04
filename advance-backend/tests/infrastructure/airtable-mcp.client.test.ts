import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AirtableMcpClient,
  compactAirtableMcpResult,
} from '../../src/infrastructure/airtable/airtable-mcp.client.ts';
import { AirtableMcpSchemaCatalog } from '../../src/infrastructure/airtable/airtable-mcp-schema.catalog.ts';

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

  it('retries a throttled response before returning the page', async () => {
    let attempts = 0;
    const client = new AirtableMcpClient(
      'secret-token',
      { describe: async () => null } as any,
      undefined,
      async () => {
        attempts += 1;
        if (attempts < 3) return new Response('', { status: 429, headers: { 'retry-after': '0' } });
        return new Response(JSON.stringify({ records: [] }), { status: 200 });
      },
    );

    assert.deepEqual(await client.listRecordsPage({ baseId: 'app1', tableId: 'tbl1' }), { records: [] });
    assert.equal(attempts, 3);
  });

  it('does not retry a terminal provider response', async () => {
    let attempts = 0;
    const client = new AirtableMcpClient(
      'secret-token',
      { describe: async () => null } as any,
      undefined,
      async () => {
        attempts += 1;
        return new Response('', { status: 401 });
      },
    );

    await assert.rejects(() => client.listRecordsPage({ baseId: 'app1', tableId: 'tbl1' }), /HTTP 401/);
    assert.equal(attempts, 1);
  });

  it('passes caller cancellation through to the Web API request', async () => {
    const controller = new AbortController();
    controller.abort(new Error('export cancelled'));
    const client = new AirtableMcpClient(
      'secret-token',
      { describe: async () => null } as any,
      undefined,
      async (_input, init) => {
        const signal = init?.signal as AbortSignal;
        assert.equal(signal.aborted, true);
        throw signal.reason;
      },
    );

    await assert.rejects(
      () => client.listRecordsPage({ baseId: 'app1', tableId: 'tbl1' }, controller.signal),
      /export cancelled/,
    );
  });
});

describe('AirtableMcpClient tool schema paging', () => {
  it('rejects a repeated MCP cursor and lets the schema catalog retry cleanly', async () => {
    const client = new AirtableMcpClient(
      'secret-token',
      new AirtableMcpSchemaCatalog(),
    );
    let calls = 0;
    (client as any).withClient = async (run: any) => run({
      listTools: async () => {
        calls += 1;
        if (calls <= 2) return { tools: [], nextCursor: 'same-cursor' };
        return { tools: [{ name: 'list_bases', inputSchema: { type: 'object' } }] };
      },
    });

    await assert.rejects(() => client.describeTool('list_bases'), /repeated a cursor/);
    assert.equal((await client.describeTool('list_bases'))?.name, 'list_bases');
    assert.equal(calls, 3);
  });

  it('bounds a non-terminating MCP tool list', async () => {
    const client = new AirtableMcpClient(
      'secret-token',
      new AirtableMcpSchemaCatalog(),
    );
    let calls = 0;
    (client as any).withClient = async (run: any) => run({
      listTools: async () => {
        calls += 1;
        return { tools: [], nextCursor: `cursor-${calls}` };
      },
    });

    await assert.rejects(() => client.describeTool('list_bases'), /exceeded 1000 pages/);
    assert.equal(calls, 1_000);
  });
});

describe('AirtableMcpClient model-facing base discovery', () => {
  it('bounds large base lists while preserving favorite bases and truthful counts', () => {
    const result = compactAirtableMcpResult('list_bases', {
      bases: [
        { id: 'app-favorite', name: 'Favorite', permissionLevel: 'create', isFavorite: true },
        ...Array.from({ length: 600 }, (_, index) => ({
          id: `app-${index}`,
          name: `Base ${index} ${'x'.repeat(80)}`,
          permissionLevel: 'create',
          isFavorite: false,
        })),
      ],
    }) as {
      bases: Array<{ id: string }>;
      divoBasePreview: {
        totalCount: number;
        returnedCount: number;
        omittedCount: number;
        truncated: boolean;
        favoritesComplete: boolean;
      };
    };

    assert.equal(result.divoBasePreview.totalCount, 601);
    assert.equal(result.divoBasePreview.truncated, true);
    assert.equal(result.divoBasePreview.returnedCount + result.divoBasePreview.omittedCount, 601);
    assert.equal(result.divoBasePreview.favoritesComplete, true);
    assert.ok(result.bases.some(base => base.id === 'app-favorite'));
    assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 24_000);
  });
});
