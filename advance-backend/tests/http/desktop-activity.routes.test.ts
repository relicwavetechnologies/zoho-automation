import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';

import { createDesktopActivityRoutes } from '../../src/http/desktop/desktop-activity.routes.ts';

const noopLogger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  child: function() { return this; },
} as any;

/**
 * Calls the last handler on a route, skipping member auth — `locals` stands in
 * for what the middleware would have set, which is exactly the boundary these
 * tests care about.
 */
function callRoute(
  router: ReturnType<typeof createDesktopActivityRoutes>,
  method: 'GET',
  path: string,
  opts: { query?: Record<string, string>; locals?: Record<string, unknown> } = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    let status = 200;
    const req = { method, path, params: {}, query: opts.query ?? {}, headers: {}, body: {} } as unknown as Request;
    const res = {
      locals: opts.locals ?? {},
      status: (s: number) => { status = s; return res; },
      json: (b: unknown) => { resolve({ status, body: b }); return res; },
    } as unknown as Response;

    const stack = (router as any).stack as any[];
    const layer = stack.find(item => item.route?.path === path && item.route?.methods?.[method.toLowerCase()]);
    if (!layer) { resolve({ status: 404, body: { error: 'not_found' } }); return; }
    const handler = layer.route.stack[layer.route.stack.length - 1]?.handle;
    Promise.resolve(handler(req, res, () => resolve({ status: 404, body: { error: 'next' } })))
      .catch((error: unknown) => resolve({ status: 500, body: String(error) }));
  });
}

describe('a member reads their own activity', () => {
  /** Records every `where` the router builds, so the scoping can be asserted. */
  function spyPrisma(overrides: Record<string, unknown> = {}) {
    const wheres: Record<string, unknown>[] = [];
    const capture = <T>(value: T) => async (args: any) => { wheres.push(args?.where ?? {}); return value; };
    return {
      wheres,
      prisma: {
        aiTokenUsage: {
          groupBy: capture([] as unknown[]),
          aggregate: capture({ _sum: { actualInputTokens: 300, cacheReadInputTokens: 700, actualOutputTokens: 50 } }),
        },
        executionRun: {
          count: capture(4),
          findMany: capture([] as unknown[]),
        },
        $queryRaw: async () => [],
        ...overrides,
      } as any,
    };
  }

  const deps = (prisma: any) => ({ prisma, logger: noopLogger, memberJwtSecret: 'x' });
  const locals = { userId: 'user-1', companyId: 'company-1' };

  it('scopes every usage query to the signed-in user', async () => {
    const { prisma, wheres } = spyPrisma();
    const result = await callRoute(createDesktopActivityRoutes(deps(prisma)), 'GET', '/usage', { locals });

    assert.equal(result.status, 200);
    // No query may be company-wide. The admin surface exists for that and does
    // its own authority check; a leak here would show one member another's spend.
    assert.ok(wheres.length > 0);
    for (const where of wheres) {
      assert.equal(where['userId'], 'user-1', `un-scoped query: ${JSON.stringify(where)}`);
      assert.equal(where['companyId'], 'company-1');
    }
  });

  it('reports cache savings as a share of input tokens', async () => {
    const { prisma } = spyPrisma();
    const result = await callRoute(createDesktopActivityRoutes(deps(prisma)), 'GET', '/usage', { locals });

    // 700 of 1000 input tokens were served from cache.
    assert.equal(result.body.data.cacheSavingsPct, 70);
  });

  it('returns a dense series so quiet days are not dropped', async () => {
    const { prisma } = spyPrisma();
    const result = await callRoute(createDesktopActivityRoutes(deps(prisma)), 'GET', '/usage', {
      locals, query: { days: '7' },
    });

    // No usage rows at all, yet every day in the window is present — otherwise
    // a chart compresses its axis and an occasional user looks continuously busy.
    assert.equal(result.body.data.series.length, 7);
    assert.ok(result.body.data.series.every((point: any) => point.spendUsd === 0));
  });

  it('clamps an absurd window rather than scanning the table', async () => {
    const { prisma } = spyPrisma();
    const result = await callRoute(createDesktopActivityRoutes(deps(prisma)), 'GET', '/usage', {
      locals, query: { days: '100000' },
    });

    assert.equal(result.body.data.days, 90);
  });

  it('ignores a userId supplied by the caller', async () => {
    const { prisma, wheres } = spyPrisma();
    // There is no userId parameter by design. Passing one must change nothing:
    // the only identity this router trusts is the one the session resolved.
    await callRoute(createDesktopActivityRoutes(deps(prisma)), 'GET', '/usage', {
      locals, query: { userId: 'someone-else' },
    });

    for (const where of wheres) assert.equal(where['userId'], 'user-1');
  });

  it('prices a run from the usage rows that carry its id', async () => {
    const started = new Date('2026-07-01T10:00:00.000Z');
    const finished = new Date('2026-07-01T10:03:00.000Z');
    const prisma = {
      executionRun: {
        findMany: async () => [{
          id: 'run-1', channel: 'lark', entrypoint: 'chat', status: 'completed',
          latestSummary: 'Reconciled the ledger', errorMessage: null,
          startedAt: started, finishedAt: finished,
        }],
      },
      aiTokenUsage: {
        groupBy: async () => [{
          executionRunId: 'run-1',
          modelId: 'deepseek-v4-flash',
          _sum: { actualInputTokens: 1_000_000, cacheReadInputTokens: 0, actualOutputTokens: 0 },
        }],
      },
    } as any;

    const result = await callRoute(createDesktopActivityRoutes(deps(prisma)), 'GET', '/runs', { locals });

    assert.equal(result.status, 200);
    const [run] = result.body.data.runs;
    assert.equal(run.id, 'run-1');
    assert.equal(run.durationMs, 180_000);
    assert.ok(run.costUsd > 0, 'a run with recorded tokens must carry a cost');
  });

  it('gives a run with no recorded usage a zero rather than failing', async () => {
    const prisma = {
      executionRun: {
        findMany: async () => [{
          id: 'run-2', channel: 'desktop', entrypoint: 'chat', status: 'running',
          latestSummary: null, errorMessage: null,
          startedAt: new Date(), finishedAt: null,
        }],
      },
      // AiTokenUsage.executionRunId is nullable on the backend channel, so a run
      // with nothing attributed to it is a normal row, not a broken one.
      aiTokenUsage: { groupBy: async () => [{ executionRunId: null, modelId: 'deepseek-v4-flash', _sum: {} }] },
    } as any;

    const result = await callRoute(createDesktopActivityRoutes(deps(prisma)), 'GET', '/runs', { locals });

    assert.equal(result.status, 200);
    assert.equal(result.body.data.runs[0].costUsd, 0);
    assert.equal(result.body.data.runs[0].durationMs, null);
  });
});
