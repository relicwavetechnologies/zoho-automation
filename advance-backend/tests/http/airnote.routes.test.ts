/**
 * Unit tests for airnote.routes.ts.
 *
 * Does NOT spin up a real Express server — extracts handlers from the Router
 * stack and calls them directly (same pattern as execution.routes.test.ts).
 *
 * Covers:
 *   (a) missing Bearer → 401 from airnoteAuth
 *   (a2) invalid Lark token → 401
 *   (a3) Lark user not linked to Divo → 403
 *   (b) no threadId → creates thread + emits meta then done
 *   (c) threadId present → reuses thread + loads history
 *   (d) threadId ownership mismatch → error SSE event
 *   (e) engine error → error SSE event + res.end
 *   (f) done carries persisted DesktopMessage id
 *   (g) GET /threads/:threadId returns messages for owner
 *   (h) GET /threads/:threadId returns 404 for wrong user
 */

import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response, NextFunction } from 'express';
import { createAirnoteRoutes } from '../../src/http/airnote/airnote.routes.ts';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const noopLogger = {
  info:  () => {},
  warn:  () => {},
  error: () => {},
  debug: () => {},
  child: function () { return this; },
} as any;

/** Minimal mock res that captures SSE frames and JSON calls. */
function makeMockRes(locals: Record<string, unknown> = {}) {
  const written: string[] = [];
  let ended = false;
  let statusCode = 200;
  let jsonBody: unknown;

  const res = {
    locals,
    writableEnded: false,
    setHeader: () => res,
    flushHeaders: () => {},
    on: (_event: string, _cb: () => void) => res,
    write: (chunk: string) => { written.push(chunk); return true; },
    end: () => { ended = true; res.writableEnded = true; },
    status: (s: number) => { statusCode = s; return res; },
    json: (body: unknown) => { jsonBody = body; return res; },
  } as unknown as Response & { written: string[]; ended: boolean; statusCode: number; jsonBody: unknown };

  (res as any).written    = written;
  (res as any).ended      = ended;
  (res as any).statusCode = statusCode;
  (res as any).jsonBody   = jsonBody;

  // Re-expose via getter so the test reads the latest value.
  Object.defineProperty(res, 'ended',      { get: () => ended });
  Object.defineProperty(res, 'statusCode', { get: () => statusCode });
  Object.defineProperty(res, 'jsonBody',   { get: () => jsonBody });

  return res as unknown as Response & {
    written: string[];
    ended: boolean;
    statusCode: number;
    jsonBody: unknown;
  };
}

/** Parse SSE frames from res.written into { name, data } objects. */
function parseSseFrames(written: string[]): Array<{ name: string; data: unknown }> {
  const frames: Array<{ name: string; data: unknown }> = [];
  for (const chunk of written) {
    const eventMatch = chunk.match(/^event: ([^\n]+)\ndata: (.+)\n\n$/s);
    if (eventMatch) {
      frames.push({ name: eventMatch[1]!, data: JSON.parse(eventMatch[2]!) });
    }
  }
  return frames;
}

/** Find the route handler for a given method + path pattern on the router. */
function findHandler(router: ReturnType<typeof createAirnoteRoutes>, method: string, pattern: string) {
  const stack = (router as any).stack as any[];
  for (const layer of stack) {
    if (!layer.route) continue;
    if (layer.route.path === pattern && layer.route.methods[method.toLowerCase()]) {
      const handlers: any[] = layer.route.stack.map((h: any) => h.handle);
      return handlers;
    }
  }
  return null;
}

/** Run all handlers in order (skipping auth by injecting pre-filled locals). */
async function callHandlerSkipAuth(
  handlers: any[],
  req: Partial<Request>,
  res: Response,
) {
  // Skip the first handler (memberAuth middleware) by starting at index 1.
  const business = handlers.slice(1);
  for (const h of business) {
    await new Promise<void>((resolve) => {
      const next: NextFunction = () => resolve();
      const result = h(req, res, next);
      if (result instanceof Promise) result.then(resolve, resolve);
      else resolve();
    });
  }
}

// ─── Mocks ────────────────────────────────────────────────────────────────────

const MOCK_USER_ID    = 'user-001';
const MOCK_COMPANY_ID = 'co-001';
const MOCK_THREAD_ID  = 'thread-abc';
const MOCK_MSG_ID     = 'msg-xyz';

function makeAuthedLocals(overrides: Record<string, unknown> = {}) {
  return {
    userId:     MOCK_USER_ID,
    companyId:  MOCK_COMPANY_ID,
    aiRole:     'MEMBER',
    larkOpenId: 'lark-open-id-001',
    email:      'user@test.com',
    isAdmin:    false,
    sessionId:  'sess-001',
    ...overrides,
  };
}

