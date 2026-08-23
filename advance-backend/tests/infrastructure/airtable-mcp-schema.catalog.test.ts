import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AirtableMcpSchemaCatalog } from '../../src/infrastructure/airtable/airtable-mcp-schema.catalog.ts';
import { ok } from '../../src/shared/result.ts';
import type { ProviderSchemaArtifact } from '../../src/application/gateway/provider-schema-artifact-catalogue.ts';

describe('AirtableMcpSchemaCatalog', () => {
  it('single-flights and reuses approved schemas across callers', async () => {
    const catalog = new AirtableMcpSchemaCatalog();
    let loads = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const loader = async () => {
      loads += 1;
      await gate;
      return [
        { name: 'list_bases', inputSchema: { type: 'object' } },
        { name: 'unapproved_tool', inputSchema: { type: 'object' } },
      ];
    };

    const first = catalog.describe('list_bases', loader);
    const second = catalog.describe('list_bases', loader);
    release();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    const thirdResult = await catalog.describe('list_bases', loader);

    assert.equal(loads, 1);
    assert.equal(firstResult?.name, 'list_bases');
    assert.deepEqual(secondResult, firstResult);
    assert.deepEqual(thirdResult, firstResult);
    assert.equal(await catalog.describe('unapproved_tool', loader), null);
  });

  it('allows a clean retry after a failed schema load', async () => {
    const catalog = new AirtableMcpSchemaCatalog();
    let attempts = 0;
    const loader = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('MCP unavailable');
      return [{ name: 'list_bases', inputSchema: { type: 'object' } }];
    };

    await assert.rejects(() => catalog.describe('list_bases', loader), /MCP unavailable/);
    assert.equal((await catalog.describe('list_bases', loader))?.name, 'list_bases');
    assert.equal(attempts, 2);
  });

  it('removes credential and local-file fields before model use or durable publication', async () => {
    let published: ProviderSchemaArtifact | undefined;
    const catalog = new AirtableMcpSchemaCatalog({
      store: {
        readHead: async () => ok(null),
        publish: async artifact => { published = artifact; return ok(undefined); },
      },
    });
    const description = await catalog.describe('list_records_for_table', async () => [{
      name: 'list_records_for_table',
      description: 'List records. Send api-key. Prefer file-path for large inputs. Dispatch records normally.',
      inputSchema: {
        type: 'object',
        required: ['baseId', 'access_token', 'file_path', 'api-key', 'file-path', 'nested'],
        properties: {
          baseId: { type: 'string' },
          access_token: { type: 'string', description: 'Bearer access_token.' },
          file_path: { type: 'string' },
          'api-key': { type: 'string' },
          'file-path': { type: 'string' },
          nested: {
            type: 'object',
            required: ['apiKey', 'tableId'],
            properties: {
              apiKey: { type: 'string' },
              tableId: { type: 'string' },
            },
          },
        },
      },
    }]);

    const serialized = JSON.stringify(description);
    assert.doesNotMatch(serialized, /access_token|apiKey|api-key|file_path|file-path/);
    assert.match(serialized, /Dispatch records normally/);
    assert.match(description?.description ?? '', /backend-owned connection/);
    assert.deepEqual((description?.inputSchema as any).required, ['baseId', 'nested']);
    assert.deepEqual((description?.inputSchema as any).properties.nested.required, ['tableId']);
    assert.ok(published);
    assert.doesNotMatch(published.payload, /access_token|apiKey|api-key|file_path|file-path/);
  });
});
