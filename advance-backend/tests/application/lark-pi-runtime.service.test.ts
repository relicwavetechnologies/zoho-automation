import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LarkPiRuntimeError,
  LarkPiRuntimeService,
} from '../../src/application/runtime/lark-pi-runtime.service.ts';
import {
  RunLatencyRecorder,
  type RunLatencySpanStore,
} from '../../src/application/observability/run-latency-recorder.ts';

const logger = {
  child() { return this; },
  info() {},
  warn() {},
  error() {},
  debug() {},
} as any;
const runEffectReceipts = {
  getVerifiedKnowledgeEffect: async () => null,
  getVerifiedWorkbookConversionOffer: async () => null,
};

function runtimeInput() {
  return {
    incoming: {
      // The surface this turn arrived on. The lease carries it into the
      // container, so a fixture without it is a run nobody could present.
      channel: 'lark',
      traceId: 'trace-1',
      text: 'Do the work',
      chatId: 'chat-1',
    },
    runContext: {
      companyId: 'company-1',
      userId: 'user-1',
      companyRole: 'MEMBER',
      channel: 'lark',
      tenantId: 'tenant-1',
      userExternalId: 'ou-user-1',
    },
    conversation: {
      channel: 'lark',
      chatId: 'chat-1',
      correlationId: 'trace-1',
    },
    threadId: 'lark:chat-1:user-1',
  } as any;
}

