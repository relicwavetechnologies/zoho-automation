import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GoogleWorkspaceMcpSchemaCatalog } from '../../src/infrastructure/google/google-workspace-mcp-schema.catalog';

describe('GoogleWorkspaceMcpSchemaCatalog', () => {
  it('single-flights and reuses reviewed schemas across connections', async () => {
    const catalog = new GoogleWorkspaceMcpSchemaCatalog();
    let loads = 0;
    const loader = async () => {
      loads += 1;
      await Promise.resolve();
      return [
        { name: 'search_gmail_messages', inputSchema: { type: 'object' } },
        { name: 'start_google_auth', inputSchema: { type: 'object' } },
      ];
    };

    const [first, second] = await Promise.all([
      catalog.describe('search_gmail_messages', loader),
      catalog.describe('search_gmail_messages', loader),
    ]);
    const third = await catalog.describe('search_gmail_messages', loader);

    assert.equal(loads, 1);
    assert.equal(first?.name, 'search_gmail_messages');
    assert.deepEqual(second, first);
    assert.deepEqual(third, first);
    assert.equal(await catalog.describe('start_google_auth', loader), null);
  });

  it('allows a clean retry after an initial sidecar failure', async () => {
    const catalog = new GoogleWorkspaceMcpSchemaCatalog();
    let attempts = 0;
    const loader = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('sidecar unavailable');
      return [{ name: 'create_spreadsheet', inputSchema: { type: 'object' } }];
    };

    await assert.rejects(() => catalog.describe('create_spreadsheet', loader), /sidecar unavailable/);
    assert.equal((await catalog.describe('create_spreadsheet', loader))?.name, 'create_spreadsheet');
    assert.equal(attempts, 2);
  });

  it('removes identity and local-file fields from both schema and guidance', async () => {
    const catalog = new GoogleWorkspaceMcpSchemaCatalog();
    const description = await catalog.describe('import_to_google_sheets', async () => [{
      name: 'import_to_google_sheets',
      description: 'Import content. For batch operations prefer file_path. Send user_google_email.',
      inputSchema: {
        type: 'object',
        required: ['file_path', 'user_google_email', 'content'],
        properties: {
          file_path: { type: 'string', description: 'A local file_path.' },
          user_google_email: { type: 'string' },
          content: { type: 'string' },
          nested: {
            type: 'object',
            required: ['path', 'url'],
            properties: { path: { type: 'string' }, url: { type: 'string' } },
          },
        },
      },
    }]);

    const serialized = JSON.stringify(description);
    assert.doesNotMatch(serialized, /file_path|user_google_email|"path"/);
    assert.match(description?.description ?? '', /inline\/base64 content or an HTTPS URL/);
    assert.deepEqual((description?.inputSchema as any).required, ['content']);
    assert.deepEqual((description?.inputSchema as any).properties.nested.required, ['url']);
  });
});