function makePrisma(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    userDepartmentPreference: {
      findUnique: async () => null,
    },
    desktopThread: {
      create: async () => ({
        id: MOCK_THREAD_ID, userId: MOCK_USER_ID, companyId: MOCK_COMPANY_ID,
        channel: 'airnote', title: 'Test', createdAt: new Date(), updatedAt: new Date(), lastMessageAt: null,
      }),
      findUnique: async ({ where }: any) => {
        if (where.id === MOCK_THREAD_ID) {
          return { id: MOCK_THREAD_ID, userId: MOCK_USER_ID, companyId: MOCK_COMPANY_ID, channel: 'airnote',
                   title: 'Test', messages: [], createdAt: new Date(), updatedAt: new Date(), lastMessageAt: null };
        }
        return null;
      },
      update: async () => ({}),
    },
    desktopMessage: {
      create: async () => ({
        id: MOCK_MSG_ID, threadId: MOCK_THREAD_ID, role: 'assistant', content: 'Hello!',
        metadata: null, createdAt: new Date(),
      }),
      count: async () => 0,
    },
    runtimeConversation: {
      upsert: async () => ({}),
    },
    memberSession: {
      findUnique: async () => null, // auth will 401 for tests that need it
    },
    ...overrides,
  } as any;
}

function makeEngineOk(sendFinalReply?: (conv: any, adapter: any) => Promise<void>) {
  return {
    run: async ({ channelAdapter, conversation }: any) => {
      if (sendFinalReply) {
        await sendFinalReply(conversation, channelAdapter);
      } else {
        await channelAdapter.sendFinalReply(conversation, {
          kind: 'final', text: '# Done', format: 'markdown', branding: undefined,
        });
      }
      return { ok: true, value: undefined };
    },
  } as any;
}

function makeChatSerializer() {
  return {
    run: (_key: string, fn: (signal: AbortSignal) => Promise<void>) => {
      void fn(new AbortController().signal);
    },
  } as any;
}

function makeApprovalGate() {
  return {} as any;
}

/** Lark OAuth service mock — getUserInfo verifies the user token → open_id. */
function makeLarkOAuth(opts: { openId?: string; throws?: boolean } = {}) {
  return {
    getUserInfo: async (_token: string) => {
      if (opts.throws) throw new Error('Lark user info failed: invalid token');
      return {
        larkOpenId: opts.openId ?? 'lark-open-id-001',
        larkUserId: null, larkName: null,
        larkEmail: 'user@test.com', larkEnName: null, tenantKey: null, avatarUrl: null,
      };
    },
  } as any;
}

