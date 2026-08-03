import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Request, Response } from 'express';
import {
  createLarkAuthRoutes,
  encodeLarkOAuthState,
  larkOAuthNonceKey,
  larkOAuthReplayKey,
} from '../../src/http/lark/lark-auth.routes.ts';
import { ok } from '../../src/shared/result.ts';

const noopLogger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  child: function () { return this; },
} as any;

async function callRoute(
  router: ReturnType<typeof createLarkAuthRoutes>,
  method: 'GET',
  path: string,
  opts: { headers?: Record<string, string>; query?: Record<string, string> } = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    let status = 200;
    let body: unknown;
    const req = {
      method,
      path,
      headers: opts.headers ?? {},
      query: opts.query ?? {},
    } as unknown as Request;
    const res = {
      status: (next: number) => { status = next; return res; },
      json: (value: unknown) => { body = value; resolve({ status, body }); return res; },
      send: (value: unknown) => { body = value; resolve({ status, body }); return res; },
    } as unknown as Response;

    const layer = (router as any).stack.find(
      (item: any) => item.route?.path === path && item.route?.methods?.[method.toLowerCase()],
    );
    const handler = layer?.route?.stack?.at(-1)?.handle;
    if (!handler) return resolve({ status: 404, body: { error: 'not_found' } });
    Promise.resolve(handler(req, res, () => resolve({ status: 404, body: { error: 'next' } })))
      .catch((error) => resolve({ status: 500, body: String(error) }));
  });
}

function makeRouter(overrides: Record<string, unknown> = {}) {
  return createLarkAuthRoutes({
    larkOAuthService: {
      isConfigured: () => true,
      generateNonce: () => 'nonce-1',
      getAuthorizeUrl: (state: string) => `https://accounts.larksuite.com/authorize?state=${state}`,
      exchangeCode: async () => { throw new Error('not configured'); },
    } as any,
    connectionRepo: {
      upsertLarkConnection: async () => ok({ id: 'connection-1' }),
      findLarkConnectionOwner: async () => ok({ userId: 'user-1' }),
    } as any,
    cache: {
      get: async () => ok(null),
      set: async () => ok(undefined),
      setNx: async () => ok(true),
      del: async () => ok(undefined),
      scanDel: async () => ok(0),
    } as any,
    logger: noopLogger,
    appId: 'cli_test',
    appSecret: 'secret',
    apiBase: 'https://open.larksuite.com',
    prisma: {
      memberSession: {
        updateMany: async () => ({ count: 1 }),
        create: async () => ({}),
      },
    } as any,
    memberSessionTtlMinutes: 480,
    sendConfirmationDm: async () => {},
    channelIdentityRepo: {
      prepareLarkLogin: async (larkOpenId: string) => ok({
        status: 'ready',
        companyId: 'company-1',
        userId: 'user-1',
        aiRole: 'MEMBER',
        larkOpenId,
        email: 'user@example.com',
        createdUser: false,
      }),
      invalidateIdentityCache: async () => {},
    } as any,
    ...overrides,
  });
}

