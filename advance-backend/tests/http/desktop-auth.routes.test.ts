import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';

import { createDesktopAuthRoutes } from '../../src/http/desktop/desktop-auth.routes.ts';
import { LARK_USER_OAUTH_SCOPES, LarkOAuthService } from '../../src/infrastructure/lark/lark-oauth.service.ts';

const noopLogger = {
  info:  () => {},
  warn:  () => {},
  error: () => {},
  debug: () => {},
  child: function() { return this; },
} as any;

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    prisma: {} as any,
    larkOAuthService: new LarkOAuthService(
      'cli_test',
      'secret',
      'https://backend.example.com/api/lark/auth/callback',
    ),
    googleOAuthService: {} as any,
    larkUserAuthLinkRepo: {} as any,
    connectionRepo: {
      listAccessibleZohoConnections: async () => ({ ok: true, value: [] }),
    } as any,
    permissions: {
      resolve: async () => ({ ok: false, error: new Error('not configured in test') }),
    } as any,
    skillCatalog: {
      listVisible: async () => [],
    } as any,
    logger: noopLogger,
    memberJwtSecret: 'test-member-secret-32-bytes-long',
    backendPublicUrl: 'https://backend.example.com',
    sessionTtlMinutes: 480,
    ...overrides,
  };
}

async function callRoute(
  router: ReturnType<typeof createDesktopAuthRoutes>,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  opts: { query?: Record<string, string>; params?: Record<string, string>; locals?: Record<string, unknown> } = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    let status = 200;
    let body: unknown = undefined;

    const req = {
      method,
      path,
      params: opts.params ?? {},
      query: opts.query ?? {},
      body: {},
      headers: {},
    } as unknown as Request;

    const res = {
      locals: opts.locals ?? {},
      status: (s: number) => { status = s; return res; },
      json: (b: unknown) => { body = b; resolve({ status, body }); return res; },
      send: (b: unknown) => { body = b; resolve({ status, body }); return res; },
    } as unknown as Response;

    const stack = (router as any).stack as any[];
    const layer = stack.find(item => item.route?.path === path && item.route?.methods?.[method.toLowerCase()]);
    if (!layer) {
      resolve({ status: 404, body: { error: 'not_found' } });
      return;
    }
    const handler = layer.route.stack[layer.route.stack.length - 1]?.handle;
    Promise.resolve(handler(req, res, () => resolve({ status: 404, body: { error: 'next' } })))
      .catch(error => resolve({ status: 500, body: String(error) }));
  });
}

