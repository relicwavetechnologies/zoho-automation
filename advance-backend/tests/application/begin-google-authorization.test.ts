import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createBeginGoogleAuthorization } from '../../src/application/connections/begin-google-authorization';
import { RunOriginStore, type RunOrigin } from '../../src/application/connections/run-origin.store';
import type { CachePort } from '../../src/shared/cache';
import type { RunContext } from '../../src/domain/orchestration/run-context';
import { ok, err } from '../../src/shared/result';
import { wrapInfra } from '../../src/shared/errors';
import { asCompanyId, asUserId } from '../../src/shared/ids';
import { asCompanyRoleSlug } from '../../src/domain/permissions/company-role';

function memoryCache(overrides: Partial<CachePort> = {}): CachePort {
  const entries = new Map<string, unknown>();
  return {
    async get<T>(key: string) { return ok((entries.get(key) ?? null) as T | null); },
    async set<T>(key: string, value: T) { entries.set(key, value); return ok(undefined); },
    async setNx() { return ok(true); },
    async del(key: string) { entries.delete(key); return ok(undefined); },
    async scanDel() { return ok(0); },
    ...overrides,
  };
}

function silentLogger() {
  const lines: Array<{ level: string; event: string }> = [];
  const record = (level: string) => (event: string) => { lines.push({ level, event }); };
  const logger: any = {
    lines,
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
  };
  logger.child = () => logger;
  return logger;
}

const ORIGIN: RunOrigin = {
  version: 1,
  companyId: 'co-1',
  userId: 'user-1',
  larkOpenId: 'ou_user',
  larkTenantKey: 'tenant-1',
  chatId: 'oc_chat',
  chatType: 'group',
  originalMessageId: 'om_request',
  rootMessageId: 'om_root',
  replyInThread: true,
  groupReplyMode: 'threaded',
  originalRequest: 'Forward every invoice to finance@example.com',
};

function runContext(overrides: Partial<RunContext> = {}): RunContext {
  return {
    companyId: asCompanyId('co-1'),
    userId: asUserId('user-1'),
    companyRole: asCompanyRoleSlug('MEMBER'),
    channel: 'lark',
    ...overrides,
  };
}

function harness(input: {
  origin?: RunOrigin;
  runId?: string;
  cache?: CachePort;
  issue?: any;
  deliver?: (() => any) | undefined;
} = {}) {
  const cache = input.cache ?? memoryCache();
  const runOrigins = new RunOriginStore(cache);
  const delivered: any[] = [];
  const issuedWith: any[] = [];
  const logger = silentLogger();

  const begin = createBeginGoogleAuthorization({
    runOrigins,
    authorization: {
      issue: input.issue ?? (async (target: any) => {
        issuedWith.push(target);
        return {
          outcome: 'issued',
          intentId: 'intent-1',
          authorizeUrl: 'https://accounts.google.com/o/oauth2/auth?state=abc',
        };
      }),
    } as any,
    deliverConnectCard: input.deliver === undefined
      ? () => async (card: any) => { delivered.push(card); return true; }
      : input.deliver,
    logger,
  });

  return { begin, runOrigins, delivered, issuedWith, logger, cache };
}

