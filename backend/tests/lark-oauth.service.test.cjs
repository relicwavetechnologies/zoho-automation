const assert = require('node:assert/strict');
const test = require('node:test');

const config = require('../dist/config').default;
const { LarkOAuthService } = require('../dist/company/channels/lark/lark-oauth.service');

const originalConfig = {
  APP_BASE_URL: config.APP_BASE_URL,
  BACKEND_PUBLIC_URL: config.BACKEND_PUBLIC_URL,
  LARK_API_BASE_URL: config.LARK_API_BASE_URL,
  LARK_APP_ID: config.LARK_APP_ID,
  LARK_APP_SECRET: config.LARK_APP_SECRET,
};

const restoreConfig = () => {
  config.APP_BASE_URL = originalConfig.APP_BASE_URL;
  config.BACKEND_PUBLIC_URL = originalConfig.BACKEND_PUBLIC_URL;
  config.LARK_API_BASE_URL = originalConfig.LARK_API_BASE_URL;
  config.LARK_APP_ID = originalConfig.LARK_APP_ID;
  config.LARK_APP_SECRET = originalConfig.LARK_APP_SECRET;
};

test.afterEach(() => {
  restoreConfig();
});

test('LarkOAuthService builds authorize URL from platform env config', () => {
  config.APP_BASE_URL = 'https://admin.example.com';
  config.BACKEND_PUBLIC_URL = 'https://api.example.com';
  config.LARK_API_BASE_URL = 'https://open.larksuite.com';
  config.LARK_APP_ID = 'cli_test_app';
  config.LARK_APP_SECRET = 'secret_test';

  const service = new LarkOAuthService();
  const authorizeUrl = new URL(service.getAuthorizeUrl({ state: 'state-token' }));

  assert.equal(service.isConfigured(), true);
  assert.equal(service.getRedirectUri(), 'https://admin.example.com/lark/callback');
  assert.equal(authorizeUrl.origin, 'https://open.larksuite.com');
  assert.equal(authorizeUrl.pathname, '/open-apis/authen/v1/index');
  assert.equal(authorizeUrl.searchParams.get('app_id'), 'cli_test_app');
  assert.equal(authorizeUrl.searchParams.get('redirect_uri'), 'https://admin.example.com/lark/callback');
  assert.equal(authorizeUrl.searchParams.get('state'), 'state-token');
});

test('LarkOAuthService reports not configured without APP_BASE_URL', () => {
  config.APP_BASE_URL = '';
  config.BACKEND_PUBLIC_URL = 'https://api.example.com';
  config.LARK_API_BASE_URL = 'https://open.larksuite.com';
  config.LARK_APP_ID = 'cli_test_app';
  config.LARK_APP_SECRET = 'secret_test';

  const service = new LarkOAuthService();

  assert.equal(service.isConfigured(), false);
  assert.throws(
    () => service.getAuthorizeUrl({ state: 'state-token' }),
    /Lark OAuth is not configured in server env/,
  );
});

test('LarkOAuthService exchanges auth code using app access token', async () => {
  config.APP_BASE_URL = 'https://admin.example.com';
  config.BACKEND_PUBLIC_URL = 'https://api.example.com';
  config.LARK_API_BASE_URL = 'https://open.larksuite.com';
  config.LARK_APP_ID = 'cli_test_app';
  config.LARK_APP_SECRET = 'secret_test';

  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (String(url).endsWith('/open-apis/auth/v3/app_access_token/internal')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: 0, app_access_token: 'app_token_123' }),
      };
    }
    if (String(url).endsWith('/open-apis/authen/v1/access_token')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          code: 0,
          msg: 'success',
          data: {
            access_token: 'user_access_123',
            refresh_token: 'refresh_123',
          },
        }),
      };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const service = new LarkOAuthService();
    const result = await service.exchangeAuthorizationCode('auth_code_123');

    assert.equal(result.accessToken, 'user_access_123');
    assert.equal(result.refreshToken, 'refresh_123');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, 'https://open.larksuite.com/open-apis/auth/v3/app_access_token/internal');
    assert.equal(calls[1].url, 'https://open.larksuite.com/open-apis/authen/v1/access_token');
    assert.equal(calls[1].options.headers.Authorization, 'Bearer app_token_123');
  } finally {
    global.fetch = originalFetch;
  }
});
