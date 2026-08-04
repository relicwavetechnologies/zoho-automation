import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AirtableMcpSchemaCatalog } from '../../src/infrastructure/airtable/airtable-mcp-schema.catalog.ts';

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
});
