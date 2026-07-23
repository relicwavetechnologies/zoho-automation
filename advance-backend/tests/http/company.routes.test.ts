/**
 * Unit tests for company.routes.ts.
 *
 *   GET  /members           — list admin members
 *   GET  /directory         — company directory
 *   GET  /invites           — list pending invites
 *   POST /invites           — create invite
 *   GET  /onboarding/status — integration provider status
 *   POST /onboarding/lark-start — create Lark user OAuth URL
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
    ownedIntegrationConnections: [],
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

const fakeGovernedConnection = {
  id: 'conn-1',
  provider: 'google_workspace',
  ownerType: 'user',
  ownerUserId: 'u-1',
  label: 'Finance Google',
  accountEmail: 'finance@example.com',
  accountName: 'Finance',
  status: 'connected',
  scopes: ['gmail.readonly'],
  connectedAt: new Date('2025-01-01'),
  lastUsedAt: new Date('2025-01-02'),
  createdAt: new Date('2025-01-01'),
  updatedAt: new Date('2025-01-02'),
  ownerUser: { id: 'u-1', name: 'Alice', email: 'alice@example.com' },
  grants: [],
  governance: null,
};

function makePrisma(overrides: {
  memberships?:       any[];
  identities?:        any[];
  invites?:           any[];
  createdInvite?:     any;
  zohoConn?:          any;
  larkBinding?:       any;
  googleConnection?:  any;
  integrationConnections?: any[];
  capabilityGovernance?: any[];
  user?:              any;
  larkUserAuthLink?:  any;
  channelIdentity?:   any;
  toolPerms?:         any[];
  actionPerms?:       any[];
} = {}) {
  return {
    user: {
      findUnique: async () => overrides.user ?? { email: 'alice@example.com' },
    },
    adminMembership: {
      findMany: async () => overrides.memberships ?? [fakeMembership],
      findFirst: async () => fakeMembership,
      count: async () => 1,
      updateMany: async () => ({ count: 1 }),
      update: async () => ({ userId: 'u-1', companyId: 'co-1', role: 'COMPANY_ADMIN' }),
    },
    adminSession: { updateMany: async () => ({ count: 1 }) },
    channelIdentity: {
      findMany: async () => overrides.identities ?? [],
      findFirst: async () => overrides.channelIdentity ?? null,
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
    larkUserAuthLink: {
      findUnique: async () => overrides.larkUserAuthLink ?? null,
    },
    integrationConnection: {
      findMany: async () => overrides.integrationConnections ?? [],
      findFirst: async () => overrides.googleConnection ?? overrides.integrationConnections?.[0] ?? null,
      updateMany: async () => ({ count: 1 }),
    },
    integrationConnectionGovernance: {
      upsert: async (input: any) => ({
        adminOverrideJson: input.create?.adminOverrideJson ?? input.update?.adminOverrideJson,
        adminOverriddenAt: new Date('2025-01-03'),
        adminOverriddenBy: 'u-1',
        version: 1,
      }),
    },
    companyCapabilityGovernance: {
      findMany: async () => overrides.capabilityGovernance ?? [],
      upsert: async (input: any) => ({
        policyJson: input.create?.policyJson ?? input.update?.policyJson,
        configuredAt: new Date('2025-01-03'),
        configuredBy: 'u-1',
        version: 1,
      }),
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
  larkOAuthService?: any;
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
    larkOAuthService: overrides.larkOAuthService ?? {
      isConfigured: () => true,
      generateNonce: () => 'lark-nonce-1',
      getAuthorizeUrl: (state: string) => `https://accounts.larksuite.com/open-apis/authen/v1/authorize?client_id=cli_test&state=${state}`,
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

// ─── PUT /members/:userId/role ──────────────────────────────────────────────

describe('PUT /members/:userId/role', () => {
  function roleMutationPrisma(input: { targetRole: 'MEMBER' | 'COMPANY_ADMIN'; companyAdminCount: number; actorIsTarget?: boolean }) {
    const target = { id: 'target-membership', userId: 'u-target', companyId: 'co-1', role: input.targetRole, isActive: true, createdAt: new Date('2025-01-01'), updatedAt: new Date('2025-01-02') };
    const actor = input.actorIsTarget
      ? target
      : { id: 'actor-membership', userId: 'u-1', companyId: 'co-1', role: 'COMPANY_ADMIN', isActive: true, createdAt: new Date('2025-01-01'), updatedAt: new Date('2025-01-02') };
    const prisma = makePrisma() as any;
    prisma.$transaction = async (work: (tx: any) => Promise<unknown>) => work(prisma);
    prisma.adminMembership = {
      findFirst: async (args: any) => args.where.userId === actor.userId ? actor : null,
      findMany: async (args: any) => args.where.userId === 'u-target' ? [target] : [],
      count: async () => input.companyAdminCount,
      updateMany: async () => ({ count: 1 }),
      update: async (args: any) => ({ userId: 'u-target', companyId: 'co-1', role: args.data.role }),
    };
    prisma.adminSession = { updateMany: async () => ({ count: 1 }) };
    return prisma;
  }

  it('allows a company admin to promote a member within their company', async () => {
    const { status, body } = await callRoute(
      createCompanyRoutes(makeRouteDeps(roleMutationPrisma({ targetRole: 'MEMBER', companyAdminCount: 1 }))),
      'PUT',
      '/members/u-target/role',
      { body: { role: 'COMPANY_ADMIN' } },
    );
    assert.equal(status, 200);
    assert.equal((body as any).data.role, 'COMPANY_ADMIN');
  });

  it('rejects demoting the last active company admin', async () => {
    const { status, body } = await callRoute(
      createCompanyRoutes(makeRouteDeps(roleMutationPrisma({ targetRole: 'COMPANY_ADMIN', companyAdminCount: 1, actorIsTarget: true }))),
      'PUT',
      '/members/u-target/role',
      { body: { role: 'MEMBER' }, locals: { ...DEFAULT_LOCALS, userId: 'u-target' } },
    );
    assert.equal(status, 409);
    assert.match((body as any).message, /at least one active company admin/i);
  });

  it('rejects a request scoped to another company for a company admin', async () => {
    const { status } = await callRoute(
      createCompanyRoutes(makeRouteDeps(roleMutationPrisma({ targetRole: 'MEMBER', companyAdminCount: 1 }))),
      'PUT',
      '/members/u-target/role',
      { body: { role: 'COMPANY_ADMIN', companyId: 'aaaaaaaa-aaaa-aaaa-aaaa-000000000001' } },
    );
    assert.equal(status, 403);
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
          ownedIntegrationConnections: [{ id: 'conn-1' }],
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

// ─── POST /onboarding/lark-start ─────────────────────────────────────────────

describe('POST /onboarding/lark-start', () => {
  it('returns a Lark authorization URL using the admin user mapped identity', async () => {
    let cachedKey = '';
    let cachedValue: unknown;
    const router = createCompanyRoutes(makeRouteDeps(makePrisma({
      larkBinding: { larkTenantKey: 'tk_abc', isActive: true, createdAt: new Date('2025-01-01') },
      channelIdentity: {
        externalUserId: 'ou_abc',
        larkOpenId:     'ou_abc',
      },
    }), {
      cache: {
        get: async () => ({ ok: true, value: null }),
        set: async (key: string, value: unknown) => { cachedKey = key; cachedValue = value; return { ok: true, value: undefined }; },
        del: async () => ({ ok: true, value: undefined }),
        scanDel: async () => ({ ok: true, value: 0 }),
      },
    }));

    const { status, body } = await callRoute(router, 'POST', '/onboarding/lark-start');

    assert.equal(status, 200);
    const data = (body as any).data;
    const url = new URL(data.url);
    assert.equal(url.origin, 'https://accounts.larksuite.com');
    assert.equal(url.searchParams.get('client_id'), 'cli_test');

    const state = JSON.parse(Buffer.from(url.searchParams.get('state') ?? '', 'base64url').toString('utf8'));
    assert.deepEqual(state, {
      companyId:  'co-1',
      userId:     'u-1',
      larkOpenId: 'ou_abc',
      nonce:      'lark-nonce-1',
    });
    assert.equal(cachedKey, 'lark:oauth:nonce:lark-nonce-1');
    assert.deepEqual(cachedValue, { companyId: 'co-1', userId: 'u-1', larkOpenId: 'ou_abc' });
  });

  it('returns 400 when the company has no active Lark tenant binding', async () => {
    const { status } = await callRoute(makeRouter(), 'POST', '/onboarding/lark-start');
    assert.equal(status, 400);
  });

  it('returns 400 when the admin user is not mapped to a Lark identity', async () => {
    const router = makeRouter({
      larkBinding: { larkTenantKey: 'tk_abc', isActive: true, createdAt: new Date('2025-01-01') },
    });
    const { status } = await callRoute(router, 'POST', '/onboarding/lark-start');
    assert.equal(status, 400);
  });

  it('returns 401 when admin user context is missing', async () => {
    const { status } = await callRoute(makeRouter({
      larkBinding: { larkTenantKey: 'tk_abc', isActive: true, createdAt: new Date('2025-01-01') },
      channelIdentity: { externalUserId: 'ou_abc', larkOpenId: 'ou_abc' },
    }), 'POST', '/onboarding/lark-start', {
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

  it('marks google connected when company connection exists', async () => {
    const router = makeRouter({
      googleConnection: { accountEmail: 'admin@company.com', connectedAt: new Date('2025-01-01') },
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

// ─── Connection governance ───────────────────────────────────────────────────

describe('connection governance', () => {
  it('lists governance-safe connection metadata without OAuth credentials', async () => {
    const { status, body } = await callRoute(makeRouter({ integrationConnections: [fakeGovernedConnection] }), 'GET', '/members/u-1/connections');
    assert.equal(status, 200);
    const connection = (body as any).data[0];
    assert.equal(connection.id, 'conn-1');
    assert.equal(connection.accountEmail, 'finance@example.com');
    assert.equal(connection.governance.source, 'platform_default');
    assert.equal(connection.governance.adminOverride.actions.send.mode, 'inherit');
    assert.equal('accessTokenEncrypted' in connection, false);
    assert.equal('tokenMetadata' in connection, false);
  });

  it('stores a company-admin override for exact connection actions', async () => {
    const { status, body } = await callRoute(makeRouter({ integrationConnections: [fakeGovernedConnection] }), 'PUT', '/connections/conn-1/governance', {
      body: {
        adminOverride: {
          version: 1,
          actions: {
            read: { mode: 'enforced', requestsPerMinute: 60, requestsPerDay: 5000, approval: 'none' },
            create: { mode: 'inherit' },
            update: { mode: 'inherit' },
            delete: { mode: 'enforced', requestsPerMinute: 5, requestsPerDay: 50, approval: 'company_admin' },
            send: { mode: 'enforced', requestsPerMinute: 10, requestsPerDay: 100, approval: 'connection_owner' },
            execute: { mode: 'inherit' },
          },
        },
      },
    });
    assert.equal(status, 200);
    assert.equal((body as any).data.adminOverride.actions.delete.approval, 'company_admin');
    assert.equal((body as any).data.adminOverride.actions.send.requestsPerMinute, 10);
  });

  it('exposes company capability policies and persists an admin update', async () => {
    const list = await callRoute(makeRouter(), 'GET', '/capability-governance');
    assert.equal(list.status, 200);
    assert.equal((list.body as any).data.find((item: any) => item.id === 'webSearch').source, 'platform_default');

    const update = await callRoute(makeRouter(), 'PUT', '/capability-governance/webSearch', {
      body: {
        policy: {
          version: 1,
          enabled: true,
          requestsPerMinute: 30,
          requestsPerDay: 1000,
          approval: 'none',
        },
      },
    });
    assert.equal(update.status, 200);
    assert.equal((update.body as any).data.policy.requestsPerMinute, 30);
  });
});
