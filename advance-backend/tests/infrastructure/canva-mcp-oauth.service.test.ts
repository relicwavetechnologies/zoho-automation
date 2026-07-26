import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CanvaMcpOAuthService } from '../../src/infrastructure/canva/canva-mcp-oauth.service.ts';

const CONFIGURED_REDIRECT = 'https://divo.example.test/api/desktop/auth/canva/callback';

function createService(env: Record<string, string | undefined>) {
  const logger = { child: () => logger };
  return new CanvaMcpOAuthService({
    env: { CANVA_MCP_URL: 'https://mcp.canva.com/mcp', ...env } as any,
    cache: {} as any,
    logger: logger as any,
  });
}

describe('CanvaMcpOAuthService', () => {
  it('omits optional URL metadata until Divo can serve valid URLs', () => {
    const service = createService({ CANVA_MCP_REDIRECT_URI: CONFIGURED_REDIRECT });

    const metadata = (service as any).clientMetadata(service.resolveRedirectUri());
    assert.equal('logo_uri' in metadata, false);
    assert.equal('tos_uri' in metadata, false);
    assert.deepEqual(metadata.redirect_uris, [CONFIGURED_REDIRECT]);
  });

  it('registers the caller-supplied callback when no override is configured', () => {
    const service = createService({});
    const fromRequest = 'https://app-dev.example.test/api/desktop/auth/canva/callback';

    assert.equal(service.resolveRedirectUri(fromRequest), fromRequest);
    assert.deepEqual((service as any).clientMetadata(fromRequest).redirect_uris, [fromRequest]);
  });

  it('lets an explicit override win over the caller-supplied callback', () => {
    const service = createService({ CANVA_MCP_REDIRECT_URI: CONFIGURED_REDIRECT });

    assert.equal(service.resolveRedirectUri('https://other.example.test/cb'), CONFIGURED_REDIRECT);
  });

  it('stays usable for token refresh even when no callback can be resolved', () => {
    // Refresh never redirects, so a connect-time callback problem must not
    // strand connections that are already live.
    const service = createService({});

    assert.equal(service.isConfigured(), true);
    assert.equal(service.isConnectConfigured(undefined), false);
    assert.equal(service.isConnectConfigured('http://localhost:8000/cb'), false);
    assert.equal(service.isConnectConfigured('https://app.example.test/cb'), true);
  });
});
