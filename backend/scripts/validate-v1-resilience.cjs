#!/usr/bin/env node

const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const {
  createLarkWebhookEventHandler,
} = require('../dist/company/channels/lark/lark.webhook.routes');
const {
  __test__: queueTestHarness,
} = require('../dist/company/queue/runtime/orchestration.queue');
const { QdrantAdapter } = require('../dist/company/integrations/vector/qdrant.adapter');
const { ZohoHttpClient } = require('../dist/company/integrations/zoho/zoho-http.client');
const {
  openAiOrchestrationModels,
} = require('../dist/company/orchestration/langchain/openai-models');
const {
  resolveRouteContract,
} = require('../dist/company/orchestration/langgraph/route-contract');

const now = () => Date.now();

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

const scenario = async (report, id, fn) => {
  const startedAt = now();
  try {
    const detail = await fn();
    report.scenarios.push({
      id,
      status: 'PASS',
      durationMs: now() - startedAt,
      detail,
    });
  } catch (error) {
    report.scenarios.push({
      id,
      status: 'FAIL',
      durationMs: now() - startedAt,
      detail: error instanceof Error ? error.message : String(error),
    });
    report.ok = false;
  }
};

const run = async () => {
  const report = {
    startedAt: new Date().toISOString(),
    finishedAt: null,
    ok: true,
    scenarios: [],
  };

  await scenario(report, 'redis_ingress_idempotency_fail_closed', async () => {
    const handler = createLarkWebhookEventHandler({
      verifyRequest: () => ({ ok: true }),
      parsePayload: () => ({
        kind: 'event_callback_message',
        envelope: { event: { message: { message_id: 'om-res-script-1' } } },
        eventType: 'im.message.receive_v1',
        eventId: 'evt-res-script-1',
      }),
      adapter: {
        normalizeIncomingEvent: () => ({
          channel: 'lark',
          userId: 'ou-res-script',
          chatId: 'oc-res-script',
          chatType: 'p2p',
          messageId: 'om-res-script-1',
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
      enqueueTask: async () => ({ taskId: 'task-res-script-1' }),
      resolveHitlAction: async () => true,
    });

    const response = await runHandler(handler, {
      headers: {},
      body: {},
      rawBody: '{}',
      requestId: 'req-res-script-1',
      method: 'POST',
      originalUrl: '/webhooks/lark/events',
      url: '/webhooks/lark/events',
    });

    if (response.statusCode !== 503) {
      throw new Error(`Expected 503 when idempotency store is down, got ${response.statusCode}`);
    }

    return {
      statusCode: response.statusCode,
      message: response.body?.message,
    };
  });

  await scenario(report, 'redis_queue_transient_retry_exhaustion', async () => {
    let attempts = 0;

    await queueTestHarness.enqueueJobWithRetry({
      taskId: 'task-res-script-queue',
      message: {
        channel: 'lark',
        userId: 'ou-res-script',
        chatId: 'oc-res-script',
        chatType: 'p2p',
        messageId: 'om-res-script-queue',
        timestamp: new Date().toISOString(),
        text: 'queue resilience',
        rawEvent: {},
        trace: {
          requestId: 'req-res-script-queue',
          textHash: 'hash-script-queue',
        },
      },
      jobId: 'job-res-script-queue',
      queueAdd: async () => {
        attempts += 1;
        const error = new Error('redis queue unavailable');
        error.code = 'ECONNREFUSED';
        throw error;
      },
    }).then(
      () => {
        throw new Error('Expected enqueue to fail with queue unavailable');
      },
      (error) => {
        if (error?.status !== 503) {
          throw new Error(`Expected queue unavailable status 503, got ${error?.status ?? 'unknown'}`);
        }
      },
    );

    return { attempts };
  });

  await scenario(report, 'qdrant_timeout_degraded_health', async () => {
    const adapter = new QdrantAdapter();
    const originalFetch = global.fetch;
    try {
      global.fetch = async () => {
        const error = new Error('timeout');
        error.name = 'TimeoutError';
        throw error;
      };

      const health = await adapter.health();
      if (health.ok) {
        throw new Error('Expected degraded qdrant health during timeout');
      }

      return health;
    } finally {
      global.fetch = originalFetch;
    }
  });

  await scenario(report, 'zoho_rate_limit_retry_then_success', async () => {
    let attempts = 0;
    const client = new ZohoHttpClient({
      fetchImpl: async () => {
        attempts += 1;
        if (attempts === 1) {
          return new Response(JSON.stringify({ message: 'rate limited' }), { status: 429 });
        }
        return new Response(JSON.stringify({ data: [{ id: '1' }] }), { status: 200 });
      },
      retry: {
        maxAttempts: 3,
        baseDelayMs: 0,
      },
    });

    const payload = await client.requestJson({
      base: 'api',
      path: '/crm/v2/Contacts?page=1&per_page=1',
      method: 'GET',
    });

    return {
      attempts,
      records: Array.isArray(payload.data) ? payload.data.length : 0,
    };
  });

  await scenario(report, 'openai_unavailable_deterministic_fallback', async () => {
    const originalEnabled = openAiOrchestrationModels.enabled;
    const originalCache = openAiOrchestrationModels.modelCache;
    try {
      openAiOrchestrationModels.enabled = true;
      openAiOrchestrationModels.modelCache = new Map([
        [
          'router',
          {
            invoke: async () => {
              throw new Error('OpenAI unavailable');
            },
          },
        ],
      ]);

      const llmOutput = await openAiOrchestrationModels.invokePrompt('router', 'classify this request');
      const route = resolveRouteContract({
        rawLlmOutput: llmOutput,
        messageText: 'show my zoho deals',
      });

      if (route.source !== 'heuristic_fallback') {
        throw new Error(`Expected heuristic fallback route, got ${route.source}`);
      }

      return {
        llmOutput,
        routeIntent: route.route.intent,
        source: route.source,
      };
    } finally {
      openAiOrchestrationModels.enabled = originalEnabled;
      openAiOrchestrationModels.modelCache = originalCache;
    }
  });

  report.finishedAt = new Date().toISOString();
  return report;
};

run()
  .then((report) => {
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.ok ? 0 : 1;
  })
  .catch((error) => {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  });