/** Channel identity repo mock — resolves a Lark open_id to a Divo user. */
function makeChannelIdentityRepo(value: unknown = {
  userId: MOCK_USER_ID, companyId: MOCK_COMPANY_ID, aiRole: 'MEMBER', channel: 'lark',
}) {
  return {
    resolveByLarkOpenId: async (_openId: string) => ({ ok: true, value }),
  } as any;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/airnote/chat', () => {
  it('(a) missing Bearer → airnoteAuth returns 401', async () => {
    const router = createAirnoteRoutes({
      prisma: makePrisma(),
      larkOAuthService: makeLarkOAuth(),
      channelIdentityRepo: makeChannelIdentityRepo(),
      logger: noopLogger,
      engine: makeEngineOk(),
      chatSerializer: makeChatSerializer(),
      approvalGate: makeApprovalGate(),
    });

    const handlers = findHandler(router, 'post', '/chat')!;
    assert.ok(handlers, 'handler not found');

    const res = makeMockRes({});
    const req = {
      method: 'POST', path: '/chat', params: {}, query: {}, body: {},
      headers: {}, // no Authorization
    } as unknown as Request;

    // airnoteAuth is async and ends the response without calling next() — await
    // its own returned promise (do NOT wait on next, which never fires on 401).
    await handlers[0](req, res, () => {});

    assert.equal((res as any).statusCode, 401);
  });

  it('(a2) invalid Lark token → airnoteAuth returns 401', async () => {
    const router = createAirnoteRoutes({
      prisma: makePrisma(),
      larkOAuthService: makeLarkOAuth({ throws: true }),
      channelIdentityRepo: makeChannelIdentityRepo(),
      logger: noopLogger,
      engine: makeEngineOk(),
      chatSerializer: makeChatSerializer(),
      approvalGate: makeApprovalGate(),
    });

    const handlers = findHandler(router, 'post', '/chat')!;
    const res = makeMockRes({});
    const req = {
      method: 'POST', path: '/chat', params: {}, query: {}, body: {},
      headers: { authorization: 'Bearer bad-token' },
    } as unknown as Request;

    await handlers[0](req, res, () => {});

    assert.equal((res as any).statusCode, 401);
  });

  it('(a3) Lark user not linked to Divo → airnoteAuth returns 403', async () => {
    const router = createAirnoteRoutes({
      prisma: makePrisma(),
      larkOAuthService: makeLarkOAuth(),
      channelIdentityRepo: makeChannelIdentityRepo(null), // resolve → null
      logger: noopLogger,
      engine: makeEngineOk(),
      chatSerializer: makeChatSerializer(),
      approvalGate: makeApprovalGate(),
    });

    const handlers = findHandler(router, 'post', '/chat')!;
    const res = makeMockRes({});
    const req = {
      method: 'POST', path: '/chat', params: {}, query: {}, body: {},
      headers: { authorization: 'Bearer valid-token' },
    } as unknown as Request;

    await handlers[0](req, res, () => {});

    assert.equal((res as any).statusCode, 403);
  });

  it('(b) no threadId → creates thread, emits meta + done', async () => {
    const prisma = makePrisma();
    const router = createAirnoteRoutes({
      prisma,
      larkOAuthService: makeLarkOAuth(),
      channelIdentityRepo: makeChannelIdentityRepo(),
      logger: noopLogger,
      engine: makeEngineOk(),
      chatSerializer: makeChatSerializer(),
      approvalGate: makeApprovalGate(),
    });

    const handlers = findHandler(router, 'post', '/chat')!;
    const res = makeMockRes(makeAuthedLocals());
    const req = {
      method: 'POST', path: '/chat', params: {}, query: {},
      body: { requestId: 'req-1', message: 'Hello Divo' },
      headers: {},
    } as unknown as Request;

    await callHandlerSkipAuth(handlers, req, res);

    const frames = parseSseFrames((res as any).written);
    const meta   = frames.find(f => f.name === 'meta');
    const done   = frames.find(f => f.name === 'done');

    assert.ok(meta, 'meta frame missing');
    assert.equal((meta!.data as any).threadId, MOCK_THREAD_ID);
    assert.equal((meta!.data as any).requestId, 'req-1');
    assert.ok(done, 'done frame missing');
    assert.equal((done!.data as any).format, 'markdown');
    assert.ok((res as any).ended, 'res should be ended');
  });

  it('(c) threadId present → reuses thread', async () => {
    const prisma = makePrisma();
    const router = createAirnoteRoutes({
      prisma,
      larkOAuthService: makeLarkOAuth(),
      channelIdentityRepo: makeChannelIdentityRepo(),
      logger: noopLogger,
      engine: makeEngineOk(),
      chatSerializer: makeChatSerializer(),
      approvalGate: makeApprovalGate(),
    });

    const handlers = findHandler(router, 'post', '/chat')!;
    const res = makeMockRes(makeAuthedLocals());
    const req = {
      method: 'POST', path: '/chat', params: {}, query: {},
      body: { requestId: 'req-2', message: 'Follow up', threadId: MOCK_THREAD_ID },
      headers: {},
    } as unknown as Request;

    await callHandlerSkipAuth(handlers, req, res);

    const frames = parseSseFrames((res as any).written);
    const meta   = frames.find(f => f.name === 'meta');
    assert.ok(meta, 'meta frame missing');
    assert.equal((meta!.data as any).threadId, MOCK_THREAD_ID);
  });

  it('(d) threadId ownership mismatch → error SSE event', async () => {
    const prisma = makePrisma({
      desktopThread: {
        findUnique: async () => ({
          id: MOCK_THREAD_ID, userId: 'other-user', companyId: MOCK_COMPANY_ID,
          channel: 'airnote', title: 'x', messages: [], createdAt: new Date(), updatedAt: new Date(),
        }),
        update: async () => ({}),
        create: async () => ({ id: MOCK_THREAD_ID, userId: MOCK_USER_ID, companyId: MOCK_COMPANY_ID }),
      },
    });
    const router = createAirnoteRoutes({
      prisma,
      larkOAuthService: makeLarkOAuth(),
      channelIdentityRepo: makeChannelIdentityRepo(),
      logger: noopLogger,
      engine: makeEngineOk(),
      chatSerializer: makeChatSerializer(),
      approvalGate: makeApprovalGate(),
    });

    const handlers = findHandler(router, 'post', '/chat')!;
    const res = makeMockRes(makeAuthedLocals());
    const req = {
      method: 'POST', path: '/chat', params: {}, query: {},
      body: { requestId: 'req-3', message: 'Hi', threadId: MOCK_THREAD_ID },
      headers: {},
    } as unknown as Request;

    await callHandlerSkipAuth(handlers, req, res);

    const frames = parseSseFrames((res as any).written);
    const error  = frames.find(f => f.name === 'error');
    assert.ok(error, 'error frame missing');
    assert.ok((res as any).ended, 'res should be ended after ownership error');
  });

  it('(e) engine error → error SSE event + res.end', async () => {
    const engine = {
      run: async ({ channelAdapter }: any) => {
        return { ok: false, error: { message: 'Engine exploded' } };
      },
    } as any;

    const prisma = makePrisma();
    const router = createAirnoteRoutes({
      prisma,
      larkOAuthService: makeLarkOAuth(),
      channelIdentityRepo: makeChannelIdentityRepo(),
      logger: noopLogger,
      engine,
      chatSerializer: makeChatSerializer(),
      approvalGate: makeApprovalGate(),
    });

    const handlers = findHandler(router, 'post', '/chat')!;
    const res = makeMockRes(makeAuthedLocals());
    const req = {
      method: 'POST', path: '/chat', params: {}, query: {},
      body: { requestId: 'req-4', message: 'Trigger error' },
      headers: {},
    } as unknown as Request;

    await callHandlerSkipAuth(handlers, req, res);

    const frames = parseSseFrames((res as any).written);
    const error  = frames.find(f => f.name === 'error');
    assert.ok(error, 'error frame missing');
    assert.ok((res as any).ended, 'res should be ended after engine error');
  });

  it('(f) done carries persisted DesktopMessage id', async () => {
    const prisma = makePrisma();
    const router = createAirnoteRoutes({
      prisma,
      larkOAuthService: makeLarkOAuth(),
      channelIdentityRepo: makeChannelIdentityRepo(),
      logger: noopLogger,
      engine: makeEngineOk(),
      chatSerializer: makeChatSerializer(),
      approvalGate: makeApprovalGate(),
    });

    const handlers = findHandler(router, 'post', '/chat')!;
    const res = makeMockRes(makeAuthedLocals());
    const req = {
      method: 'POST', path: '/chat', params: {}, query: {},
      body: { requestId: 'req-5', message: 'Give me data' },
      headers: {},
    } as unknown as Request;

    await callHandlerSkipAuth(handlers, req, res);

    const frames = parseSseFrames((res as any).written);
    const done   = frames.find(f => f.name === 'done');
    assert.ok(done, 'done frame missing');
    assert.equal((done!.data as any).message.id, MOCK_MSG_ID);
    assert.equal((done!.data as any).message.threadId, MOCK_THREAD_ID);
    assert.equal((done!.data as any).message.role, 'assistant');
  });
});

