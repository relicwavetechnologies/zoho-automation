import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AirtableMcpClient,
  compactAirtableMcpResult,
} from '../../src/infrastructure/airtable/airtable-mcp.client.ts';
import { AirtableMcpSchemaCatalog } from '../../src/infrastructure/airtable/airtable-mcp-schema.catalog.ts';

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
