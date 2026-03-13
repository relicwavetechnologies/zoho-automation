const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildPrimaryIngressIdempotencyKey,
  createLarkWebhookEventHandler,
  mapVerificationReasonToHttpStatus,
} = require('../dist/company/channels/lark/lark.webhook.routes');

const createResponse = () => {
  const response = {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };

  return response;
};

const runHandler = async (handler, request) => {
  const response = createResponse();
  let nextError;
  await handler(request, response, (error) => {
    if (error) {
      nextError = error;
    }
  });

  if (nextError) {
    throw nextError;
  }

  return response;
};

const baseRequest = () => ({
  headers: {},
  body: {},
  rawBody: '{}',
  requestId: 'req-1',
});

const eventCallbackMessage = (eventId = 'evt_1') => ({
  kind: 'event_callback_message',
  envelope: { event: { message: { message_id: 'om_1' } } },
  eventType: 'im.message.receive_v1',
  eventId,
});

const normalizedMessage = {
  channel: 'lark',
  userId: 'ou_1',
  chatId: 'oc_1',
  chatType: 'p2p',
  messageId: 'om_1',
  timestamp: new Date().toISOString(),
  text: 'hello from lark',
  rawEvent: {},
};

test('mapVerificationReasonToHttpStatus maps replay_window_exceeded to 403', () => {
  assert.equal(mapVerificationReasonToHttpStatus('replay_window_exceeded'), 403);
});

test('mapVerificationReasonToHttpStatus maps invalid token rejection to 401', () => {
  assert.equal(mapVerificationReasonToHttpStatus('invalid_verification_token'), 401);
});

test('webhook handler returns 401 for invalid verification token failures', async () => {
  const handler = createLarkWebhookEventHandler({
    verifyRequest: () => ({ ok: false, reason: 'invalid_verification_token' }),
  });

  const response = await runHandler(handler, baseRequest());

  assert.equal(response.statusCode, 401);
  assert.equal(response.body.success, false);
});

test('webhook handler returns 403 for replay window verification failures', async () => {
  const handler = createLarkWebhookEventHandler({
    verifyRequest: () => ({ ok: false, reason: 'replay_window_exceeded' }),
  });

  const response = await runHandler(handler, baseRequest());

  assert.equal(response.statusCode, 403);
  assert.equal(response.body.success, false);
});

test('webhook handler uses eventId as primary idempotency key and claims message alias key best-effort', async () => {
  const claims = [];
  let enqueueCount = 0;
  const handler = createLarkWebhookEventHandler({
    verifyRequest: () => ({ ok: true }),
    parsePayload: () => eventCallbackMessage('evt_primary'),
    adapter: {
      normalizeIncomingEvent: () => normalizedMessage,
      sendMessage: async () => ({ status: 'sent' }),
    },
    claimIngressKey: async (channel, keyType, key) => {
      claims.push({ channel, keyType, key });
      return true;
    },
    enqueueTask: async () => {
      enqueueCount += 1;
      return { taskId: 'task-1' };
    },
    resolveHitlAction: async () => true,
  });

  const response = await runHandler(handler, baseRequest());

  assert.equal(response.statusCode, 202);
  assert.equal(enqueueCount, 1);
  assert.deepEqual(claims, [
    { channel: 'lark', keyType: 'event', key: 'evt_primary' },
    { channel: 'lark', keyType: 'message', key: 'om_1' },
  ]);
});

test('webhook handler falls back to messageId idempotency key when eventId is missing', async () => {
  const claims = [];
  const handler = createLarkWebhookEventHandler({
    verifyRequest: () => ({ ok: true }),
    parsePayload: () => eventCallbackMessage(''),
    adapter: {
      normalizeIncomingEvent: () => normalizedMessage,
      sendMessage: async () => ({ status: 'sent' }),
    },
    claimIngressKey: async (channel, keyType, key) => {
      claims.push({ channel, keyType, key });
      return true;
    },
    enqueueTask: async () => ({ taskId: 'task-2' }),
    resolveHitlAction: async () => true,
  });

  const response = await runHandler(handler, baseRequest());

  assert.equal(response.statusCode, 202);
  assert.deepEqual(claims, [{ channel: 'lark', keyType: 'message', key: 'om_1' }]);
});

