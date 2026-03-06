const assert = require('node:assert/strict');
const test = require('node:test');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost:5432/test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
process.env.CORS_ALLOWED_ORIGINS = process.env.CORS_ALLOWED_ORIGINS || 'http://localhost:5173';

const configModule = require('../dist/config');
const config = configModule.default || configModule;
const {
  createLarkWebhookEventHandler,
} = require('../dist/company/channels/lark/lark.webhook.routes');
const {
  __test__: queueTestHarness,
} = require('../dist/company/queue/runtime/orchestration.queue');

const createResponse = () => ({
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
});

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
  requestId: 'req-resilience-redis-1',
  method: 'POST',
  originalUrl: '/webhooks/lark/events',
  url: '/webhooks/lark/events',
});

test('resilience(redis): ingress idempotency outage returns 503 and does not enqueue', async () => {
  let enqueueCount = 0;

  const handler = createLarkWebhookEventHandler({
    verifyRequest: () => ({ ok: true }),
    parsePayload: () => ({
      kind: 'event_callback_message',
      envelope: { event: { message: { message_id: 'om-res-1' } } },
      eventType: 'im.message.receive_v1',
      eventId: 'evt-res-1',
    }),
    adapter: {
      normalizeIncomingEvent: () => ({
        channel: 'lark',
        userId: 'ou-res',
        chatId: 'oc-res',
        chatType: 'p2p',
        messageId: 'om-res-1',
        timestamp: new Date().toISOString(),
        text: 'resilience check',
        rawEvent: {},
      }),
      sendMessage: async () => ({ status: 'sent' }),
    },
    claimIngressKey: async () => {
      const error = new Error('redis unavailable');
      error.code = 'ECONNREFUSED';
      throw error;
    },
    enqueueTask: async () => {
      enqueueCount += 1;
      return { taskId: 'task-res-redis' };
    },
    resolveHitlAction: async () => true,
  });

  const response = await runHandler(handler, baseRequest());

  assert.equal(response.statusCode, 503);
  assert.equal(response.body.success, false);
  assert.equal(enqueueCount, 0);
});

test('resilience(redis): queue enqueue retries transient redis errors then fails with 503', async () => {
  let attempts = 0;
  const message = {
    channel: 'lark',
    userId: 'ou-res',
    chatId: 'oc-res',
    chatType: 'p2p',
    messageId: 'om-res-queue-1',
    timestamp: new Date().toISOString(),
    text: 'queue retry fail path',
    rawEvent: {},
    trace: {
      requestId: 'req-res-queue-1',
      textHash: 'hash-1',
    },
  };

  await assert.rejects(
    () =>
      queueTestHarness.enqueueJobWithRetry({
        taskId: 'task-res-queue-fail',
        message,
        jobId: 'job-res-queue-fail',
        queueAdd: async () => {
          attempts += 1;
          const error = new Error('redis queue unavailable');
          error.code = 'ECONNREFUSED';
          throw error;
        },
      }),
    (error) => {
      assert.equal(error.status, 503);
      assert.equal(error.message, 'Orchestration queue unavailable');
      return true;
    },
  );

  assert.equal(attempts, config.ORCHESTRATION_QUEUE_ADD_MAX_ATTEMPTS);
});

test('resilience(redis): queue enqueue recovers after transient failure within retry bound', async () => {
  let attempts = 0;
  const message = {
    channel: 'lark',
    userId: 'ou-res',
    chatId: 'oc-res',
    chatType: 'p2p',
    messageId: 'om-res-queue-2',
    timestamp: new Date().toISOString(),
    text: 'queue retry success path',
    rawEvent: {},
    trace: {
      requestId: 'req-res-queue-2',
      textHash: 'hash-2',
    },
  };

  await queueTestHarness.enqueueJobWithRetry({
    taskId: 'task-res-queue-success',
    message,
    jobId: 'job-res-queue-success',
    queueAdd: async () => {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error('redis temporarily unavailable');
        error.code = 'ECONNREFUSED';
        throw error;
      }
      return { id: 'bullmq-job-id-1' };
    },
  });

  assert.equal(attempts, 2);
});
