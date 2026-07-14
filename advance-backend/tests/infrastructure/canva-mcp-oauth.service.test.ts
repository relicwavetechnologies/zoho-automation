import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CanvaMcpOAuthService } from '../../src/infrastructure/canva/canva-mcp-oauth.service.ts';

describe('CanvaMcpOAuthService', () => {
  it('omits optional URL metadata until Divo can serve valid URLs', () => {
    const logger = { child: () => logger };
    const service = new CanvaMcpOAuthService({
      env: {
        BACKEND_PUBLIC_URL: 'https://divo.example.test',
        CANVA_MCP_URL: 'https://mcp.canva.com/mcp',
        CANVA_MCP_REDIRECT_URI: 'https://divo.example.test/api/desktop/auth/canva/callback',
      } as any,
      cache: {} as any,
      logger: logger as any,
    });

    const metadata = (service as any).clientMetadata();
    assert.equal('logo_uri' in metadata, false);
    assert.equal('tos_uri' in metadata, false);
    assert.deepEqual(metadata.redirect_uris, ['https://divo.example.test/api/desktop/auth/canva/callback']);
  });
});
