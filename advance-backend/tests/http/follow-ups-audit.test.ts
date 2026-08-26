import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { createBroadcastRoutes } from '../../src/http/member/broadcasts.routes.ts';
import { createFollowUpRoutes } from '../../src/http/member/follow-ups.routes.ts';
import { createFollowUpDigestRunner } from '../../src/application/follow-ups/follow-up-digest.runner.ts';
import type { AuditService, RecordAuditInput } from '../../src/application/observability/audit.service.ts';
import { ok, err } from '../../src/shared/result.ts';
import { InfraError } from '../../src/shared/errors.ts';

// ─── helpers ───────────────────────────────────────────────────────────────

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child() { return this as unknown as typeof noopLogger; },
} as unknown as import('../../src/shared/logger.ts').Logger;

const allowed = async () => ({ kind: 'allowed' as const });
const resolveDept = async () => 'dept-1';

type Captured = RecordAuditInput;

function makeAudit(captured: Captured[]): AuditService {
  const svc = {
    record(input: RecordAuditInput) {
      captured.push(input);
    },
  } satisfies Pick<AuditService, 'record'>;
  return svc as unknown as AuditService;
}

function fakeRes(locals: Record<string, unknown> = {}) {
  let status = 200;
  let body: unknown = undefined;
  const res = {
    locals: { companyId: 'co-1', userId: 'u-1', aiRole: 'MEMBER', ...locals },
    status(code: number) { status = code; return res; },
    json(payload: unknown) { body = payload; return res; },
    getStatus() { return status; },
    getBody() { return body; },
  } as unknown as Response & { getStatus(): number; getBody(): unknown; locals: Record<string, unknown> };
  // attach helpers for test
  (res as unknown as { _getStatus: () => number })._getStatus = () => status;
  (res as unknown as { _getBody: () => unknown })._getBody = () => body;
  return res;
}

async function callRoute(
  router: ReturnType<typeof createBroadcastRoutes> | ReturnType<typeof createFollowUpRoutes>,
  method: string,
  path: string,
  opts: {
    body?: unknown;
    query?: Record<string, string>;
    params?: Record<string, string>;
    locals?: Record<string, unknown>;
  } = {},
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve) => {
    let status = 200;
    let responseBody: unknown = undefined;
    const locals = { companyId: 'co-1', userId: 'u-1', aiRole: 'MEMBER', ...(opts.locals ?? {}) };

    const req = {
      method,
      body: opts.body ?? {},
      query: opts.query ?? {},
      params: opts.params ?? {},
      headers: {},
    } as unknown as Request;

    const res = {
      locals,
      status: (s: number) => { status = s; return res; },
      json: (b: unknown) => { responseBody = b; resolve({ status, body: responseBody }); return res; },
    } as unknown as Response;

    const next = (e?: unknown) => {
      if (e) {
        const err = e as Error & { status?: number };
        status = err.status ?? 500;
        responseBody = { error: err.message };
      }
      resolve({ status, body: responseBody });
    };

    const stack: unknown[] = (router as unknown as { stack: unknown[] }).stack ?? [];
    function matchLayer(layer: unknown, url: string): Record<string, string> | null {
      const l = layer as { route?: { path: string; methods: Record<string, boolean>; stack: { handle: (req: Request, res: Response, next: (e?: unknown) => void) => unknown }[] } };
      if (!l.route) return null;
      const routePath: string = l.route.path;
      const routeMethod = Object.keys(l.route.methods)[0]?.toUpperCase();
      if (routeMethod !== method.toUpperCase()) return null;
      const paramNames: string[] = [];
      const pattern = routePath.replace(/:([^/]+)/g, (_: string, name: string) => { paramNames.push(name); return '([^/]+)'; });
      const m = url.match(new RegExp(`^${pattern}$`));
      if (!m) return null;
      const params: Record<string, string> = {};
      paramNames.forEach((name, i) => { params[name] = m[i + 1]!; });
      return params;
    }

    let matched = false;
    for (const layer of stack as Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (req: Request, res: Response, next: (e?: unknown) => void) => unknown }> } }>) {
      const params = matchLayer(layer, path);
      if (params !== null) {
        (req as unknown as { params: Record<string, string> }).params = { ...params, ...(opts.params ?? {}) };
        matched = true;
        const handler = layer.route?.stack[0]?.handle;
        if (handler) {
          Promise.resolve(handler(req, res, next)).catch(next);
        } else {
          next();
        }
        break;
      }
    }
    if (!matched) {
      // try to find handler by also checking if path has no params but we passed params directly
      // fallback: iterate again for routes without params
      for (const layer of stack as Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (req: Request, res: Response, next: (e?: unknown) => void) => unknown }> } }>) {
        const l = layer as { route?: { path: string; methods: Record<string, boolean> } };
        if (!l.route) continue;
        if (l.route.path === path && Object.keys(l.route.methods)[0]?.toUpperCase() === method.toUpperCase()) {
          (req as unknown as { params: Record<string, string> }).params = opts.params ?? {};
          const handler = (layer as unknown as { route: { stack: Array<{ handle: (req: Request, res: Response, next: (e?: unknown) => void) => unknown }> } }).route.stack[0]?.handle;
          if (handler) {
            Promise.resolve(handler(req, res, next)).catch(next);
            matched = true;
            break;
          }
        }
      }
    }
    if (!matched) resolve({ status: 404, body: { error: 'not_matched', path, method } });
  });
}