test('webhook handler returns 202 duplicate ignored when primary idempotency key is already claimed', async () => {
  let enqueueCount = 0;
  const handler = createLarkWebhookEventHandler({
    verifyRequest: () => ({ ok: true }),
    parsePayload: () => eventCallbackMessage('evt_duplicate'),
    adapter: {
      normalizeIncomingEvent: () => normalizedMessage,
      sendMessage: async () => ({ status: 'sent' }),
    },
    claimIngressKey: async () => false,
    enqueueTask: async () => {
      enqueueCount += 1;
      return { taskId: 'task-3' };
    },
    resolveHitlAction: async () => true,
  });

  const response = await runHandler(handler, baseRequest());

  assert.equal(response.statusCode, 202);
  assert.equal(response.body.message, 'Duplicate ingress ignored (idempotency hit)');
  assert.equal(enqueueCount, 0);
});

test('webhook handler returns 202 duplicate ignored when message alias was already claimed for a new event id', async () => {
  let enqueueCount = 0;
  const claims = [];
  const handler = createLarkWebhookEventHandler({
    verifyRequest: () => ({ ok: true }),
    parsePayload: () => eventCallbackMessage('evt_newer_copy'),
    adapter: {
      normalizeIncomingEvent: () => normalizedMessage,
      sendMessage: async () => ({ status: 'sent' }),
    },
    claimIngressKey: async (channel, keyType, key) => {
      claims.push({ channel, keyType, key });
      return keyType === 'event';
    },
    enqueueTask: async () => {
      enqueueCount += 1;
      return { taskId: 'task-ignored' };
    },
    resolveHitlAction: async () => true,
  });

  const response = await runHandler(handler, baseRequest());

  assert.equal(response.statusCode, 202);
  assert.equal(response.body.message, 'Duplicate ingress ignored (idempotency hit)');
  assert.equal(response.body.data.keyType, 'message');
  assert.equal(response.body.data.idempotencyKey, 'emiac:idempotent:lark:message:om_1');
  assert.equal(enqueueCount, 0);
  assert.deepEqual(claims, [
    { channel: 'lark', keyType: 'event', key: 'evt_newer_copy' },
    { channel: 'lark', keyType: 'message', key: 'om_1' },
  ]);
});

test('webhook handler returns 503 when idempotency store is unavailable', async () => {
  let enqueueCount = 0;
  const handler = createLarkWebhookEventHandler({
    verifyRequest: () => ({ ok: true }),
    parsePayload: () => eventCallbackMessage('evt_unavailable'),
    adapter: {
      normalizeIncomingEvent: () => normalizedMessage,
      sendMessage: async () => ({ status: 'sent' }),
    },
    claimIngressKey: async () => {
      throw new Error('redis unavailable');
    },
    enqueueTask: async () => {
      enqueueCount += 1;
      return { taskId: 'task-4' };
    },
    resolveHitlAction: async () => true,
  });

  const response = await runHandler(handler, baseRequest());

  assert.equal(response.statusCode, 503);
  assert.equal(response.body.success, false);
  assert.equal(enqueueCount, 0);
});

test('webhook handler ignores stale message deliveries before enqueue', async () => {
  let enqueueCount = 0;
  const handler = createLarkWebhookEventHandler({
    verifyRequest: () => ({ ok: true }),
    parsePayload: () => eventCallbackMessage('evt_stale'),
    adapter: {
      normalizeIncomingEvent: () => ({
        ...normalizedMessage,
        timestamp: new Date(Date.now() - (10 * 60 * 1000)).toISOString(),
      }),
      sendMessage: async () => ({ status: 'sent' }),
    },
    claimIngressKey: async () => true,
    enqueueTask: async () => {
      enqueueCount += 1;
      return { taskId: 'task-stale' };
    },
    resolveHitlAction: async () => true,
  });

  const response = await runHandler(handler, baseRequest());

  assert.equal(response.statusCode, 202);
  assert.equal(response.body.message, 'Lark event ignored because the message is too old to process safely');
  assert.equal(response.body.data.reason, 'stale_message_delivery');
  assert.equal(enqueueCount, 0);
});

test('buildPrimaryIngressIdempotencyKey uses event key when event id is present', () => {
  const key = buildPrimaryIngressIdempotencyKey({
    channel: 'lark',
    eventId: 'evt_123',
    messageId: 'om_123',
  });

  assert.deepEqual(key, {
    keyType: 'event',
    key: 'evt_123',
    idempotencyKey: 'emiac:idempotent:lark:event:evt_123',
  });
});

test('buildPrimaryIngressIdempotencyKey falls back to message key when event id is empty', () => {
  const key = buildPrimaryIngressIdempotencyKey({
    channel: 'lark',
    eventId: '  ',
    messageId: 'om_321',
  });

  assert.deepEqual(key, {
    keyType: 'message',
    key: 'om_321',
    idempotencyKey: 'emiac:idempotent:lark:message:om_321',
  });
});
