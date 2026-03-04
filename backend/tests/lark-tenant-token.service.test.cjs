const assert = require('node:assert/strict');
const test = require('node:test');

const { LarkTenantTokenService } = require('../dist/company/channels/lark/lark-tenant-token.service');

const silentLog = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const jsonResponse = (payload, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });

test('LarkTenantTokenService caches token and refreshes before expiry buffer', async () => {
  let now = 0;
  let callCount = 0;

  const fetchImpl = async () => {
    callCount += 1;
    if (callCount === 1) {
      return jsonResponse({
        code: 0,
        msg: 'ok',
        tenant_access_token: 'token-one',
        expire: 10,
      });
    }

    return jsonResponse({
      code: 0,
      msg: 'ok',
      tenant_access_token: 'token-two',
      expire: 10,
    });
  };

  const service = new LarkTenantTokenService({
    apiBaseUrl: 'https://example.test',
    appId: 'app-id',
    appSecret: 'app-secret',
    refreshBufferMs: 3000,
    fetchImpl,
    now: () => now,
    log: silentLog,
  });

  const first = await service.getAccessToken();
  assert.equal(first, 'token-one');
  assert.equal(callCount, 1);

  now = 2000;
  const second = await service.getAccessToken();
  assert.equal(second, 'token-one');
  assert.equal(callCount, 1);

  now = 8000;
  const third = await service.getAccessToken();
  assert.equal(third, 'token-two');
  assert.equal(callCount, 2);
});

test('LarkTenantTokenService retries transient failures with bounded backoff', async () => {
  let callCount = 0;
  const delays = [];

  const fetchImpl = async () => {
    callCount += 1;
    if (callCount === 1) {
      throw new Error('ECONNRESET');
    }

    return jsonResponse({
      code: 0,
      msg: 'ok',
      tenant_access_token: 'token-retried',
      expire: 60,
    });
  };

  const service = new LarkTenantTokenService({
    apiBaseUrl: 'https://example.test',
    appId: 'app-id',
    appSecret: 'app-secret',
    fetchImpl,
    maxRetries: 3,
    retryBaseDelayMs: 25,
    sleep: async (ms) => {
      delays.push(ms);
    },
    log: silentLog,
  });

  const token = await service.getAccessToken();
  assert.equal(token, 'token-retried');
  assert.equal(callCount, 2);
  assert.deepEqual(delays, [25]);
});

test('LarkTenantTokenService falls back to static token when auto fetch fails', async () => {
  const service = new LarkTenantTokenService({
    apiBaseUrl: 'https://example.test',
    appId: 'app-id',
    appSecret: 'app-secret',
    staticToken: 'manual-token',
    fetchImpl: async () => {
      throw new Error('network down');
    },
    maxRetries: 1,
    log: silentLog,
  });

  const token = await service.getAccessToken();
  assert.equal(token, 'manual-token');
});
