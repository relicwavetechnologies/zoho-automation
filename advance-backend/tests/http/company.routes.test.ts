/**
 * Unit tests for company.routes.ts.
 *
 *   GET  /members           — list admin members
 *   GET  /directory         — company directory
 *   GET  /invites           — list pending invites
 *   POST /invites           — create invite
 *   GET  /onboarding/status — integration provider status
 *   GET  /tool-permissions  — company tool permissions matrix
 *
 * Verifies:
 *   - 200/201 happy paths + response shapes
 *   - Company scope enforcement
 *   - Zod validation rejects bad POST /invites input
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { createCompanyRoutes } from '../../src/http/admin/company.routes.ts';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const noopLogger = {
  info:  () => {},
  warn:  () => {},
  error: () => {},
  debug: () => {},
  child: function() { return this as typeof noopLogger; },
} as any;

const DEFAULT_LOCALS     = { companyId: 'co-1', isSuperAdmin: false, userId: 'u-1' };
const SUPER_ADMIN_LOCALS = { companyId: '', isSuperAdmin: true, userId: 'u-sa' };

async function callRoute(
  router: ReturnType<typeof createCompanyRoutes>,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  opts: {
    query?:  Record<string, string>;
    body?:   Record<string, unknown>;
    locals?: Record<string, unknown>;
  } = {},
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve) => {
    let status = 200;
    let responseBody: unknown = {};
    const locals = opts.locals ?? { ...DEFAULT_LOCALS };

    const req = {
      method, path,
      params:  {},
      query:   opts.query ?? {},
      body:    opts.body  ?? {},
      headers: {},
    } as unknown as Request;

    const res = {
      locals,
      status: (s: number) => { status = s; return res; },
      json: (b: unknown) => { responseBody = b; resolve({ status, body: responseBody }); return res; },
    } as unknown as Response;

    const next = (err?: unknown) => {
      if (err) {
        const e = err as Error & { status?: number };
        status = e.status ?? 500;
        responseBody = { success: false, message: e.message };
      }
      resolve({ status, body: responseBody });
    };

    const stack: any[] = (router as any).stack ?? [];

    function matchLayer(layer: any, url: string): Record<string, string> | null {
      if (!layer.route) return null;
      const routePath: string = layer.route.path;
      const routeMethod: string = Object.keys(layer.route.methods)[0]!.toUpperCase();
      if (routeMethod !== method) return null;
      const paramNames: string[] = [];
      const pattern = routePath.replace(/:([^/]+)/g, (_: string, name: string) => { paramNames.push(name); return '([^/]+)'; });
      const m = url.match(new RegExp(`^${pattern}$`));
      if (!m) return null;
      const params: Record<string, string> = {};
      paramNames.forEach((name, i) => { params[name] = m[i + 1]!; });
      return params;
    }

    let matched = false;
    for (const layer of stack) {
      const params = matchLayer(layer, path);
      if (params !== null) {
        req.params = params as any;
        matched = true;
        const handler = layer.route.stack[0]?.handle;
        if (handler) { Promise.resolve(handler(req, res, next)).catch(next); }
        else { next(); }
        break;
      }
    }
    if (!matched) next();
  });
}

// ─── Fake data ────────────────────────────────────────────────────────────────

const fakeMembership = {
  id:        'mem-1',
  userId:    'u-1',
  companyId: 'co-1',
  role:      'COMPANY_ADMIN',
  isActive:  true,
  createdAt: new Date('2025-01-01'),
  updatedAt: new Date('2025-01-02'),
  user:      { id: 'u-1', name: 'Alice', email: 'alice@example.com', createdAt: new Date('2025-01-01') },
};

const fakeMembershipForDirectory = {
  ...fakeMembership,
  user: {
    ...fakeMembership.user,
    googleAuthLinks:       [],
    departmentMemberships: [],
  },
};

const fakeInvite = {
  id:        'inv-1',
  email:     'bob@example.com',
  role:      'MEMBER',
  status:    'pending',
  expiresAt: new Date('2025-02-01'),
  createdAt: new Date('2025-01-01'),
};

const fakeToolPerm = {
  id:      'tp-1',
  toolId:  'zoho-crm',
  role:    'COMPANY_ADMIN',
  enabled: true,
};

const fakeActionPerm = {
  id:          'ap-1',
  toolId:      'zoho-crm',
  role:        'COMPANY_ADMIN',
  actionGroup: 'leads.read',
  enabled:     true,
};

function makePrisma(overrides: {
  memberships?:       any[];
  identities?:        any[];
  invites?:           any[];
  createdInvite?:     any;
  zohoConn?:          any;
  larkBinding?:       any;
  googleLink?:        any;
  toolPerms?:         any[];
  actionPerms?:       any[];
} = {}) {
  return {
    adminMembership: {
      findMany: async () => overrides.memberships ?? [fakeMembership],
    },
    channelIdentity: {
      findMany: async () => overrides.identities ?? [],
    },
    companyInvite: {
      findMany: async () => overrides.invites ?? [fakeInvite],
      create:   async () => overrides.createdInvite ?? { ...fakeInvite, token: 'tok-1' },
    },
    zohoConnection: {
      findFirst: async () => overrides.zohoConn ?? null,
    },
    larkTenantBinding: {
      findFirst: async () => overrides.larkBinding ?? null,
    },
    companyGoogleAuthLink: {
      findFirst: async () => overrides.googleLink ?? null,
    },
    toolPermission: {
      findMany: async () => overrides.toolPerms ?? [fakeToolPerm],
    },
    toolActionPermission: {
      findMany: async () => overrides.actionPerms ?? [fakeActionPerm],
    },
  } as any;
}

const testEnv = {
  APP_BASE_URL: 'http://localhost:5173',
  ZOHO_CLIENT_ID: 'zoho-client',
  ZOHO_CLIENT_SECRET: 'zoho-secret',
  ZOHO_REDIRECT_URI: 'http://localhost:5173/zoho/callback',
  ZOHO_ACCOUNTS_BASE_URL: 'https://accounts.zoho.in',
  ZOHO_API_BASE_URL: 'https://www.zohoapis.in',
} as any;

function makeRouteDeps(prisma: any, overrides: {
  cache?: any;
  zohoTokenService?: any;
  zohoConnectionRepo?: any;
} = {}) {
  return {
    prisma,
    logger: noopLogger,
    env: testEnv,
    cache: overrides.cache ?? {
      get: async () => ({ ok: true, value: { companyId: 'co-1', userId: 'u-1' } }),
      set: async () => ({ ok: true, value: undefined }),
      del: async () => ({ ok: true, value: undefined }),
      scanDel: async () => ({ ok: true, value: 0 }),
    } as any,
    zohoTokenService: overrides.zohoTokenService ?? {
      isConfigured: () => true,
      exchangeAuthorizationCode: async () => ({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresIn: 3600,
        scopes: ['ZohoBooks.fullaccess.all'],
      }),
    } as any,
    zohoConnectionRepo: overrides.zohoConnectionRepo ?? {
      upsertFromExchange: async () => ({ ok: true, value: undefined }),
    } as any,
  };
}

function makeRouter(overrides?: Parameters<typeof makePrisma>[0]) {
  return createCompanyRoutes(makeRouteDeps(makePrisma(overrides)));
}

// ─── GET /members ─────────────────────────────────────────────────────────────

describe('GET /members', () => {
  it('returns 200 with member list', async () => {
    const { status, body } = await callRoute(makeRouter(), 'GET', '/members');
    assert.equal(status, 200);
    const b = body as any;
    assert.equal(b.success, true);
    assert.equal(b.data.length, 1);
    assert.equal(b.data[0].userId, 'u-1');
    assert.equal(b.data[0].email, 'alice@example.com');
  });

  it('returns 400 when SUPER_ADMIN omits companyId', async () => {
    const { status } = await callRoute(makeRouter(), 'GET', '/members', {
      locals: SUPER_ADMIN_LOCALS,
    });
    assert.equal(status, 400);
  });

  it('returns 403 when company mismatch', async () => {
    const { status } = await callRoute(makeRouter(), 'GET', '/members', {
      query: { companyId: 'co-other' },
    });
    assert.equal(status, 403);
  });

  it('returns empty list when no members', async () => {
    const router = makeRouter({ memberships: [] });
    const { body } = await callRoute(router, 'GET', '/members');
    assert.equal((body as any).data.length, 0);
  });
});

// ─── GET /directory ───────────────────────────────────────────────────────────

describe('GET /directory', () => {
  it('returns 200 with directory entries', async () => {
    const router = makeRouter({ memberships: [fakeMembershipForDirectory] });
    const { status, body } = await callRoute(router, 'GET', '/directory');
    assert.equal(status, 200);
    const b = body as any;
    assert.equal(b.success, true);
    assert.equal(b.data.length, 1);
    assert.equal(b.data[0].userId, 'u-1');
    assert.equal(b.data[0].name, 'Alice');
    assert.equal(b.data[0].larkLinked, false);
    assert.equal(b.data[0].googleConnected, false);
  });

  it('marks larkLinked=true when identity exists', async () => {
    const router = makeRouter({
      memberships: [fakeMembershipForDirectory],
      identities: [{
        id: 'ci-1', email: 'alice@example.com', displayName: 'Alice L',
        larkOpenId: 'ou_abc', larkUserId: 'u_abc', sourceRoles: [],
      }],
    });
    const { body } = await callRoute(router, 'GET', '/directory');
    assert.equal((body as any).data[0].larkLinked, true);
    assert.equal((body as any).data[0].larkOpenId, 'ou_abc');
  });

  it('marks googleConnected=true when auth link has no revokedAt', async () => {
    const router = makeRouter({
      memberships: [{
        ...fakeMembershipForDirectory,
        user: {
          ...fakeMembershipForDirectory.user,
          googleAuthLinks: [{ id: 'ga-1', revokedAt: null }],
        },
      }],
    });
    const { body } = await callRoute(router, 'GET', '/directory');
    assert.equal((body as any).data[0].googleConnected, true);
  });

  it('returns 400 when SUPER_ADMIN omits companyId', async () => {
    const { status } = await callRoute(makeRouter(), 'GET', '/directory', {
      locals: SUPER_ADMIN_LOCALS,
    });
    assert.equal(status, 400);
  });
});

// ─── GET /invites ─────────────────────────────────────────────────────────────

describe('GET /invites', () => {
  it('returns 200 with invite list', async () => {
    const { status, body } = await callRoute(makeRouter(), 'GET', '/invites');
    assert.equal(status, 200);
    const b = body as any;
    assert.equal(b.success, true);
    assert.equal(b.data.length, 1);
    assert.equal(b.data[0].email, 'bob@example.com');
    assert.equal(b.data[0].status, 'pending');
  });

  it('returns 400 when SUPER_ADMIN omits companyId', async () => {
    const { status } = await callRoute(makeRouter(), 'GET', '/invites', {
      locals: SUPER_ADMIN_LOCALS,
    });
    assert.equal(status, 400);
  });
});

// ─── POST /invites ────────────────────────────────────────────────────────────

describe('POST /invites', () => {
  const validBody = { email: 'newuser@example.com', roleId: 'MEMBER' };

  it('returns 201 on success', async () => {
    const { status, body } = await callRoute(makeRouter(), 'POST', '/invites', { body: validBody });
    assert.equal(status, 201);
    assert.equal((body as any).success, true);
    assert.equal((body as any).data.email, 'bob@example.com');
  });

  it('returns 400 when email is invalid', async () => {
    const { status } = await callRoute(makeRouter(), 'POST', '/invites', {
      body: { email: 'not-an-email', roleId: 'MEMBER' },
    });
    assert.equal(status, 400);
  });

  it('returns 400 when roleId is missing', async () => {
    const { status } = await callRoute(makeRouter(), 'POST', '/invites', {
      body: { email: 'user@example.com' },
    });
    assert.equal(status, 400);
  });

  it('returns 400 when SUPER_ADMIN omits companyId', async () => {
    const { status } = await callRoute(makeRouter(), 'POST', '/invites', {
      locals: SUPER_ADMIN_LOCALS,
      body:   validBody,
    });
    assert.equal(status, 400);
  });

  it('passes companyId from body for SUPER_ADMIN', async () => {
    let capturedData: any;
    const prisma = {
      ...makePrisma(),
      companyInvite: {
        findMany: async () => [],
        create: async (args: any) => { capturedData = args.data; return fakeInvite; },
      },
    } as any;
    const router = createCompanyRoutes(makeRouteDeps(prisma));
    await callRoute(router, 'POST', '/invites', {
      locals: SUPER_ADMIN_LOCALS,
      body:   { ...validBody, companyId: 'aaaaaaaa-aaaa-aaaa-aaaa-000000000001' },
    });
    assert.equal(capturedData.companyId, 'aaaaaaaa-aaaa-aaaa-aaaa-000000000001');
  });
});

// ─── POST /onboarding/zoho-start ─────────────────────────────────────────────

describe('POST /onboarding/zoho-start', () => {
  it('returns a Zoho authorization URL built from backend env', async () => {
    let cachedKey = '';
    let cachedValue: unknown;
    const router = createCompanyRoutes(makeRouteDeps(makePrisma(), {
      cache: {
        get: async () => ({ ok: true, value: null }),
        set: async (key: string, value: unknown) => { cachedKey = key; cachedValue = value; return { ok: true, value: undefined }; },
        del: async () => ({ ok: true, value: undefined }),
        scanDel: async () => ({ ok: true, value: 0 }),
      },
    }));

    const { status, body } = await callRoute(router, 'POST', '/onboarding/zoho-start');

    assert.equal(status, 200);
    const data = (body as any).data;
    const url = new URL(data.authUrl);
    assert.equal(url.origin, 'https://accounts.zoho.in');
    assert.equal(url.pathname, '/oauth/v2/auth');
    assert.equal(url.searchParams.get('client_id'), 'zoho-client');
    assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:5173/zoho/callback');
    assert.equal(url.searchParams.get('access_type'), 'offline');
    assert.equal(url.searchParams.get('prompt'), 'consent');
    assert.equal(data.message, 'Zoho OAuth started with full access.');
    assert.ok(cachedKey.startsWith('zoho:oauth:nonce:'));
    assert.deepEqual(cachedValue, { companyId: 'co-1', userId: 'u-1' });
  });

  it('returns 401 when admin user context is missing', async () => {
    const { status } = await callRoute(makeRouter(), 'POST', '/onboarding/zoho-start', {
      locals: { companyId: 'co-1', isSuperAdmin: false },
    });
    assert.equal(status, 401);
  });
});

// ─── POST /onboarding/connect ────────────────────────────────────────────────

describe('POST /onboarding/connect', () => {
  it('exchanges the Zoho callback code and stores the company connection', async () => {
    let exchangeArgs: any;
    let upsertArgs: any;
    const router = createCompanyRoutes(makeRouteDeps(makePrisma(), {
      zohoTokenService: {
        isConfigured: () => true,
        exchangeAuthorizationCode: async (args: any) => {
          exchangeArgs = args;
          return {
            accessToken: 'new-access-token',
            refreshToken: 'new-refresh-token',
            expiresIn: 3600,
            scopes: ['ZohoBooks.fullaccess.all'],
          };
        },
      },
      zohoConnectionRepo: {
        upsertFromExchange: async (args: any) => {
          upsertArgs = args;
          return { ok: true, value: undefined };
        },
      },
    }));
    const state = Buffer.from(JSON.stringify({
      companyId: 'co-1',
      environment: 'prod',
      nonce: 'nonce-1',
      returnTo: 'http://localhost:5173/settings?tab=integrations',
    })).toString('base64url');

    const { status, body } = await callRoute(router, 'POST', '/onboarding/connect', {
      body: { code: 'auth-code', state },
    });

    assert.equal(status, 200);
    assert.equal((body as any).data.connected, true);
    assert.deepEqual(exchangeArgs, {
      companyId: 'co-1',
      environment: 'prod',
      authorizationCode: 'auth-code',
      redirectUri: 'http://localhost:5173/zoho/callback',
    });
    assert.equal(upsertArgs.companyId, 'co-1');
    assert.equal(upsertArgs.accessToken, 'new-access-token');
    assert.equal(upsertArgs.refreshToken, 'new-refresh-token');
  });

  it('returns 400 for an invalid Zoho state', async () => {
    const { status } = await callRoute(makeRouter(), 'POST', '/onboarding/connect', {
      body: { code: 'auth-code', state: 'not-json' },
    });
    assert.equal(status, 400);
  });
});

// ─── GET /onboarding/status ───────────────────────────────────────────────────

describe('GET /onboarding/status', () => {
  it('returns 200 with 3 providers (all disconnected by default)', async () => {
    const { status, body } = await callRoute(makeRouter(), 'GET', '/onboarding/status');
    assert.equal(status, 200);
    const providers = (body as any).data as any[];
    assert.equal(providers.length, 3);
    assert.ok(providers.some((p: any) => p.provider === 'zoho'));
    assert.ok(providers.some((p: any) => p.provider === 'lark'));
    assert.ok(providers.some((p: any) => p.provider === 'google'));
    assert.ok(providers.every((p: any) => p.connected === false));
  });

  it('marks zoho connected when status is CONNECTED', async () => {
    const router = makeRouter({
      zohoConn: { status: 'CONNECTED', environment: 'production', connectedAt: new Date('2025-01-01') },
    });
    const { body } = await callRoute(router, 'GET', '/onboarding/status');
    const zoho = (body as any).data.find((p: any) => p.provider === 'zoho');
    assert.equal(zoho.connected, true);
    assert.equal(zoho.details.environment, 'production');
  });

  it('marks lark connected when binding exists', async () => {
    const router = makeRouter({
      larkBinding: { larkTenantKey: 'tk_abc', isActive: true, createdAt: new Date('2025-01-01') },
    });
    const { body } = await callRoute(router, 'GET', '/onboarding/status');
    const lark = (body as any).data.find((p: any) => p.provider === 'lark');
    assert.equal(lark.connected, true);
    assert.equal(lark.details.tenantKey, 'tk_abc');
  });

  it('marks google connected when link exists', async () => {
    const router = makeRouter({
      googleLink: { googleEmail: 'admin@company.com', linkedAt: new Date('2025-01-01') },
    });
    const { body } = await callRoute(router, 'GET', '/onboarding/status');
    const google = (body as any).data.find((p: any) => p.provider === 'google');
    assert.equal(google.connected, true);
    assert.equal(google.details.email, 'admin@company.com');
  });

  it('returns 400 when SUPER_ADMIN omits companyId', async () => {
    const { status } = await callRoute(makeRouter(), 'GET', '/onboarding/status', {
      locals: SUPER_ADMIN_LOCALS,
    });
    assert.equal(status, 400);
  });
});

// ─── GET /tool-permissions ────────────────────────────────────────────────────

describe('GET /tool-permissions', () => {
  it('returns 200 with permissions and actionPermissions arrays', async () => {
    const { status, body } = await callRoute(makeRouter(), 'GET', '/tool-permissions');
    assert.equal(status, 200);
    const b = body as any;
    assert.equal(b.success, true);
    assert.ok(Array.isArray(b.data.permissions));
    assert.ok(Array.isArray(b.data.actionPermissions));
    assert.equal(b.data.permissions.length, 1);
    assert.equal(b.data.actionPermissions.length, 1);
    assert.equal(b.data.permissions[0].toolId, 'zoho-crm');
    assert.equal(b.data.actionPermissions[0].actionGroup, 'leads.read');
  });

  it('returns 400 when SUPER_ADMIN omits companyId', async () => {
    const { status } = await callRoute(makeRouter(), 'GET', '/tool-permissions', {
      locals: SUPER_ADMIN_LOCALS,
    });
    assert.equal(status, 400);
  });

  it('returns empty arrays when no permissions exist', async () => {
    const router = makeRouter({ toolPerms: [], actionPerms: [] });
    const { body } = await callRoute(router, 'GET', '/tool-permissions');
    assert.equal((body as any).data.permissions.length, 0);
    assert.equal((body as any).data.actionPermissions.length, 0);
  });
});