describe('Lark OAuth account binding', () => {
  it('does not trust caller-supplied connect headers without a matching server identity', async () => {
    const router = makeRouter();
    const response = await callRoute(router, 'GET', '/connect', {
      headers: {
        'x-company-id': 'company-victim',
        'x-user-id': 'user-victim',
        'x-lark-open-id': 'ou_victim',
        'x-lark-tenant-key': 'tenant-victim',
      },
    });

    assert.equal(response.status, 403);
    assert.deepEqual(response.body, { error: 'lark_identity_mismatch' });
  });

  it('does not issue an authorize URL when the nonce cannot be stored', async () => {
    const events: string[] = [];
    const router = makeRouter({
      logger: {
        ...noopLogger,
        error: (event: string) => { events.push(event); },
      },
      cache: {
        get: async () => ok(null),
        set: async () => ({ ok: false, error: new Error('redis unavailable') }),
        del: async () => ok(undefined),
        setNx: async () => ok(true),
        scanDel: async () => ok(0),
      },
    });

    const response = await callRoute(router, 'GET', '/connect', {
      headers: {
        'x-company-id': 'company-1',
        'x-user-id': 'user-1',
        'x-lark-open-id': 'ou_alice',
        'x-lark-tenant-key': 'tenant-1',
      },
    });

    assert.equal(response.status, 503);
    assert.deepEqual(response.body, { error: 'lark_auth_state_unavailable' });
    assert.deepEqual(events, ['lark.auth.connect.nonce_store_failed']);
  });

  it('rejects a callback when OAuth returns a different Lark account', async () => {
    const state = {
      companyId: 'company-1', userId: 'user-1', larkOpenId: 'ou_expected',
      tenantKey: 'tenant-1', nonce: 'nonce-1',
    };
    let upsertCalled = false;
    const router = makeRouter({
      larkOAuthService: {
        isConfigured: () => true,
        exchangeCode: async () => ({
          accessToken: 'token', refreshToken: 'refresh', tokenType: 'Bearer', expiresIn: 3600,
          refreshTokenExpiresIn: 7200, larkOpenId: 'ou_attacker', larkUserId: 'user-lark',
          larkName: 'Attacker', larkEmail: 'attacker@example.com', larkEnName: null,
          tenantKey: 'tenant-1', scope: 'offline_access', avatarUrl: null,
        }),
      } as any,
      connectionRepo: {
        upsertLarkConnection: async () => { upsertCalled = true; return ok({ id: 'bad' }); },
      } as any,
      cache: {
        get: async (key: string) => {
          assert.equal(key, larkOAuthNonceKey('nonce-1'));
          return ok({
            companyId: state.companyId,
            userId: state.userId,
            larkOpenId: state.larkOpenId,
            tenantKey: state.tenantKey,
          });
        },
        set: async () => ok(undefined), setNx: async () => ok(true),
        del: async () => ok(undefined), scanDel: async () => ok(0),
      } as any,
    });

    const response = await callRoute(router, 'GET', '/callback', {
      query: { code: 'code-1', state: encodeLarkOAuthState(state) },
    });

    assert.equal(response.status, 400);
    assert.match(String(response.body), /Connection failed/);
    assert.equal(upsertCalled, false);
  });

  it('rejects a callback when OAuth returns a different Lark tenant', async () => {
    const state = {
      companyId: 'company-1', userId: 'user-1', larkOpenId: 'ou_expected',
      tenantKey: 'tenant-expected', nonce: 'nonce-1',
    };
    let upsertCalled = false;
    const router = makeRouter({
      larkOAuthService: {
        isConfigured: () => true,
        exchangeCode: async () => ({
          accessToken: 'token', refreshToken: 'refresh', tokenType: 'Bearer', expiresIn: 3600,
          refreshTokenExpiresIn: 7200, larkOpenId: 'ou_expected', larkUserId: 'user-lark',
          larkName: 'Expected User', larkEmail: 'expected@example.com', larkEnName: null,
          tenantKey: 'tenant-other', scope: 'offline_access', avatarUrl: null,
        }),
      } as any,
      connectionRepo: {
        upsertLarkConnection: async () => { upsertCalled = true; return ok({ id: 'bad' }); },
      } as any,
      cache: {
        get: async () => ok({
          companyId: state.companyId,
          userId: state.userId,
          larkOpenId: state.larkOpenId,
          tenantKey: state.tenantKey,
        }),
        set: async () => ok(undefined), setNx: async () => ok(true),
        del: async () => ok(undefined), scanDel: async () => ok(0),
      } as any,
    });

    const response = await callRoute(router, 'GET', '/callback', {
      query: { code: 'code-1', state: encodeLarkOAuthState(state) },
    });

    assert.equal(response.status, 400);
    assert.match(String(response.body), /Connection failed/);
    assert.equal(upsertCalled, false);
  });

  it('rejects a callback when the tenant binding became inactive', async () => {
    const state = {
      companyId: 'company-1', userId: 'user-1', larkOpenId: 'ou_expected',
      tenantKey: 'tenant-1', nonce: 'nonce-1',
    };
    let exchangeCalled = false;
    let upsertCalled = false;
    const router = makeRouter({
      larkOAuthService: {
        isConfigured: () => true,
        exchangeCode: async () => {
          exchangeCalled = true;
          throw new Error('must not exchange');
        },
      } as any,
      connectionRepo: {
        upsertLarkConnection: async () => { upsertCalled = true; return ok({ id: 'bad' }); },
      } as any,
      channelIdentityRepo: {
        prepareLarkLogin: async () => ok(null),
        invalidateIdentityCache: async () => {},
      } as any,
      cache: {
        get: async () => ok({
          companyId: state.companyId,
          userId: state.userId,
          larkOpenId: state.larkOpenId,
          tenantKey: state.tenantKey,
        }),
        set: async () => ok(undefined), setNx: async () => ok(true),
        del: async () => ok(undefined), scanDel: async () => ok(0),
      } as any,
    });

    const response = await callRoute(router, 'GET', '/callback', {
      query: { code: 'code-1', state: encodeLarkOAuthState(state) },
    });

    assert.equal(response.status, 400);
    assert.equal(exchangeCalled, false);
    assert.equal(upsertCalled, false);
  });

  it('issues a Lark member session before replaying the pending request', async () => {
    const state = {
      companyId: 'company-1', userId: 'user-1', larkOpenId: 'ou_expected',
      tenantKey: 'tenant-1', nonce: 'nonce-1',
    };
    const order: string[] = [];
    let createdSession: Record<string, unknown> | undefined;
    let renewalWhere: Record<string, unknown> | undefined;
    const router = makeRouter({
      larkOAuthService: {
        isConfigured: () => true,
        exchangeCode: async () => ({
          accessToken: 'token', refreshToken: 'refresh', tokenType: 'Bearer', expiresIn: 3600,
          refreshTokenExpiresIn: 7200, larkOpenId: 'ou_expected', larkUserId: 'user-lark',
          larkName: 'Expected User', larkEmail: 'expected@example.com', larkEnName: null,
          tenantKey: 'tenant-1', scope: 'offline_access', avatarUrl: null,
        }),
      } as any,
      connectionRepo: {
        upsertLarkConnection: async () => {
          order.push('connection');
          return ok({ id: 'connection-1' });
        },
      } as any,
      cache: {
        get: async () => ok({
          companyId: state.companyId,
          userId: state.userId,
          larkOpenId: state.larkOpenId,
          tenantKey: state.tenantKey,
          pendingEvent: { event: { message: { message_id: 'om_pending' } } },
        }),
        set: async () => ok(undefined), setNx: async () => ok(true),
        del: async () => ok(undefined), scanDel: async () => ok(0),
      } as any,
      prisma: {
        memberSession: {
          updateMany: async ({ where }: { where: Record<string, unknown> }) => {
            order.push('renew');
            renewalWhere = where;
            return { count: 0 };
          },
          create: async ({ data }: { data: Record<string, unknown> }) => {
            order.push('create');
            createdSession = data;
            return {};
          },
        },
      } as any,
      onLinked: async () => { order.push('replay'); },
    });

    const response = await callRoute(router, 'GET', '/callback', {
      query: { code: 'code-1', state: encodeLarkOAuthState(state) },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(order, ['connection', 'renew', 'create', 'replay']);
    assert.equal(createdSession?.['channel'], 'lark');
    assert.equal(createdSession?.['authProvider'], 'lark');
    assert.equal(createdSession?.['larkOpenId'], 'ou_expected');
    assert.equal(createdSession?.['larkTenantKey'], 'tenant-1');
    assert.equal(renewalWhere?.['larkOpenId'], 'ou_expected');
    assert.equal(renewalWhere?.['larkTenantKey'], 'tenant-1');
  });
});

/**
 * The hop that replaced Lark's own consent screen.
 *
 * The card in Lark now opens the web login, and this route attaches the Lark
 * identity to the session that sign-in produced. It is the one place where a
 * link somebody else can see in a group chat meets a real session, so most of
 * what is worth testing here is what it refuses.
 */
async function callLink(
  router: ReturnType<typeof createLarkAuthRoutes>,
  body: unknown,
  locals: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    let status = 200;
    const req = { method: 'POST', path: '/link', headers: {}, query: {}, body } as unknown as Request;
    const res = {
      locals,
      status: (next: number) => { status = next; return res; },
      json: (value: unknown) => { resolve({ status, body: value }); return res; },
      send: (value: unknown) => { resolve({ status, body: value }); return res; },
    } as unknown as Response;

    const layer = (router as any).stack.find(
      (item: any) => item.route?.path === '/link' && item.route?.methods?.post,
    );
    const handler = layer?.route?.stack?.at(-1)?.handle;
    if (!handler) return resolve({ status: 404, body: { error: 'not_found' } });
    Promise.resolve(handler(req, res, () => resolve({ status: 404, body: { error: 'next' } })))
      .catch((error) => resolve({ status: 500, body: String(error) }));
  });
}

