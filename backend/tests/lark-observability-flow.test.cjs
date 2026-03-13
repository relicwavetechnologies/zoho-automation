const assert = require('node:assert/strict');
const test = require('node:test');

const { createLarkWebhookEventHandler } = require('../dist/company/channels/lark/lark.webhook.routes');
const { buildLarkTextHash } = require('../dist/company/channels/lark/lark-observability');

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

const createCaptureLogger = () => {
  const logs = [];
  const push = (level) => (message, meta) => logs.push({ level, message, meta });
  return {
    logs,
    logger: {
      debug: push('debug'),
      info: push('info'),
      warn: push('warn'),
      error: push('error'),
      success: push('success'),
    },
  };
};

const baseRequest = () => ({
  headers: {},
  body: {},
  rawBody: JSON.stringify({ type: 'event_callback' }),
  method: 'POST',
  originalUrl: '/webhooks/lark/events',
  url: '/webhooks/lark/events',
  requestId: 'req-123',
});

const messageText = 'hello team';
const expectedHash = buildLarkTextHash(messageText);
const normalizedMessage = {
  channel: 'lark',
  userId: 'ou_1',
  chatId: 'oc_1',
  chatType: 'p2p',
  messageId: 'om_1',
  timestamp: new Date().toISOString(),
  text: messageText,
  rawEvent: {},
};

const parsedMessage = {
  kind: 'event_callback_message',
  envelope: {},
  eventType: 'im.message.receive_v1',
  eventId: 'evt_1',
};

test('observability chain logs ingress received -> verified -> queued with shared trace keys', async () => {
  const capture = createCaptureLogger();
  const handler = createLarkWebhookEventHandler({
    log: capture.logger,
    verifyRequest: () => ({ ok: true }),
    parsePayload: () => parsedMessage,
    adapter: {
      normalizeIncomingEvent: () => normalizedMessage,
      sendMessage: async () => ({ status: 'sent' }),
    },
    claimIngressKey: async () => true,
    enqueueTask: async () => ({ taskId: 'task-1' }),
    resolveHitlAction: async () => true,
  });

  const response = await runHandler(handler, baseRequest());

  assert.equal(response.statusCode, 202);
  const received = capture.logs.find((entry) => entry.message === 'lark.ingress.received');
  const verified = capture.logs.find((entry) => entry.message === 'lark.ingress.verified');
  const queued = capture.logs.find((entry) => entry.message === 'lark.ingress.queued');

  assert.ok(received);
  assert.ok(verified);
  assert.ok(queued);
  assert.equal(queued.meta.requestId, 'req-123');
  assert.equal(queued.meta.messageId, 'om_1');
  assert.equal(queued.meta.eventId, 'evt_1');
  assert.equal(queued.meta.taskId, 'task-1');
  assert.equal(queued.meta.textHash, expectedHash);
  assert.equal(JSON.stringify(queued.meta).includes(messageText), false);
});

test('duplicate message path logs lark.ingress.duplicate_ignored with idempotency details', async () => {
  const capture = createCaptureLogger();
  const handler = createLarkWebhookEventHandler({
    log: capture.logger,
    verifyRequest: () => ({ ok: true }),
    parsePayload: () => parsedMessage,
    adapter: {
      normalizeIncomingEvent: () => normalizedMessage,
      sendMessage: async () => ({ status: 'sent' }),
    },
    claimIngressKey: async () => false,
    enqueueTask: async () => ({ taskId: 'task-not-used' }),
    resolveHitlAction: async () => true,
  });

  const response = await runHandler(handler, baseRequest());

  assert.equal(response.statusCode, 202);
  const duplicate = capture.logs.find((entry) => entry.message === 'lark.ingress.duplicate_ignored');
  assert.ok(duplicate);
  assert.equal(duplicate.meta.requestId, 'req-123');
  assert.equal(duplicate.meta.keyType, 'event');
  assert.equal(duplicate.meta.idempotencyKey, 'company:idempotent:lark:event:evt_1');
  assert.equal(JSON.stringify(duplicate.meta).includes(messageText), false);
});

test('idempotency outage logs lark.ingress.idempotency_unavailable and returns 503', async () => {
  const capture = createCaptureLogger();
  const handler = createLarkWebhookEventHandler({
    log: capture.logger,
    verifyRequest: () => ({ ok: true }),
    parsePayload: () => parsedMessage,
    adapter: {
      normalizeIncomingEvent: () => normalizedMessage,
      sendMessage: async () => ({ status: 'sent' }),
    },
    claimIngressKey: async () => {
      throw new Error('redis down');
    },
    enqueueTask: async () => ({ taskId: 'task-not-used' }),
    resolveHitlAction: async () => true,
  });

  const response = await runHandler(handler, baseRequest());

  assert.equal(response.statusCode, 503);
  const unavailable = capture.logs.find((entry) => entry.message === 'lark.ingress.idempotency_unavailable');
  assert.ok(unavailable);
  assert.equal(unavailable.meta.requestId, 'req-123');
  assert.equal(unavailable.meta.messageId, 'om_1');
  assert.equal(unavailable.meta.textHash, expectedHash);
  assert.equal(JSON.stringify(unavailable.meta).includes(messageText), false);
});