describe('desktop auth routes', () => {
  const connectionPrisma = (provider: 'google_workspace' | 'zoho') => ({
    integrationConnection: {
      findFirst: async () => ({
        id: `${provider}-1`,
        label: 'Finance account',
        accountEmail: 'finance@example.com',
        accountName: 'Finance',
        ownerType: 'company',
        ownerUserId: null,
        createdBy: 'admin-1',
        scopes: [],
        connectedAt: new Date('2026-07-01T00:00:00.000Z'),
        ownerUser: null,
        grants: [],
      }),
    },
    adminMembership: { findMany: async () => [] },
    department: { findMany: async () => [] },
    departmentRole: { findMany: async () => [] },
    company: { findUnique: async () => ({ id: 'company-1', name: 'Acme' }) },
  });

  it('disconnects only the selected Google connection for an admin accessor', async () => {
    const revoked: unknown[] = [];
    const router = createDesktopAuthRoutes(makeDeps({
      prisma: connectionPrisma('google_workspace'),
      connectionRepo: {
        listAccessibleGoogleConnections: async () => ({ ok: true, value: [{ connectionId: 'google_workspace-1', access: 'admin' }] }),
        revokeConnection: async (input: unknown) => { revoked.push(input); return { ok: true, value: true }; },
      },
    }));

    const result = await callRoute(router, 'DELETE', '/google/connections/:connectionId', {
      params: { connectionId: 'google_workspace-1' },
      locals: { userId: 'user-1', companyId: 'company-1', aiRole: 'MEMBER' },
    });

    assert.equal(result.status, 200);
    assert.deepEqual(revoked, [{ companyId: 'company-1', connectionId: 'google_workspace-1', provider: 'google_workspace' }]);
  });

  it('disconnects only the selected Zoho connection for an admin accessor', async () => {
    const revoked: unknown[] = [];
    const router = createDesktopAuthRoutes(makeDeps({
      prisma: connectionPrisma('zoho'),
      connectionRepo: {
        listAccessibleZohoConnections: async () => ({ ok: true, value: [{ connectionId: 'zoho-1', access: 'admin' }] }),
        revokeConnection: async (input: unknown) => { revoked.push(input); return { ok: true, value: true }; },
      },
    }));

    const result = await callRoute(router, 'DELETE', '/zoho/connections/:connectionId', {
      params: { connectionId: 'zoho-1' },
      locals: { userId: 'user-1', companyId: 'company-1', aiRole: 'MEMBER' },
    });

    assert.equal(result.status, 200);
    assert.deepEqual(revoked, [{ companyId: 'company-1', connectionId: 'zoho-1', provider: 'zoho' }]);
  });

  it('refuses to disconnect a connection without admin access', async () => {
    let revoked = false;
    const router = createDesktopAuthRoutes(makeDeps({
      prisma: connectionPrisma('google_workspace'),
      connectionRepo: {
        listAccessibleGoogleConnections: async () => ({ ok: true, value: [{ connectionId: 'google_workspace-1', access: 'read_only' }] }),
        revokeConnection: async () => { revoked = true; return { ok: true, value: true }; },
      },
    }));

    const result = await callRoute(router, 'DELETE', '/google/connections/:connectionId', {
      params: { connectionId: 'google_workspace-1' },
      locals: { userId: 'user-1', companyId: 'company-1', aiRole: 'MEMBER' },
    });

    assert.equal(result.status, 403);
    assert.equal(revoked, false);
  });

  it('builds Lark authorize URL with email/task/offline scopes and desktop callback URI', async () => {
    const router = createDesktopAuthRoutes(makeDeps());
    const result = await callRoute(router, 'GET', '/lark/authorize-url');

    assert.equal(result.status, 200);
    assert.equal(result.body.success, true);

    const authorizeUrl = new URL(result.body.data.authorizeUrl);
    assert.equal(authorizeUrl.origin, 'https://accounts.larksuite.com');
    assert.equal(authorizeUrl.searchParams.get('client_id'), 'cli_test');
    assert.equal(
      authorizeUrl.searchParams.get('redirect_uri'),
      'https://backend.example.com/api/desktop/auth/lark/callback',
    );
    assert.equal(authorizeUrl.searchParams.get('scope'), LARK_USER_OAUTH_SCOPES.join(' '));
  });

  it('returns the active department persona for an authorized desktop member', async () => {
    const router = createDesktopAuthRoutes(makeDeps({
      prisma: {
        departmentMembership: {
          findFirst: async () => ({
            department: {
              id: '5d649f61-d5ea-4fd6-a52e-7166c33fb1cd',
              name: 'Finance',
              agentConfig: {
                desktopPersonaPrompt: 'Prefer verified records.',
                isActive: true,
                updatedAt: new Date('2026-07-11T10:00:00.000Z'),
              },
            },
          }),
        },
      },
    }));
    const result = await callRoute(router, 'GET', '/runtime-context', {
      query: { departmentId: '5d649f61-d5ea-4fd6-a52e-7166c33fb1cd' },
      locals: { userId: 'user-1', companyId: 'company-1' },
    });

    assert.equal(result.status, 200);
    assert.deepEqual(result.body.data, {
      departmentId: '5d649f61-d5ea-4fd6-a52e-7166c33fb1cd',
      departmentName: 'Finance',
      personaPrompt: 'Prefer verified records.',
      version: '2026-07-11T10:00:00.000Z',
    });
  });

  it('does not expose a persona for an inaccessible department', async () => {
    const router = createDesktopAuthRoutes(makeDeps({
      prisma: { departmentMembership: { findFirst: async () => null } },
    }));
    const result = await callRoute(router, 'GET', '/runtime-context', {
      query: { departmentId: '5d649f61-d5ea-4fd6-a52e-7166c33fb1cd' },
      locals: { userId: 'user-1', companyId: 'company-1' },
    });

    assert.equal(result.status, 403);
    assert.equal(result.body.success, false);
  });

  it('returns a permission-filtered Finance capability bootstrap', async () => {
    const allowedActionsByTool = new Map([
      ['zohoBooks', new Set(['read', 'create'])],
      ['zohoCrm', new Set(['read'])],
      ['webSearch', new Set(['read'])],
    ]);
    const router = createDesktopAuthRoutes(makeDeps({
      prisma: {
        departmentMembership: {
          findFirst: async () => ({
            department: {
              id: '5d649f61-d5ea-4fd6-a52e-7166c33fb1cd',
              name: 'Finance',
              slug: 'finance',
              agentConfig: null,
            },
          }),
        },
      },
      permissions: {
        resolve: async () => ({
          ok: true,
          value: {
            allowedToolIds: new Set(['zohoBooks', 'zohoCrm', 'webSearch']),
            allowedActionsByTool,
            decisions: [],
            department: { roleSlug: 'FINANCE_MANAGER' },
          },
        }),
      },
      skillCatalog: {
        listVisible: async () => [{
          id: 'skill-finance',
          slug: 'finance-ops-core',
          name: 'Finance Ops Core',
          description: 'Route broad finance questions.',
          instructions: 'Backend recipe',
          toolIds: ['zohoBooks', 'zohoCrm'],
        }],
      },
      connectionRepo: {
        listAccessibleZohoConnections: async () => ({
          ok: true,
          value: [{
            connectionId: 'zoho-connection-1',
            label: 'Finance Books',
            access: 'read_write',
          }],
        }),
      },
    }));

    const result = await callRoute(router, 'GET', '/runtime-context', {
      query: { departmentId: '5d649f61-d5ea-4fd6-a52e-7166c33fb1cd' },
      locals: {
        userId: 'user-1',
        companyId: 'company-1',
        aiRole: 'MEMBER',
      },
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.data.capabilityBootstrap.departmentFunction, 'finance');
    assert.equal(result.body.data.capabilityBootstrap.departmentRole, 'FINANCE_MANAGER');
    assert.deepEqual(result.body.data.capabilityBootstrap.preferredTools, [
      { toolId: 'zohoBooks', actions: ['read', 'create'] },
      { toolId: 'zohoCrm', actions: ['read'] },
      { toolId: 'webSearch', actions: ['read'] },
    ]);
    assert.deepEqual(result.body.data.capabilityBootstrap.zohoConnection, {
      accessibleCount: 1,
      connectionId: 'zoho-connection-1',
      label: 'Finance Books',
      access: 'read_write',
    });
  });

  it('returns no persona when the department agent config is disabled', async () => {
    const router = createDesktopAuthRoutes(makeDeps({
      prisma: {
        departmentMembership: {
          findFirst: async () => ({
            department: {
              id: '5d649f61-d5ea-4fd6-a52e-7166c33fb1cd',
              name: 'Finance',
              agentConfig: {
                desktopPersonaPrompt: 'This must not reach desktop Pi.',
                isActive: false,
                updatedAt: new Date('2026-07-11T10:00:00.000Z'),
              },
            },
          }),
        },
      },
    }));
    const result = await callRoute(router, 'GET', '/runtime-context', {
      query: { departmentId: '5d649f61-d5ea-4fd6-a52e-7166c33fb1cd' },
      locals: { userId: 'user-1', companyId: 'company-1' },
    });

    assert.equal(result.status, 200);
    assert.deepEqual(result.body.data, {
      departmentId: '5d649f61-d5ea-4fd6-a52e-7166c33fb1cd',
      departmentName: 'Finance',
      personaPrompt: '',
      version: null,
    });
  });
});
