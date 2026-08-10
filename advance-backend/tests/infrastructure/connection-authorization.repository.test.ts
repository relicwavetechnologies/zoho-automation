import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hashConnectionAuthorizationState } from '../../src/application/connections/connection-authorization-intent.ts';
import { ConnectionAuthorizationRepository } from '../../src/infrastructure/persistence/connection-authorization.repository.ts';

const TARGET = {
  companyId: 'company-1',
  userId: 'user-1',
  departmentId: 'department-1',
  larkOpenId: 'ou_user',
  larkTenantKey: 'tenant-1',
  chatId: 'oc_chat',
  chatType: 'p2p',
  originalMessageId: 'om_original',
  rootMessageId: 'om_root',
  replyInThread: true,
  groupReplyMode: 'thread',
  originalRequest: 'Forward new OTP mails from alerts@example.com to Alice',
  requestedToolIds: ['mailAutomations.create'],
};

const storedIntent = (over: Record<string, unknown> = {}) => ({
  id: 'intent-1',
  provider: 'google_workspace',
  status: 'pending',
  expiresAt: new Date('2026-07-29T05:10:00.000Z'),
  connectionId: null,
  correlationId: 'correlation-1',
  continuationIdempotencyKey: 'google-oauth-continuation:correlation-1',
  ...TARGET,
  ...over,
});

