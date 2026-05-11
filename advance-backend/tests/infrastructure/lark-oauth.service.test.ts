import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { LarkOAuthService } from '../../src/infrastructure/lark/lark-oauth.service';

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
  it('exchanges an authorization code using a Bearer app access token and enriches user info', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });

      if (String(url).endsWith('/open-apis/auth/v3/app_access_token/internal')) {
        return jsonResponse({ code: 0, app_access_token: 'app-token', expire: 7200 });
      }
      if (String(url).endsWith('/open-apis/authen/v1/oidc/access_token')) {
        assert.equal(init?.headers?.['Authorization' as keyof HeadersInit], 'Bearer app-token');
        assert.deepEqual(JSON.parse(String(init?.body)), {
          grant_type: 'authorization_code',
          code: 'auth-code',
        });
        return jsonResponse({
          code: 0,
          data: {
            access_token: 'user-token',
            refresh_token: 'refresh-token',
            token_type: 'Bearer',
            expires_in: 6900,
            refresh_expires_in: 2592000,
          },
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
    assert.equal(calls.length, 3);
  });

  it('reuses the cached app access token for refresh requests', async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(String(url));

      if (String(url).endsWith('/open-apis/auth/v3/app_access_token/internal')) {
        return jsonResponse({ code: 0, app_access_token: 'app-token', expire: 7200 });
      }
      if (String(url).endsWith('/open-apis/authen/v1/oidc/access_token')) {
        return jsonResponse({
          code: 0,
          data: { access_token: 'user-token-1', refresh_token: 'refresh-token', expires_in: 6900 },
        });
      }
      if (String(url).endsWith('/open-apis/authen/v1/oidc/refresh_access_token')) {
        assert.equal(init?.headers?.['Authorization' as keyof HeadersInit], 'Bearer app-token');
        assert.deepEqual(JSON.parse(String(init?.body)), {
          grant_type: 'refresh_token',
          refresh_token: 'refresh-token',
        });
        return jsonResponse({
          code: 0,
          data: { access_token: 'user-token-2', refresh_token: 'refresh-token-2', expires_in: 6900 },
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
      urls.filter(url => url.endsWith('/open-apis/auth/v3/app_access_token/internal')).length,
      1,
    );
  });
});