// ─── broadcast tests ───────────────────────────────────────────────────────

describe('follow-ups audit', () => {
  it('broadcast sent success records counts and no phone numbers', async () => {
    const captured: Captured[] = [];
    const audit = makeAudit(captured);
    const broadcasts = {
      send: async () => ok({ broadcastId: 'b-1', skipped: ['a'], unverified: [] }),
      cancel: async () => ok({ stopped: true }),
    } as unknown as import('../../src/application/whatsapp/whatsapp-broadcast.service.ts').WhatsappBroadcastService;

    const router = createBroadcastRoutes({
      broadcasts,
      resolveDepartmentId: resolveDept,
      authorize: allowed as unknown as import('../../src/http/member/broadcasts.routes.ts').BroadcastRoutesDeps['authorize'],
      auditService: audit,
      logger: noopLogger,
    });

    const { status } = await callRoute(router, 'POST', '/', {
      body: {
        sessionId: 'sess-1',
        label: 'test',
        body: 'hello world',
        recipients: [{ waChatId: '12592995127491@lid', displayName: 'Priya', isGroup: false }],
      },
    });

    assert.equal(status, 202);
    assert.equal(captured.length, 1);
    const rec = captured[0]!;
    assert.equal(rec.action, 'followups.broadcast.sent');
    assert.equal(rec.outcome, 'success');
    assert.equal(rec.actorId, 'u-1');
    assert.equal(rec.companyId, 'co-1');
    const meta = rec.metadata as Record<string, unknown>;
    assert.equal(meta['broadcastId'], 'b-1');
    assert.equal(meta['recipients'], 1);
    // no phone numbers or bodies in metadata
    const dumped = JSON.stringify(meta);
    assert.doesNotMatch(dumped, /12592995/);
    assert.doesNotMatch(dumped, /hello world/);
    assert.doesNotMatch(dumped, /@lid/);
    // Which team sent it. `AuditLog` has no departmentId column, so the row
    // carries it in metadata or the trail cannot answer "what did UA do" — the
    // question this feature exists inside a shared company to answer.
    assert.equal(meta['departmentId'], 'dept-1');
  });

  it('broadcast sent failure records failure with counts', async () => {
    const captured: Captured[] = [];
    const audit = makeAudit(captured);
    const broadcastErr = new InfraError({ layer: 'http', op: 'whatsapp.broadcastRefused', cause: { reason: 'too_many' }, message: 'too many' });
    const broadcasts = {
      send: async () => err(broadcastErr),
    } as unknown as import('../../src/application/whatsapp/whatsapp-broadcast.service.ts').WhatsappBroadcastService;

    const router = createBroadcastRoutes({
      broadcasts,
      resolveDepartmentId: resolveDept,
      authorize: allowed as unknown as import('../../src/http/member/broadcasts.routes.ts').BroadcastRoutesDeps['authorize'],
      auditService: audit,
      logger: noopLogger,
    });

    await callRoute(router, 'POST', '/', {
      body: {
        sessionId: 'sess-1',
        label: 'test',
        body: 'hello',
        recipients: [{ waChatId: '12592995127491@lid', displayName: 'Priya', isGroup: false }],
      },
    });

    assert.equal(captured.length, 1);
    assert.equal(captured[0]!.action, 'followups.broadcast.sent');
    assert.equal(captured[0]!.outcome, 'failure');
    const dumped = JSON.stringify(captured[0]!.metadata);
    assert.doesNotMatch(dumped, /@lid/);
    // A failure row that does not say why is a row nobody can act on.
    const failMeta = captured[0]!.metadata as Record<string, unknown>;
    assert.equal(failMeta['error'], 'too many');
    assert.equal(failMeta['departmentId'], 'dept-1');
  });

  it('broadcast cancelled records success', async () => {
    const captured: Captured[] = [];
    const audit = makeAudit(captured);
    const broadcasts = {
      cancel: async () => ok({ stopped: true }),
      send: async () => ok({ broadcastId: 'b-1', skipped: [], unverified: [] }),
    } as unknown as import('../../src/application/whatsapp/whatsapp-broadcast.service.ts').WhatsappBroadcastService;

    const router = createBroadcastRoutes({
      broadcasts,
      resolveDepartmentId: resolveDept,
      authorize: allowed as unknown as import('../../src/http/member/broadcasts.routes.ts').BroadcastRoutesDeps['authorize'],
      auditService: audit,
      logger: noopLogger,
    });

    const { status } = await callRoute(router, 'POST', '/b-1/cancel', {
      params: { id: 'b-1' },
    });

    assert.equal(status, 200);
    assert.equal(captured.length, 1);
    assert.equal(captured[0]!.action, 'followups.broadcast.cancelled');
    assert.equal(captured[0]!.outcome, 'success');
    assert.equal((captured[0]!.metadata as Record<string, unknown>)['departmentId'], 'dept-1');
  });

  it('followups.item.resolved verb on done', async () => {
    const captured: Captured[] = [];
    const audit = makeAudit(captured);
    const followUps = {
      listOpen: async () => ok([]),
      listChats: async () => ok([]),
      setFollowUpState: async () => ok({ id: 'f-1' }),
      setChatTracking: async () => ok({ id: 'c-1' }),
    } as unknown as import('../../src/infrastructure/persistence/follow-ups.repository.ts').FollowUpsRepoPort;
    const sessions = {
      list: async () => ok([]),
      create: async () => ok({ id: 'n-1', label: 'x' }),
    } as unknown as import('../../src/application/whatsapp/whatsapp-session.service.ts').WhatsappSessionService;

    const router = createFollowUpRoutes({
      followUps,
      sessions: sessions,
      historyRepair: { repair: async () => ok({ chatsRead: 0, messagesRecovered: 0, failures: [] }) } as unknown as import('../../src/application/whatsapp/whatsapp-history-repair.ts').WhatsappHistoryRepair,
      resolveDepartmentId: resolveDept,
      authorize: allowed as unknown as import('../../src/http/member/follow-ups.routes.ts').FollowUpRoutesDeps['authorize'],
      auditService: audit,
      logger: noopLogger,
    });

    const { status } = await callRoute(router, 'PATCH', '/f-1', {
      params: { id: 'f-1' },
      body: { action: 'done' },
    });

    assert.equal(status, 200);
    assert.equal(captured.length, 1);
    assert.equal(captured[0]!.action, 'followups.item.resolved');
    assert.equal(captured[0]!.outcome, 'success');
    assert.equal((captured[0]!.metadata as Record<string, unknown>)['followUpId'], 'f-1');
  });

  it('404 on follow-up records nothing', async () => {
    const captured: Captured[] = [];
    const audit = makeAudit(captured);
    const followUps = {
      listOpen: async () => ok([]),
      listChats: async () => ok([]),
      setFollowUpState: async () => ok(null),
      setChatTracking: async () => ok({ id: 'c-1' }),
    } as unknown as import('../../src/infrastructure/persistence/follow-ups.repository.ts').FollowUpsRepoPort;
    const sessions = {
      list: async () => ok([]),
      create: async () => ok({ id: 'n-1', label: 'x' }),
    } as unknown as import('../../src/application/whatsapp/whatsapp-session.service.ts').WhatsappSessionService;

    const router = createFollowUpRoutes({
      followUps,
      sessions,
      historyRepair: { repair: async () => ok({ chatsRead: 0, messagesRecovered: 0, failures: [] }) } as unknown as import('../../src/application/whatsapp/whatsapp-history-repair.ts').WhatsappHistoryRepair,
      resolveDepartmentId: resolveDept,
      authorize: allowed as unknown as import('../../src/http/member/follow-ups.routes.ts').FollowUpRoutesDeps['authorize'],
      auditService: audit,
      logger: noopLogger,
    });

    const { status } = await callRoute(router, 'PATCH', '/missing', {
      params: { id: 'missing' },
      body: { action: 'done' },
    });

    assert.equal(status, 404);
    assert.equal(captured.length, 0);
  });

  it('followups.number.linked records success with id only', async () => {
    const captured: Captured[] = [];
    const audit = makeAudit(captured);
    const followUps = {
      listOpen: async () => ok([]),
      listChats: async () => ok([]),
      setFollowUpState: async () => ok({ id: 'f-1' }),
      setChatTracking: async () => ok({ id: 'c-1' }),
    } as unknown as import('../../src/infrastructure/persistence/follow-ups.repository.ts').FollowUpsRepoPort;
    const sessions = {
      list: async () => ok([]),
      create: async () => ok({ id: 'n-99', label: 'Bookings' }),
    } as unknown as import('../../src/application/whatsapp/whatsapp-session.service.ts').WhatsappSessionService;

    const router = createFollowUpRoutes({
      followUps,
      sessions,
      historyRepair: { repair: async () => ok({ chatsRead: 0, messagesRecovered: 0, failures: [] }) } as unknown as import('../../src/application/whatsapp/whatsapp-history-repair.ts').WhatsappHistoryRepair,
      resolveDepartmentId: resolveDept,
      authorize: allowed as unknown as import('../../src/http/member/follow-ups.routes.ts').FollowUpRoutesDeps['authorize'],
      auditService: audit,
      logger: noopLogger,
    });

    const { status } = await callRoute(router, 'POST', '/numbers', {
      body: { label: 'Bookings desk' },
    });

    assert.equal(status, 200);
    assert.equal(captured.length, 1);
    assert.equal(captured[0]!.action, 'followups.number.linked');
    assert.equal(captured[0]!.outcome, 'success');
    assert.equal((captured[0]!.metadata as Record<string, unknown>)['numberId'], 'n-99');
  });

  it('followups.chat.tracking_changed records muted', async () => {
    const captured: Captured[] = [];
    const audit = makeAudit(captured);
    const followUps = {
      listOpen: async () => ok([]),
      listChats: async () => ok([]),
      setFollowUpState: async () => ok({ id: 'f-1' }),
      setChatTracking: async () => ok({ id: 'chat-1' }),
    } as unknown as import('../../src/infrastructure/persistence/follow-ups.repository.ts').FollowUpsRepoPort;
    const sessions = {
      list: async () => ok([]),
      create: async () => ok({ id: 'n-1', label: 'x' }),
    } as unknown as import('../../src/application/whatsapp/whatsapp-session.service.ts').WhatsappSessionService;

    const router = createFollowUpRoutes({
      followUps,
      sessions,
      historyRepair: { repair: async () => ok({ chatsRead: 0, messagesRecovered: 0, failures: [] }) } as unknown as import('../../src/application/whatsapp/whatsapp-history-repair.ts').WhatsappHistoryRepair,
      resolveDepartmentId: resolveDept,
      authorize: allowed as unknown as import('../../src/http/member/follow-ups.routes.ts').FollowUpRoutesDeps['authorize'],
      auditService: audit,
      logger: noopLogger,
    });

    const { status } = await callRoute(router, 'PATCH', '/chats/chat-1', {
      params: { id: 'chat-1' },
      body: { muted: true },
    });

    assert.equal(status, 200);
    assert.equal(captured.length, 1);
    assert.equal(captured[0]!.action, 'followups.chat.tracking_changed');
    assert.equal((captured[0]!.metadata as Record<string, unknown>)['muted'], true);
    assert.equal((captured[0]!.metadata as Record<string, unknown>)['chatId'], 'chat-1');
  });

  it('digest delivered success uses system actor and counts only', async () => {
    const captured: Captured[] = [];
    const audit = makeAudit(captured);
    const repo = {
      readDigestWindow: async () => ok({ items: [{ id: 'f-1', title: 'x', owner: 'us', counterparty: 'Priya', chatName: 'c', dueDate: null, urgency: 'high', sessionId: 's-1', sessionLabel: 'Desk' }], dark: [] }),
      completeDigest: async () => ok(undefined),
      releaseDigest: async () => ok(undefined),
    } as unknown as import('../../src/infrastructure/persistence/follow-ups.repository.ts').FollowUpsRepoPort;

    const claim = {
      digestId: 'd-1',
      companyId: 'co-1',
      departmentId: 'dept-1',
      larkChatId: 'oc_1',
      timesJson: ['09:00'],
      daysJson: ['MO'],
      timeZone: 'Asia/Kolkata',
      coveredThrough: new Date('2026-08-24T00:00:00Z'),
      scheduledFor: new Date('2026-08-25T03:30:00Z'),
      claimToken: 't-1',
    } as unknown as import('../../src/infrastructure/persistence/follow-ups.repository.ts').ClaimedDigest;

    const runner = createFollowUpDigestRunner({
      repo,
      deliver: async () => 'msg',
      auditService: audit,
      logger: noopLogger,
      now: () => new Date('2026-08-25T03:30:00Z'),
    });

    await runner(claim);
    assert.equal(captured.length, 1);
    assert.equal(captured[0]!.actorId, 'system');
    assert.equal(captured[0]!.action, 'followups.digest.delivered');
    assert.equal(captured[0]!.outcome, 'success');
    const m = captured[0]!.metadata as Record<string, unknown>;
    assert.equal(m['digestId'], 'd-1');
    assert.equal(typeof m['cards'], 'number');
  });

  it('digest delivered failure uses system actor', async () => {
    const captured: Captured[] = [];
    const audit = makeAudit(captured);
    const repo = {
      readDigestWindow: async () => ok({ items: [{ id: 'f-1', title: 'x', owner: 'us', counterparty: 'Priya', chatName: 'c', dueDate: null, urgency: 'high', sessionId: 's-1', sessionLabel: 'Desk' }], dark: [] }),
      completeDigest: async () => ok(undefined),
      releaseDigest: async () => ok(undefined),
    } as unknown as import('../../src/infrastructure/persistence/follow-ups.repository.ts').FollowUpsRepoPort;

    const claim = {
      digestId: 'd-2',
      companyId: 'co-1',
      departmentId: 'dept-1',
      larkChatId: 'oc_1',
      timesJson: ['09:00'],
      daysJson: ['MO'],
      timeZone: 'Asia/Kolkata',
      coveredThrough: new Date('2026-08-24T00:00:00Z'),
      scheduledFor: new Date('2026-08-25T03:30:00Z'),
      claimToken: 't-1',
    } as unknown as import('../../src/infrastructure/persistence/follow-ups.repository.ts').ClaimedDigest;

    const runner = createFollowUpDigestRunner({
      repo,
      deliver: async () => { throw new Error('lark down'); },
      auditService: audit,
      logger: noopLogger,
      now: () => new Date('2026-08-25T03:30:00Z'),
    });

    await runner(claim);
    assert.equal(captured.length, 1);
    assert.equal(captured[0]!.actorId, 'system');
    assert.equal(captured[0]!.action, 'followups.digest.delivered');
    assert.equal(captured[0]!.outcome, 'failure');
    // The reason is the whole point of the durable copy: `log.error` carries it
    // too, but that line rolls off with the container's log cap.
    const digestMeta = captured[0]!.metadata as Record<string, unknown>;
    assert.equal(digestMeta['error'], 'lark down');
    assert.equal(digestMeta['departmentId'], 'dept-1');
  });
});
