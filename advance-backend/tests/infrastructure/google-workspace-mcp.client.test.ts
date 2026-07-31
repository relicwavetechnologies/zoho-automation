import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertSafeGoogleWorkspaceMcpInput,
  unwrapGoogleWorkspaceMcpResult,
} from '../../src/infrastructure/google/google-workspace-mcp.client';

describe('GoogleWorkspaceMcpClient boundary', () => {
  it('preserves structured MCP results', () => {
    const value = { spreadsheetId: 'sheet-1', url: 'https://docs.google.com/spreadsheets/d/sheet-1' };
    assert.deepEqual(unwrapGoogleWorkspaceMcpResult({ structuredContent: value }), value);
  });

  it('parses a JSON text response without flattening it into an LLM envelope', () => {
    assert.deepEqual(
      unwrapGoogleWorkspaceMcpResult({ content: [{ type: 'text', text: '{"documentId":"doc-1"}' }] }),
      { documentId: 'doc-1' },
    );
  });

  it('blocks sidecar-local paths recursively', () => {
    assert.throws(
      () => assertSafeGoogleWorkspaceMcpInput({ attachments: [{ file_path: '/Users/me/.ssh/id_rsa' }] }),
      /base64 content or an HTTPS URL/,
    );
    assert.throws(
      () => assertSafeGoogleWorkspaceMcpInput({ image: { url: 'file:///etc/passwd' } }),
      /must not use a file:\/\/ URL/,
    );
    assert.throws(
      () => assertSafeGoogleWorkspaceMcpInput({ path: null }),
      /input\.path is not allowed/,
    );
  });

  it('allows base64 content and HTTPS sources', () => {
    assert.doesNotThrow(() => assertSafeGoogleWorkspaceMcpInput({
      attachments: [{ content: 'SGVsbG8=', url: 'https://files.example.com/report.pdf' }],
    }));
  });

  it('rejects caller-supplied identity fields at the Divo boundary', () => {
    assert.throws(
      () => assertSafeGoogleWorkspaceMcpInput({
        query: 'is:unread newer_than:14d',
        user_google_email: 'another-account@example.com',
      }),
      /identity is derived from the selected connection's OAuth bearer token/,
    );
  });
});
