import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';

import { createDesktopSkillRoutes } from '../../src/http/desktop/desktop-skills.routes.ts';

const noopLogger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  child: function() { return this; },
} as any;

function permission(toolActions: Record<string, string[]>) {
  return {
    allowedToolIds: new Set(Object.keys(toolActions)),
    allowedActionsByTool: new Map(
      Object.entries(toolActions).map(([toolId, actions]) => [toolId, new Set(actions)]),
    ),
    decisions: [],
  } as any;
}

function skill(input: {
  id: string;
  slug: string;
  name: string;
  toolIds: string[];
  departmentId?: string;
}) {
  return {
    description: `${input.name} description`,
    aliases: [],
    tags: [],
    instructions: 'Hidden recipe.',
    revision: 1,
    ...input,
  };
}

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    prisma: {
      departmentMembership: {
        findMany: async () => [
          { department: { id: 'dept-tech', name: 'Tech Testing' } },
          { department: { id: 'dept-finance', name: 'Finance' } },
        ],
      },
    },
    memberJwtSecret: 'secret',
    logger: noopLogger,
    skillAccessEnforcement: {
      listGrantedSkillIds: async () => new Set(['skill-menhood', 'skill-company']),
    },
    permissions: {
      resolve: async ({ departmentId }: { departmentId?: string }) => ({
        ok: true,
        value: permission(departmentId === 'dept-finance'
          ? { airtableRecords: ['read'], menhoodData: ['read'] }
          : { menhoodData: ['read'] }),
      }),
    },
    skillCatalog: {
      listVisible: async ({ departmentId }: { departmentId?: string }) => {
        if (departmentId === 'dept-tech') {
          return [
            skill({
              id: 'skill-menhood',
              slug: 'menhood-data',
              name: 'Menhood Data',
              toolIds: ['menhoodData', 'airtableRecords'],
              departmentId: 'dept-tech',
            }),
            skill({
              id: 'skill-company',
              slug: 'schedule-divo-work',
              name: 'Schedule Divo Work',
              toolIds: [],
            }),
          ];
        }
        return [
          skill({
            id: 'skill-menhood',
            slug: 'menhood-data',
            name: 'Menhood Data',
            toolIds: ['menhoodData', 'airtableRecords'],
            departmentId: 'dept-finance',
          }),
        ];
      },
    },
    ...overrides,
  } as any;
}

function callRoute(
  router: ReturnType<typeof createDesktopSkillRoutes>,
  path: string,
  opts: {
    locals?: Record<string, unknown>;
    auth?: string;
    handler?: 'auth' | 'route';
  } = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    let status = 200;
    const req = {
      method: 'GET',
      path,
      params: {},
      query: {},
      headers: opts.auth ? { authorization: opts.auth } : {},
      body: {},
    } as unknown as Request;
    const res = {
      locals: opts.locals ?? {},
      status: (s: number) => { status = s; return res; },
      json: (b: unknown) => { resolve({ status, body: b }); return res; },
    } as unknown as Response;

    const layer = (router as any).stack.find((item: any) =>
      item.route?.path === path && item.route.methods?.get);
    const stackIndex = opts.handler === 'auth' ? 0 : (layer?.route?.stack?.length ?? 1) - 1;
    const handler = layer?.route?.stack?.[stackIndex]?.handle;
    if (!handler) {
      resolve({ status: 404, body: { error: 'not_found' } });
      return;
    }
    Promise.resolve(handler(req, res, () => resolve({ status: 404, body: { error: 'next' } })))
      .catch((error: unknown) => resolve({ status: 500, body: String(error) }));
  });
}

describe('desktop skills routes', () => {
  it('rejects requests before any skill lookup when the member token is missing', async () => {
    let lookedUpMemberships = false;
    const router = createDesktopSkillRoutes(makeDeps({
      prisma: {
        departmentMembership: {
          findMany: async () => {
            lookedUpMemberships = true;
            return [];
          },
        },
      },
    }));

    const result = await callRoute(router, '/skills', { handler: 'auth' });

    assert.equal(result.status, 401);
    assert.equal(result.body.error, 'Missing authorization token');
    assert.equal(lookedUpMemberships, false);
  });

  it('returns the member-visible skill union and prefers a runnable department', async () => {
    const calls: Array<{ companyId: string; userId?: string; departmentId?: string; grantedSkillIds?: ReadonlySet<string> }> = [];
    const deps = makeDeps({
      skillAccessEnforcement: {
        listGrantedSkillIds: async (companyId: string, userId: string) => {
          calls.push({ companyId, userId });
          return new Set(['skill-menhood', 'skill-company']);
        },
      },
      skillCatalog: {
        listVisible: async (input: any) => {
          calls.push({
            companyId: input.companyId,
            departmentId: input.departmentId,
            grantedSkillIds: input.grantedSkillIds,
          });
          if (input.departmentId === 'dept-tech') {
            return [
              skill({
                id: 'skill-menhood',
                slug: 'menhood-data',
                name: 'Menhood Data',
                toolIds: ['menhoodData', 'airtableRecords'],
                departmentId: 'dept-tech',
              }),
              skill({
                id: 'skill-company',
                slug: 'schedule-divo-work',
                name: 'Schedule Divo Work',
                toolIds: [],
              }),
            ];
          }
          return [
            skill({
              id: 'skill-menhood',
              slug: 'menhood-data',
              name: 'Menhood Data',
              toolIds: ['menhoodData', 'airtableRecords'],
              departmentId: 'dept-finance',
            }),
          ];
        },
      },
    });

    const result = await callRoute(createDesktopSkillRoutes(deps), '/skills', {
      locals: { companyId: 'company-1', userId: 'user-1', aiRole: 'MEMBER' },
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.success, true);
    assert.deepEqual(
      result.body.data.skills.map((entry: any) => ({
        slug: entry.slug,
        departmentName: entry.departmentName,
        missingTools: entry.missingTools,
      })),
      [
        { slug: 'menhood-data', departmentName: 'Finance', missingTools: [] },
        { slug: 'schedule-divo-work', departmentName: null, missingTools: [] },
      ],
    );
    assert.equal(calls.filter(call => call.userId === 'user-1').length, 1);
    assert.deepEqual(
      calls.filter(call => call.departmentId).map(call => call.departmentId),
      ['dept-tech', 'dept-finance'],
    );
    assert.ok(calls.filter(call => call.departmentId).every(call =>
      call.grantedSkillIds?.has('skill-menhood') && call.grantedSkillIds?.has('skill-company')));
  });

  it('only resolves skills through active memberships in active departments', async () => {
    let membershipWhere: unknown;
    const deps = makeDeps({
      prisma: {
        departmentMembership: {
          findMany: async (args: any) => {
            membershipWhere = args.where;
            return [];
          },
        },
      },
    });

    const result = await callRoute(createDesktopSkillRoutes(deps), '/skills', {
      locals: { companyId: 'company-1', userId: 'user-1', aiRole: 'MEMBER' },
    });

    assert.equal(result.status, 200);
    assert.deepEqual(membershipWhere, {
      userId: 'user-1',
      status: 'active',
      department: { companyId: 'company-1', status: 'active' },
    });
  });
});
