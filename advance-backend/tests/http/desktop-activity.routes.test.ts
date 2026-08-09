import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';

import {
  createDesktopActivityRoutes,
  createDesktopTeamActivityRoutes,
} from '../../src/http/desktop/desktop-activity.routes.ts';

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
  opts: { query?: Record<string, string>; locals?: Record<string, unknown>; params?: Record<string, string> } = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    let status = 200;
    const req = { method, path, params: opts.params ?? {}, query: opts.query ?? {}, headers: {}, body: {} } as unknown as Request;
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

    // 112, not 90: the ceiling is sixteen weeks because that is what the Home
    // calendar is drawn over — sixteen columns of seven. The number moved; the
    // guard this test exists for did not.
    assert.equal(result.body.data.days, 112);
  });

  it('serves the full sixteen weeks the Home calendar asks for', async () => {
    const { prisma } = spyPrisma();
    const result = await callRoute(createDesktopActivityRoutes(deps(prisma)), 'GET', '/usage', {
      locals, query: { days: '112' },
    });

    // Silently clamped to 90 this drew thirteen columns and a ragged
    // fourteenth, which reads as missing data rather than a shorter window.
    assert.equal(result.body.data.days, 112);
    assert.equal(result.body.data.series.length, 112);
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

describe('a manager reads their team’s cost', () => {
  const deps = (prisma: any) => ({ prisma, logger: noopLogger, memberJwtSecret: 'x' });
  const locals = { userId: 'manager-1', companyId: 'company-1' };
  const params = { departmentId: 'dept-1' };

  /**
   * `companyRole` is what AdminMembership says; `managesDepartment` is whether
   * the MANAGER lookup finds a row. Together they cover the two ways in.
   */
  function spyPrisma(options: {
    companyRole?: string | null;
    managesDepartment?: boolean;
    members?: Array<{ userId: string; name: string; email: string; slug: string }>;
    usage?: Array<{ userId: string; modelId: string; _sum: Record<string, number> }>;
    runs?: Array<{ userId: string; count: number }>;
  } = {}) {
    const wheres: Record<string, unknown>[] = [];
    const members = options.members ?? [
      { userId: 'user-a', name: 'Ada', email: 'ada@example.com', slug: 'MEMBER' },
      { userId: 'user-b', name: 'Ben', email: 'ben@example.com', slug: 'MEMBER' },
    ];
    return {
      wheres,
      prisma: {
        adminMembership: {
          findFirst: async () => (options.companyRole === null ? null : { role: options.companyRole ?? 'MEMBER' }),
        },
        departmentMembership: {
          findFirst: async () => (options.managesDepartment ?? true ? { id: 'membership-1' } : null),
          findMany: async () => members.map(m => ({
            userId: m.userId,
            user: { name: m.name, email: m.email },
            role: { slug: m.slug, name: m.slug === 'MANAGER' ? 'Manager' : 'Member' },
          })),
        },
        aiTokenUsage: {
          groupBy: async (args: any) => { wheres.push(args?.where ?? {}); return options.usage ?? []; },
        },
        executionRun: {
          groupBy: async (args: any) => {
            wheres.push(args?.where ?? {});
            return (options.runs ?? []).map(r => ({ userId: r.userId, _count: { id: r.count } }));
          },
        },
      } as any,
    };
  }

  it('refuses somebody who neither manages the team nor administers the company', async () => {
    const { prisma } = spyPrisma({ companyRole: 'MEMBER', managesDepartment: false });
    const result = await callRoute(
      createDesktopTeamActivityRoutes(deps(prisma)), 'GET', '/departments/:departmentId/usage', { locals, params },
    );

    assert.equal(result.status, 403);
  });

  it('refuses somebody with no live membership in the company at all', async () => {
    const { prisma } = spyPrisma({ companyRole: null });
    const result = await callRoute(
      createDesktopTeamActivityRoutes(deps(prisma)), 'GET', '/departments/:departmentId/usage', { locals, params },
    );

    assert.equal(result.status, 403);
  });

  it('admits a company admin who does not personally manage the team', async () => {
    const { prisma } = spyPrisma({ companyRole: 'COMPANY_ADMIN', managesDepartment: false });
    const result = await callRoute(
      createDesktopTeamActivityRoutes(deps(prisma)), 'GET', '/departments/:departmentId/usage', { locals, params },
    );

    assert.equal(result.status, 200);
  });

  it('reads only the people in this department', async () => {
    const { prisma, wheres } = spyPrisma({ managesDepartment: true });
    await callRoute(
      createDesktopTeamActivityRoutes(deps(prisma)), 'GET', '/departments/:departmentId/usage', { locals, params },
    );

    // The member list is the only thing bounding these queries, so it has to
    // reach every one of them — otherwise a manager sees the whole company.
    assert.ok(wheres.length > 0);
    for (const where of wheres) {
      assert.equal(where['companyId'], 'company-1');
      assert.deepEqual((where['userId'] as any)?.in, ['user-a', 'user-b']);
    }
  });

  it('totals spend and runs per person, heaviest first', async () => {
    const { prisma } = spyPrisma({
      usage: [
        { userId: 'user-a', modelId: 'deepseek-v4-flash', _sum: { actualInputTokens: 1_000_000, cacheReadInputTokens: 0, actualOutputTokens: 0 } },
        { userId: 'user-b', modelId: 'deepseek-v4-flash', _sum: { actualInputTokens: 5_000_000, cacheReadInputTokens: 0, actualOutputTokens: 0 } },
      ],
      runs: [{ userId: 'user-a', count: 3 }],
    });
    const result = await callRoute(
      createDesktopTeamActivityRoutes(deps(prisma)), 'GET', '/departments/:departmentId/usage', { locals, params },
    );

    const { people, spendUsd, runs, totalPeople, activePeople } = result.body.data;
    assert.deepEqual(people.map((p: any) => p.userId), ['user-b', 'user-a']);
    assert.ok(spendUsd > 0);
    assert.equal(runs, 3);
    assert.equal(totalPeople, 2);
    // Ben spent tokens but has no runs in the window; adoption counts runs.
    assert.equal(activePeople, 1);
  });

  it('answers plainly for a department with nobody in it', async () => {
    const { prisma } = spyPrisma({ members: [] });
    const result = await callRoute(
      createDesktopTeamActivityRoutes(deps(prisma)), 'GET', '/departments/:departmentId/usage', { locals, params },
    );

    // An empty team must not turn into an unbounded `userId: { in: [] }` query
    // or a divide-by-zero in the caller's percentages.
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.data, { days: 30, spendUsd: 0, runs: 0, totalPeople: 0, activePeople: 0, people: [] });
  });
});
