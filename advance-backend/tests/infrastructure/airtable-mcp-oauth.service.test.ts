import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AirtableMcpOAuthService } from '../../src/infrastructure/airtable/airtable-mcp-oauth.service.ts';

const logger: any = { info() {}, warn() {}, error() {}, debug() {}, child() { return logger; } };
const cache: any = {
  get: async () => ({ ok: true, value: null }),
  set: async () => ({ ok: true }),
  del: async () => ({ ok: true }),
};

const service = (overrides: Record<string, unknown> = {}) => new AirtableMcpOAuthService({
  env: { AIRTABLE_MCP_URL: 'https://mcp.airtable.com/mcp', ...overrides } as never,
  cache,
  logger,
});

describe('AirtableMcpOAuthService callback origin policy', () => {
  it('accepts a loopback HTTP callback so the desktop app can connect in development', () => {
    // The callback origin is derived from the request, which is plain HTTP on
    // localhost. Requiring HTTPS unconditionally made connecting impossible.
    const svc = service();
    for (const uri of [
      'http://localhost:8000/api/desktop/auth/airtable/callback',
      'http://127.0.0.1:8000/api/desktop/auth/airtable/callback',
      'http://[::1]:8000/api/desktop/auth/airtable/callback',
    ]) {
      assert.equal(svc.isConnectConfigured(uri), true, uri);
    }
  });

  it('still requires HTTPS for any origin that leaves the machine', () => {
    const svc = service();
    assert.equal(svc.isConnectConfigured('https://api.example.com/cb'), true);
    // The loopback carve-out must not become a blanket HTTP allowance.
    assert.equal(svc.isConnectConfigured('http://evil.example.com/cb'), false);
    assert.equal(svc.isConnectConfigured('http://localhost.evil.com/cb'), false);
    assert.equal(svc.isConnectConfigured('ftp://localhost/cb'), false);
    assert.equal(svc.isConnectConfigured('not-a-url'), false);
    assert.equal(svc.isConnectConfigured(undefined), false);
  });

  it('lets a configured redirect URI override the request-derived one', () => {
    const svc = service({ AIRTABLE_MCP_REDIRECT_URI: 'https://api.example.com/cb' });
    assert.equal(svc.resolveRedirectUri('http://localhost:8000/other'), 'https://api.example.com/cb');
  });

  it('keeps refresh working even when no callback origin is resolvable', () => {
    // isConfigured must stay independent of the redirect URI: refreshing an
    // existing connection never redirects, so a bad callback must not strand
    // live connections.
    assert.equal(service().isConfigured(), true);
    assert.equal(service({ AIRTABLE_MCP_URL: 'http://mcp.airtable.com/mcp' }).isConfigured(), false);
  });
});
