const assert = require('node:assert/strict');
const test = require('node:test');

const { LarkChannelAdapter } = require('../dist/company/channels/lark/lark.adapter');

const jsonResponse = (payload, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });

test('LarkChannelAdapter sendMessage retries once after token invalid response', async () => {
  const tokenCalls = [];
  let requestCount = 0;

  const adapter = new LarkChannelAdapter({
    apiBaseUrl: 'https://example.test',
    tokenService: {
      getAccessToken: async (input) => {
        tokenCalls.push(input ?? null);
        return tokenCalls.length === 1 ? 'token-old' : 'token-new';
      },
    },
    fetchImpl: async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return jsonResponse(
          {
            code: 99991663,
            msg: 'tenant_access_token invalid',
          },
          401,
        );
      }

      return jsonResponse({
        data: {
          message_id: 'om_123',
        },
      });
    },
  });

  const result = await adapter.sendMessage({
    chatId: 'oc_test',
    text: 'hello',
  });

  assert.equal(result.status, 'sent');
  assert.equal(result.messageId, 'om_123');
  assert.equal(requestCount, 2);
  assert.deepEqual(tokenCalls, [null, { forceRefresh: true }]);
});

test('LarkChannelAdapter updateMessage retries once after token invalid response', async () => {
  const tokenCalls = [];
  let requestCount = 0;

  const adapter = new LarkChannelAdapter({
    apiBaseUrl: 'https://example.test',
    tokenService: {
      getAccessToken: async (input) => {
        tokenCalls.push(input ?? null);
        return tokenCalls.length === 1 ? 'token-old' : 'token-new';
      },
    },
    fetchImpl: async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return jsonResponse(
          {
            msg: 'tenant_access_token expired',
          },
          401,
        );
      }

      return jsonResponse({
        data: {
          message_id: 'om_updated',
        },
      });
    },
  });

  const result = await adapter.updateMessage({
    messageId: 'om_seed',
    text: 'updated text',
  });

  assert.equal(result.status, 'updated');
  assert.equal(requestCount, 2);
  assert.deepEqual(tokenCalls, [null, { forceRefresh: true }]);
});
