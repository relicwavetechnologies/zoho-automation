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
  });

  it('allows base64 content and HTTPS sources', () => {
    assert.doesNotThrow(() => assertSafeGoogleWorkspaceMcpInput({
      attachments: [{ content: 'SGVsbG8=', url: 'https://files.example.com/report.pdf' }],
    }));
  });
});
