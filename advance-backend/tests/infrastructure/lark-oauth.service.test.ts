import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { LARK_USER_OAUTH_SCOPES, LarkOAuthService } from '../../src/infrastructure/lark/lark-oauth.service';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe('LarkOAuthService', () => {
  it('builds the Lark OAuth URL with the canonical email/task/offline scopes', () => {
    const service = new LarkOAuthService('cli_test', 'secret', 'https://example.com/callback');
    const url = new URL(service.getAuthorizeUrl('state-1'));

    assert.equal(url.origin, 'https://accounts.larksuite.com');
    assert.equal(url.pathname, '/open-apis/authen/v1/authorize');
    assert.equal(url.searchParams.get('client_id'), 'cli_test');
    assert.equal(url.searchParams.get('redirect_uri'), 'https://example.com/callback');
    assert.equal(url.searchParams.get('state'), 'state-1');
    assert.equal(url.searchParams.get('scope'), LARK_USER_OAUTH_SCOPES.join(' '));
  });

  it('exchanges an authorization code with the OAuth token endpoint and enriches user info', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });

      if (String(url).endsWith('/open-apis/authen/v2/oauth/token')) {
        assert.deepEqual(JSON.parse(String(init?.body)), {
          grant_type:    'authorization_code',
          client_id:     'cli_test',
          client_secret: 'secret',
          code: 'auth-code',
          redirect_uri: 'https://example.com/callback',
        });
        return jsonResponse({
          code: '0',
          access_token: 'user-token',
          refresh_token: 'refresh-token',
          token_type: 'Bearer',
          expires_in: 6900,
          refresh_token_expires_in: 2592000,
          scope: LARK_USER_OAUTH_SCOPES.join(' '),
        });
      }
      if (String(url).endsWith('/open-apis/authen/v1/user_info')) {
        assert.equal(init?.headers?.['Authorization' as keyof HeadersInit], 'Bearer user-token');
        return jsonResponse({
          code: 0,
          data: {
            open_id: 'ou_123',
            user_id: 'u_123',
            name: 'Abhishek Verma',
            enterprise_email: 'vabhi.verma2678@gmail.com',
            en_name: 'Abhishek',
            tenant_key: 'tenant-1',
            avatar_url: 'https://example.com/avatar.png',
          },
        });
      }

      throw new Error(`unexpected fetch ${String(url)}`);
    }) as typeof fetch;

    const service = new LarkOAuthService('cli_test', 'secret', 'https://example.com/callback');

    const tokens = await service.exchangeCode('auth-code');

    assert.equal(tokens.accessToken, 'user-token');
    assert.equal(tokens.refreshToken, 'refresh-token');
    assert.equal(tokens.refreshTokenExpiresIn, 2592000);
    assert.equal(tokens.larkOpenId, 'ou_123');
    assert.equal(tokens.larkUserId, 'u_123');
    assert.equal(tokens.larkEmail, 'vabhi.verma2678@gmail.com');
    assert.equal(tokens.tenantKey, 'tenant-1');
    assert.equal(tokens.avatarUrl, 'https://example.com/avatar.png');
    assert.equal(tokens.scope, LARK_USER_OAUTH_SCOPES.join(' '));
    assert.equal(calls.length, 2);
  });

  it('refreshes user tokens with the OAuth token endpoint', async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(String(url));

      if (String(url).endsWith('/open-apis/authen/v2/oauth/token') && String(init?.body).includes('authorization_code')) {
        return jsonResponse({
          code: '0',
          access_token: 'user-token-1',
          refresh_token: 'refresh-token',
          expires_in: 6900,
        });
      }
      if (String(url).endsWith('/open-apis/authen/v2/oauth/token')) {
        assert.deepEqual(JSON.parse(String(init?.body)), {
          grant_type: 'refresh_token',
          client_id: 'cli_test',
          client_secret: 'secret',
          refresh_token: 'refresh-token',
        });
        return jsonResponse({
          code: '0',
          access_token: 'user-token-2',
          refresh_token: 'refresh-token-2',
          expires_in: 6900,
        });
      }
      if (String(url).endsWith('/open-apis/authen/v1/user_info')) {
        return jsonResponse({
          code: 0,
          data: {
            open_id: 'ou_123',
            user_id: 'u_123',
            name: 'Abhishek Verma',
            enterprise_email: 'vabhi.verma2678@gmail.com',
            tenant_key: 'tenant-1',
          },
        });
      }

      throw new Error(`unexpected fetch ${String(url)}`);
    }) as typeof fetch;

    const service = new LarkOAuthService('cli_test', 'secret', 'https://example.com/callback');

    await service.exchangeCode('auth-code');
    const refreshed = await service.refreshUserToken('refresh-token');

    assert.equal(refreshed.accessToken, 'user-token-2');
    assert.equal(
      urls.filter(url => url.endsWith('/open-apis/authen/v2/oauth/token')).length,
      2,
    );
  });
});