describe('ConnectionAuthorizationRepository', () => {
  it('persists only a hash of the one-time browser state and the full continuation target', async () => {
    let createInput: any;
    const repo = new ConnectionAuthorizationRepository({
      connectionAuthorizationIntent: {
        create: async (input: any) => {
          createInput = input;
          return { id: 'intent-1' };
        },
      },
    } as any, 'test-encryption-key');
    const now = new Date('2026-07-29T05:00:00.000Z');

    const result = await repo.create({ ...TARGET, now, ttlMs: 60_000 });

    assert.ok(result.ok && result.value.outcome === 'issued');
    if (!result.ok || result.value.outcome !== 'issued') return;
    assert.equal(result.value.intentId, 'intent-1');
    assert.equal(createInput.data.state, undefined);
    assert.equal(
      createInput.data.stateHash,
      hashConnectionAuthorizationState(result.value.state),
    );
    assert.equal(createInput.data.provider, 'google_workspace');
    assert.equal(typeof createInput.data.activeDedupeKey, 'string');
    assert.deepEqual({
      companyId: createInput.data.companyId,
      userId: createInput.data.userId,
      departmentId: createInput.data.departmentId,
      larkOpenId: createInput.data.larkOpenId,
      larkTenantKey: createInput.data.larkTenantKey,
      chatId: createInput.data.chatId,
      chatType: createInput.data.chatType,
      originalMessageId: createInput.data.originalMessageId,
      rootMessageId: createInput.data.rootMessageId,
      replyInThread: createInput.data.replyInThread,
      groupReplyMode: createInput.data.groupReplyMode,
      originalRequest: createInput.data.originalRequest,
      requestedToolIds: createInput.data.requestedToolIds,
    }, TARGET);
    assert.equal(createInput.data.expiresAt.toISOString(), '2026-07-29T05:01:00.000Z');
  });

  it('returns the existing active intent when the same Lark request retries', async () => {
    const repo = new ConnectionAuthorizationRepository({
      connectionAuthorizationIntent: {
        create: async () => {
          throw Object.assign(new Error('unique'), { code: 'P2002' });
        },
        findFirst: async () => ({
          id: 'intent-existing',
          expiresAt: new Date('2026-07-29T05:09:00.000Z'),
          correlationId: 'correlation-existing',
        }),
      },
    } as any, 'test-encryption-key');

    const result = await repo.create({
      ...TARGET,
      now: new Date('2026-07-29T05:00:00.000Z'),
    });

    assert.deepEqual(result, {
      ok: true,
      value: {
        outcome: 'already_pending',
        intentId: 'intent-existing',
        expiresAt: new Date('2026-07-29T05:09:00.000Z'),
        correlationId: 'correlation-existing',
      },
    });
  });

  it('claims a valid callback exactly once and returns only stored binding data', async () => {
    let findInput: any;
    let updateInput: any;
    const repo = new ConnectionAuthorizationRepository({
      connectionAuthorizationIntent: {
        findUnique: async (input: any) => {
          findInput = input;
          return storedIntent();
        },
        updateMany: async (input: any) => {
          updateInput = input;
          return { count: 1 };
        },
      },
    } as any, 'test-encryption-key');
    const now = new Date('2026-07-29T05:01:00.000Z');

    const result = await repo.claimCallback('opaque-state', now, 'google-code');

    assert.ok(result.ok && result.value.outcome === 'claimed');
    assert.equal(
      findInput.where.stateHash,
      hashConnectionAuthorizationState('opaque-state'),
    );
    assert.deepEqual(updateInput.where, {
      id: 'intent-1',
      status: 'pending',
      expiresAt: { gt: now },
    });
    assert.notEqual(updateInput.data.authorizationCodeEncrypted, 'google-code');
    assert.match(updateInput.data.authorizationCodeEncrypted, /^v1:/);
    assert.deepEqual({
      companyId: result.value.intent.companyId,
      userId: result.value.intent.userId,
      departmentId: result.value.intent.departmentId,
      larkOpenId: result.value.intent.larkOpenId,
      larkTenantKey: result.value.intent.larkTenantKey,
      chatId: result.value.intent.chatId,
      chatType: result.value.intent.chatType,
      originalMessageId: result.value.intent.originalMessageId,
      rootMessageId: result.value.intent.rootMessageId,
      replyInThread: result.value.intent.replyInThread,
      groupReplyMode: result.value.intent.groupReplyMode,
      originalRequest: result.value.intent.originalRequest,
      requestedToolIds: result.value.intent.requestedToolIds,
    }, TARGET);
  });

  it('rejects replay without returning a continuation target', async () => {
    const repo = new ConnectionAuthorizationRepository({
      connectionAuthorizationIntent: {
        findUnique: async () => storedIntent({ status: 'exchanging' }),
      },
    } as any);

    assert.deepEqual(
      await repo.claimCallback(
        'already-used',
        new Date('2026-07-29T05:00:00.000Z'),
      ),
      {
        ok: true,
        value: { outcome: 'already_consumed' },
      },
    );
  });

  it('expires a stale pending intent instead of exchanging its code', async () => {
    let updateInput: any;
    const repo = new ConnectionAuthorizationRepository({
      connectionAuthorizationIntent: {
        findUnique: async () =>
          storedIntent({ expiresAt: new Date('2026-07-29T04:59:00.000Z') }),
        updateMany: async (input: any) => {
          updateInput = input;
          return { count: 1 };
        },
      },
    } as any);

    const result = await repo.claimCallback(
      'expired',
      new Date('2026-07-29T05:00:00.000Z'),
    );

    assert.deepEqual(result, { ok: true, value: { outcome: 'expired' } });
    assert.equal(updateInput.data.status, 'expired');
  });

  it('atomically releases one continuation only after the connection is stored', async () => {
    const updates: any[] = [];
    const repo = new ConnectionAuthorizationRepository({
      connectionAuthorizationIntent: {
        updateMany: async (input: any) => {
          updates.push(input);
          return { count: 1 };
        },
        findUnique: async () =>
          storedIntent({ status: 'connected', connectionId: 'connection-1' }),
      },
    } as any);

    const connected = await repo.markConnected('intent-1', 'connection-1');
    const continuation = await repo.claimContinuation('intent-1');

    assert.deepEqual(connected, { ok: true, value: true });
    assert.ok(continuation.ok && continuation.value);
    assert.equal(continuation.value.connectionId, 'connection-1');
    assert.deepEqual(updates[0].where, {
      id: 'intent-1',
      status: 'exchanging',
    });
    assert.equal(updates[0].data.continuationStatus, 'pending');
    assert.deepEqual(updates[1].where, {
      id: 'intent-1',
      status: 'connected',
      continuationStatus: 'pending',
      connectionId: { not: null },
    });
  });

  it('does not start a second agent run after the continuation claim is lost', async () => {
    const repo = new ConnectionAuthorizationRepository({
      connectionAuthorizationIntent: {
        updateMany: async () => ({ count: 0 }),
      },
    } as any);

    assert.deepEqual(await repo.claimContinuation('intent-1'), {
      ok: true,
      value: null,
    });
  });

  it('clears staged OAuth credentials on terminal authorization failure', async () => {
    let update: any;
    const repo = new ConnectionAuthorizationRepository({
      connectionAuthorizationIntent: {
        updateMany: async (input: any) => {
          update = input;
          return { count: 1 };
        },
      },
    } as any);

    const result = await repo.markAuthorizationFailed(
      'intent-1',
      'authorization_completion_failed',
    );

    assert.equal(result.ok, true);
    assert.equal(update.data.authorizationCodeEncrypted, null);
    assert.equal(update.data.exchangeTokensEncrypted, null);
  });
});