describe('createBeginGoogleAuthorization', () => {
  it('attaches the direct Google OAuth action to the run final response', async () => {
    const h = harness();
    await h.runOrigins.remember('run-1', ORIGIN);

    const result = await h.begin({
      toolId: 'googleGmail',
      reason: 'Connect Google to read your mail.',
      runContext: runContext({ runtimeRunId: 'run-1' }),
    });

    assert.deepEqual(result, { status: 'sent', intentId: 'intent-1' });
    assert.equal(h.delivered.length, 0);
    assert.deepEqual((await h.runOrigins.recall({
      runId: 'run-1',
      companyId: 'co-1',
      userId: 'user-1',
    }))?.googleAuthorization, {
      intentId: 'intent-1',
      authorizeUrl: 'https://accounts.google.com/o/oauth2/auth?state=abc',
    });
  });

  it('carries the original ask into the intent so the run can be resumed', async () => {
    const h = harness();
    await h.runOrigins.remember('run-1', ORIGIN);

    await h.begin({
      toolId: 'mailAutomations',
      reason: 'Connect Google.',
      runContext: runContext({ runtimeRunId: 'run-1' }),
    });

    assert.deepEqual(h.issuedWith[0], {
      companyId: 'co-1',
      userId: 'user-1',
      larkOpenId: 'ou_user',
      larkTenantKey: 'tenant-1',
      chatId: 'oc_chat',
      chatType: 'group',
      originalMessageId: 'om_request',
      rootMessageId: 'om_root',
      replyInThread: true,
      groupReplyMode: 'threaded',
      originalRequest: 'Forward every invoice to finance@example.com',
      requestedToolIds: ['mailAutomations'],
    });
  });

  it('is unavailable for a run that carries no runtime run ID', async () => {
    // This is the desktop case, and it is also exactly the state every
    // production run was in while this path was dead: nothing to look up.
    const h = harness();
    await h.runOrigins.remember('run-1', ORIGIN);

    const result = await h.begin({
      toolId: 'googleGmail',
      reason: 'Connect Google.',
      runContext: runContext(),
    });

    assert.deepEqual(result, { status: 'unavailable' });
    assert.equal(h.delivered.length, 0);
  });

  it('will not start an authorization for another member from a known run ID', async () => {
    const h = harness();
    await h.runOrigins.remember('run-1', ORIGIN);

    const result = await h.begin({
      toolId: 'googleGmail',
      reason: 'Connect Google.',
      runContext: runContext({
        userId: asUserId('user-2'),
        runtimeRunId: 'run-1',
      }),
    });

    assert.deepEqual(result, { status: 'unavailable' });
    assert.equal(h.delivered.length, 0);
  });

  it('does not send a second card while one is already pending', async () => {
    const h = harness({
      issue: async () => ({ outcome: 'already_pending', intentId: 'intent-existing' }),
    });
    await h.runOrigins.remember('run-1', ORIGIN);

    const result = await h.begin({
      toolId: 'googleGmail',
      reason: 'Connect Google.',
      runContext: runContext({ runtimeRunId: 'run-1' }),
    });

    assert.deepEqual(result, { status: 'already_pending', intentId: 'intent-existing' });
    assert.equal(h.delivered.length, 0);
  });

  it('falls back to a separate Connect card when the final action cannot be stored', async () => {
    const cache = memoryCache();
    const store = cache.set.bind(cache);
    cache.set = async (key, value, ttlSeconds) => (
      (value as any)?.googleAuthorization
        ? err(wrapInfra('redis', 'set', new Error('down')))
        : store(key, value, ttlSeconds)
    );
    const h = harness({ cache });
    await h.runOrigins.remember('run-1', ORIGIN);

    const result = await h.begin({
      toolId: 'googleGmail',
      reason: 'Connect Google to read your mail.',
      runContext: runContext({ runtimeRunId: 'run-1' }),
    });

    assert.deepEqual(result, { status: 'sent', intentId: 'intent-1' });
    assert.deepEqual(h.delivered, [{
      url: 'https://accounts.google.com/o/oauth2/auth?state=abc',
      reason: 'Connect Google to read your mail.',
      chatId: 'oc_chat',
      replyToMessageId: 'om_request',
      replyInThread: true,
    }]);
  });

  it('reports unavailable when neither final-action storage nor fallback delivery works', async () => {
    const cache = memoryCache();
    const store = cache.set.bind(cache);
    cache.set = async (key, value, ttlSeconds) => (
      (value as any)?.googleAuthorization
        ? err(wrapInfra('redis', 'set', new Error('down')))
        : store(key, value, ttlSeconds)
    );
    const h = harness({ cache, deliver: () => async () => false });
    await h.runOrigins.remember('run-1', ORIGIN);

    const result = await h.begin({
      toolId: 'googleGmail',
      reason: 'Connect Google.',
      runContext: runContext({ runtimeRunId: 'run-1' }),
    });

    assert.deepEqual(result, { status: 'unavailable' });
    assert.ok(h.logger.lines.some((line: any) =>
      line.event === 'google.authorization.card_delivery_failed'));
  });

  it('reports unavailable, and says so in the log, when the origin cannot be read', async () => {
    const h = harness({
      cache: memoryCache({
        get: async () => err(wrapInfra('redis', 'get', new Error('down'))),
      }),
    });

    const result = await h.begin({
      toolId: 'googleGmail',
      reason: 'Connect Google.',
      runContext: runContext({ runtimeRunId: 'run-1' }),
    });

    assert.deepEqual(result, { status: 'unavailable' });
    assert.ok(h.logger.lines.some((line: any) =>
      line.event === 'google.authorization.run_origin_unreadable'));
  });

  it('logs a run whose origin has aged out rather than failing silently', async () => {
    const h = harness();

    const result = await h.begin({
      toolId: 'googleGmail',
      reason: 'Connect Google.',
      runContext: runContext({ runtimeRunId: 'run-gone' }),
    });

    assert.deepEqual(result, { status: 'unavailable' });
    assert.ok(h.logger.lines.some((line: any) =>
      line.event === 'google.authorization.run_origin_missing'));
  });
});
