import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { GOOGLE_WORKSPACE_OAUTH_SCOPES } from '../../src/domain/google/google-workspace-scope.ts';
import { GoogleConnectionAuthorizationService } from '../../src/application/connections/google-connection-authorization.service.ts';
import {
  GoogleConnectionContinuationQueue,
  GoogleConnectionContinuationWorker,
} from '../../src/application/connections/google-connection-continuation.ts';
import {
  buildGoogleConnectCard,
  googleConnectFallbackText,
} from '../../src/infrastructure/channels/lark/lark-google-connect.ts';
import { createGoogleConnectionRoutes } from '../../src/http/google/google-connection.routes.ts';
import { IntegrationConnectionRepository } from '../../src/infrastructure/persistence/integration-connection.repository.ts';

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: function() { return this; },
} as any;

const TARGET = {
  intentId: 'intent-1',
  provider: 'google_workspace' as const,
  companyId: 'company-1',
  userId: 'user-1',
  departmentId: 'department-old',
  larkOpenId: 'ou_user',
  larkTenantKey: 'tenant-1',
  chatId: 'oc_chat',
  chatType: 'group',
  originalMessageId: 'om_original',
  rootMessageId: 'om_root',
  replyInThread: true,
  groupReplyMode: 'threaded',
  originalRequest: 'Forward new OTP mail from alerts@example.com to Alice',
  requestedToolIds: ['mailAutomations'],
  correlationId: 'correlation-1',
  continuationIdempotencyKey: 'google-oauth-continuation:correlation-1',
};

const claimedCallback = {
  outcome: 'claimed' as const,
  intent: TARGET,
};

const savedConnection = {
  id: 'connection-1',
  companyId: 'company-1',
  provider: 'google_workspace',
  ownerType: 'user',
  ownerUserId: 'user-1',
  label: 'user@example.com Google Workspace',
  accountEmail: 'user@example.com',
  status: 'connected',
  scopes: [...GOOGLE_WORKSPACE_OAUTH_SCOPES],
  accessToken: 'access-secret',
  refreshToken: 'refresh-secret',
  connectedAt: new Date(),
};

