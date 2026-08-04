import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LarkPiRuntimeError,
  LarkPiRuntimeService,
} from '../../src/application/runtime/lark-pi-runtime.service.ts';

const logger = {
  child() { return this; },
  info() {},
  warn() {},
  error() {},
  debug() {},
} as any;
const runEffectReceipts = {
  getVerifiedKnowledgeEffect: async () => null,
  getVerifiedDataExportOffer: async () => null,
  getVerifiedWorkbookConversionOffer: async () => null,
};

function runtimeInput() {
  return {
    incoming: {
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

test('injects verified recent exports for the exact conversation without backend handles', async () => {
  let controllerBody: Record<string, unknown> | undefined;
  let historyLookup: unknown;
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
      getHistory: async () => assert.fail('dedicated export lookup must be used'),
      getRecentToolTurns: async (conversationKey, toolName, limit, scope, ownerUserId) => {
        historyLookup = { conversationKey, toolName, limit, scope, ownerUserId };
        return {
          ok: true as const,
          value: [{
            id: 'turn-1',
            role: 'tool' as const,
            content: 'verified export',
            timestamp: '2026-08-02T00:00:00.000Z',
            toolName: 'dataExportResource',
            toolOutcome: {
              version: 1,
              kind: 'data_export_resource',
              resourceRef: 'resource-safe-1',
              ownerUserId: 'user-1',
              artifactId: 'sheet-secret-id',
              artifactUrl: 'https://docs.google.com/spreadsheets/d/sheet-secret-id/edit',
              artifactType: 'google_sheet',
              rowCount: 50,
              connectionId: 'connection-secret-id',
              spreadsheetId: 'sheet-secret-id',
              createdAt: '2026-08-02T00:00:00.000Z',
              expiresAt: '2099-08-09T00:00:00.000Z',
            },
          }],
        };
      },
      appendTurn: async () => assert.fail('non-p2p test must not append conversation turns'),
    },
    fetch: async (_url, init) => {
      controllerBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ text: 'Finished' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  await service.run(runtimeInput());

  assert.deepEqual(historyLookup, {
    conversationKey: 'lark:chat-1:user-1',
    toolName: 'dataExportResource',
    limit: 5,
    scope: { companyId: 'company-1', channel: 'lark' },
    ownerUserId: 'user-1',
  });
  const message = String(controllerBody?.['message']);
  assert.match(message, /RECENT DIVO EXPORTS/);
  assert.match(message, /resource-safe-1/);
  assert.match(message, /https:\/\/docs\.google\.com\/spreadsheets\/d\/sheet-secret-id\/edit/);
  assert.match(message, /op=call_exported_sheet and resourceRef/);
  assert.match(message, /Do not resolve its URL, choose an account/);
  assert.match(message, /CURRENT USER REQUEST:\nDo the work/);
  assert.doesNotMatch(message, /connection-secret-id|connectionId|spreadsheetId/);
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

test('turns a verified export offer receipt into explicit governed format choices', async () => {
  const offerId = '11111111-1111-4111-8111-111111111111';
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
      getVerifiedDataExportOffer: async identity => ({
        version: 1,
        kind: 'data_export_offer',
        status: 'offered',
        effectKind: 'data_export_offered',
        ...identity,
        offerId,
        createdAt: '2026-08-02T00:00:00.000Z',
      }),
    },
    fetch: async () => new Response(JSON.stringify({ text: 'I found more rows.' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  });

  const result = await service.run(runtimeInput());

  assert.deepEqual(result.actions, [
    {
      label: 'Google Sheet',
      value: JSON.stringify({ kind: 'data_export_confirm', offerId, format: 'google_sheet' }),
      style: 'primary',
    },
    {
      label: 'CSV in Drive',
      value: JSON.stringify({ kind: 'data_export_confirm', offerId, format: 'csv' }),
    },
    {
      label: 'Excel (.xlsx)',
      value: JSON.stringify({ kind: 'data_export_confirm', offerId, format: 'xlsx' }),
    },
  ]);
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
      getVerifiedDataExportOffer: async () => null,
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
          companyId: 'company-1',
          userId: 'user-1',
          larkOpenId: 'ou-user-1',
          larkTenantKey: 'tenant-1',
          chatId: 'chat-1',
          chatType: 'p2p',
          originalMessageId: 'message-1',
          replyInThread: false,
          originalRequest: 'Read my mail',
          googleAuthorization: {
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
      getVerifiedDataExportOffer: async () => null,
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
    { type: 'writing' },
  ]);
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
      && error.userMessage === 'Divo hit a temporary problem while finishing this request. Please try again.',
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
  assert.equal(update.data.status, 'failed');
  assert.ok(update.data.finishedAt instanceof Date);
  assert.equal(update.data.errorCode, 'interrupted');
  assert.equal(update.data.errorMessage, 'The Pi run was interrupted.');
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
    incoming: { traceId: 'trace-1', text: ask },
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
    incoming: { traceId: 'trace-1', text: ask },
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
    incoming: { traceId: 'trace-1', text: 'A'.repeat(60_000) },
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

test('the run asks for the Pro model pinned to the Lark channel', async () => {
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

  assert.equal(runBody?.['model'], 'deepseek-v4-pro');
  assert.equal(runBody?.['provider'], 'deepseek');
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
    companyId: 'company-1',
    userId: 'user-1',
    larkOpenId: 'ou-user-1',
    larkTenantKey: 'tenant-1',
    chatId: 'chat-1',
    chatType: 'group',
    originalMessageId: 'om_request',
    rootMessageId: 'om_root',
    replyInThread: true,
    groupReplyMode: 'threaded',
    originalRequest: 'Do the work',
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

test('the export lookup and the knowledge recall are in flight together', async () => {
  const events: string[] = [];
  const settleLater = () => new Promise(resolve => setTimeout(resolve, 5));
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
      getHistory: async () => ({ ok: true as const, value: [] }),
      getRecentToolTurns: async () => {
        events.push('history:start');
        await settleLater();
        events.push('history:end');
        return { ok: true as const, value: [] };
      },
      appendTurn: async () => assert.fail('non-p2p test must not append conversation turns'),
    },
    knowledgeRecall: {
      recall: async () => {
        events.push('recall:start');
        await settleLater();
        events.push('recall:end');
        return { facts: [] };
      },
    } as any,
    fetch: async () => new Response(JSON.stringify({ text: 'Finished' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  });

  await service.run(runtimeInput());

  // Run one behind the other, the history read would have finished before the
  // recall was even issued, putting both round trips in front of the container
  // start. Overlapping is the whole point.
  assert.deepEqual(events, ['history:start', 'recall:start', 'history:end', 'recall:end']);
});