test('records one causal runtime path without storing prompts or answers', async () => {
  const spans: Array<Record<string, any>> = [];
  const admissions: unknown[] = [];
  const controllerStartedAt = Date.now() - 5;
  const store: RunLatencySpanStore = {
    findOwnedIdByRequestId: async () => {
      throw new Error('bound execution id should avoid a late lookup');
    },
    insertSpans: async batch => { spans.push(...batch); },
  };
  const service = new LarkPiRuntimeService({
    prisma: {
      memberSession: {
        findFirst: async () => ({
          sessionId: 'session-1',
          expiresAt: new Date(Date.now() + 2 * 60 * 60_000),
        }),
      },
    } as any,
    logger,
    memberJwtSecret: 'test-secret',
    backendUrl: 'https://backend.example',
    controllerUrl: 'http://127.0.0.1:4317',
    instanceId: 'pi-local-1',
    leaseTtlSeconds: 3_600,
    runTimeoutMs: 30_000,
    runEffectReceipts,
    runLatencyRecorder: new RunLatencyRecorder(store, logger),
    executionRuns: {
      admit: async input => {
        admissions.push(input);
        return 'execution-1';
      },
      failDetached() {},
    },
    fetch: async () => new Response(JSON.stringify({
      text: 'Finished secret answer',
      runtimeTelemetry: {
        wallMs: 5,
        phases: [{
          name: 'model',
          startedAt: controllerStartedAt,
          endedAt: controllerStartedAt + 5,
          durationMs: 5,
          status: 'ok',
        }],
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  });

  await service.run(runtimeInput());
  await new Promise(resolve => setImmediate(resolve));

  const byName = new Map(spans.map(span => [span.name, span]));
  assert.equal(admissions.length, 1);
  assert.equal(byName.get('runtime.run.admit')?.parentSpanId, 'runtime.request');
  assert.equal(byName.get('runtime.request')?.status, 'ok');
  assert.equal(byName.get('runtime.controller.turn')?.spanId, 'runtime.controller');
  assert.equal(byName.get('runtime.controller.turn')?.parentSpanId, 'runtime.request');
  assert.equal(byName.get('runtime.controller.connect')?.parentSpanId, 'runtime.controller');
  assert.equal(byName.get('controller.model')?.parentSpanId, 'runtime.controller');
  assert.equal(byName.get('controller.model')?.source, 'pi-controller');
  assert.equal(byName.has('runtime.session.resolve'), true);
  assert.equal(byName.has('runtime.effects.knowledge'), true);
  const serialized = JSON.stringify(spans);
  assert.equal(serialized.includes('Do the work'), false);
  assert.equal(serialized.includes('Finished secret answer'), false);
});

test('mints a scoped Lark lease and sends no caller-selected profile or approval', async () => {
  let controllerBody: Record<string, unknown> | undefined;
  let sessionQuery: Record<string, unknown> | undefined;
  const service = new LarkPiRuntimeService({
    prisma: {
      memberSession: {
        findFirst: async (query: Record<string, unknown>) => {
          sessionQuery = query;
          return {
            sessionId: 'session-1',
            expiresAt: new Date(Date.now() + 2 * 60 * 60_000),
          };
        },
      },
    } as any,
    logger,
    memberJwtSecret: 'test-secret',
    backendUrl: 'https://backend.example',
    controllerUrl: 'http://127.0.0.1:4317/',
    instanceId: 'pi-local-1',
    leaseTtlSeconds: 3_600,
    runTimeoutMs: 30_000,
    runEffectReceipts,
    fetch: async (url, init) => {
      assert.equal(url, 'http://127.0.0.1:4317/v1/lark-runs');
      assert.match(new Headers(init?.headers).get('accept') ?? '', /application\/x-ndjson/);
      controllerBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ text: 'Finished' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  assert.deepEqual(await service.run(runtimeInput()), {
    text: 'Finished',
    effects: [],
    effectVerification: 'verified',
  });
  assert.equal(controllerBody?.['backendUrl'], 'https://backend.example');
  assert.equal(controllerBody?.['message'], 'Do the work');
  assert.equal('profile' in (controllerBody ?? {}), false);
  assert.equal('approve' in (controllerBody ?? {}), false);
  // Identity-bound, not channel-bound. Sign-in happens once in the web app now,
  // and the session it creates is stamped `desktop` — pinning `channel: 'lark'`
  // here would make that session invisible and force Lark to mint its own.
  assert.equal((sessionQuery?.['where'] as Record<string, unknown>)?.['larkTenantKey'], 'tenant-1');
  assert.equal((sessionQuery?.['where'] as Record<string, unknown>)?.['larkOpenId'], 'ou-user-1');
  assert.equal('channel' in ((sessionQuery?.['where'] as Record<string, unknown>) ?? {}), false);

  const token = String(controllerBody?.['runtimeLease']);
  const claims = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'));
  assert.equal(claims.aud, 'divo-pi-runtime');
  assert.equal(claims.channel, 'lark');
  assert.equal(claims.userId, 'user-1');
  assert.equal(claims.companyId, 'company-1');
  assert.equal(claims.instanceId, 'pi-local-1');
  assert.equal(claims.threadId, 'lark:chat-1:user-1');
  assert.equal(claims.runId, 'trace-1');
  assert.equal(claims.chatId, 'chat-1');
  assert.equal(claims.contextAudience, 'private');
});

test('uses the same signed private lease for chat-session preparation and reset', async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const service = new LarkPiRuntimeService({
    prisma: {
      memberSession: {
        findFirst: async () => ({
          sessionId: 'session-1',
          expiresAt: new Date(Date.now() + 2 * 60 * 60_000),
        }),
      },
    } as any,
    logger,
    memberJwtSecret: 'test-secret',
    backendUrl: 'https://backend.example',
    controllerUrl: 'http://127.0.0.1:4317',
    instanceId: 'pi-local-1',
    leaseTtlSeconds: 3_600,
    runTimeoutMs: 30_000,
    fetch: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response('{}', { status: 200 });
    },
  });
  const input = {
    ...runtimeInput(),
    incoming: { ...runtimeInput().incoming, chatType: 'p2p' },
    threadId: 'oc_chat:session:0123456789abcdef01234567',
  } as any;

  await service.preparePrivateSession(input);
  await service.clearPrivateSession(input);

  assert.deepEqual(calls.map(call => call.url), [
    'http://127.0.0.1:4317/v1/lark-sessions',
    'http://127.0.0.1:4317/v1/lark-sessions',
  ]);
  assert.deepEqual(calls.map(call => call.body.operation), ['prepare', 'reset']);
  const claims = JSON.parse(
    Buffer.from(String(calls[0]!.body.runtimeLease).split('.')[1]!, 'base64url').toString('utf8'),
  );
  assert.equal(claims.contextAudience, 'private');
  assert.equal(claims.threadId, input.threadId);
});

test('binds a group run to a shared audience in the signed runtime lease', async () => {
  let controllerBody: Record<string, unknown> | undefined;
  const service = serviceCapturingBody(value => { controllerBody = value; });

  await service.run({
    ...runtimeInput(),
    incoming: { ...runtimeInput().incoming, chatType: 'group' },
    sessionScope: 'run',
  } as any);

  const token = String(controllerBody?.['runtimeLease']);
  const claims = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'));
  assert.equal(claims.contextAudience, 'shared');
  assert.equal(controllerBody?.['sessionScope'], 'run');
});

test('turns a verified workbook receipt into one explicit copy confirmation', async () => {
  const offerId = '44444444-4444-4444-8444-444444444444';
  const service = new LarkPiRuntimeService({
    prisma: {
      memberSession: {
        findFirst: async () => ({
          sessionId: 'session-1',
          expiresAt: new Date(Date.now() + 2 * 60 * 60_000),
        }),
      },
    } as any,
    logger,
    memberJwtSecret: 'test-secret',
    backendUrl: 'https://backend.example',
    controllerUrl: 'http://127.0.0.1:4317',
    instanceId: 'pi-local-1',
    leaseTtlSeconds: 3_600,
    runTimeoutMs: 30_000,
    runEffectReceipts: {
      getVerifiedKnowledgeEffect: async () => null,
      getVerifiedWorkbookConversionOffer: async identity => ({
        version: 1,
        kind: 'workbook_conversion_offer',
        status: 'offered',
        effectKind: 'workbook_conversion_offered',
        ...identity,
        offerId,
        connectionId: '11111111-1111-4111-8111-111111111111',
        fileId: 'xlsx_file_1',
        fileName: 'Forecast.xlsx',
        createdAt: '2026-08-02T00:00:00.000Z',
      }),
    },
    fetch: async () => new Response(JSON.stringify({
      text: 'I can make a Google Sheets copy. The original workbook will stay unchanged.',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  });

  const result = await service.run(runtimeInput());

  assert.deepEqual(result.actions, [{
    label: 'Create Google Sheet copy',
    value: JSON.stringify({ kind: 'workbook_conversion_confirm', offerId }),
    style: 'primary',
  }]);
});

test('turns a run-bound Google authorization into a direct final-card action', async () => {
  let recalledRunId: string | undefined;
  const service = new LarkPiRuntimeService({
    prisma: {
      memberSession: {
        findFirst: async () => ({
          sessionId: 'session-1',
          expiresAt: new Date(Date.now() + 2 * 60 * 60_000),
        }),
      },
    } as any,
    logger,
    memberJwtSecret: 'test-secret',
    backendUrl: 'https://backend.example',
    controllerUrl: 'http://127.0.0.1:4317',
    instanceId: 'pi-local-1',
    leaseTtlSeconds: 3_600,
    runTimeoutMs: 30_000,
    runEffectReceipts,
    runOrigins: {
      remember: async () => true,
      recall: async (input) => {
        recalledRunId = input.runId;
        return {
          version: 1,
          channel: 'lark',
          companyId: 'company-1',
          userId: 'user-1',
          originalRequest: 'Read my mail',
          conversationKey: 'chat-1',
          lark: {
            larkOpenId: 'ou-user-1',
            larkTenantKey: 'tenant-1',
            chatId: 'chat-1',
            chatType: 'p2p',
            originalMessageId: 'message-1',
            replyInThread: false,
          },
          pendingAuthorization: {
            provider: 'google_workspace',
            intentId: 'intent-1',
            authorizeUrl: 'https://accounts.google.com/o/oauth2/auth?state=opaque',
          },
        };
      },
    },
    fetch: async () => new Response(JSON.stringify({ text: 'Connect Google to continue.' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  });

  const input = runtimeInput();
  const result = await service.run(input);

  assert.equal(recalledRunId, input.incoming.traceId);
  assert.equal(
    result.text,
    '# Connect Google Workspace\n\nConnect or reconnect your Google account below. '
      + 'Once it’s connected, I’ll continue this request automatically—no need to send it again.',
  );
  assert.deepEqual(result.actions, [{
    label: 'Connect Google',
    url: 'https://accounts.google.com/o/oauth2/auth?state=opaque',
    style: 'primary',
  }]);
});

test('never injects personal recall into a group prompt and preserves retrieval metadata', async () => {
  let controllerBody: Record<string, unknown> | undefined;
  let recallInput: Record<string, unknown> | undefined;
  const service = new LarkPiRuntimeService({
    prisma: {
      memberSession: {
        findFirst: async () => ({
          sessionId: 'session-1',
          expiresAt: new Date(Date.now() + 2 * 60 * 60_000),
        }),
      },
    } as any,
    logger,
    memberJwtSecret: 'test-secret',
    backendUrl: 'https://backend.example',
    controllerUrl: 'http://127.0.0.1:4317',
    instanceId: 'pi-local-1',
    leaseTtlSeconds: 3_600,
    runTimeoutMs: 30_000,
    runEffectReceipts,
    knowledgeRecall: {
      recall: async input => {
        recallInput = input as unknown as Record<string, unknown>;
        return {
          status: 'partial' as const,
          coverage: {
            personal: 'searched' as const,
            departments: { searched: 2, failed: 1 },
            company: 'searched' as const,
          },
          degradation: 'canonical_hydration_failed' as const,
          facts: [
            { scope: 'personal' as const, text: 'Private fact.' },
            { scope: 'company' as const, text: 'Company fact.' },
          ],
        };
      },
    },
    fetch: async (_url, init) => {
      controllerBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ text: 'Finished' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  await service.run({
    ...runtimeInput(),
    incoming: { ...runtimeInput().incoming, chatType: 'group' },
  } as any);

  const message = String(controllerBody?.['message']);
  assert.equal(recallInput?.['audience'], 'shared');
  assert.ok(message.includes('RETRIEVAL_STATUS: partial'));
  assert.ok(message.includes('personal=skipped'));
  assert.ok(message.includes('departments=2 searched, 1 failed'));
  assert.ok(message.includes('[Company] "Company fact."'));
  assert.ok(!message.includes('Private fact.'));
  assert.ok(message.includes('canonical hydration failed'));
});

test('delivers a natural personal-preference acknowledgement and captures learning once', async () => {
  const captured: unknown[] = [];
  const acknowledgement = 'Got it — I’ll give you very detailed answers from now on.';
  const service = new LarkPiRuntimeService({
    prisma: {
      memberSession: {
        findFirst: async () => ({
          sessionId: 'session-1',
          expiresAt: new Date(Date.now() + 2 * 60 * 60_000),
        }),
      },
    } as any,
    logger,
    memberJwtSecret: 'test-secret',
    backendUrl: 'https://backend.example',
    controllerUrl: 'http://127.0.0.1:4317',
    instanceId: 'pi-local-1',
    leaseTtlSeconds: 3_600,
    runTimeoutMs: 30_000,
    runEffectReceipts,
    knowledgeLearning: {
      captureCompletedTurn: async (input) => { captured.push(input); },
    },
    fetch: async () => new Response(JSON.stringify({ text: acknowledgement }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  });

  const result = await service.run({
    ...runtimeInput(),
    incoming: {
      ...runtimeInput().incoming,
      chatType: 'p2p',
      text: 'I always want very detailed answers, remember it.',
    },
  });

  assert.equal(result.text, acknowledgement);
  assert.deepEqual(captured, [{
    sourceId: 'lark:trace-1',
    companyId: 'company-1',
    userId: 'user-1',
    companyRole: 'MEMBER',
    channel: 'lark',
    userMessages: ['I always want very detailed answers, remember it.'],
    assistantText: acknowledgement,
  }]);
});

test('persists private turns idempotently and teaches from the recent human conversation', async () => {
  const appended: Array<Record<string, unknown>> = [];
  let captured: any;
  const service = new LarkPiRuntimeService({
    prisma: {
      memberSession: {
        findFirst: async () => ({
          sessionId: 'session-1',
          expiresAt: new Date(Date.now() + 2 * 60 * 60_000),
        }),
      },
    } as any,
    logger,
    memberJwtSecret: 'test-secret',
    backendUrl: 'https://backend.example',
    controllerUrl: 'http://127.0.0.1:4317',
    instanceId: 'pi-local-1',
    leaseTtlSeconds: 3_600,
    runTimeoutMs: 30_000,
    runEffectReceipts,
    conversationHistory: {
      appendTurn: async (chatId, turn, scope, metadata) => {
        appended.push({ chatId, turn, scope, metadata });
        return { ok: true as const, value: { id: `turn-${appended.length}`, ...turn } };
      },
      getHistory: async () => ({
        ok: true as const,
        value: [
          { id: '1', role: 'user' as const, content: 'Start with a summary.', timestamp: '2026-07-31T00:00:00.000Z' },
          { id: '2', role: 'assistant' as const, content: 'Understood.', timestamp: '2026-07-31T00:00:01.000Z' },
          { id: '3', role: 'user' as const, content: 'Then include a detailed table.', timestamp: '2026-07-31T00:00:02.000Z' },
        ],
      }),
    },
    knowledgeLearning: {
      captureCompletedTurn: async input => { captured = input; },
    },
    fetch: async () => new Response(JSON.stringify({ text: 'I will follow that format.' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  });

  await service.run({
    ...runtimeInput(),
    incoming: {
      ...runtimeInput().incoming,
      chatType: 'p2p',
      messageId: 'om-message-1',
      timestamp: '2026-07-31T00:00:02.000Z',
      text: 'Then include a detailed table.',
    },
  });

  assert.equal(appended.length, 2);
  assert.equal((appended[0]?.metadata as any)?.dedupeKey, 'lark:om-message-1:user');
  assert.equal((appended[1]?.metadata as any)?.dedupeKey, 'lark:om-message-1:assistant');
  assert.deepEqual(captured.userMessages, [
    'Start with a summary.',
    'Then include a detailed table.',
  ]);
});

/*
 * A web ask carrying a video reads, to the model, as the evidence block first
 * and the member's question after it. Anything that learns durable personal
 * facts must be handed the question — screen text is not something the member
 * said, and the extractor's input window would be spent on the excerpt before
 * ever reaching their words.
 */
const VIDEO_ASK = '[Video: "flow.mov" — Divo watched this recording (30s, 1 screens examined). '
  + 'frame:1 Zoho Books — Overdue invoice 4182]\n\nwhich of these is overdue?';

function learningService(history: {
  ok: boolean;
  value?: unknown;
  error?: unknown;
}, capture: (input: any) => void) {
  return new LarkPiRuntimeService({
    prisma: {
      memberSession: {
        findFirst: async () => ({
          sessionId: 'session-1',
          expiresAt: new Date(Date.now() + 2 * 60 * 60_000),
        }),
      },
    } as any,
    logger,
    memberJwtSecret: 'test-secret',
    backendUrl: 'https://backend.example',
    controllerUrl: 'http://127.0.0.1:4317',
    instanceId: 'pi-local-1',
    leaseTtlSeconds: 3_600,
    runTimeoutMs: 30_000,
    runEffectReceipts,
    conversationHistory: {
      appendTurn: async (_chatId, turn) => ({ ok: true as const, value: { id: 'turn-1', ...turn } }),
      getHistory: async () => history as any,
    },
    knowledgeLearning: { captureCompletedTurn: async (input: any) => { capture(input); } },
    fetch: async () => new Response(JSON.stringify({ text: 'Invoice 4182.' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  } as any);
}

const videoRun = () => ({
  ...runtimeInput(),
  incoming: {
    ...runtimeInput().incoming,
    chatType: 'p2p' as const,
    messageId: 'om-video-1',
    timestamp: '2026-08-18T00:00:02.000Z',
    text: VIDEO_ASK,
  },
  ask: { text: 'which of these is overdue?', attachments: [] },
});

test('learns from what the member typed, not from what Divo read off the screen', async () => {
  let captured: any;
  const service = learningService({
    ok: true,
    value: [
      { id: '1', role: 'user', content: 'earlier question', timestamp: '2026-08-18T00:00:00.000Z' },
      { id: '2', role: 'user', content: VIDEO_ASK, timestamp: '2026-08-18T00:00:02.000Z' },
    ],
  }, input => { captured = input; });

  await service.run(videoRun() as any);

  assert.equal(captured.userMessages.at(-1), 'which of these is overdue?');
  assert.equal(
    JSON.stringify(captured.userMessages).includes('Overdue invoice 4182'),
    false,
    'machine-read screen text must never be learned as the member\'s own words',
  );
});

test('keeps the member\'s words even when the conversation could not be read back', async () => {
  let captured: any;
  // The degraded path: persistence threw, so there is no history to correct —
  // and it is exactly the path a guard on the happy path alone would miss.
  const service = learningService(
    { ok: false, error: new Error('postgres is down') },
    input => { captured = input; },
  );

  await service.run(videoRun() as any);

  assert.equal(captured.userMessages.at(-1), 'which of these is overdue?');
  assert.equal(JSON.stringify(captured.userMessages).includes('Overdue invoice 4182'), false);
});

test('a protected run is neither persisted nor learned and emits cleanup-confirmed provenance', async () => {
  let persisted = 0;
  let learned = 0;
  let receiptLookups = 0;
  const notices: unknown[] = [];
  const protectedResponses: Array<unknown[]> = [];
  const reference = {
    provider: 'shopify' as const,
    connectionId: '11111111-1111-4111-8111-111111111111',
    resourceType: 'customer' as const,
    resourceId: 'gid://shopify/Customer/123456789',
  };
  protectedResponses.push([reference], []);
  const service = new LarkPiRuntimeService({
    prisma: {
      memberSession: {
        findFirst: async () => ({
          sessionId: 'session-1',
          expiresAt: new Date(Date.now() + 2 * 60 * 60_000),
        }),
      },
    } as any,
    logger,
    memberJwtSecret: 'test-secret',
    backendUrl: 'https://backend.example',
    controllerUrl: 'http://127.0.0.1:4317',
    instanceId: 'pi-local-1',
    leaseTtlSeconds: 3_600,
    runTimeoutMs: 30_000,
    runEffectReceipts: {
      getVerifiedKnowledgeEffect: async () => {
        receiptLookups++;
        return null;
      },
    },
    conversationHistory: {
      appendTurn: async () => {
        persisted++;
        return { ok: true as const, value: {} as any };
      },
      getHistory: async () => ({ ok: true as const, value: [] }),
    },
    knowledgeLearning: {
      captureCompletedTurn: async () => { learned++; },
    },
    onProtectedRun: async notice => { notices.push(notice); },
    fetch: async () => new Response(`${JSON.stringify({
      type: 'result',
      text: 'Customer account is active.',
      protectedDataUsed: true,
      protectedRefs: protectedResponses.shift(),
    })}\n`, {
      status: 200,
      headers: { 'content-type': 'application/x-ndjson' },
    }),
  });

  const result = await service.run({
    ...runtimeInput(),
    incoming: {
      ...runtimeInput().incoming,
      chatType: 'p2p',
      messageId: 'om-protected-1',
      timestamp: '2026-08-03T00:00:00.000Z',
    },
  });

  assert.deepEqual(result, {
    text: 'Customer account is active.',
    protectedDataUsed: true,
    protectedReferences: [reference],
  });
  const emptyResult = await service.run({
    ...runtimeInput(),
    incoming: {
      ...runtimeInput().incoming,
      traceId: 'trace-2',
      chatType: 'p2p',
      messageId: 'om-protected-2',
      timestamp: '2026-08-03T00:01:00.000Z',
      text: 'Count matching customers',
    },
  });
  assert.deepEqual(emptyResult, {
    text: 'Customer account is active.',
    protectedDataUsed: true,
    protectedReferences: [],
  });
  assert.equal(persisted, 0);
  assert.equal(learned, 0);
  assert.equal(receiptLookups, 0);
  assert.deepEqual(notices, [{
    companyId: 'company-1',
    userId: 'user-1',
    chatId: 'chat-1',
    threadId: 'lark:chat-1:user-1',
    runId: 'trace-1',
    protectedDataUsed: true,
    references: [reference],
    sessionDeletionRequested: true,
  }, {
    companyId: 'company-1',
    userId: 'user-1',
    chatId: 'chat-1',
    threadId: 'lark:chat-1:user-1',
    runId: 'trace-2',
    protectedDataUsed: true,
    references: [],
    sessionDeletionRequested: true,
  }]);
});

test('allows a verified explicit personal save and does not enqueue duplicate implicit learning', async () => {
  let learningCaptures = 0;
  const effect = {
    version: 1 as const,
    kind: 'personal_memory' as const,
    status: 'applied' as const,
    effectKind: 'personal_memory_applied' as const,
    companyId: 'company-1',
    userId: 'user-1',
    chatId: 'chat-1',
    threadId: 'lark:chat-1:user-1',
    runId: 'trace-1',
    actionId: 'memory-call-1',
    action: 'updated' as const,
    logicalKey: 'communication.answers.detail',
    resourceId: '11111111-1111-4111-8111-111111111111',
    resourceVersion: 3,
    projection: 'completed' as const,
    appliedAt: '2026-07-31T00:00:00.000Z',
  };
  const text = "Done — I've saved your detailed-answer preference in personal memory.";
  const service = new LarkPiRuntimeService({
    prisma: {
      memberSession: {
        findFirst: async () => ({
          sessionId: 'session-1',
          expiresAt: new Date(Date.now() + 2 * 60 * 60_000),
        }),
      },
    } as any,
    logger,
    memberJwtSecret: 'test-secret',
    backendUrl: 'https://backend.example',
    controllerUrl: 'http://127.0.0.1:4317',
    instanceId: 'pi-local-1',
    leaseTtlSeconds: 3_600,
    runTimeoutMs: 30_000,
    runEffectReceipts: {
      getVerifiedKnowledgeEffect: async () => effect,
    },
    knowledgeLearning: {
      captureCompletedTurn: async () => { learningCaptures++; },
    },
    fetch: async () => new Response(JSON.stringify({ text }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  });

  const result = await service.run({
    ...runtimeInput(),
    incoming: {
      ...runtimeInput().incoming,
      chatType: 'p2p',
      text: 'I always want very detailed answers, remember it.',
    },
  });

  assert.equal(result.text, text);
  assert.deepEqual(result.effects, [effect]);
  assert.equal(learningCaptures, 0);
});

test('reports an inactive cloud session before contacting the controller', async () => {
  let controllerCalled = false;
  const service = new LarkPiRuntimeService({
    prisma: {
      memberSession: {
        findFirst: async () => null,
      },
    } as any,
    logger,
    memberJwtSecret: 'test-secret',
    backendUrl: 'https://backend.example',
    controllerUrl: 'http://127.0.0.1:4317',
    instanceId: 'pi-local-1',
    leaseTtlSeconds: 3_600,
    runTimeoutMs: 30_000,
    fetch: async () => {
      controllerCalled = true;
      return new Response();
    },
  });

  assert.equal(await service.hasActiveSession(runtimeInput().runContext), false);
  await assert.rejects(
    () => service.run(runtimeInput()),
    (error: unknown) =>
      error instanceof LarkPiRuntimeError
      && error.code === 'runtime_session_missing',
  );
  assert.equal(controllerCalled, false);
});

test('does not accept another Lark workspace session for the same member', async () => {
  let controllerCalled = false;
  const otherWorkspaceSession = {
    sessionId: 'session-other',
    larkTenantKey: 'tenant-other',
    larkOpenId: 'ou-other',
    expiresAt: new Date(Date.now() + 2 * 60 * 60_000),
  };
  const service = new LarkPiRuntimeService({
    prisma: {
      memberSession: {
        findFirst: async ({ where }: { where: Record<string, unknown> }) =>
          where['larkTenantKey'] === otherWorkspaceSession.larkTenantKey
          && where['larkOpenId'] === otherWorkspaceSession.larkOpenId
            ? otherWorkspaceSession
            : null,
      },
    } as any,
    logger,
    memberJwtSecret: 'test-secret',
    backendUrl: 'https://backend.example',
    controllerUrl: 'http://127.0.0.1:4317',
    instanceId: 'pi-local-1',
    leaseTtlSeconds: 3_600,
    runTimeoutMs: 30_000,
    fetch: async () => {
      controllerCalled = true;
      return new Response();
    },
  });

  assert.equal(await service.hasActiveSession(runtimeInput().runContext), false);
  assert.equal(controllerCalled, false);
});

test('streams sanitized controller progress before returning the final text', async () => {
  const progress: unknown[] = [];
  const spans: Array<Record<string, any>> = [];
  const service = new LarkPiRuntimeService({
    prisma: {
      memberSession: {
        findFirst: async () => ({
          sessionId: 'session-1',
          expiresAt: new Date(Date.now() + 2 * 60 * 60_000),
        }),
      },
    } as any,
    logger,
    memberJwtSecret: 'test-secret',
    backendUrl: 'https://backend.example',
    controllerUrl: 'http://127.0.0.1:4317',
    instanceId: 'pi-local-1',
    leaseTtlSeconds: 3_600,
    runTimeoutMs: 30_000,
    runLatencyRecorder: new RunLatencyRecorder({
      findOwnedIdByRequestId: async () => { throw new Error('run is bound at admission'); },
      insertSpans: async batch => { spans.push(...batch); },
    }, logger),
    executionRuns: {
      admit: async () => 'execution-1',
      failDetached() {},
    },
    fetch: async () => new Response([
      JSON.stringify({
        type: 'progress',
        progress: {
          type: 'starting',
          stage: 'container',
          label: 'Starting your Pi agent…',
          rawSecret: 'ignored',
        },
      }),
      JSON.stringify({
        type: 'progress',
        progress: {
          type: 'tool_start',
          callId: 'call-1',
          toolName: 'divo_gateway',
          toolId: 'googleDrive',
          args: { token: 'ignored' },
        },
      }),
      JSON.stringify({
        type: 'progress',
        progress: {
          type: 'tool_end',
          callId: 'call-1',
          toolName: 'divo_gateway',
          isError: false,
          result: { secret: 'ignored' },
        },
      }),
      JSON.stringify({ type: 'heartbeat' }),
      JSON.stringify({ type: 'progress', progress: { type: 'working' } }),
      JSON.stringify({ type: 'progress', progress: { type: 'thinking' } }),
      JSON.stringify({ type: 'progress', progress: { type: 'thought', index: 0, text: 'Checking.' } }),
      JSON.stringify({ type: 'progress', progress: { type: 'answer_delta', index: 0, delta: 'Fin' } }),
      JSON.stringify({ type: 'progress', progress: { type: 'writing' } }),
      JSON.stringify({ type: 'result', text: 'Finished' }),
      '',
    ].join('\n'), {
      status: 200,
      headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
    }),
  });

  const result = await service.run({
    ...runtimeInput(),
    onProgress: async event => { progress.push(event); },
  });

  assert.deepEqual(result, { text: 'Finished' });
  assert.deepEqual(progress, [
    {
      type: 'starting',
      stage: 'container',
      label: 'Starting your Pi agent…',
    },
    {
      type: 'tool_start',
      callId: 'call-1',
      toolName: 'divo_gateway',
      toolId: 'googleDrive',
    },
    {
      type: 'tool_end',
      callId: 'call-1',
      toolName: 'divo_gateway',
      isError: false,
    },
    { type: 'working' },
    { type: 'thinking' },
    { type: 'thought', index: 0, text: 'Checking.' },
    { type: 'answer_delta', index: 0, delta: 'Fin' },
    { type: 'writing' },
  ]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(
    spans.filter(span => span.name.startsWith('runtime.output.')).map(span => span.name),
    [
      'runtime.output.first_progress',
      'runtime.output.first_reasoning',
      'runtime.output.first_text',
    ],
  );
});

test('rejects an unterminated oversized controller frame without buffering indefinitely', async () => {
  const service = new LarkPiRuntimeService({
    prisma: {
      memberSession: {
        findFirst: async () => ({
          sessionId: 'session-1',
          expiresAt: new Date(Date.now() + 2 * 60 * 60_000),
        }),
      },
    } as any,
    logger,
    memberJwtSecret: 'test-secret',
    backendUrl: 'https://backend.example',
    controllerUrl: 'http://127.0.0.1:4317',
    instanceId: 'pi-local-1',
    leaseTtlSeconds: 3_600,
    runTimeoutMs: 30_000,
    fetch: async () => new Response('x'.repeat(2 * 1_024 * 1_024 + 1), {
      status: 200,
      headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
    }),
  });

  await assert.rejects(
    service.run(runtimeInput()),
    (error) => error instanceof LarkPiRuntimeError
      && error.code === 'invalid_controller_stream',
  );
});

test('preserves controller capacity errors and never invokes a fallback', async () => {
  const service = new LarkPiRuntimeService({
    prisma: {
      memberSession: {
        findFirst: async () => ({
          sessionId: 'session-1',
          expiresAt: new Date(Date.now() + 2 * 60 * 60_000),
        }),
      },
    } as any,
    logger,
    memberJwtSecret: 'test-secret',
    backendUrl: 'https://backend.example',
    controllerUrl: 'http://127.0.0.1:4317',
    instanceId: 'pi-local-1',
    leaseTtlSeconds: 3_600,
    runTimeoutMs: 30_000,
    runEffectReceipts,
    fetch: async () => new Response(JSON.stringify({
      error: {
        code: 'capacity_full',
        message: 'All Pi slots are busy. Please retry.',
      },
    }), {
      status: 429,
      headers: { 'content-type': 'application/json' },
    }),
  });

  await assert.rejects(
    service.run(runtimeInput()),
    (error) => error instanceof LarkPiRuntimeError
      && error.code === 'capacity_full'
      && error.userMessage === 'Divo is at full capacity right now. Please try again shortly.',
  );
});

test('preserves capacity errors from the streamed controller protocol', async () => {
  const service = new LarkPiRuntimeService({
    prisma: {
      memberSession: {
        findFirst: async () => ({
          sessionId: 'session-1',
          expiresAt: new Date(Date.now() + 2 * 60 * 60_000),
        }),
      },
    } as any,
    logger,
    memberJwtSecret: 'test-secret',
    backendUrl: 'https://backend.example',
    controllerUrl: 'http://127.0.0.1:4317',
    instanceId: 'pi-local-1',
    leaseTtlSeconds: 3_600,
    runTimeoutMs: 30_000,
    fetch: async () => new Response(`${JSON.stringify({
      type: 'error',
      error: {
        code: 'capacity_full',
        message: 'All Pi slots are busy. Please retry.',
      },
    })}\n`, {
      status: 200,
      headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
    }),
  });

  await assert.rejects(
    service.run(runtimeInput()),
    (error) => error instanceof LarkPiRuntimeError
      && error.code === 'capacity_full'
      && error.userMessage === 'Divo is at full capacity right now. Please try again shortly.',
  );
});

test('a streamed provider failure keeps diagnostics internal', async () => {
  const service = new LarkPiRuntimeService({
    prisma: {
      memberSession: {
        findFirst: async () => ({
          sessionId: 'session-1',
          expiresAt: new Date(Date.now() + 2 * 60 * 60_000),
        }),
      },
    } as any,
    logger,
    memberJwtSecret: 'test-secret',
    backendUrl: 'https://backend.example',
    controllerUrl: 'http://127.0.0.1:4317',
    instanceId: 'pi-local-1',
    leaseTtlSeconds: 3_600,
    runTimeoutMs: 30_000,
    fetch: async () => new Response(`${JSON.stringify({
      type: 'error',
      error: {
        code: 'model_continuation_failed',
        message: 'Assistant error: Connection error. upstream-token=secret',
      },
    })}\n`, {
      status: 200,
      headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
    }),
  });

  await assert.rejects(
    service.run(runtimeInput()),
    (error) => error instanceof LarkPiRuntimeError
      && error.code === 'model_continuation_failed'
      && error.message.includes('upstream-token=secret')
      && error.userMessage === 'Divo lost the model connection while finishing this request. Please try again.'
      && !error.userMessage.includes('upstream-token=secret'),
  );
});

test('a streamed provider failure after a company action explains why Divo did not retry', async () => {
  const service = new LarkPiRuntimeService({
    prisma: {
      memberSession: {
        findFirst: async () => ({
          sessionId: 'session-1',
          expiresAt: new Date(Date.now() + 2 * 60 * 60_000),
        }),
      },
    } as any,
    logger,
    memberJwtSecret: 'test-secret',
    backendUrl: 'https://backend.example',
    controllerUrl: 'http://127.0.0.1:4317',
    instanceId: 'pi-local-1',
    leaseTtlSeconds: 3_600,
    runTimeoutMs: 30_000,
    fetch: async () => new Response(`${JSON.stringify({
      type: 'error',
      error: {
        code: 'model_continuation_failed',
        message: 'The model provider failed after a company action was issued. Divo stopped instead of retrying and risking a duplicate action.',
      },
    })}\n`, {
      status: 200,
      headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
    }),
  });

  await assert.rejects(
    service.run(runtimeInput()),
    (error) => error instanceof LarkPiRuntimeError
      && error.code === 'model_continuation_failed'
      && error.userMessage === 'Divo lost the model connection while handling a company-action step. It did not retry automatically, so it would not duplicate the action. Check the latest result before trying again.',
  );
});

test('propagates caller interruption instead of converting it to a Pi failure', async () => {
  const controller = new AbortController();
  const terminalized: unknown[] = [];
  const service = new LarkPiRuntimeService({
    prisma: {
      memberSession: {
        findFirst: async () => ({
          sessionId: 'session-1',
          expiresAt: new Date(Date.now() + 2 * 60 * 60_000),
        }),
      },
      executionRun: {
        updateMany: async (input: unknown) => {
          terminalized.push(input);
          return { count: 1 };
        },
      },
    } as any,
    logger,
    memberJwtSecret: 'test-secret',
    backendUrl: 'https://backend.example',
    controllerUrl: 'http://127.0.0.1:4317',
    instanceId: 'pi-local-1',
    leaseTtlSeconds: 3_600,
    runTimeoutMs: 30_000,
    runEffectReceipts,
    fetch: async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      controller.abort();
    }),
  });

  await assert.rejects(
    service.run({ ...runtimeInput(), abortSignal: controller.signal }),
    (error) => error instanceof DOMException && error.name === 'AbortError',
  );
  assert.equal(terminalized.length, 1);
  const update = terminalized[0] as any;
  assert.deepEqual(update.where, {
    requestId: 'trace-1',
    companyId: 'company-1',
    userId: 'user-1',
    status: 'running',
  });
  assert.equal(update.data.status, 'interrupted');
  assert.ok(update.data.finishedAt instanceof Date);
  assert.equal(update.data.errorCode, 'interrupted');
  assert.equal(update.data.errorMessage, 'Interrupted by user.');
});

// ── Attachment staging ──────────────────────────────────────────────────────

function textAttachment(name: string, body: string, mimeType = 'application/pdf') {
  return {
    kind: 'file' as const,
    name,
    mimeType,
    openStream: async () => (async function* () {
      yield new TextEncoder().encode(body);
    })(),
  };
}

function stagingService(
  onCall: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
) {
  const pendingRows: any[] = [];
  return new LarkPiRuntimeService({
    prisma: {
      memberSession: {
        findFirst: async () => ({
          sessionId: 'session-1',
          expiresAt: new Date(Date.now() + 2 * 60 * 60_000),
        }),
      },
      runtimePendingAttachment: {
        count: async () => pendingRows.filter(row => !row.consumedAt).length,
        createMany: async ({ data }: any) => {
          pendingRows.push(...data.map((row: any, index: number) => ({
            id: `pending-${pendingRows.length + index + 1}`,
            ...row,
            consumedAt: null,
          })));
          return { count: data.length };
        },
        findMany: async () => pendingRows
          .filter(row => !row.consumedAt)
          .map(row => ({ id: row.id, descriptorJson: row.descriptorJson })),
        updateMany: async ({ where, data }: any) => {
          let count = 0;
          for (const row of pendingRows) {
            if (where.id.in.includes(row.id) && !row.consumedAt) {
              row.consumedAt = data.consumedAt;
              count++;
            }
          }
          return { count };
        },
      },
    } as any,
    logger,
    memberJwtSecret: 'test-secret',
    backendUrl: 'https://backend.example',
    controllerUrl: 'http://127.0.0.1:4317',
    instanceId: 'pi-local-1',
    leaseTtlSeconds: 3_600,
    runTimeoutMs: 30_000,
    fetch: (async (url: string, init?: RequestInit) => onCall(String(url), init)) as any,
  });
}

test('files are staged into the container before the run and carry the same lease', async () => {
  const calls: Array<{ url: string; method: string; headers: Headers; body: unknown }> = [];
  const service = stagingService(async (url, init) => {
    calls.push({
      url,
      method: String(init?.method),
      headers: new Headers(init?.headers),
      body: init?.body,
    });
    if (url.endsWith('/v1/runtime-files')) {
      return new Response(
        JSON.stringify({ attachment: {
          requestId: 'request-1', fileId: 'file-1', fileName: 'bill.pdf',
          kind: 'file', mimeType: 'application/pdf', bytes: 8,
        } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify({ text: 'Done' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  await service.run({
    ...runtimeInput(),
    attachments: [textAttachment('EMIAC TI 0714.pdf', '%PDF-1.7')],
  });

  assert.equal(calls.length, 2);
  // Order matters: a run must never start before its files exist in the volume.
  assert.ok(calls[0]!.url.endsWith('/v1/runtime-files'));
  assert.equal(calls[0]!.method, 'PUT');
  assert.ok(calls[1]!.url.endsWith('/v1/lark-runs'));

  const lease = String(JSON.parse(String(calls[1]!.body))['runtimeLease']);
  assert.equal(calls[0]!.headers.get('authorization'), `Bearer ${lease}`);
  assert.equal(calls[0]!.headers.get('content-type'), 'application/pdf');
  assert.equal(calls[0]!.headers.get('x-divo-file-id'), 'file-1');
  assert.equal(calls[0]!.headers.get('x-divo-file-kind'), 'file');
  assert.equal(
    Buffer.from(calls[0]!.headers.get('x-divo-file-name') ?? '', 'base64url').toString('utf8'),
    'EMIAC TI 0714.pdf',
  );
});

test('an attachment-only DM stages bytes without starting a model run', async () => {
  const calls: Array<{ url: string; authorization: string | null }> = [];
  let runBody: any;
  const service = stagingService(async (url, init) => {
    calls.push({
      url,
      authorization: new Headers(init?.headers).get('authorization'),
    });
    if (url.endsWith('/v1/runtime-files')) {
      return new Response(
        JSON.stringify({ attachment: {
          requestId: 'request-1', fileId: 'file-1', fileName: 'notes.txt',
          kind: 'file', mimeType: 'text/plain', bytes: 13,
        } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    runBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ text: 'Summarized.' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  await service.stagePendingAttachments({
    ...runtimeInput(),
    incoming: {
      ...runtimeInput().incoming,
      chatType: 'p2p',
      messageId: 'om-file-only',
      text: '',
    },
    attachments: [textAttachment('notes.txt', 'private notes', 'text/plain')],
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /\/v1\/runtime-files$/);
  const lease = String(calls[0]!.authorization).replace(/^Bearer /, '');
  const claims = JSON.parse(Buffer.from(lease.split('.')[1]!, 'base64url').toString('utf8'));
  assert.equal(claims.contextAudience, 'private');
  assert.equal(claims.runId, 'trace-1');

  await service.run({
    ...runtimeInput(),
    incoming: {
      ...runtimeInput().incoming,
      chatType: 'p2p',
      messageId: 'om-follow-up',
      text: 'Please summarize the file I just sent.',
    },
  });
  assert.equal(runBody.attachments.length, 1);
  assert.equal(runBody.attachments[0].fileName, 'notes.txt');
});

test('attachment bytes stream rather than riding in JSON or base64', async () => {
  let uploadBody: unknown;
  const service = stagingService(async (url, init) => {
    if (url.endsWith('/v1/runtime-files')) {
      uploadBody = init?.body;
      return new Response(JSON.stringify({ attachment: {
        requestId: 'request-1', fileId: 'file-1', fileName: 'bill.pdf',
        kind: 'file', mimeType: 'application/pdf', bytes: 14,
      } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ text: 'Done' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  await service.run({
    ...runtimeInput(),
    attachments: [textAttachment('bill.pdf', 'STREAMED-BYTES')],
  });

  assert.ok(uploadBody instanceof ReadableStream, 'body must be a stream, not a buffered string');
  const received = await new Response(uploadBody as ReadableStream).text();
  assert.equal(received, 'STREAMED-BYTES');
});

test('only the controller-issued descriptors reach the run request', async () => {
  let runBody: Record<string, unknown> | undefined;
  const service = stagingService(async (url, init) => {
    if (url.endsWith('/v1/runtime-files')) {
      return new Response(
        JSON.stringify({
          attachment: {
            requestId: 'request-1', fileId: 'file-1', fileName: 'bill.pdf', bytes: 8,
            kind: 'file', mimeType: 'application/pdf',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    runBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ text: 'Done' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  await service.run({
    ...runtimeInput(),
    attachments: [textAttachment('local name.pdf', 'bytes')],
  });

  assert.deepEqual(runBody?.['attachments'], [
    {
      requestId: 'request-1',
      fileId: 'file-1',
      fileName: 'bill.pdf',
      kind: 'file',
      mimeType: 'application/pdf',
      bytes: 8,
    },
  ]);
});

test('a run with no attachments omits the field entirely', async () => {
  let runBody: Record<string, unknown> | undefined;
  const service = stagingService(async (_url, init) => {
    runBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ text: 'Done' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  await service.run(runtimeInput());
  assert.equal('attachments' in (runBody ?? {}), false);
});

// Five screenshots in one message is an ordinary thing to send. Refusing the
// whole turn for it answered nothing at all; the run now gets the first four and
// is told, by name, which it does not have — so the shortfall reaches the user
// instead of being hidden inside a confident answer built from a subset.
test('past the fourth file the run is trimmed and told what it is missing', async () => {
  let opened = 0;
  let runBody: Record<string, unknown> | undefined;
  const service = stagingService(async (url, init) => {
    if (url.endsWith('/v1/lark-runs')) {
      runBody = JSON.parse(String((init as RequestInit | undefined)?.body ?? '{}')) as Record<string, unknown>;
      return new Response(JSON.stringify({ text: 'ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    const headers = new Headers(init?.headers);
    return new Response(JSON.stringify({
      attachment: {
        requestId: headers.get('x-divo-request-id'),
        fileId: headers.get('x-divo-file-id'),
        fileName: `shot-${opened}.png`,
        kind: 'image',
        mimeType: 'image/png',
        bytes: 1,
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });

  const attachment = (index: number) => ({
    kind: 'image' as const,
    name: `shot-${index}.png`,
    mimeType: 'image/png',
    openStream: async () => {
      opened += 1;
      return (async function* () { yield new Uint8Array([1]); })();
    },
  });

  await service.run({ ...runtimeInput(), attachments: [1, 2, 3, 4, 5, 6].map(attachment) });

  assert.equal(opened, 4);
  assert.equal((runBody?.['attachments'] as unknown[]).length, 4);
  const message = String(runBody?.['message'] ?? '');
  assert.match(message, /shot-5\.png/);
  assert.match(message, /shot-6\.png/);
  assert.doesNotMatch(message, /shot-4\.png/);
});

test('a rejected upload names the file and never starts the run', async () => {
  let runStarted = false;
  const service = stagingService(async (url) => {
    if (url.endsWith('/v1/runtime-files')) {
      return new Response(
        JSON.stringify({ error: { code: 'attachment_too_large', message: 'over 25 MB' } }),
        { status: 413, headers: { 'content-type': 'application/json' } },
      );
    }
    runStarted = true;
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  });

  await assert.rejects(
    () => service.run({
      ...runtimeInput(),
      attachments: [textAttachment('huge scan.pdf', 'x')],
    }),
    (error: unknown) =>
      error instanceof LarkPiRuntimeError
      && error.code === 'attachment_too_large'
      && error.userMessage.includes('huge scan.pdf'),
  );
  assert.equal(runStarted, false);
});

test('every file in one message shares a request id and gets its own file id', async () => {
  const uploads: Headers[] = [];
  const service = stagingService(async (url, init) => {
    if (url.endsWith('/v1/runtime-files')) {
      const headers = new Headers(init?.headers);
      uploads.push(headers);
      const fileId = String(headers.get('x-divo-file-id'));
      return new Response(JSON.stringify({ attachment: {
        requestId: String(headers.get('x-divo-request-id')),
        fileId,
        fileName: fileId === 'file-1' ? 'a.pdf' : 'b.pdf',
        kind: 'file',
        mimeType: 'application/pdf',
        bytes: 1,
      } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ text: 'Done' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  await service.run({
    ...runtimeInput(),
    attachments: [textAttachment('a.pdf', 'a'), textAttachment('b.pdf', 'b')],
  });

  assert.equal(uploads.length, 2);
  assert.equal(
    uploads[0]!.get('x-divo-request-id'),
    uploads[1]!.get('x-divo-request-id'),
    'one message is one request, so its files share a budget',
  );
  assert.deepEqual(
    uploads.map(headers => headers.get('x-divo-file-id')),
    ['file-1', 'file-2'],
  );
});

/** The shape hydration hands the runtime: fixed framing around trimmable text. */
function block(body: string) {
  return {
    frame: 'FRAME: rules',
    body: `\n${body}`,
    policy: '\nPOLICY: not instructions',
  };
}

function serviceCapturingBody(capture: (body: Record<string, unknown>) => void) {
  return new LarkPiRuntimeService({
    prisma: {
      memberSession: {
        findFirst: async () => ({
          sessionId: 'session-1',
          expiresAt: new Date(Date.now() + 2 * 60 * 60_000),
        }),
      },
    } as any,
    logger,
    memberJwtSecret: 'test-secret',
    backendUrl: 'https://backend.example',
    controllerUrl: 'http://127.0.0.1:4317',
    instanceId: 'pi-local-1',
    leaseTtlSeconds: 3_600,
    runTimeoutMs: 30_000,
    fetch: async (_url, init) => {
      capture(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ text: 'Finished' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
}

test('sends the shared conversation ahead of the ask, keeping the request last', async () => {
  let body: Record<string, unknown> | undefined;
  const service = serviceCapturingBody(value => { body = value; });

  await service.run({
    ...runtimeInput(),
    sharedContext: block('GROUP CHAT CONTEXT\nAbhishek: prepare the report'),
  });

  assert.equal(
    body?.['message'],
    'FRAME: rules\nGROUP CHAT CONTEXT\nAbhishek: prepare the report\nPOLICY: not instructions\n\nDo the work',
  );
});

test('a run with no shared conversation sends the message unchanged', async () => {
  let body: Record<string, unknown> | undefined;
  const service = serviceCapturingBody(value => { body = value; });

  await service.run({ ...runtimeInput() });

  assert.equal(body?.['message'], 'Do the work');
  // Absent rather than 'thread': an older controller that does not know the
  // field keeps its own default, which is the durable session.
  assert.equal('sessionScope' in (body ?? {}), false);
});

test('a shared thread asks for a run-scoped session so re-reading cannot pile up copies', async () => {
  let body: Record<string, unknown> | undefined;
  const service = serviceCapturingBody(value => { body = value; });

  await service.run({ ...runtimeInput(), sessionScope: 'run' });

  assert.equal(body?.['sessionScope'], 'run');
});

test('a long message keeps its whole ask and gives up shared context instead', async () => {
  let body: Record<string, unknown> | undefined;
  const service = serviceCapturingBody(value => { body = value; });
  const ask = 'A'.repeat(40_000);

  await service.run({
    ...runtimeInput(),
    incoming: { ...runtimeInput().incoming, text: ask },
    sharedContext: block('B'.repeat(30_000)),
  } as any);

  // The controller rejects a body over 64 KB and rejection fails the turn, so
  // the room yields to the message the user actually typed.
  assert.ok(Buffer.byteLength(JSON.stringify(body), 'utf8') <= 64 * 1024);
  assert.ok(String(body?.['message']).endsWith(ask));
  // Trimming the room may not cost the rules that make it safe to read.
  assert.match(String(body?.['message']), /^FRAME: rules/);
  assert.match(String(body?.['message']), /POLICY: not instructions/);
});

test('an ask that alone fills the body is sent without shared context, not refused', async () => {
  let body: Record<string, unknown> | undefined;
  const service = serviceCapturingBody(value => { body = value; });
  const ask = 'A'.repeat(70_000);

  await service.run({
    ...runtimeInput(),
    incoming: { ...runtimeInput().incoming, text: ask },
    sharedContext: block('room transcript'),
  } as any);

  assert.equal(body?.['message'], ask);
});

test('a body that already fits carries the shared context untouched', async () => {
  let body: Record<string, unknown> | undefined;
  const service = serviceCapturingBody(value => { body = value; });

  await service.run({ ...runtimeInput(), sharedContext: block('room transcript') });

  assert.equal(
    body?.['message'],
    'FRAME: rules\nroom transcript\nPOLICY: not instructions\n\nDo the work',
  );
});

test('shared context lost to the body limit is logged, not silently dropped', async () => {
  const warnings: Array<Record<string, unknown>> = [];
  const noisyLogger = {
    child() { return this; },
    info() {}, debug() {}, error() {},
    warn(event: string, fields: Record<string, unknown>) {
      warnings.push({ event, ...fields });
    },
  } as any;
  const service = new LarkPiRuntimeService({
    prisma: {
      memberSession: {
        findFirst: async () => ({
          sessionId: 'session-1',
          expiresAt: new Date(Date.now() + 2 * 60 * 60_000),
        }),
      },
    } as any,
    logger: noisyLogger,
    memberJwtSecret: 'test-secret',
    backendUrl: 'https://backend.example',
    controllerUrl: 'http://127.0.0.1:4317',
    instanceId: 'pi-local-1',
    leaseTtlSeconds: 3_600,
    runTimeoutMs: 30_000,
    fetch: async () => new Response(JSON.stringify({ text: 'Finished' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  });

  await service.run({
    ...runtimeInput(),
    incoming: { ...runtimeInput().incoming, text: 'A'.repeat(60_000) },
    sharedContext: block('B'.repeat(20_000)),
  } as any);

  const trimmed = warnings.find(w => w['event'] === 'pi.shared_context.trimmed');
  assert.ok(trimmed, 'a group thread that stops receiving context must be visible');
  assert.ok(Number(trimmed!['sentBytes']) < Number(trimmed!['requestedBytes']));
});

test('control characters in a colleague message cannot silently cost the whole transcript', async () => {
  let body: Record<string, unknown> | undefined;
  const service = serviceCapturingBody(value => { body = value; });

  // Each of these serializes to six bytes, so escaping inflates the body far
  // past what trimming by the raw overflow alone would recover.
  await service.run({
    ...runtimeInput(),
    sharedContext: block('\u0001'.repeat(20_000)),
  } as any);

  assert.ok(Buffer.byteLength(JSON.stringify(body), 'utf8') <= 64 * 1024);
  // Some of the room survives rather than none of it.
  assert.match(String(body?.['message']), /Do the work$/);
  // Some of the room survives rather than none of it, and it is still framed.
  assert.match(String(body?.['message']), /^FRAME: rules/);
  assert.match(String(body?.['message']), /POLICY: not instructions/);
});

test('a caller-issued session is used verbatim, not the member\'s own sign-in', async () => {
  // Session lookup prefers a real sign-in so an interactive turn is never handed
  // a machine session that is about to be revoked. A scheduled run has to opt
  // out of that: tools decide the runtime owns delivery by reading how the
  // session was issued, and borrowing the member's sign-in makes a scheduled run
  // look like the person typing — with every delivery guard off.
  const queries: Record<string, unknown>[] = [];
  const service = new LarkPiRuntimeService({
    prisma: {
      memberSession: {
        findFirst: async (query: Record<string, unknown>) => {
          queries.push(query);
          const where = query['where'] as Record<string, unknown>;
          return where['sessionId'] === 'machine-sess'
            ? { sessionId: 'machine-sess', expiresAt: new Date(Date.now() + 2 * 60 * 60_000) }
            : { sessionId: 'human-sess', expiresAt: new Date(Date.now() + 2 * 60 * 60_000) };
        },
      },
    } as any,
    logger,
    memberJwtSecret: 'test-secret',
    backendUrl: 'https://backend.example',
    controllerUrl: 'http://127.0.0.1:4317/',
    instanceId: 'pi-local-1',
    leaseTtlSeconds: 3_600,
    runTimeoutMs: 30_000,
    fetch: async () => new Response(JSON.stringify({ text: 'Finished' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  });

  await service.run({ ...runtimeInput(), sessionId: 'machine-sess' });

  assert.equal(queries.length, 1, 'the preference query must be skipped entirely');
  const where = queries[0]?.['where'] as Record<string, unknown>;
  assert.equal(where['sessionId'], 'machine-sess');
  // Never widened to "any session for this member".
  assert.equal(where['userId'], 'user-1');
  assert.equal(where['revokedAt'], null);
});

test('the run asks for Spark when Lark supplies no choice', async () => {
  let runBody: Record<string, unknown> | undefined;
  const service = new LarkPiRuntimeService({
    prisma: {
      memberSession: {
        findFirst: async () => ({
          sessionId: 'session-1',
          expiresAt: new Date(Date.now() + 2 * 60 * 60_000),
        }),
      },
    } as any,
    logger,
    memberJwtSecret: 'test-secret',
    backendUrl: 'https://backend.example',
    controllerUrl: 'http://127.0.0.1:4317',
    instanceId: 'pi-local-1',
    leaseTtlSeconds: 3_600,
    runTimeoutMs: 30_000,
    fetch: (async (_url: string, init?: RequestInit) => {
      runBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return new Response(JSON.stringify({ text: 'ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as any,
  });

  await service.run(runtimeInput());

  // Moved off DeepSeek deliberately; DeepSeek stays selectable, it is simply no
  // longer what a Lark run gets when nobody chose. `medium` is Spark's own
  // default rung, and there is no `off` to fall back to — Spark reasons on
  // every call.
  assert.equal(runBody?.['model'], 'muse-spark-1.2-contributor');
  assert.equal(runBody?.['provider'], 'meta');
  assert.equal(runBody?.['thinkingLevel'], 'medium');
});

test('an allowed web choice reaches the controller as the exact model and effort pair', async () => {
  let runBody: Record<string, unknown> | undefined;
  const service = new LarkPiRuntimeService({
    prisma: {
      memberSession: {
        findFirst: async () => ({
          sessionId: 'session-1',
          expiresAt: new Date(Date.now() + 2 * 60 * 60_000),
        }),
      },
    } as any,
    logger,
    memberJwtSecret: 'test-secret',
    backendUrl: 'https://backend.example',
    controllerUrl: 'http://127.0.0.1:4317',
    instanceId: 'pi-local-1',
    leaseTtlSeconds: 3_600,
    runTimeoutMs: 30_000,
    allowedModelsFor: async () => ['gpt-5.6-luna'],
    fetch: (async (_url: string, init?: RequestInit) => {
      runBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return new Response(JSON.stringify({ text: 'ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as any,
  });

  await service.run({
    ...runtimeInput(),
    modelSelection: { model: 'gpt-5.6-luna', reasoningEffort: 'medium' },
  });

  assert.equal(runBody?.['model'], 'gpt-5.6-luna');
  assert.equal(runBody?.['provider'], 'openai');
  assert.equal(runBody?.['thinkingLevel'], 'medium');
});

test('a tampered web choice is refused before the controller is called', async () => {
  const service = new LarkPiRuntimeService({
    prisma: {} as any,
    logger,
    memberJwtSecret: 'test-secret',
    backendUrl: 'https://backend.example',
    controllerUrl: 'http://127.0.0.1:4317',
    instanceId: 'pi-local-1',
    leaseTtlSeconds: 3_600,
    runTimeoutMs: 30_000,
    allowedModelsFor: async () => ['deepseek-v4-flash'],
  });

  await assert.rejects(
    service.modelFor('user-1', { model: 'gpt-5.6-luna', reasoningEffort: 'high' }),
    (error) => error instanceof LarkPiRuntimeError && error.code === 'model_not_allowed',
  );
});

function larkIngressInput(overrides: Record<string, unknown> = {}) {
  const base = runtimeInput();
  return {
    ...base,
    incoming: {
      ...base.incoming,
      channel: 'lark',
      messageId: 'om_request',
      chatType: 'group',
      tenantKey: 'tenant-1',
      userExternalId: 'ou-user-1',
      rootMessageId: 'om_root',
      groupReplyMode: 'threaded',
      ...overrides,
    },
    conversation: { ...base.conversation, replyInThread: true },
  } as any;
}

function originRecordingService(
  runOrigins: { remember: (runId: string, origin: unknown) => Promise<boolean> },
) {
  return new LarkPiRuntimeService({
    prisma: {
      memberSession: {
        findFirst: async () => ({
          sessionId: 'session-1',
          expiresAt: new Date(Date.now() + 2 * 60 * 60_000),
        }),
      },
    } as any,
    logger,
    memberJwtSecret: 'test-secret',
    backendUrl: 'https://backend.example',
    controllerUrl: 'http://127.0.0.1:4317/',
    instanceId: 'pi-local-1',
    leaseTtlSeconds: 3_600,
    runTimeoutMs: 30_000,
    runEffectReceipts,
    runOrigins,
    fetch: async () => new Response(JSON.stringify({ text: 'Finished' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  });
}

// The run is the only moment the inbound Lark request still exists. A tool that
// later needs Google OAuth has to send a card back into this conversation and
// re-run this ask, and for a long time nothing recorded either, so the card was
// never sent at all.
test('records where a Lark run came from so a deferred authorization can resume it', async () => {
  const written: Array<{ runId: string; origin: any }> = [];
  const service = originRecordingService({
    remember: async (runId, origin) => { written.push({ runId, origin: origin as any }); return true; },
  });

  await service.run(larkIngressInput());

  assert.equal(written.length, 1);
  assert.equal(written[0]!.runId, 'trace-1');
  assert.deepEqual(written[0]!.origin, {
    version: 1,
    channel: 'lark',
    companyId: 'company-1',
    userId: 'user-1',
    originalRequest: 'Do the work',
    conversationKey: 'chat-1',
    lark: {
      larkOpenId: 'ou-user-1',
      larkTenantKey: 'tenant-1',
      chatId: 'chat-1',
      chatType: 'group',
      originalMessageId: 'om_request',
      rootMessageId: 'om_root',
      replyInThread: true,
      groupReplyMode: 'threaded',
    },
  });
});

test('records nothing for a run with no tenant identity to authorize against', async () => {
  const written: unknown[] = [];
  const service = originRecordingService({
    remember: async (_runId, origin) => { written.push(origin); return true; },
  });

  // A scheduled run reaches the same code path without a real Lark event
  // behind it. There is no conversation to continue in, so inventing an origin
  // would only produce a Connect card nobody asked for.
  await service.run(larkIngressInput({ tenantKey: undefined }));

  assert.deepEqual(written, []);
});

test('a run survives an unwritable origin, losing only the Connect card', async () => {
  const service = originRecordingService({
    remember: async () => { throw new Error('redis down'); },
  });

  assert.equal((await service.run(larkIngressInput())).text, 'Finished');
});

// A web run holds a real signed-in session but has no Lark open id, and the
// identity guard used to run before the named-session branch — so it answered
// "Your Divo cloud session is not active" to somebody demonstrably signed in.
test('a caller that names its session needs no Lark identity to find it', async () => {
  let sessionQuery: Record<string, unknown> | undefined;
  const service = new LarkPiRuntimeService({
    prisma: {
      memberSession: {
        findFirst: async (query: Record<string, unknown>) => {
          sessionQuery = query;
          return { sessionId: 'session-web', expiresAt: new Date(Date.now() + 2 * 60 * 60_000) };
        },
      },
    } as any,
    logger,
    memberJwtSecret: 'test-secret',
    backendUrl: 'https://backend.example',
    controllerUrl: 'http://127.0.0.1:4317/',
    instanceId: 'pi-local-1',
    leaseTtlSeconds: 3_600,
    runTimeoutMs: 30_000,
    fetch: async () => new Response(JSON.stringify({ text: 'Finished' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  });

  const base = runtimeInput();
  const result = await service.run({
    ...base,
    sessionId: 'session-web',
    incoming: { ...base.incoming, channel: 'web' },
    runContext: {
      companyId: 'company-1',
      userId: 'user-1',
      companyRole: 'MEMBER',
      channel: 'web',
    },
  } as any);

  assert.equal(result.text, 'Finished');
  const where = sessionQuery?.['where'] as Record<string, unknown>;
  assert.equal(where['sessionId'], 'session-web');
  // Looked up by the session the caller is holding, pinned to this member —
  // never by a Lark tenant/open-id pair a web caller does not have.
  assert.equal('larkOpenId' in where, false);
  assert.equal('larkTenantKey' in where, false);
});

// The lease is what carries the surface into the container, where the
// presentation policy is built from it.
test('a web run leases the web surface, not Lark', async () => {
  let body: Record<string, unknown> | undefined;
  const service = serviceCapturingBody(value => { body = value; });
  const base = runtimeInput();

  await service.run({
    ...base,
    sessionId: 'session-1',
    incoming: { ...base.incoming, channel: 'web' },
  } as any);

  const lease = String(body?.['runtimeLease']);
  const claims = JSON.parse(Buffer.from(lease.split('.')[1]!, 'base64url').toString('utf8'));
  assert.equal(claims.channel, 'web');
});