describe('GET /api/airnote/threads/:threadId', () => {
  it('(g) returns messages for the owner', async () => {
    const prisma = makePrisma();
    const router = createAirnoteRoutes({
      prisma,
      larkOAuthService: makeLarkOAuth(),
      channelIdentityRepo: makeChannelIdentityRepo(),
      logger: noopLogger,
      engine: makeEngineOk(),
      chatSerializer: makeChatSerializer(),
      approvalGate: makeApprovalGate(),
    });

    const handlers = findHandler(router, 'get', '/threads/:threadId')!;
    assert.ok(handlers, 'GET /threads/:threadId handler not found');

    const res = makeMockRes(makeAuthedLocals());
    const req = {
      method: 'GET', path: `/threads/${MOCK_THREAD_ID}`,
      params: { threadId: MOCK_THREAD_ID }, query: {},
      body: {}, headers: {},
    } as unknown as Request;

    await callHandlerSkipAuth(handlers, req, res);

    const body = (res as any).jsonBody as any;
    assert.ok(body?.success, 'expected success response');
    assert.equal(body.data.id, MOCK_THREAD_ID);
    assert.ok(Array.isArray(body.data.messages));
  });

  it('(h) returns 404 for non-owner', async () => {
    const prisma = makePrisma({
      desktopThread: {
        findUnique: async () => ({
          id: MOCK_THREAD_ID, userId: 'someone-else', companyId: MOCK_COMPANY_ID,
          channel: 'airnote', title: 'x', messages: [],
          createdAt: new Date(), updatedAt: new Date(), lastMessageAt: null,
        }),
        update: async () => ({}),
        create: async () => ({}),
      },
    });
    const router = createAirnoteRoutes({
      prisma,
      larkOAuthService: makeLarkOAuth(),
      channelIdentityRepo: makeChannelIdentityRepo(),
      logger: noopLogger,
      engine: makeEngineOk(),
      chatSerializer: makeChatSerializer(),
      approvalGate: makeApprovalGate(),
    });

    const handlers = findHandler(router, 'get', '/threads/:threadId')!;
    const res = makeMockRes(makeAuthedLocals());
    const req = {
      method: 'GET', path: `/threads/${MOCK_THREAD_ID}`,
      params: { threadId: MOCK_THREAD_ID }, query: {},
      body: {}, headers: {},
    } as unknown as Request;

    await callHandlerSkipAuth(handlers, req, res);

    assert.equal((res as any).statusCode, 404);
  });
});