describe('GoogleConnectionAuthorizationService', () => {
  it('issues an opaque authorize URL for the exact cloud callback', async () => {
    let authorizeInput: any;
    const service = new GoogleConnectionAuthorizationService({
      intentRepo: {
        create: async () => ({
          ok: true,
          value: {
            outcome: 'issued',
            intentId: 'intent-1',
            state: 'opaque-state',
            expiresAt: new Date('2026-07-29T05:10:00.000Z'),
            correlationId: 'correlation-1',
          },
        }),
      } as any,
      googleOAuth: {
        getAuthorizeUrl: (input: any) => {
          authorizeInput = input;
          return `https://accounts.google.test/auth?state=${input.state}`;
        },
      } as any,
      connectionRepo: {} as any,
      callbackUrl: 'http://localhost:8000/api/google/connection/callback',
      logger: noopLogger,
    });

    const issued = await service.issue(TARGET);

    assert.equal(issued.authorizeUrl, 'https://accounts.google.test/auth?state=opaque-state');
    assert.deepEqual(authorizeInput, {
      state: 'opaque-state',
      redirectUri: 'http://localhost:8000/api/google/connection/callback',
      // A mail rule asks for mail. `gmail.send` is named in its own right
      // because Google's `gmail.modify` does not carry it, and a forward that
      // cannot send is the failure this narrowing would otherwise introduce.
      scopes: [
        'openid',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile',
        'https://www.googleapis.com/auth/gmail.modify',
        'https://www.googleapis.com/auth/gmail.send',
        'https://www.googleapis.com/auth/gmail.labels',
      ],
    });
    // The point of the whole change: somebody who asked for a mail rule is
    // never shown Drive, Calendar or Apps Script on the consent screen.
    for (const absent of ['drive', 'calendar', 'documents', 'spreadsheets', 'script']) {
      assert.equal(
        (authorizeInput.scopes as string[]).some(scope => scope.includes(absent)),
        false,
        `mail authorization should not request ${absent}`,
      );
    }
    assert.equal(issued.authorizeUrl.includes('company-1'), false);
    assert.equal(issued.authorizeUrl.includes('user-1'), false);
  });

  it('stores one user-owned full-scope connection then releases continuation', async () => {
    let upsertInput: any;
    let mailBriefInput: any;
    const service = new GoogleConnectionAuthorizationService({
      intentRepo: {
        claimCallback: async () => ({ ok: true, value: claimedCallback }),
        stageExchangeTokens: async () => ({ ok: true, value: true }),
        markAuthorizationFailed: async () => ({ ok: true, value: undefined }),
      } as any,
      googleOAuth: {
        exchangeAuthorizationCode: async () => ({
          accessToken: 'access-secret',
          refreshToken: 'refresh-secret',
          tokenType: 'Bearer',
          expiresIn: 3600,
          scope: GOOGLE_WORKSPACE_OAUTH_SCOPES.join(' '),
        }),
        fetchUserInfo: async () => ({
          sub: 'google-user-1',
          email: 'user@example.com',
          name: 'Divo User',
        }),
      } as any,
      connectionRepo: {
        upsertGoogleConnection: async (input: any) => {
          upsertInput = input;
          return { ok: true, value: savedConnection };
        },
      } as any,
      mailBriefOnboarding: async (input: any) => {
        mailBriefInput = input;
        return { ok: true, value: { subscriptionId: 'sub-1', briefId: 'brief-1', mailboxCreated: true, briefCreated: true, firstBriefQueued: true } };
      },
      callbackUrl: 'https://app-dev.example/api/google/connection/callback',
      logger: noopLogger,
    });

    const completion = await service.complete({
      state: 'opaque-state',
      code: 'google-code',
    });

    assert.deepEqual(completion, {
      outcome: 'connected',
      intentId: 'intent-1',
      connectionId: 'connection-1',
      accountName: 'user@example.com',
    });
    assert.equal(upsertInput.companyId, 'company-1');
    assert.equal(upsertInput.ownerType, 'user');
    assert.equal(upsertInput.ownerUserId, 'user-1');
    assert.equal(upsertInput.refreshToken, 'refresh-secret');
    assert.equal(upsertInput.authorizationIntentId, 'intent-1');
    assert.deepEqual(mailBriefInput, {
      companyId: 'company-1',
      userId: 'user-1',
      connectionId: 'connection-1',
      mailboxEmail: 'user@example.com',
    });
  });

  it('does not start mail brief for a Docs authorization with prior Gmail scopes', async () => {
    let mailBriefCalled = false;
    const service = new GoogleConnectionAuthorizationService({
      intentRepo: {
        claimCallback: async () => ({
          ok: true,
          value: {
            outcome: 'claimed',
            intent: { ...TARGET, requestedToolIds: ['googleDocs'] },
          },
        }),
        stageExchangeTokens: async () => ({ ok: true, value: true }),
        markAuthorizationFailed: async () => ({ ok: true, value: undefined }),
      } as any,
      googleOAuth: {
        exchangeAuthorizationCode: async () => ({
          accessToken: 'access-secret',
          refreshToken: 'refresh-secret',
          tokenType: 'Bearer',
          expiresIn: 3600,
          scope: [
            'openid',
            'https://www.googleapis.com/auth/userinfo.email',
            'https://www.googleapis.com/auth/userinfo.profile',
            'https://www.googleapis.com/auth/documents',
            'https://www.googleapis.com/auth/drive.readonly',
            'https://www.googleapis.com/auth/drive.file',
            'https://www.googleapis.com/auth/spreadsheets',
            // Incremental OAuth may return previously granted Gmail scopes.
            // They must not turn this Docs callback into Mail onboarding.
            'https://www.googleapis.com/auth/gmail.modify',
            'https://www.googleapis.com/auth/gmail.send',
            'https://www.googleapis.com/auth/gmail.labels',
          ].join(' '),
        }),
        fetchUserInfo: async () => ({
          sub: 'google-user-1',
          email: 'user@example.com',
          name: 'Divo User',
        }),
      } as any,
      connectionRepo: {
        upsertGoogleConnection: async () => ({ ok: true, value: savedConnection }),
      } as any,
      mailBriefOnboarding: async () => {
        mailBriefCalled = true;
        return { ok: true, value: { subscriptionId: 'sub-1', briefId: 'brief-1', mailboxCreated: true, briefCreated: true, firstBriefQueued: true } };
      },
      callbackUrl: 'https://app-dev.example/api/google/connection/callback',
      logger: noopLogger,
    });

    const completion = await service.complete({
      state: 'opaque-state',
      code: 'google-code',
    });

    assert.equal(completion.outcome, 'connected');
    assert.equal(mailBriefCalled, false);
  });

  it('atomically stores the connection, owner grant, and continuation release', async () => {
    const writes: string[] = [];
    const tx = {
      integrationConnection: {
        upsert: async ({ create }: any) => {
          writes.push('connection');
          return {
            id: 'connection-1',
            ...create,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
        },
      },
      integrationConnectionGrant: {
        upsert: async () => {
          writes.push('grant');
          return {};
        },
      },
      connectionAuthorizationIntent: {
        updateMany: async ({ where, data }: any) => {
          writes.push('intent');
          assert.deepEqual(
            { id: where.id, companyId: where.companyId, userId: where.userId, status: where.status },
            {
              id: 'intent-1',
              companyId: 'company-1',
              userId: 'user-1',
              status: 'exchanging',
            },
          );
          assert.equal(data.continuationStatus, 'pending');
          assert.equal(data.authorizationCodeEncrypted, null);
          assert.equal(data.exchangeTokensEncrypted, null);
          return { count: 1 };
        },
      },
    };
    const repo = new IntegrationConnectionRepository({
      $transaction: async (work: (db: typeof tx) => unknown) => work(tx),
    } as any, {
      ZOHO_TOKEN_ENCRYPTION_KEY: 'test-encryption-key',
    } as any);

    const stored = await repo.upsertGoogleConnection({
      companyId: 'company-1',
      ownerType: 'user',
      ownerUserId: 'user-1',
      createdBy: 'user-1',
      googleUserId: 'google-user-1',
      googleEmail: 'user@example.com',
      scope: GOOGLE_WORKSPACE_OAUTH_SCOPES.join(' '),
      accessToken: 'access-secret',
      refreshToken: 'refresh-secret',
      authorizationIntentId: 'intent-1',
      initialAccess: 'admin',
    });

    assert.equal(stored.ok, true);
    assert.deepEqual(writes, ['connection', 'grant', 'intent']);
  });

  it('does not save or continue when Google returns no offline credential', async () => {
    let saved = false;
    let failureCode: string | undefined;
    const service = new GoogleConnectionAuthorizationService({
      intentRepo: {
        claimCallback: async () => ({ ok: true, value: claimedCallback }),
        stageExchangeTokens: async () => ({ ok: true, value: true }),
        markAuthorizationFailed: async (_id: string, code: string) => {
          failureCode = code;
          return { ok: true, value: undefined };
        },
      } as any,
      googleOAuth: {
        exchangeAuthorizationCode: async () => ({
          accessToken: 'access-secret',
          scope: GOOGLE_WORKSPACE_OAUTH_SCOPES.join(' '),
        }),
      } as any,
      connectionRepo: {
        upsertGoogleConnection: async () => {
          saved = true;
          return { ok: true, value: savedConnection };
        },
      } as any,
      callbackUrl: 'https://app-dev.example/api/google/connection/callback',
      logger: noopLogger,
    });

    await assert.rejects(
      service.complete({ state: 'opaque-state', code: 'google-code' }),
      /offline refresh credential/,
    );
    assert.equal(saved, false);
    assert.equal(failureCode, 'refresh_credential_missing');
  });

  it('does not exchange a replayed callback', async () => {
    let exchanged = false;
    const service = new GoogleConnectionAuthorizationService({
      intentRepo: {
        claimCallback: async () => ({
          ok: true,
          value: { outcome: 'already_consumed' },
        }),
      } as any,
      googleOAuth: {
        exchangeAuthorizationCode: async () => {
          exchanged = true;
          throw new Error('should not run');
        },
      } as any,
      connectionRepo: {} as any,
      callbackUrl: 'https://app-dev.example/api/google/connection/callback',
      logger: noopLogger,
    });

    assert.deepEqual(await service.complete({
      state: 'opaque-state',
      code: 'replayed-code',
    }), { outcome: 'already_consumed' });
    assert.equal(exchanged, false);
  });

  it('resumes a stale exchange from staged tokens without redeeming the code again', async () => {
    let exchanges = 0;
    let upserts = 0;
    const service = new GoogleConnectionAuthorizationService({
      intentRepo: {
        listStaleExchangeIds: async () => ({ ok: true, value: ['intent-1'] }),
        loadRecoverableExchange: async () => ({
          ok: true,
          value: {
            intent: TARGET,
            authorizationCode: 'spent-code',
            tokens: {
              accessToken: 'staged-access',
              refreshToken: 'staged-refresh',
              scope: GOOGLE_WORKSPACE_OAUTH_SCOPES.join(' '),
              expiresIn: 3600,
              tokenType: 'Bearer',
            },
          },
        }),
        markAuthorizationFailed: async () => ({ ok: true, value: undefined }),
      } as any,
      googleOAuth: {
        exchangeAuthorizationCode: async () => {
          exchanges += 1;
          throw new Error('must not redeem a staged exchange again');
        },
        fetchUserInfo: async () => ({
          sub: 'google-user-1',
          email: 'user@example.com',
        }),
      } as any,
      connectionRepo: {
        upsertGoogleConnection: async () => {
          upserts += 1;
          return { ok: true, value: savedConnection };
        },
      } as any,
      callbackUrl: 'https://app-dev.example/api/google/connection/callback',
      logger: noopLogger,
    });

    const recovered = await service.reconcileStaleExchanges(new Date());

    assert.equal(exchanges, 0);
    assert.equal(upserts, 1);
    assert.equal(recovered[0]?.intentId, 'intent-1');
  });
});

describe('Google connection continuation', () => {
  it('deduplicates queue admission by authorization intent', async () => {
    let adds = 0;
    const queue = new GoogleConnectionContinuationQueue(
      'redis://unused',
      'test',
      {
        getJob: async () => ({
          id: 'google_oauth_intent-1',
          getState: async () => 'waiting',
          retry: async () => {},
        }),
        add: async () => {
          adds += 1;
          return { id: 'unexpected' };
        },
        close: async () => {},
      } as any,
    );

    assert.equal(await queue.enqueue('intent-1'), 'google_oauth_intent-1');
    assert.equal(adds, 0);
  });

  it('recovers a failed queue job instead of leaving a pending intent stranded', async () => {
    let retried = false;
    const queue = new GoogleConnectionContinuationQueue(
      'redis://unused',
      'test',
      {
        getJob: async () => ({
          id: 'google_oauth_intent-1',
          getState: async () => 'failed',
          retry: async () => { retried = true; },
        }),
        add: async () => ({ id: 'unexpected' }),
        close: async () => {},
      } as any,
    );

    await queue.enqueue('intent-1');
    assert.equal(retried, true);
  });

  it('starts one fresh Pi run from the stored request and current identity', async () => {
    let piInput: any;
    let finishInput: any;
    const worker = new GoogleConnectionContinuationWorker({
      redisUrl: 'redis://unused',
      queue: { enqueue: async () => '' },
      intentRepo: {
        findPendingContinuation: async () => ({
          ok: true,
          value: { ...TARGET, connectionId: 'connection-1' },
        }),
        claimContinuation: async () => ({
          ok: true,
          value: { ...TARGET, connectionId: 'connection-1' },
        }),
        finishContinuation: async (...args: any[]) => {
          finishInput = args;
          return { ok: true, value: undefined };
        },
        listPendingContinuationIds: async () => ({ ok: true, value: [] }),
      } as any,
      identityRepo: {
        resolveByLarkTenantIdentity: async () => ({
          ok: true,
          value: {
            companyId: 'company-1',
            userId: 'user-1',
            aiRole: 'MEMBER',
            activeDepartmentId: 'department-current',
            email: 'member@example.com',
            channel: 'lark',
          },
        }),
      } as any,
      connectionRepo: {
        listAccessibleGoogleConnections: async () => ({
          ok: true,
          value: [{
            connectionId: 'connection-1',
            provider: 'google_workspace',
            label: 'Google',
            ownerType: 'user',
            ownerUserId: 'user-1',
            access: 'admin',
            scopes: [...GOOGLE_WORKSPACE_OAUTH_SCOPES],
            connectedAt: new Date(),
          }],
        }),
      } as any,
      runPi: async (input: any) => {
        piInput = input;
        return 'done';
      },
      channelAdapter: {
        key: 'lark',
      } as any,
      logger: noopLogger,
    });

    await worker.process({ id: 'job-1', data: { intentId: 'intent-1' } });

    assert.equal(piInput.incoming.text, TARGET.originalRequest);
    assert.equal(piInput.incoming.messageId, 'oauth-continuation-intent-1');
    assert.equal(piInput.incoming.raw.resumeReason, 'google_connected');
    assert.equal(piInput.incoming.raw.connectionId, 'connection-1');
    assert.equal(piInput.runContext.departmentId, 'department-current');
    assert.equal(piInput.runContext.requestId, TARGET.continuationIdempotencyKey);
    // The tool IDs stay on the incoming message as a record of what triggered
    // this continuation. They used to be copied onto the run context too, with
    // a comment promising an RBAC intersection that no code performed — every
    // tool call in the fresh run resolves permissions the ordinary way, so the
    // field granted nothing and guarded nothing.
    assert.deepEqual(piInput.incoming.raw.requestedToolIds, ['mailAutomations']);
    assert.equal('continuationToolIds' in piInput.runContext, false);
    assert.equal(piInput.conversation.chatId, 'oc_chat');
    assert.equal(piInput.conversation.replyToMessageId, 'om_original');
    assert.equal(piInput.conversation.replyInThread, true);
    assert.equal(piInput.channelAdapter.key, 'lark');
    assert.deepEqual(finishInput, [
      'intent-1',
      { runId: TARGET.continuationIdempotencyKey },
    ]);
  });

  it('records a visible Pi delivery failure without reporting completion', async () => {
    let finishInput: any;
    const worker = new GoogleConnectionContinuationWorker({
      redisUrl: 'redis://unused',
      queue: { enqueue: async () => '' },
      intentRepo: {
        findPendingContinuation: async () => ({
          ok: true,
          value: { ...TARGET, connectionId: 'connection-1' },
        }),
        claimContinuation: async () => ({
          ok: true,
          value: { ...TARGET, connectionId: 'connection-1' },
        }),
        finishContinuation: async (...args: any[]) => {
          finishInput = args;
          return { ok: true, value: undefined };
        },
      } as any,
      identityRepo: {
        resolveByLarkTenantIdentity: async () => ({
          ok: true,
          value: {
            companyId: 'company-1',
            userId: 'user-1',
            aiRole: 'MEMBER',
            channel: 'lark',
          },
        }),
      } as any,
      connectionRepo: {
        listAccessibleGoogleConnections: async () => ({
          ok: true,
          value: [{
            connectionId: 'connection-1',
            ownerType: 'user',
            ownerUserId: 'user-1',
          }],
        }),
      } as any,
      runPi: async () => null,
      channelAdapter: { key: 'lark' } as any,
      logger: noopLogger,
    });

    await worker.process({ id: 'job-1', data: { intentId: 'intent-1' } });

    assert.deepEqual(finishInput, [
      'intent-1',
      { failureCode: 'continuation_delivery_failed' },
    ]);
  });

  it('does not start a second run when the durable continuation claim is gone', async () => {
    let runs = 0;
    const worker = new GoogleConnectionContinuationWorker({
      redisUrl: 'redis://unused',
      queue: { enqueue: async () => '' },
      intentRepo: {
        findPendingContinuation: async () => ({
          ok: true,
          value: { ...TARGET, connectionId: 'connection-1' },
        }),
        claimContinuation: async () => ({ ok: true, value: null }),
        finishContinuation: async () => ({ ok: true, value: undefined }),
        listPendingContinuationIds: async () => ({ ok: true, value: [] }),
      } as any,
      identityRepo: {} as any,
      connectionRepo: {} as any,
      runPi: async () => {
        runs += 1;
        return 'done';
      },
      channelAdapter: { key: 'lark' } as any,
      logger: noopLogger,
    });

    await worker.process({ id: 'job-2', data: { intentId: 'intent-1' } });
    assert.equal(runs, 0);
  });

  it('leaves the intent pending when another replica owns the Lark lane', async () => {
    let claims = 0;
    const worker = new GoogleConnectionContinuationWorker({
      redisUrl: 'redis://unused',
      queue: { enqueue: async () => '' },
      intentRepo: {
        findPendingContinuation: async () => ({
          ok: true,
          value: { ...TARGET, connectionId: 'connection-1' },
        }),
        claimContinuation: async () => {
          claims += 1;
          return { ok: true, value: null };
        },
        finishContinuation: async () => ({ ok: true, value: undefined }),
        listPendingContinuationIds: async () => ({ ok: true, value: [] }),
      } as any,
      identityRepo: {} as any,
      connectionRepo: {} as any,
      runPi: async () => 'done',
      channelAdapter: { key: 'lark' } as any,
      laneLeaseHolder: {
        withLane: async () => ({
          outcome: 'deferred',
          ownerId: 'other-replica',
          expiresAt: new Date(),
        }),
      } as any,
      logger: noopLogger,
    });

    await assert.rejects(
      worker.process({ id: 'job-3', data: { intentId: 'intent-1' } }),
      /lane is held/,
    );
    assert.equal(claims, 0);
  });
});

describe('Google connection card and callback route', () => {
  it('renders an open-url card and a plain-link fallback without identity data', () => {
    const input = {
      url: 'https://accounts.google.test/auth?state=opaque',
      reason: 'I need your Google account to finish this.',
    };
    const wrapper = JSON.parse(buildGoogleConnectCard(input));
    const card = JSON.parse(wrapper.card);
    assert.equal(card.body.elements[1].behaviors[0].type, 'open_url');
    assert.equal(card.body.elements[1].behaviors[0].default_url, input.url);
    assert.match(googleConnectFallbackText(input), /state=opaque/);
    assert.equal(JSON.stringify(card).includes('company-1'), false);
    assert.equal(JSON.stringify(card).includes('user-1'), false);
  });

  it('returns callback success immediately after queue admission', async () => {
    let enqueued: string | undefined;
    const router = createGoogleConnectionRoutes({
      authorization: {
        complete: async () => ({
          outcome: 'connected',
          intentId: 'intent-1',
          connectionId: 'connection-1',
          accountName: '<user@example.com>',
        }),
      } as any,
      continuationQueue: {
        enqueue: async (intentId: string) => {
          enqueued = intentId;
          return 'job-1';
        },
      },
      logger: noopLogger,
    });

    const response = await callRoute(router, '/callback', {
      state: 'opaque',
      code: 'google-code',
    });

    assert.equal(response.status, 200);
    assert.equal(enqueued, 'intent-1');
    assert.match(String(response.body), /Google connected/);
    assert.equal(String(response.body).includes('<user@example.com>'), false);
    assert.match(String(response.body), /&lt;user@example.com&gt;/);
  });
});

async function callRoute(
  router: ReturnType<typeof createGoogleConnectionRoutes>,
  path: string,
  query: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
  return new Promise(resolve => {
    let status = 200;
    let body: unknown;
    const req = { method: 'GET', path, query } as unknown as Request;
    const res = {
      setHeader: () => {},
      status: (value: number) => {
        status = value;
        return res;
      },
      send: (value: unknown) => {
        body = value;
        resolve({ status, body });
        return res;
      },
    } as unknown as Response;
    const layer = (router as any).stack.find(
      (entry: any) => entry.route?.path === path && entry.route.methods.get,
    );
    Promise.resolve(layer.route.stack[0].handle(req, res, () => {}))
      .catch(error => resolve({ status: 500, body: String(error) }));
  });
}