const linkState = (over: Record<string, string> = {}) => encodeLarkOAuthState({
  companyId: 'company-1', userId: 'user-1', larkOpenId: 'ou_alice',
  tenantKey: 'tenant-1', nonce: 'nonce-1', ...over,
} as any);

const storedNonce = (extra: Record<string, unknown> = {}) => ({
  companyId: 'company-1', userId: 'user-1', larkOpenId: 'ou_alice',
  tenantKey: 'tenant-1', ...extra,
});

const signedInAs = (userId: string) => ({ userId, companyId: 'company-1', sessionId: 'session-1' });

describe('attaching a Lark identity to a web session', () => {
  it('refuses when the person who signed in is not the person the card named', async () => {
    const writes: string[] = [];
    const deleted: string[] = [];
    const router = makeRouter({
      cache: {
        get: async () => ok(storedNonce()),
        set: async () => ok(undefined),
        del: async (key: string) => { deleted.push(key); return ok(undefined); },
        setNx: async () => ok(true),
        scanDel: async () => ok(0),
      },
      prisma: {
        memberSession: {
          update: async () => { writes.push('update'); return {}; },
          updateMany: async () => { writes.push('updateMany'); return { count: 0 }; },
        },
      },
    });

    const response = await callLink(router, { state: linkState() }, signedInAs('user-bob'));

    assert.equal(response.status, 403);
    assert.deepEqual(response.body, { error: 'different_account' });
    // The dangerous outcome is a half-done link, so nothing may be written and
    // the nonce must survive for the person it was actually for.
    assert.deepEqual(writes, []);
    assert.deepEqual(deleted, []);
  });

  it('reports an expired link separately from a refusal, so the page can say "ask for a new one"', async () => {
    const router = makeRouter({
      cache: {
        get: async () => ok(null),
        set: async () => ok(undefined),
        del: async () => ok(undefined),
        setNx: async () => ok(true),
        scanDel: async () => ok(0),
      },
    });

    const response = await callLink(router, { state: linkState() }, signedInAs('user-1'));

    assert.equal(response.status, 410);
    assert.deepEqual(response.body, { error: 'link_expired' });
  });

  it('reports a nonce-store outage as temporary instead of expired', async () => {
    const events: string[] = [];
    const router = makeRouter({
      logger: {
        ...noopLogger,
        error: (event: string) => { events.push(event); },
      },
      cache: {
        get: async () => ({ ok: false, error: new Error('redis unavailable') }),
        set: async () => ok(undefined),
        del: async () => ok(undefined),
        setNx: async () => ok(true),
        scanDel: async () => ok(0),
      },
    });

    const response = await callLink(router, { state: linkState() }, signedInAs('user-1'));

    assert.equal(response.status, 503);
    assert.deepEqual(response.body, { error: 'lark_link_status_unavailable' });
    assert.deepEqual(events, ['lark.auth.link.nonce_read_failed']);
  });

  it('turns an unexpected link-route failure into a logged temporary error', async () => {
    const events: string[] = [];
    const router = makeRouter({
      logger: {
        ...noopLogger,
        error: (event: string) => { events.push(event); },
      },
      cache: {
        get: async () => { throw new Error('redis connection dropped'); },
        set: async () => ok(undefined),
        del: async () => ok(undefined),
        setNx: async () => ok(true),
        scanDel: async () => ok(0),
      },
    });

    const response = await callLink(router, { state: linkState() }, signedInAs('user-1'));

    assert.equal(response.status, 503);
    assert.deepEqual(response.body, { error: 'lark_auth_unavailable' });
    assert.deepEqual(events, ['lark.auth.request_failed']);
  });

  it('refuses when the workspace mapping went away while the card sat unread', async () => {
    const router = makeRouter({
      cache: {
        get: async () => ok(storedNonce()),
        set: async () => ok(undefined),
        del: async () => ok(undefined),
        setNx: async () => ok(true),
        scanDel: async () => ok(0),
      },
      channelIdentityRepo: {
        prepareLarkLogin: async () => ok({ status: 'missing_email', companyId: 'company-1' }),
        invalidateIdentityCache: async () => {},
      },
    });

    const response = await callLink(router, { state: linkState() }, signedInAs('user-1'));

    assert.equal(response.status, 403);
    assert.deepEqual(response.body, { error: 'lark_identity_mismatch' });
  });

  it('requests OAuth when this exact Lark account has no capability connection', async () => {
    const writes: string[] = [];
    const deleted: string[] = [];
    const router = makeRouter({
      cache: {
        get: async () => ok(storedNonce()),
        set: async () => ok(undefined),
        del: async (key: string) => { deleted.push(key); return ok(undefined); },
        setNx: async () => ok(true),
        scanDel: async () => ok(0),
      },
      connectionRepo: {
        findLarkConnectionOwner: async (input: { companyId: string; larkOpenId: string; larkTenantKey: string }) => {
          assert.equal(input.companyId, 'company-1');
          assert.equal(input.larkOpenId, 'ou_alice');
          assert.equal(input.larkTenantKey, 'tenant-1');
          return ok(null);
        },
      },
      prisma: {
        memberSession: {
          update: async () => { writes.push('update'); return {}; },
          updateMany: async () => { writes.push('updateMany'); return { count: 0 }; },
        },
      },
    });

    const response = await callLink(router, { state: linkState() }, signedInAs('user-1'));

    assert.equal(response.status, 409);
    assert.deepEqual(response.body, { error: 'lark_connection_required' });
    assert.deepEqual(writes, []);
    assert.deepEqual(deleted, [], 'OAuth must be able to reuse the pending link');
  });

  it('does not turn a connection-status outage into another OAuth redirect', async () => {
    const router = makeRouter({
      cache: {
        get: async () => ok(storedNonce()),
        set: async () => ok(undefined),
        del: async () => ok(undefined),
        setNx: async () => ok(true),
        scanDel: async () => ok(0),
      },
      connectionRepo: {
        findLarkConnectionOwner: async () => ({ ok: false, error: new Error('database unavailable') }),
      },
    });

    const response = await callLink(router, { state: linkState() }, signedInAs('user-1'));

    assert.equal(response.status, 503);
    assert.deepEqual(response.body, { error: 'lark_connection_status_unavailable' });
  });

  it('stamps the caller\'s session, detaches the identity from any other, and replays the question', async () => {
    const deleted: string[] = [];
    const order: string[] = [];
    let stamped: any = null;
    let detached: any = null;
    let replayed: unknown = null;
    let resolvedCard: unknown = null;

    const router = makeRouter({
      cache: {
        get: async () => ok(storedNonce({
          pendingEvent: { message: 'what is on my calendar?' },
          signInCardMessageId: 'om_sign_in',
          signInCardDisplayName: 'Alice',
        })),
        set: async () => ok(undefined),
        del: async (key: string) => { deleted.push(key); return ok(undefined); },
        setNx: async () => ok(true),
        scanDel: async () => ok(0),
      },
      prisma: {
        memberSession: {
          update: async (args: any) => { stamped = args; return {}; },
          updateMany: async (args: any) => { detached = args; return { count: 1 }; },
        },
      },
      channelIdentityRepo: {
        prepareLarkLogin: async (larkOpenId: string) => ok({
          status: 'ready', companyId: 'company-1', userId: 'user-1', aiRole: 'MEMBER',
          larkOpenId, email: 'user@example.com', createdUser: false,
        }),
        invalidateIdentityCache: async () => { order.push('invalidated'); },
      },
      onLinked: async (event: Record<string, unknown>) => {
        order.push('replayed');
        replayed = event;
      },
      onSignInCardResolved: async (input) => {
        order.push('sign_in_card');
        resolvedCard = input;
      },
    });

    const response = await callLink(router, { state: linkState() }, signedInAs('user-1'));

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { linked: true, replaying: true });

    // The session the person is holding right now is the one that gets the
    // identity — nothing is created, so this cannot become a second sign-in.
    assert.equal(stamped.where.sessionId, 'session-1');
    assert.equal(stamped.data.larkOpenId, 'ou_alice');
    assert.equal(stamped.data.larkTenantKey, 'tenant-1');

    // One Lark identity resolves to one session, or the runtime has a choice
    // to make and no way to make it.
    assert.equal(detached.where.sessionId.not, 'session-1');
    assert.equal(detached.data.larkOpenId, null);

    assert.deepEqual(deleted, [larkOAuthNonceKey('nonce-1')], 'single use');

    await new Promise((r) => setImmediate(r));
    assert.deepEqual(replayed, { message: 'what is on my calendar?' });
    assert.deepEqual(resolvedCard, {
      messageId: 'om_sign_in',
      displayName: 'Alice',
      replaying: true,
    });
    assert.deepEqual(order, ['invalidated', 'sign_in_card', 'replayed']);
  });

  it('does not start a second replay when the link is clicked twice quickly', async () => {
    let claimAttempts = 0;
    let replayCalls = 0;
    let finishReplay!: (value: boolean) => void;
    const replay = new Promise<boolean>((resolve) => { finishReplay = resolve; });
    const router = makeRouter({
      cache: {
        get: async () => ok(storedNonce({ pendingEvent: { message: 'hello' } })),
        set: async () => ok(undefined),
        del: async () => ok(undefined),
        setNx: async () => {
          claimAttempts += 1;
          return ok(claimAttempts === 1);
        },
        scanDel: async () => ok(0),
      },
      prisma: {
        memberSession: {
          update: async () => ({}),
          updateMany: async () => ({ count: 0 }),
        },
      },
      onLinked: async () => {
        replayCalls += 1;
        return replay;
      },
    });

    const first = callLink(router, { state: linkState() }, signedInAs('user-1'));
    await new Promise((resolve) => setImmediate(resolve));
    const second = callLink(router, { state: linkState() }, signedInAs('user-1'));
    const [firstResponse, secondResponse] = await Promise.all([first, second]);

    assert.deepEqual(firstResponse.body, { linked: true, replaying: true });
    assert.deepEqual(secondResponse.body, { linked: true, replaying: true });
    assert.equal(replayCalls, 1);

    finishReplay(true);
    await new Promise((resolve) => setImmediate(resolve));
  });

  it('keeps the pending link when replay does not complete', async () => {
    const deleted: string[] = [];
    const router = makeRouter({
      cache: {
        get: async () => ok(storedNonce({ pendingEvent: { message: 'what is on my calendar?' } })),
        set: async () => ok(undefined),
        del: async (key: string) => { deleted.push(key); return ok(undefined); },
        setNx: async () => ok(true),
        scanDel: async () => ok(0),
      },
      prisma: {
        memberSession: {
          update: async () => ({}),
          updateMany: async () => ({ count: 0 }),
        },
      },
      onLinked: async () => false,
    });

    const response = await callLink(router, { state: linkState() }, signedInAs('user-1'));

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { linked: true, replaying: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(deleted, [larkOAuthReplayKey('nonce-1')], 'the nonce remains retryable until replay completes');
  });

  it('logs a nonce cleanup failure without hiding a successful link', async () => {
    const events: string[] = [];
    const router = makeRouter({
      logger: {
        ...noopLogger,
        error: (event: string) => { events.push(event); },
      },
      cache: {
        get: async () => ok(storedNonce()),
        set: async () => ok(undefined),
        del: async () => ({ ok: false, error: new Error('redis unavailable') }),
        setNx: async () => ok(true),
        scanDel: async () => ok(0),
      },
      prisma: {
        memberSession: {
          update: async () => ({}),
          updateMany: async () => ({ count: 0 }),
        },
      },
    });

    const response = await callLink(router, { state: linkState() }, signedInAs('user-1'));

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { linked: true, replaying: false });
    assert.deepEqual(events, ['lark.auth.link.nonce_cleanup_failed']);
  });

  it('says so plainly when the link is not a link', async () => {
    const router = makeRouter();
    const response = await callLink(router, { state: 'not-base64-json' }, signedInAs('user-1'));
    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { error: 'invalid_link' });
  });

  it('needs a session — the route never creates one', async () => {
    const router = makeRouter();
    const response = await callLink(router, { state: linkState() }, {});
    assert.equal(response.status, 401);
    assert.deepEqual(response.body, { error: 'not_signed_in' });
  });
});
