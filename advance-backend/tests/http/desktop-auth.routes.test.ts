import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import type { Request, Response } from 'express';

import { allowsPiRuntimeLease, createDesktopAuthRoutes } from '../../src/http/desktop/desktop-auth.routes.ts';
import { LARK_USER_OAUTH_SCOPES, LarkOAuthService } from '../../src/infrastructure/lark/lark-oauth.service.ts';
import { ZohoTokenService } from '../../src/infrastructure/zoho/zoho-token.service.ts';
import {
  RunLatencyRecorder,
  type RunLatencySpanStore,
} from '../../src/application/observability/run-latency-recorder.ts';
import { RuntimeContextLifecycle } from '../../src/application/runtime/runtime-context-lifecycle.ts';

const noopLogger = {
  info:  () => {},
  warn:  () => {},
  error: () => {},
  debug: () => {},
  child: function() { return this; },
} as any;

function captureLogger() {
  const events: string[] = [];
  const logger: any = {
    info: (event: string) => events.push(event),
    warn: (event: string) => events.push(event),
    error: (event: string) => events.push(event),
    debug: (event: string) => events.push(event),
    child: () => logger,
  };
  return { events, logger };
}

function signTestState(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', 'test-member-secret-32-bytes-long')
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${signature}`;
}

function makeDeps(overrides: Record<string, unknown> = {}) {
  const {
    prisma: overridePrismaValue,
    runtimeContextLifecycle: overrideRuntimeContextLifecycle,
    ...rest
  } = overrides;
  const overridePrisma = (overridePrismaValue ?? {}) as Record<string, unknown>;
  const deps = {
    prisma: {
      knowledgeResource: { findMany: async () => [] },
      ...overridePrisma,
    } as any,
    larkOAuthService: new LarkOAuthService(
      'cli_test',
      'secret',
      'https://backend.example.com/api/lark/auth/callback',
    ),
    googleOAuthService: {} as any,
    canvaMcpOAuthService: {} as any,
    shopifyAuthorizationService: {
      isConfigured: () => true,
      begin: async () => ({ authorizeUrl: 'https://demo.myshopify.com/admin/oauth/authorize' }),
      beginReconnect: async () => ({ authorizeUrl: 'https://demo.myshopify.com/admin/oauth/authorize' }),
      listCompanyConnections: async () => [],
    } as any,
    larkUserAuthLinkRepo: {} as any,
    connectionRepo: {
      listAccessibleZohoConnections: async () => ({ ok: true, value: [] }),
    } as any,
    permissions: {
      resolve: async () => ({ ok: false, error: new Error('not configured in test') }),
    } as any,
    skillCatalog: {
      listVisible: async () => [],
      registryRevision: async () => 1,
    } as any,
    skillAccessEnforcement: {
      listGrantedSkillIds: async () => new Set<string>(),
    } as any,
    managerPersonaRuntime: {
      getDepartmentBrief: async () => null,
    } as any,
    memory: null,
    logger: noopLogger,
    memberJwtSecret: 'test-member-secret-32-bytes-long',
    backendPublicUrl: 'https://backend.example.com',
    appBaseUrl: 'https://app.example.com',
    sessionTtlMinutes: 480,
    ...rest,
  };
  return {
    ...deps,
    runtimeContextLifecycle: overrideRuntimeContextLifecycle ?? new RuntimeContextLifecycle({
      prisma: deps.prisma,
      permissions: deps.permissions,
      skillCatalog: deps.skillCatalog,
      skillAccessEnforcement: deps.skillAccessEnforcement,
      managerPersonaRuntime: deps.managerPersonaRuntime,
      connectionRegistry: deps.connectionRepo,
      logger: deps.logger,
    }),
  };
}

async function callRoute(
  router: ReturnType<typeof createDesktopAuthRoutes>,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  opts: {
    query?: Record<string, string>;
    params?: Record<string, string>;
    headers?: Record<string, string>;
    body?: unknown;
    locals?: Record<string, unknown>;
  } = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    let status = 200;
    let body: unknown = undefined;
    const listeners = new Map<string, () => void>();
    const finish = () => listeners.get('finish')?.();

    const req = {
      method,
      path,
      params: opts.params ?? {},
      query: opts.query ?? {},
      body: opts.body ?? {},
      headers: opts.headers ?? {},
    } as unknown as Request;

    const res = {
      locals: opts.locals ?? {},
      status: (s: number) => { status = s; return res; },
      setHeader: () => res,
      once: (event: string, listener: () => void) => { listeners.set(event, listener); return res; },
      json: (b: unknown) => { body = b; finish(); resolve({ status, body }); return res; },
      send: (b: unknown) => { body = b; finish(); resolve({ status, body }); return res; },
      redirect: (s: number, location: string) => { status = s; body = location; finish(); resolve({ status, body }); return res; },
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
  const connectionPrisma = (provider: 'google_workspace' | 'zoho' | 'canva') => ({
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

  it('carries a user-provided Canva connection name through the OAuth state', async () => {
    let authorization: { attemptId: string; state: string; redirectUri?: string } | null = null;
    const router = createDesktopAuthRoutes(makeDeps({
      canvaMcpOAuthService: {
        isConnectConfigured: () => true,
        beginAuthorization: async (input: { attemptId: string; state: string; redirectUri?: string }) => {
          authorization = input;
          return 'https://mcp.canva.com/authorize';
        },
      },
    }));

    const result = await callRoute(router, 'GET', '/canva/authorize-url', {
      query: { label: 'Marketing workspace' },
      locals: { userId: 'user-1', companyId: 'company-1' },
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.data.authorizeUrl, 'https://mcp.canva.com/authorize');
    assert.ok(authorization);
    const payload = JSON.parse(Buffer.from(authorization.state.split('.')[1]!, 'base64url').toString('utf8'));
    assert.equal(payload.label, 'Marketing workspace');
  });

  it('builds the Canva callback on the backend URL the desktop signed in against', async () => {
    let authorization: { state: string; redirectUri?: string } | null = null;
    const router = createDesktopAuthRoutes(makeDeps({
      env: { BACKEND_PUBLIC_URL_ALLOWLIST: 'https://app-dev.example.test' } as any,
      canvaMcpOAuthService: {
        isConnectConfigured: () => true,
        beginAuthorization: async (input: { state: string; redirectUri?: string }) => {
          authorization = input;
          return 'https://mcp.canva.com/authorize';
        },
      },
    }));

    const result = await callRoute(router, 'GET', '/canva/authorize-url', {
      headers: { host: 'app-dev.example.test' },
      locals: { userId: 'user-1', companyId: 'company-1' },
    });

    assert.equal(result.status, 200);
    assert.ok(authorization);
    // Not backendPublicUrl ('https://backend.example.com') — the request host wins.
    assert.equal(
      authorization.redirectUri,
      'https://app-dev.example.test/api/desktop/auth/canva/callback',
    );
    // The callback replays it from state, so both legs present the same URI.
    const payload = JSON.parse(Buffer.from(authorization.state.split('.')[1]!, 'base64url').toString('utf8'));
    assert.equal(payload.redirectUri, 'https://app-dev.example.test/api/desktop/auth/canva/callback');
  });

  it('ignores a Host that is not allowlisted rather than registering it', async () => {
    let authorization: { redirectUri?: string } | null = null;
    const router = createDesktopAuthRoutes(makeDeps({
      env: { BACKEND_PUBLIC_URL_ALLOWLIST: 'https://app-dev.example.test' } as any,
      canvaMcpOAuthService: {
        isConnectConfigured: () => true,
        beginAuthorization: async (input: { redirectUri?: string }) => {
          authorization = input;
          return 'https://mcp.canva.com/authorize';
        },
      },
    }));

    await callRoute(router, 'GET', '/canva/authorize-url', {
      headers: { host: 'attacker.example.test' },
      locals: { userId: 'user-1', companyId: 'company-1' },
    });

    assert.ok(authorization);
    assert.equal(
      authorization.redirectUri,
      'https://backend.example.com/api/desktop/auth/canva/callback',
    );
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
    assert.deepEqual(revoked, [{ companyId: 'company-1', connectionId: 'google_workspace-1', provider: 'google_workspace', actorId: 'user-1' }]);
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
    assert.deepEqual(revoked, [{ companyId: 'company-1', connectionId: 'zoho-1', provider: 'zoho', actorId: 'user-1' }]);
  });

  it('marks a manually provisioned Zoho connection as manageable by its creator', async () => {
    const router = createDesktopAuthRoutes(makeDeps({
      prisma: {
        zohoConnection: { findUnique: async () => null },
        integrationConnection: {
          findMany: async () => [{
            id: 'zoho-1',
            ownerUserId: null,
            createdBy: 'user-1',
          }],
        },
      },
      connectionRepo: {
        listAccessibleZohoConnections: async () => ({
          ok: true,
          value: [{
            connectionId: 'zoho-1',
            label: 'Finance account',
            accountName: 'Finance',
            ownerType: 'company',
            access: 'read_only',
            scopes: ['ZohoBooks.fullaccess.READ'],
            connectedAt: new Date('2026-07-01T00:00:00.000Z'),
          }],
        }),
      },
    }));

    const result = await callRoute(router, 'GET', '/zoho/status', {
      locals: { userId: 'user-1', companyId: 'company-1', aiRole: 'MEMBER' },
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.data.canManage, false);
    assert.equal(result.body.data.connections[0].access, 'read_only');
    assert.equal(result.body.data.connections[0].canManage, true);
  });

  it('disconnects only the selected shared Canva connection for an admin accessor', async () => {
    const revoked: unknown[] = [];
    const router = createDesktopAuthRoutes(makeDeps({
      prisma: connectionPrisma('canva'),
      connectionRepo: {
        listAccessibleCanvaConnections: async () => ({ ok: true, value: [{ connectionId: 'canva-1', access: 'admin' }] }),
        revokeConnection: async (input: unknown) => { revoked.push(input); return { ok: true, value: true }; },
      },
    }));

    const result = await callRoute(router, 'DELETE', '/canva/connections/:connectionId', {
      params: { connectionId: 'canva-1' },
      locals: { userId: 'user-1', companyId: 'company-1', aiRole: 'MEMBER' },
    });

    assert.equal(result.status, 200);
    assert.deepEqual(revoked, [{ companyId: 'company-1', connectionId: 'canva-1', provider: 'canva', actorId: 'user-1' }]);
  });

  it('manages Shopify through the provider-neutral RBAC surface with read-only grants', async () => {
    const grants: unknown[] = [];
    const connection = {
      id: 'shopify-1', provider: 'shopify', status: 'connected', label: 'Demo store', accountEmail: null,
      accountName: 'Demo', ownerType: 'company', ownerUserId: null, createdBy: 'installer-1', scopes: ['read_orders'],
      connectedAt: new Date('2026-08-01T00:00:00.000Z'), ownerUser: null, grants: [], governance: null, tokenMetadata: {},
    };
    const router = createDesktopAuthRoutes(makeDeps({
      prisma: {
        integrationConnection: { findFirst: async () => connection },
        adminMembership: { findMany: async () => [{ role: 'MEMBER', user: { id: 'member-1', email: 'member@example.test', name: 'Member' } }] },
        department: { findMany: async () => [{ id: 'commerce-1', name: 'Commerce', slug: 'commerce' }] },
        departmentRole: { findMany: async () => [] },
        company: { findUnique: async () => ({ id: 'company-1', name: 'Acme' }) },
      },
      connectionRepo: {
        listAccessibleShopifyConnections: async () => ({ ok: true, value: [] }),
        grantConnection: async (input: unknown) => { grants.push(input); return { ok: true, value: undefined }; },
      },
    }));
    const locals = { userId: 'admin-1', companyId: 'company-1', aiRole: 'COMPANY_ADMIN' };

    const manage = await callRoute(router, 'GET', '/connections/:connectionId/manage', {
      params: { connectionId: 'shopify-1' }, locals,
    });
    assert.equal(manage.status, 200);
    assert.equal(manage.body.data.connection.readOnlyEnforced, true);
    assert.deepEqual(manage.body.data.accessLevels.map((level: any) => level.value), ['read_only']);

    const deniedWrite = await callRoute(router, 'POST', '/connections/:connectionId/grants', {
      params: { connectionId: 'shopify-1' }, locals,
      body: { granteeType: 'department', granteeId: 'commerce-1', access: 'read_write' },
    });
    assert.equal(deniedWrite.status, 400);
    assert.equal(grants.length, 0);

    const granted = await callRoute(router, 'POST', '/connections/:connectionId/grants', {
      params: { connectionId: 'shopify-1' }, locals,
      body: { granteeType: 'department', granteeId: 'commerce-1', access: 'read_only' },
    });
    assert.equal(granted.status, 200);
    assert.deepEqual(grants, [{
      companyId: 'company-1', connectionId: 'shopify-1', granteeType: 'department',
      granteeId: 'commerce-1', access: 'read_only', grantedBy: 'admin-1',
    }]);
  });

  it('starts desktop Shopify OAuth only for company admins using signed parameter state', async () => {
    const starts: unknown[] = [];
    const router = createDesktopAuthRoutes(makeDeps({
      shopifyAuthorizationService: {
        isConfigured: () => true,
        begin: async (input: unknown) => {
          starts.push(input);
          return { authorizeUrl: 'https://demo.myshopify.com/admin/oauth/authorize?state=signed' };
        },
      },
    }));
    const member = await callRoute(router, 'GET', '/shopify/authorize-url', {
      query: { shopDomain: 'demo.myshopify.com' },
      locals: { userId: 'member-1', companyId: 'company-1', aiRole: 'MEMBER' },
    });
    assert.equal(member.status, 403);
    assert.equal(starts.length, 0);

    const admin = await callRoute(router, 'GET', '/shopify/authorize-url', {
      query: { shopDomain: ' Demo.MyShopify.com ' },
      locals: { userId: 'admin-1', companyId: 'company-1', aiRole: 'COMPANY_ADMIN' },
    });
    assert.equal(admin.status, 200);
    assert.equal(admin.body.data.authorizeUrl, 'https://demo.myshopify.com/admin/oauth/authorize?state=signed');
    assert.deepEqual(starts, [{
      companyId: 'company-1', userId: 'admin-1', shopDomain: 'demo.myshopify.com',
      stateTransport: 'signed_parameter',
    }]);
  });

  it('completes desktop Shopify OAuth from a pasted callback URL for company admins', async () => {
    const completed: unknown[] = [];
    const router = createDesktopAuthRoutes(makeDeps({
      shopifyAuthorizationService: {
        isConfigured: () => true,
        complete: async (input: unknown) => {
          completed.push(input);
          return { status: 'connected' };
        },
      },
    }));

    const member = await callRoute(router, 'POST', '/shopify/callback-url', {
      body: { callbackUrl: 'https://backend.example.com/api/shopify/auth/callback?code=abc&state=signed' },
      locals: { userId: 'member-1', companyId: 'company-1', aiRole: 'MEMBER' },
    });
    assert.equal(member.status, 403);
    assert.equal(completed.length, 0);

    const admin = await callRoute(router, 'POST', '/shopify/callback-url', {
      body: { callbackUrl: 'https://backend.example.com/api/shopify/auth/callback?code=abc&state=signed' },
      locals: { userId: 'admin-1', companyId: 'company-1', aiRole: 'COMPANY_ADMIN' },
    });
    assert.equal(admin.status, 200);
    assert.equal(admin.body.data.status, 'connected');
    assert.equal((completed[0] as any).expectedCompanyId, 'company-1');
    assert.equal((completed[0] as any).searchParams.get('code'), 'abc');
    assert.equal((completed[0] as any).searchParams.get('state'), 'signed');
  });

  it('connects Shopify directly with per-store client credentials for company admins', async () => {
    const connected: unknown[] = [];
    const router = createDesktopAuthRoutes(makeDeps({
      shopifyAuthorizationService: {
        connectWithClientCredentials: async (input: unknown) => {
          connected.push(input);
          return {
            status: 'connected',
            connectionId: 'shopify-1',
            shopDomain: 'demo.myshopify.com',
            shopName: 'Demo Store',
            scopes: ['read_reports'],
            accessTokenExpiresAt: new Date('2026-08-03T12:00:00.000Z'),
          };
        },
      },
    }));

    const member = await callRoute(router, 'POST', '/shopify/client-credentials', {
      body: { shopDomain: 'demo.myshopify.com', clientId: 'cid', clientSecret: 'secret' },
      locals: { userId: 'member-1', companyId: 'company-1', aiRole: 'MEMBER' },
    });
    assert.equal(member.status, 403);
    assert.equal(connected.length, 0);

    const admin = await callRoute(router, 'POST', '/shopify/client-credentials', {
      body: { shopDomain: ' Demo.MyShopify.com ', clientId: 'cid', clientSecret: 'secret', label: 'Demo' },
      locals: { userId: 'admin-1', companyId: 'company-1', aiRole: 'COMPANY_ADMIN' },
    });
    assert.equal(admin.status, 200);
    assert.equal(admin.body.data.status, 'connected');
    assert.deepEqual(connected, [{
      companyId: 'company-1',
      userId: 'admin-1',
      shopDomain: 'demo.myshopify.com',
      clientId: 'cid',
      clientSecret: 'secret',
      label: 'Demo',
    }]);
  });

  it('returns read-only Shopify status and keeps stale stores visible to company admins', async () => {
    const connectedAt = new Date('2026-08-01T00:00:00.000Z');
    const router = createDesktopAuthRoutes(makeDeps({
      connectionRepo: {
        listAccessibleShopifyConnections: async () => ({ ok: true, value: [{
          connectionId: 'shopify-live', provider: 'shopify', label: 'Live store', accountName: 'Live',
          ownerType: 'company', access: 'admin', scopes: ['read_orders'], connectedAt,
        }] }),
      },
      shopifyAuthorizationService: {
        isConfigured: () => true,
        listCompanyConnections: async () => [{
          connectionId: 'shopify-stale', shopDomain: 'stale.myshopify.com', label: 'Stale store',
          status: 'reauthorization_required', connectedAt,
        }],
      },
    }));
    const result = await callRoute(router, 'GET', '/shopify/status', {
      locals: { userId: 'admin-1', companyId: 'company-1', aiRole: 'COMPANY_ADMIN' },
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.data.canManage, true);
    assert.equal(result.body.data.readOnlyEnforced, true);
    assert.equal(result.body.data.connections.length, 2);
    assert.deepEqual(result.body.data.connections.map((connection: any) => ({
      id: connection.connectionId,
      access: connection.access,
      canManage: connection.canManage,
      reconnectRequired: connection.reconnectRequired,
    })), [
      { id: 'shopify-live', access: 'read_only', canManage: true, reconnectRequired: false },
      { id: 'shopify-stale', access: 'read_only', canManage: true, reconnectRequired: true },
    ]);
  });

  it('returns only granted live Shopify stores to a member without management authority', async () => {
    const connectedAt = new Date('2026-08-01T00:00:00.000Z');
    const router = createDesktopAuthRoutes(makeDeps({
      connectionRepo: {
        listAccessibleShopifyConnections: async () => ({ ok: true, value: [{
          connectionId: 'shopify-granted', provider: 'shopify', label: 'Granted store',
          ownerType: 'company', access: 'read_only', scopes: ['read_reports'], connectedAt,
        }] }),
      },
      shopifyAuthorizationService: {
        isConfigured: () => true,
        listCompanyConnections: async () => { throw new Error('members must not list ungranted stores'); },
      },
    }));
    const result = await callRoute(router, 'GET', '/shopify/status', {
      locals: { userId: 'member-1', companyId: 'company-1', aiRole: 'MEMBER' },
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.data.canManage, false);
    assert.deepEqual(result.body.data.connections.map((connection: any) => ({
      id: connection.connectionId, access: connection.access, canManage: connection.canManage,
    })), [{ id: 'shopify-granted', access: 'read_only', canManage: false }]);
  });

  it('does not let a demoted Shopify installer retain implicit connection-admin authority', async () => {
    const connection = {
      id: 'shopify-1', provider: 'shopify', status: 'connected', label: 'Demo store', accountEmail: null,
      accountName: 'Demo', ownerType: 'company', ownerUserId: null, createdBy: 'installer-1', scopes: ['read_orders'],
      connectedAt: new Date('2026-08-01T00:00:00.000Z'), ownerUser: null, grants: [], governance: null, tokenMetadata: {},
    };
    const router = createDesktopAuthRoutes(makeDeps({
      prisma: { integrationConnection: { findFirst: async () => connection } },
      connectionRepo: {
        listAccessibleShopifyConnections: async () => ({ ok: true, value: [{
          connectionId: 'shopify-1', access: 'read_only', ownerType: 'company', label: 'Demo store',
          scopes: ['read_orders'], connectedAt: new Date('2026-08-01T00:00:00.000Z'),
        }] }),
      },
    }));
    const result = await callRoute(router, 'GET', '/connections/:connectionId/manage', {
      params: { connectionId: 'shopify-1' },
      locals: { userId: 'installer-1', companyId: 'company-1', aiRole: 'MEMBER' },
    });
    assert.equal(result.status, 403);
  });

  it('lets a company admin verify and store an Airtable PAT without returning the secret', async () => {
    const token = 'pat-super-secret';
    let storedConnection: Record<string, unknown> | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_input, init) => {
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${token}`);
      return Response.json({
        id: 'usr-airtable-1',
      });
    };

    try {
      const router = createDesktopAuthRoutes(makeDeps({
        connectionRepo: {
          upsertAirtableConnection: async (input: Record<string, unknown>) => {
            storedConnection = input;
            return { ok: true, value: { id: 'airtable-1', label: input['label'] } };
          },
        },
      }));

      const result = await callRoute(router, 'POST', '/airtable/pat', {
        body: { personalAccessToken: ` ${token} `, label: 'Finance bases', accessMode: 'read_write' },
        locals: { userId: 'admin-1', companyId: 'company-1', aiRole: 'COMPANY_ADMIN' },
      });

      assert.equal(result.status, 200);
      assert.equal(storedConnection?.['accessToken'], token);
      assert.equal(storedConnection?.['externalAccountId'], 'mcp-pat:efb14cf6579790df2ee07b8398a9f7713f61f8e70730b4d0d9ca9bd0f8297ecd');
      assert.deepEqual(storedConnection?.['scopes'], [
        'data.records:read',
        'data.records:write',
        'data.recordComments:read',
        'data.recordComments:write',
        'schema.bases:read',
        'schema.bases:write',
        'workspacesAndBases:read',
      ]);
      assert.deepEqual(storedConnection?.['tokenMetadata'], {
        authenticationMethod: 'personal_access_token',
        airtableUserId: 'usr-airtable-1',
        scopeSource: 'admin_declaration',
        declaredAccessMode: 'read_write',
      });
      assert.equal(JSON.stringify(result.body).includes(token), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('stores only read scopes for a read-only Airtable PAT declaration', async () => {
    const token = 'pat-read-only-secret';
    let storedConnection: Record<string, unknown> | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({ id: 'usr-airtable-1' });

    try {
      const router = createDesktopAuthRoutes(makeDeps({
        connectionRepo: {
          upsertAirtableConnection: async (input: Record<string, unknown>) => {
            storedConnection = input;
            return { ok: true, value: { id: 'airtable-1', label: 'Read-only bases' } };
          },
        },
      }));

      const result = await callRoute(router, 'POST', '/airtable/pat', {
        body: { personalAccessToken: token, accessMode: 'read_only' },
        locals: { userId: 'admin-1', companyId: 'company-1', aiRole: 'COMPANY_ADMIN' },
      });

      assert.equal(result.status, 200);
      assert.deepEqual(storedConnection?.['scopes'], [
        'data.records:read',
        'data.recordComments:read',
        'schema.bases:read',
        'workspacesAndBases:read',
      ]);
      assert.equal((storedConnection?.['scopes'] as string[]).some((scope) => scope.endsWith(':write')), false);
      assert.equal(JSON.stringify(result.body).includes(token), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects an Airtable PAT from a non-admin before verification or storage', async () => {
    let verified = false;
    let stored = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      verified = true;
      return Response.json({ id: 'usr-airtable-1', scopes: [] });
    };

    try {
      const router = createDesktopAuthRoutes(makeDeps({
        connectionRepo: {
          upsertAirtableConnection: async () => {
            stored = true;
            return { ok: true, value: { id: 'airtable-1', label: 'Airtable' } };
          },
        },
      }));

      const result = await callRoute(router, 'POST', '/airtable/pat', {
        body: { personalAccessToken: 'pat-secret' },
        locals: { userId: 'member-1', companyId: 'company-1', aiRole: 'MEMBER' },
      });

      assert.equal(result.status, 403);
      assert.equal(verified, false);
      assert.equal(stored, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('stores the Zoho accounts domain used for the OAuth exchange', async () => {
    let storedConnection: Record<string, unknown> | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
      organizations: [{ organization_id: 'org-1', name: 'India Books', is_default_org: true }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

    try {
      const router = createDesktopAuthRoutes(makeDeps({
        env: {
          ZOHO_API_BASE_URL: 'https://www.zohoapis.com',
          ZOHO_ACCOUNTS_BASE_URL: 'https://accounts.zoho.com',
        },
        zohoTokenService: {
          isConfigured: () => true,
          getAuthorizeConfig: async () => ({
            clientId: 'client-1',
            accountsBaseUrl: 'https://accounts.zoho.in',
          }),
          exchangeAuthorizationCode: async () => ({
            accessToken: 'token-1',
            refreshToken: 'refresh-1',
            expiresIn: 3600,
            scopes: ['ZohoBooks.fullaccess.all'],
            accountsBaseUrl: 'https://accounts.zoho.in',
            apiDomain: 'https://www.zohoapis.in',
          }),
        },
        zohoConnectionRepo: {
          upsertFromExchange: async () => ({ ok: true, value: {} }),
        },
        connectionRepo: {
          listAccessibleZohoConnections: async () => ({ ok: true, value: [] }),
          upsertZohoConnection: async (input: Record<string, unknown>) => {
            storedConnection = input;
            return { ok: true, value: { id: 'connection-1' } };
          },
        },
      }));

      const authorize = await callRoute(router, 'GET', '/zoho/authorize-url', {
        locals: { userId: 'user-1', companyId: 'company-1', aiRole: 'COMPANY_ADMIN' },
      });
      const state = new URL(authorize.body.data.authorizeUrl).searchParams.get('state')!;
      const callback = await callRoute(router, 'GET', '/zoho/callback', {
        query: { code: 'code-1', state },
      });

      assert.equal(callback.status, 200);
      assert.equal(storedConnection?.['accountsBaseUrl'], 'https://accounts.zoho.in');
      assert.equal(storedConnection?.['apiBaseUrl'], 'https://www.zohoapis.in');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('stores a Self Client grant as connection-scoped read-only Zoho credentials', async () => {
    let exchanged: Record<string, unknown> | undefined;
    let storedConnection: Record<string, unknown> | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
      organizations: [{ organization_id: 'org-1', name: 'Finance India', is_default_org: true }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

    try {
      const router = createDesktopAuthRoutes(makeDeps({
        env: {
          ZOHO_API_BASE_URL: 'https://www.zohoapis.com',
          ZOHO_ACCOUNTS_BASE_URL: 'https://accounts.zoho.com',
        },
        zohoTokenService: {
          exchangeSelfClientGrant: async (input: Record<string, unknown>) => {
            exchanged = input;
            return {
              accessToken: 'access-1',
              refreshToken: 'refresh-1',
              expiresIn: 3600,
              scopes: ['ZohoCRM.modules.ALL', 'ZohoBooks.fullaccess.all'],
              accountsBaseUrl: 'https://accounts.zoho.in',
              apiDomain: 'https://www.zohoapis.in',
              tokenType: 'Bearer',
            };
          },
        },
        connectionRepo: {
          listAccessibleZohoConnections: async () => ({ ok: true, value: [] }),
          upsertZohoConnection: async (input: Record<string, unknown>) => {
            storedConnection = input;
            return { ok: true, value: { id: 'connection-1', label: input['label'] } };
          },
        },
      }));

      const result = await callRoute(router, 'POST', '/zoho/self-client', {
        body: {
          label: 'Finance read-only',
          clientId: 'client-id-1234',
          clientSecret: 'client-secret-1234',
          grantToken: 'short-lived-grant-1234',
          accountsBaseUrl: 'https://accounts.zoho.in',
        },
        locals: { userId: 'admin-1', companyId: 'company-1', aiRole: 'COMPANY_ADMIN' },
      });

      assert.equal(result.status, 200);
      assert.equal(exchanged?.['accountsBaseUrl'], 'https://accounts.zoho.in');
      assert.equal(storedConnection?.['ownerType'], 'company');
      assert.equal(storedConnection?.['initialAccess'], 'read_only');
      assert.deepEqual(storedConnection?.['selfClientOAuth'], {
        clientId: 'client-id-1234',
        clientSecret: 'client-secret-1234',
      });
      assert.deepEqual(storedConnection?.['scopes'], [
        'ZohoCRM.modules.ALL',
        'ZohoBooks.fullaccess.all',
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('isolates refresh credentials between OAuth and Self Client Zoho connections', async () => {
    const requests: Array<{ url: string; clientId: string; refreshToken: string }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const body = new URLSearchParams(String(init?.body ?? ''));
      requests.push({
        url: String(input),
        clientId: body.get('client_id') ?? '',
        refreshToken: body.get('refresh_token') ?? '',
      });
      return new Response(JSON.stringify({ access_token: `access-${requests.length}`, expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    try {
      const connectionRepo = {
        findOAuthCredentials: async () => ({
          ok: true,
          value: {
            clientId: 'oauth-client',
            clientSecret: 'oauth-secret',
            redirectUri: 'https://backend.example.com/callback',
            accountsBaseUrl: 'https://accounts.zoho.com',
            apiBaseUrl: 'https://www.zohoapis.com',
          },
        }),
      } as any;
      const integrationRepo = {
        findAccessibleZohoConnection: async ({ connectionId }: { connectionId: string }) => ({
          ok: true,
          value: {
            id: connectionId,
            companyId: 'company-1',
            provider: 'zoho',
            ownerType: 'company',
            label: connectionId,
            status: 'connected',
            scopes: ['ZohoBooks.fullaccess.READ'],
            refreshToken: connectionId === 'manual-1' ? 'manual-refresh' : 'oauth-refresh',
            accessTokenExpiresAt: new Date(0),
            tokenMetadata: connectionId === 'manual-1'
              ? { accountsBaseUrl: 'https://accounts.zoho.in' }
              : { accountsBaseUrl: 'https://accounts.zoho.com' },
            ...(connectionId === 'manual-1' ? {
              zohoClientCredentials: {
                clientId: 'manual-client',
                clientSecret: 'manual-secret',
                accountsBaseUrl: 'https://accounts.zoho.in',
              },
            } : {}),
            connectedAt: new Date(),
          },
        }),
        updateZohoTokens: async () => ({ ok: true, value: undefined }),
      } as any;
      const cache = {
        get: async () => ({ ok: true, value: null }),
        set: async () => ({ ok: true, value: undefined }),
      } as any;
      const service = new ZohoTokenService(connectionRepo, cache, {
        ZOHO_CLIENT_ID: '',
        ZOHO_CLIENT_SECRET: '',
        ZOHO_ACCOUNTS_BASE_URL: 'https://accounts.zoho.com',
        ZOHO_API_BASE_URL: 'https://www.zohoapis.com',
      } as any, noopLogger, integrationRepo);

      await service.getValidConnectionAuth({
        companyId: 'company-1',
        userId: 'user-1',
        connectionId: 'manual-1',
        minimumAccess: 'read_only',
      });
      await service.getValidConnectionAuth({
        companyId: 'company-1',
        userId: 'user-1',
        connectionId: 'oauth-1',
        minimumAccess: 'read_only',
      });

      assert.deepEqual(requests, [
        {
          url: 'https://accounts.zoho.in/oauth/v2/token',
          clientId: 'manual-client',
          refreshToken: 'manual-refresh',
        },
        {
          url: 'https://accounts.zoho.com/oauth/v2/token',
          clientId: 'oauth-client',
          refreshToken: 'oauth-refresh',
        },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
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

  it('builds Lark authorize URL using the Desktop-selected local backend callback URI', async () => {
    const router = createDesktopAuthRoutes(makeDeps());
    const result = await callRoute(router, 'GET', '/lark/authorize-url', {
      headers: { host: 'localhost:8000' },
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.success, true);

    const authorizeUrl = new URL(result.body.data.authorizeUrl);
    assert.equal(authorizeUrl.origin, 'https://accounts.larksuite.com');
    assert.equal(authorizeUrl.searchParams.get('client_id'), 'cli_test');
    assert.equal(
      authorizeUrl.searchParams.get('redirect_uri'),
      'http://localhost:8000/api/desktop/auth/lark/callback',
    );
    assert.equal(authorizeUrl.searchParams.get('scope'), LARK_USER_OAUTH_SCOPES.join(' '));
  });

  it('returns a same-tab Lark login to the original app-local page', async () => {
    const router = createDesktopAuthRoutes(makeDeps());
    const returnTo = '/link/lark?state=card-state';
    const authorize = await callRoute(router, 'GET', '/lark/authorize-url', {
      headers: { host: 'localhost:8000' },
      query: { returnTo },
    });
    const state = new URL(authorize.body.data.authorizeUrl).searchParams.get('state')!;

    const callback = await callRoute(router, 'GET', '/lark/callback', {
      query: { code: 'lark-code', state },
    });

    assert.equal(callback.status, 303);
    const location = new URL(callback.body);
    assert.equal(location.origin, 'https://app.example.com');
    assert.equal(location.pathname, '/login');
    assert.equal(location.searchParams.get('next'), returnTo);
    assert.equal(location.searchParams.get('lark_code'), 'lark-code');
    assert.equal(location.searchParams.get('lark_state'), state);
  });

  /*
   * A deployment can answer to more than one hostname — a real domain and the
   * bare-IP name it was stood up on. A session lives in `localStorage`, which
   * is partitioned per origin, so finishing sign-in on the other hostname
   * writes the token somewhere the hostname the person was using cannot read.
   * They land back on the login page holding a session that exists, and signing
   * in again does not fix it because it lands in the same place.
   */
  it('finishes sign-in on the hostname it was started on', async () => {
    const router = createDesktopAuthRoutes(makeDeps({
      // One origin serves both, which is what makes the request's own host the
      // right answer: whatever answered this request also serves the app.
      appBaseUrl: 'https://app.103.example.io',
      backendPublicUrl: 'https://app.103.example.io',
      env: {
        BACKEND_PUBLIC_URL_ALLOWLIST: 'https://app.103.example.io,https://divo.example.com',
      } as any,
    }));
    const authorize = await callRoute(router, 'GET', '/lark/authorize-url', {
      headers: { host: 'divo.example.com' },
      query: { returnTo: '/me/mail' },
    });
    const state = new URL(authorize.body.data.authorizeUrl).searchParams.get('state')!;

    const callback = await callRoute(router, 'GET', '/lark/callback', {
      headers: { host: 'divo.example.com' },
      query: { code: 'lark-code', state },
    });

    assert.equal(callback.status, 303);
    assert.equal(new URL(callback.body).origin, 'https://divo.example.com');
  });

  /*
   * A Host header is client-controlled. Following an unvetted one would let a
   * link of somebody else's choosing decide where a fresh session gets written,
   * so an unrecognised host falls back to the configured origin.
   */
  it('refuses to finish sign-in on a hostname the deployment never claimed', async () => {
    const router = createDesktopAuthRoutes(makeDeps({
      appBaseUrl: 'https://app.103.example.io',
      backendPublicUrl: 'https://app.103.example.io',
      env: { BACKEND_PUBLIC_URL_ALLOWLIST: 'https://app.103.example.io' } as any,
    }));
    const authorize = await callRoute(router, 'GET', '/lark/authorize-url', {
      headers: { host: 'app.103.example.io' },
      query: { returnTo: '/me/mail' },
    });
    const state = new URL(authorize.body.data.authorizeUrl).searchParams.get('state')!;

    const callback = await callRoute(router, 'GET', '/lark/callback', {
      headers: { host: 'evil.example' },
      query: { code: 'lark-code', state },
    });

    assert.equal(callback.status, 303);
    assert.equal(new URL(callback.body).origin, 'https://app.103.example.io');
  });

  /*
   * Where the app and the API are on different hosts, the host that answered
   * this request serves no web app at all — the configured origin is the only
   * correct answer, and the request's own is exactly wrong.
   */
  it('keeps using the configured app origin when the app and API are split', async () => {
    const router = createDesktopAuthRoutes(makeDeps({
      env: {
        BACKEND_PUBLIC_URL_ALLOWLIST: 'https://backend.example.com,https://api2.example.com',
      } as any,
    }));
    const authorize = await callRoute(router, 'GET', '/lark/authorize-url', {
      headers: { host: 'api2.example.com' },
      query: { returnTo: '/me/mail' },
    });
    const state = new URL(authorize.body.data.authorizeUrl).searchParams.get('state')!;

    const callback = await callRoute(router, 'GET', '/lark/callback', {
      headers: { host: 'api2.example.com' },
      query: { code: 'lark-code', state },
    });

    assert.equal(callback.status, 303);
    assert.equal(new URL(callback.body).origin, 'https://app.example.com');
  });

  it('does not carry an external return target through Lark login', async () => {
    const router = createDesktopAuthRoutes(makeDeps());
    const authorize = await callRoute(router, 'GET', '/lark/authorize-url', {
      headers: { host: 'localhost:8000' },
      query: { returnTo: '//evil.example/path' },
    });
    const state = new URL(authorize.body.data.authorizeUrl).searchParams.get('state')!;
    const payload = JSON.parse(Buffer.from(state.split('.')[1]!, 'base64url').toString('utf8'));

    assert.equal(payload.returnTo, undefined);
  });

  it('does not return a non-login OAuth state to the app login page', async () => {
    const router = createDesktopAuthRoutes(makeDeps());
    const state = signTestState({
      kind: 'lark_connection',
      nonce: 'nonce-1',
      returnTo: '/link/lark?state=card-state',
      exp: Math.floor(Date.now() / 1000) + 600,
    });

    const callback = await callRoute(router, 'GET', '/lark/callback', {
      query: { code: 'lark-code', state },
    });

    assert.equal(callback.status, 200);
    assert.match(String(callback.body), /Authentication complete/);
  });

  it('builds the additional Lark-account callback from the Desktop-selected local backend', async () => {
    const router = createDesktopAuthRoutes(makeDeps());
    const result = await callRoute(router, 'GET', '/lark/connections/authorize-url', {
      headers: { host: 'localhost:8000' },
      locals: { userId: 'user-1', companyId: 'company-1' },
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.success, true);
    const authorizeUrl = new URL(result.body.data.authorizeUrl);
    assert.equal(
      authorizeUrl.searchParams.get('redirect_uri'),
      'http://localhost:8000/api/desktop/auth/lark/connections/callback',
    );
  });

  it('keeps Google OAuth on the Desktop-selected local backend through code exchange', async () => {
    let authorizeRedirectUri: string | undefined;
    let exchangedRedirectUri: string | undefined;
    let storedConnection: Record<string, unknown> | undefined;
    let mailBriefInput: Record<string, unknown> | undefined;
    const router = createDesktopAuthRoutes(makeDeps({
      googleOAuthService: {
        getAuthorizeUrl: ({ state, redirectUri }: { state: string; redirectUri: string }) => {
          authorizeRedirectUri = redirectUri;
          return `https://accounts.google.com/o/oauth2/v2/auth?state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(redirectUri)}`;
        },
        exchangeAuthorizationCode: async (_code: string, redirectUri: string) => {
          exchangedRedirectUri = redirectUri;
          return { accessToken: 'google-access-token', refreshToken: 'google-refresh-token', expiresIn: 3600, scope: 'openid https://www.googleapis.com/auth/spreadsheets' };
        },
        fetchUserInfo: async () => ({ sub: 'google-user-1', email: 'user@example.com', name: 'User' }),
      },
      connectionRepo: {
        upsertGoogleConnection: async (input: Record<string, unknown>) => {
          storedConnection = input;
          return { ok: true, value: { id: 'google-connection-1', accountEmail: 'user@example.com' } };
        },
      },
      mailBriefOnboarding: async (input: Record<string, unknown>) => {
        mailBriefInput = input;
        return { ok: true, value: { subscriptionId: 'sub-1', briefId: 'brief-1', mailboxCreated: true, briefCreated: true, firstBriefQueued: true } };
      },
    }));

    const authorize = await callRoute(router, 'GET', '/google/authorize-url', {
      headers: { host: 'localhost:8000' },
      locals: { userId: 'user-1', companyId: 'company-1' },
    });

    assert.equal(authorize.status, 200);
    assert.equal(authorizeRedirectUri, 'http://localhost:8000/api/desktop/auth/google/callback');
    const authorizeUrl = new URL(authorize.body.data.authorizeUrl);
    assert.equal(authorizeUrl.searchParams.get('redirect_uri'), authorizeRedirectUri);
    const state = authorizeUrl.searchParams.get('state')!;
    const payload = JSON.parse(Buffer.from(state.split('.')[1]!, 'base64url').toString('utf8'));
    assert.equal(payload.redirectUri, authorizeRedirectUri);
    assert.deepEqual(payload.requestedToolIds, []);

    const callback = await callRoute(router, 'GET', '/google/callback', {
      query: { code: 'google-code', state },
    });

    assert.equal(callback.status, 200);
    assert.equal(exchangedRedirectUri, authorizeRedirectUri);
    assert.equal(storedConnection?.['scope'], 'openid https://www.googleapis.com/auth/spreadsheets');
    assert.equal(mailBriefInput, undefined);
  });

  it('starts mail brief after desktop Gmail OAuth', async () => {
    let authorizeScopes: string[] | undefined;
    let includeGrantedScopes: boolean | undefined;
    let mailBriefInput: Record<string, unknown> | undefined;
    const router = createDesktopAuthRoutes(makeDeps({
      googleOAuthService: {
        getAuthorizeUrl: ({ state, redirectUri, scopes, includeGrantedScopes: incremental }: { state: string; redirectUri: string; scopes?: string[]; includeGrantedScopes?: boolean }) => {
          authorizeScopes = scopes;
          includeGrantedScopes = incremental;
          return `https://accounts.google.com/o/oauth2/v2/auth?state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(redirectUri)}`;
        },
        exchangeAuthorizationCode: async () => ({
          accessToken: 'google-access-token',
          refreshToken: 'google-refresh-token',
          expiresIn: 3600,
          scope: [
            'openid',
            'https://www.googleapis.com/auth/userinfo.email',
            'https://www.googleapis.com/auth/userinfo.profile',
            'https://www.googleapis.com/auth/gmail.modify',
            'https://www.googleapis.com/auth/gmail.send',
            'https://www.googleapis.com/auth/gmail.labels',
          ].join(' '),
        }),
        fetchUserInfo: async () => ({ sub: 'google-user-1', email: 'user@example.com', name: 'User' }),
      },
      connectionRepo: {
        upsertGoogleConnection: async () => (
          { ok: true, value: { id: 'google-connection-1', accountEmail: 'user@example.com' } }
        ),
      },
      mailBriefOnboarding: async (input: Record<string, unknown>) => {
        mailBriefInput = input;
        return { ok: true, value: { subscriptionId: 'sub-1', briefId: 'brief-1', mailboxCreated: true, briefCreated: true, firstBriefQueued: true } };
      },
    }));

    const authorize = await callRoute(router, 'GET', '/google/authorize-url', {
      headers: { host: 'localhost:8000' },
      locals: { userId: 'user-1', companyId: 'company-1' },
      query: { for: 'mailAutomations' },
    });
    const state = new URL(authorize.body.data.authorizeUrl).searchParams.get('state')!;
    const payload = JSON.parse(Buffer.from(state.split('.')[1]!, 'base64url').toString('utf8'));
    const callback = await callRoute(router, 'GET', '/google/callback', {
      query: { code: 'google-code', state },
    });

    assert.equal(callback.status, 200);
    assert.deepEqual(payload.requestedToolIds, ['mailAutomations']);
    assert.deepEqual(authorizeScopes, [
      'openid',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.labels',
    ]);
    assert.equal(includeGrantedScopes, false);
    assert.deepEqual(mailBriefInput, {
      companyId: 'company-1',
      userId: 'user-1',
      connectionId: 'google-connection-1',
      mailboxEmail: 'user@example.com',
    });
  });

  it('keeps Zoho OAuth on the Desktop-selected local backend through code exchange', async () => {
    let exchangedRedirectUri: string | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({ org: [] }),
    })) as typeof fetch;
    try {
      const router = createDesktopAuthRoutes(makeDeps({
        env: {
          ZOHO_API_BASE_URL: 'https://www.zohoapis.in',
          ZOHO_ACCOUNTS_BASE_URL: 'https://accounts.zoho.in',
        },
        zohoTokenService: {
          isConfigured: () => true,
          getAuthorizeConfig: async () => ({
            clientId: 'client-1',
            accountsBaseUrl: 'https://accounts.zoho.in',
          }),
          exchangeAuthorizationCode: async (input: { redirectUri: string }) => {
            exchangedRedirectUri = input.redirectUri;
            return {
              accessToken: 'token-1',
              refreshToken: 'refresh-1',
              expiresIn: 3600,
              scopes: ['ZohoBooks.fullaccess.all'],
              accountsBaseUrl: 'https://accounts.zoho.in',
              apiDomain: 'https://www.zohoapis.in',
            };
          },
        },
        zohoConnectionRepo: {
          upsertFromExchange: async () => ({ ok: true, value: {} }),
        },
        connectionRepo: {
          listAccessibleZohoConnections: async () => ({ ok: true, value: [] }),
          upsertZohoConnection: async () => ({ ok: true, value: { id: 'connection-1' } }),
        },
      }));

      const authorize = await callRoute(router, 'GET', '/zoho/authorize-url', {
        headers: { host: 'localhost:8000' },
        locals: { userId: 'user-1', companyId: 'company-1', aiRole: 'COMPANY_ADMIN' },
      });
      const authorizeUrl = new URL(authorize.body.data.authorizeUrl);
      assert.equal(
        authorizeUrl.searchParams.get('redirect_uri'),
        'http://localhost:8000/api/desktop/auth/zoho/callback',
      );

      const callback = await callRoute(router, 'GET', '/zoho/callback', {
        query: { code: 'code-1', state: authorizeUrl.searchParams.get('state')! },
      });

      assert.equal(callback.status, 200);
      assert.equal(exchangedRedirectUri, 'http://localhost:8000/api/desktop/auth/zoho/callback');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('uses the company bound to the exchanged Lark tenant, not an arbitrary company', async () => {
    const sessionCompanyIds: string[] = [];
    const connectionCompanyIds: string[] = [];
    const invalidatedOpenIds: string[] = [];
    const router = createDesktopAuthRoutes(makeDeps({
      invalidateLarkIdentityCache: async (larkOpenId: string) => {
        invalidatedOpenIds.push(larkOpenId);
      },
      larkOAuthService: {
        isConfigured: () => true,
        getAuthorizeUrl: (state: string, input: { redirectUri: string }) =>
          `https://accounts.larksuite.com/authorize?state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(input.redirectUri)}`,
        exchangeCode: async () => ({
          accessToken: 'access-token', refreshToken: 'refresh-token', tokenType: 'Bearer',
          expiresIn: 7200, refreshTokenExpiresIn: 2_592_000,
          larkOpenId: 'ou_relicwave_dev', larkUserId: 'u_relicwave_dev', larkName: 'Dev User',
          larkEmail: 'dev@relicwave.example', larkEnName: null,
          tenantKey: 'tenant-development', scope: 'auth:user.id:read', avatarUrl: null,
        }),
      },
      prisma: {
        company: { findFirst: async () => { throw new Error('must not select an arbitrary company'); } },
        larkTenantBinding: {
          findFirst: async ({ where }: { where: { larkTenantKey: string; isActive: boolean } }) =>
            where.larkTenantKey === 'tenant-development' && where.isActive
              ? { companyId: 'company-development' }
              : null,
        },
        user: {
          findFirst: async () => null,
          create: async () => ({ id: 'user-1', email: 'dev@relicwave.example', name: 'Dev User' }),
        },
        adminMembership: { findFirst: async () => null, create: async () => ({}) },
        memberSession: { create: async ({ data }: { data: { companyId: string } }) => { sessionCompanyIds.push(data.companyId); } },
        department: { findMany: async () => [] },
      },
      connectionRepo: {
        findLarkConnectionOwner: async () => ({ ok: true, value: null }),
        upsertLarkConnection: async ({ companyId }: { companyId: string }) => {
          connectionCompanyIds.push(companyId);
          return { ok: true, value: {} };
        },
      },
    }));

    const authorize = await callRoute(router, 'GET', '/lark/authorize-url', { headers: { host: 'localhost:8000' } });
    const state = new URL(authorize.body.data.authorizeUrl).searchParams.get('state');
    const result = await callRoute(router, 'POST', '/lark/exchange', { body: { code: 'auth-code', state } });

    assert.equal(result.status, 200);
    assert.equal(result.body.data.session.companyId, 'company-development');
    assert.deepEqual(sessionCompanyIds, ['company-development']);
    assert.deepEqual(connectionCompanyIds, ['company-development']);
    assert.deepEqual(invalidatedOpenIds, ['ou_relicwave_dev']);
  });

  it('does not issue a successful Lark session when its capability connection cannot be saved', async () => {
    let createdSession = false;
    const router = createDesktopAuthRoutes(makeDeps({
      larkOAuthService: {
        isConfigured: () => true,
        getAuthorizeUrl: (state: string) => `https://accounts.larksuite.com/authorize?state=${encodeURIComponent(state)}`,
        exchangeCode: async () => ({
          accessToken: 'access-token', refreshToken: 'refresh-token', tokenType: 'Bearer',
          expiresIn: 7200, refreshTokenExpiresIn: 2_592_000,
          larkOpenId: 'ou_user', larkUserId: 'u_user', larkName: 'User',
          larkEmail: 'user@example.com', larkEnName: null,
          tenantKey: 'tenant-1', scope: 'auth:user.id:read', avatarUrl: null,
        }),
      },
      prisma: {
        larkTenantBinding: { findFirst: async () => ({ companyId: 'company-1' }) },
        user: { findFirst: async () => ({ id: 'user-1', email: 'user@example.com', name: 'User' }) },
        adminMembership: { findFirst: async () => ({ role: 'MEMBER' }) },
        memberSession: { create: async () => { createdSession = true; } },
        department: { findMany: async () => [] },
      },
      connectionRepo: {
        upsertLarkConnection: async () => ({ ok: false, error: new Error('storage unavailable') }),
      },
    }));

    const authorize = await callRoute(router, 'GET', '/lark/authorize-url', { headers: { host: 'localhost:8000' } });
    const state = new URL(authorize.body.data.authorizeUrl).searchParams.get('state');
    const result = await callRoute(router, 'POST', '/lark/exchange', { body: { code: 'auth-code', state } });

    assert.equal(result.status, 500);
    assert.equal(result.body.message, 'Could not complete Lark sign-in. Please try again.');
    assert.equal(createdSession, false);
  });

  it('rejects an unbound Lark tenant before creating a session or connection', async () => {
    let createdSession = false;
    let storedConnection = false;
    const router = createDesktopAuthRoutes(makeDeps({
      larkOAuthService: {
        isConfigured: () => true,
        getAuthorizeUrl: (state: string, input: { redirectUri: string }) =>
          `https://accounts.larksuite.com/authorize?state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(input.redirectUri)}`,
        exchangeCode: async () => ({
          accessToken: 'access-token', refreshToken: 'refresh-token', tokenType: 'Bearer',
          expiresIn: 7200, refreshTokenExpiresIn: 2_592_000,
          larkOpenId: 'ou_unknown', larkUserId: 'u_unknown', larkName: 'Unknown User',
          larkEmail: 'unknown@example.com', larkEnName: null,
          tenantKey: 'tenant-unknown', scope: 'auth:user.id:read', avatarUrl: null,
        }),
      },
      prisma: {
        larkTenantBinding: { findFirst: async () => null },
        memberSession: { create: async () => { createdSession = true; } },
      },
      connectionRepo: {
        upsertLarkConnection: async () => { storedConnection = true; return { ok: true, value: {} }; },
      },
    }));

    const authorize = await callRoute(router, 'GET', '/lark/authorize-url', { headers: { host: 'localhost:8000' } });
    const state = new URL(authorize.body.data.authorizeUrl).searchParams.get('state');
    const result = await callRoute(router, 'POST', '/lark/exchange', { body: { code: 'auth-code', state } });

    assert.equal(result.status, 403);
    assert.match(result.body.message, /not linked to an active Divo company/);
    assert.equal(createdSession, false);
    assert.equal(storedConnection, false);
  });

  it('does not create a separate Desktop user when Lark does not expose an email', async () => {
    let exchangedRedirectUri: string | undefined;
    let createdUser = false;
    let storedConnection = false;
    const router = createDesktopAuthRoutes(makeDeps({
      larkOAuthService: {
        isConfigured: () => true,
        getAuthorizeUrl: (state: string, input: { redirectUri: string }) =>
          `https://accounts.larksuite.com/authorize?state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(input.redirectUri)}`,
        exchangeCode: async (_code: string, redirectUri: string) => {
          exchangedRedirectUri = redirectUri;
          return {
            accessToken: 'access-token', refreshToken: 'refresh-token', tokenType: 'Bearer',
            expiresIn: 7200, refreshTokenExpiresIn: 2_592_000,
            larkOpenId: 'ou_no_email', larkUserId: 'u_no_email', larkName: 'No Email User',
            larkEmail: null, larkEnName: null, tenantKey: 'tenant-1', scope: 'auth:user.id:read', avatarUrl: null,
          };
        },
      },
      prisma: {
        larkTenantBinding: { findFirst: async () => ({ companyId: 'company-1' }) },
        user: {
          findFirst: async () => null,
          findUnique: async () => null,
          create: async () => { createdUser = true; return { id: 'user-1', email: 'unused@example.com', name: 'Unused' }; },
        },
        adminMembership: { findFirst: async () => null, create: async () => ({}) },
        memberSession: { create: async () => ({}) },
        department: { findMany: async () => [] },
      },
      connectionRepo: {
        findLarkConnectionOwner: async (input: { companyId: string; larkOpenId: string; larkTenantKey: string }) => {
          assert.deepEqual(input, {
            companyId: 'company-1',
            larkOpenId: 'ou_no_email',
            larkTenantKey: 'tenant-1',
          });
          return { ok: true, value: null };
        },
        upsertLarkConnection: async () => {
          storedConnection = true;
          return { ok: true, value: {} };
        },
      },
    }));

    const authorize = await callRoute(router, 'GET', '/lark/authorize-url', {
      headers: { host: 'localhost:8000' },
    });
    const state = new URL(authorize.body.data.authorizeUrl).searchParams.get('state');
    const result = await callRoute(router, 'POST', '/lark/exchange', {
      body: { code: 'auth-code', state },
    });

    assert.equal(result.status, 400);
    assert.equal(exchangedRedirectUri, 'http://localhost:8000/api/desktop/auth/lark/callback');
    assert.match(result.body.message, /contact:user\.email:readonly/);
    assert.equal(createdUser, false);
    assert.equal(storedConnection, false);
  });

  it('fails closed when Lark returns no usable account identity', async () => {
    const logging = captureLogger();
    let createdUser = false;
    let createdSession = false;
    let storedConnection = false;
    const router = createDesktopAuthRoutes(makeDeps({
      logger: logging.logger,
      larkOAuthService: {
        isConfigured: () => true,
        getAuthorizeUrl: (state: string, input: { redirectUri: string }) =>
          `https://accounts.larksuite.com/authorize?state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(input.redirectUri)}`,
        exchangeCode: async () => ({
          accessToken: 'access-token', refreshToken: 'refresh-token', tokenType: 'Bearer',
          expiresIn: 7200, refreshTokenExpiresIn: 2_592_000,
          larkOpenId: '   ', larkUserId: null, larkName: 'No Identity',
          larkEmail: 'no-identity@example.com', larkEnName: null,
          tenantKey: 'tenant-1', scope: 'auth:user.id:read', avatarUrl: null,
        }),
      },
      prisma: {
        larkTenantBinding: { findFirst: async () => ({ companyId: 'company-1' }) },
        user: {
          findFirst: async () => { throw new Error('user lookup must not run'); },
          create: async () => { createdUser = true; return { id: 'user-1', email: 'unused@example.com', name: 'Unused' }; },
        },
        adminMembership: { findFirst: async () => ({ role: 'MEMBER' }), create: async () => ({}) },
        memberSession: { create: async () => { createdSession = true; } },
        department: { findMany: async () => [] },
      },
      connectionRepo: {
        findLarkConnectionOwner: async () => ({ ok: true, value: null }),
        upsertLarkConnection: async () => { storedConnection = true; return { ok: true, value: {} }; },
      },
    }));

    const authorize = await callRoute(router, 'GET', '/lark/authorize-url', { headers: { host: 'localhost:8000' } });
    const state = new URL(authorize.body.data.authorizeUrl).searchParams.get('state');
    const result = await callRoute(router, 'POST', '/lark/exchange', { body: { code: 'auth-code', state } });

    assert.equal(result.status, 400);
    assert.match(result.body.message, /usable account identity/);
    assert.equal(createdUser, false);
    assert.equal(createdSession, false);
    assert.equal(storedConnection, false);
    assert.ok(logging.events.includes('lark.exchange.identity_missing'));
  });

  it('rejects an existing synthetic Lark owner instead of signing it in as a Member', async () => {
    let createdUser = false;
    let createdMembership = false;
    let createdSession = false;
    let storedConnection = false;
    const router = createDesktopAuthRoutes(makeDeps({
      larkOAuthService: {
        isConfigured: () => true,
        getAuthorizeUrl: (state: string, input: { redirectUri: string }) =>
          `https://accounts.larksuite.com/authorize?state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(input.redirectUri)}`,
        exchangeCode: async () => ({
          accessToken: 'access-token', refreshToken: 'refresh-token', tokenType: 'Bearer',
          expiresIn: 7200, refreshTokenExpiresIn: 2_592_000,
          larkOpenId: 'ou_existing_placeholder', larkUserId: 'u_existing_placeholder',
          larkName: 'Existing Placeholder', larkEmail: null, larkEnName: null,
          tenantKey: 'tenant-1', scope: 'auth:user.id:read', avatarUrl: null,
        }),
      },
      prisma: {
        larkTenantBinding: { findFirst: async () => ({ companyId: 'company-1' }) },
        user: {
          findFirst: async () => null,
          findUnique: async () => ({
            id: 'temporary-user',
            email: 'lark-opaque@identity.divo.invalid',
            name: 'Existing Placeholder',
          }),
          create: async () => {
            createdUser = true;
            return { id: 'unused-user', email: 'unused@example.com', name: 'Unused' };
          },
        },
        adminMembership: {
          findFirst: async () => null,
          create: async () => { createdMembership = true; return {}; },
        },
        memberSession: { create: async () => { createdSession = true; return {}; } },
        department: { findMany: async () => [] },
      },
      connectionRepo: {
        findLarkConnectionOwner: async () => ({ ok: true, value: { userId: 'temporary-user' } }),
        upsertLarkConnection: async () => {
          storedConnection = true;
          return { ok: true, value: {} };
        },
      },
    }));

    const authorize = await callRoute(router, 'GET', '/lark/authorize-url', {
      headers: { host: 'localhost:8000' },
    });
    const state = new URL(authorize.body.data.authorizeUrl).searchParams.get('state');
    const result = await callRoute(router, 'POST', '/lark/exchange', {
      body: { code: 'auth-code', state },
    });

    assert.equal(result.status, 400);
    assert.match(result.body.message, /contact:contact\.base:readonly/);
    assert.equal(createdUser, false);
    assert.equal(createdMembership, false);
    assert.equal(createdSession, false);
    assert.equal(storedConnection, false);
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
    const { surface, ...context } = result.body.data as Record<string, unknown>;
    assert.deepEqual(context, {
      departmentId: '5d649f61-d5ea-4fd6-a52e-7166c33fb1cd',
      departmentName: 'Finance',
      personaPrompt: 'Prefer verified records.',
      version: '2026-07-11T10:00:00.000Z',
      personalMemory: [],
    });
    // The container builds its presentation policy from this and nothing else.
    // Absent, it would say nothing about the surface and Divo would go back to
    // guessing — which is the state this whole design replaced.
    assert.equal((surface as Record<string, unknown>)['key'], 'desktop');
  });

  it('returns only active, current, user-owned personal memory without requiring a department', async () => {
    const calls: unknown[] = [];
    const router = createDesktopAuthRoutes(makeDeps({
      prisma: {
        knowledgeResource: {
          findMany: async (input: unknown) => {
            calls.push(input);
            return [
              {
                id: 'memory-1',
                companyId: 'company-1',
                ownerUserId: 'user-1',
                scope: 'personal',
                kind: 'memory',
                status: 'active',
                logicalKey: 'memory.concise',
                currentVersion: 2,
                updatedAt: new Date('2026-08-14T10:00:00.000Z'),
                department: null,
                versions: [{ version: 2, contentJson: { facts: ['User prefers concise weekly summaries.'] } }],
              },
            ];
          },
        },
      },
    }));
    const result = await callRoute(router, 'GET', '/runtime-context', {
      locals: { userId: 'user-1', companyId: 'company-1' },
    });

    assert.equal(result.status, 200);
    const { surface: _surface, ...context } = result.body.data as Record<string, unknown>;
    assert.deepEqual(context, {
      departmentId: null,
      departmentName: null,
      personaPrompt: '',
      version: null,
      personalMemory: ['User prefers concise weekly summaries.'],
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      where: {
        companyId: 'company-1',
        ownerUserId: 'user-1',
        scope: 'personal',
        kind: 'memory',
        status: 'active',
      },
      orderBy: { updatedAt: 'desc' },
      take: 100,
      include: {
        department: { select: { name: true } },
        versions: {
          orderBy: { version: 'desc' },
          take: 1,
          select: { version: true, contentJson: true },
        },
      },
    });
  });

  it('logs canonical personal-memory failure while returning a safe empty snapshot', async () => {
    const { events, logger } = captureLogger();
    const router = createDesktopAuthRoutes(makeDeps({
      logger,
      prisma: {
        knowledgeResource: {
          findMany: async () => { throw new Error('database unavailable'); },
        },
      },
    }));
    const result = await callRoute(router, 'GET', '/runtime-context', {
      locals: { userId: 'user-1', companyId: 'company-1' },
    });

    assert.equal(result.status, 200);
    assert.deepEqual(result.body.data.personalMemory, []);
    assert.deepEqual(events, ['runtime_context.personal_memory_failed']);
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

  it('appends the active manager persona brief without making it a permission grant', async () => {
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
      managerPersonaRuntime: {
        getDepartmentBrief: async () => ({
          version: 'manager-persona:4:2026-07-18T10:00:00.000Z',
          prompt: 'MANAGER PERSONA TREE — backend-generated learned operating context.',
        }),
      },
    }));
    const result = await callRoute(router, 'GET', '/runtime-context', {
      query: { departmentId: '5d649f61-d5ea-4fd6-a52e-7166c33fb1cd' },
      locals: { userId: 'user-1', companyId: 'company-1' },
    });

    assert.equal(result.status, 200);
    assert.match(result.body.data.personaPrompt, /Prefer verified records/);
    assert.match(result.body.data.personaPrompt, /MANAGER PERSONA TREE/);
    assert.equal(
      result.body.data.version,
      '2026-07-11T10:00:00.000Z|manager-persona:4:2026-07-18T10:00:00.000Z',
    );
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
          aliases: [],
          tags: [],
          revision: 3,
        }],
        registryRevision: async () => 9,
      },
      skillAccessEnforcement: {
        listGrantedSkillIds: async () => new Set(['skill-finance']),
      },
      connectionRepo: {
        listAccessibleZohoConnections: async () => ({
          ok: true,
          value: [{
            connectionId: 'zoho-connection-1',
            provider: 'zoho',
            label: 'Finance Books',
            ownerType: 'company',
            access: 'read_write',
            scopes: ['ZohoBooks.fullaccess.all'],
            connectedAt: new Date('2026-07-01T00:00:00.000Z'),
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
    assert.equal(result.body.data.capabilityBootstrap.version, 2);
    assert.equal(result.body.data.capabilityBootstrap.registryRevision, 9);
    assert.equal(result.body.data.capabilityBootstrap.departmentRole, 'FINANCE_MANAGER');
    assert.deepEqual(result.body.data.capabilityBootstrap.availableSkills, [{
      id: 'skill-finance',
      slug: 'finance-ops-core',
      name: 'Finance Ops Core',
      description: 'Route broad finance questions.',
      revision: 3,
    }]);
    assert.deepEqual(result.body.data.capabilityBootstrap.preferredTools, [
      { toolId: 'zohoBooks', actions: ['read', 'create'] },
      { toolId: 'zohoCrm', actions: ['read'] },
      { toolId: 'webSearch', actions: ['read'] },
    ]);
    assert.deepEqual(result.body.data.capabilityBootstrap.zohoConnections, [{
      connectionId: 'zoho-connection-1',
      label: 'Finance Books',
      access: 'read_write',
      services: ['books'],
    }]);
  });

  it('resolves what a member may do once, however many bootstraps the answer feeds', async () => {
    const departmentId = '5d649f61-d5ea-4fd6-a52e-7166c33fb1cd';
    const calls: string[] = [];
    const permission = {
      ok: true,
      value: {
        allowedToolIds: new Set(['zohoBooks']),
        allowedActionsByTool: new Map([['zohoBooks', new Set(['read'])]]),
        decisions: [],
        department: { roleSlug: 'MEMBER' },
      },
    };
    const router = createDesktopAuthRoutes(makeDeps({
      prisma: {
        departmentMembership: {
          findFirst: async () => ({
            department: { id: departmentId, name: 'Finance', slug: 'finance', agentConfig: null },
          }),
        },
      },
      permissions: {
        resolve: async () => { calls.push('permissions.resolve'); return permission; },
      },
      skillCatalog: {
        // Serves both shapes, so the capability bootstrap genuinely succeeds
        // here rather than throwing into its own catch and being skipped.
        listVisible: async () => [{
          id: 'skill-finance',
          slug: 'finance-ops-core',
          name: 'Finance Ops Core',
          description: 'Route broad finance questions.',
          instructions: '# Finance Ops',
          toolIds: ['zohoBooks'],
          aliases: [],
          tags: ['router'],
          revision: 3,
        }],
        registryRevision: async () => { calls.push('registryRevision'); return 9; },
      },
      skillAccessEnforcement: {
        listGrantedSkillIds: async () => { calls.push('listGrantedSkillIds'); return new Set(['skill-finance']); },
      },
    }));

    const result = await callRoute(router, 'GET', '/runtime-context', {
      query: { departmentId, capabilityVersion: '3', nativeSkills: '1' },
      locals: {
        userId: 'user-1',
        companyId: 'company-1',
        aiRole: 'MEMBER',
        isPiRuntimeLease: true,
        runtimeDepartmentId: departmentId,
      },
    });

    assert.equal(result.status, 200);
    // Both bootstraps are present, so both consumers really did run — otherwise
    // the count below would be trivially satisfied by one of them being skipped.
    assert.ok(result.body.data.nativeSkillBootstrap);
    assert.ok(result.body.data.capabilityBootstrap);
    // This is the request on a turn's critical path, and it used to ask for all
    // three of these twice — the two permission queries differing only in a
    // `channel` the resolver never reads.
    assert.deepEqual(calls.sort(), ['listGrantedSkillIds', 'permissions.resolve', 'registryRevision']);
  });

  it('loads the native catalogue once and omits duplicate skill guidance from the Cloud capability projection', async () => {
    const departmentId = '5d649f61-d5ea-4fd6-a52e-7166c33fb1cd';
    const started: string[] = [];
    const releases: Array<() => void> = [];
    const skill = {
      id: 'skill-finance',
      slug: 'finance-ops-core',
      name: 'Finance Ops Core',
      description: 'Route broad finance questions.',
      instructions: '# Finance Ops',
      toolIds: ['zohoBooks'],
      aliases: [],
      tags: ['router'],
      revision: 3,
    };
    const router = createDesktopAuthRoutes(makeDeps({
      prisma: {
        departmentMembership: {
          findFirst: async () => ({
            department: { id: departmentId, name: 'Finance', slug: 'finance', agentConfig: null },
          }),
        },
      },
      permissions: {
        resolve: async () => ({
          ok: true,
          value: {
            allowedToolIds: new Set(['zohoBooks']),
            allowedActionsByTool: new Map([['zohoBooks', new Set(['read'])]]),
            decisions: [],
            department: { roleSlug: 'MEMBER' },
          },
        }),
      },
      skillCatalog: {
        listVisible: async (input: { complete?: boolean }) => {
          started.push(input.complete ? 'native' : 'capability');
          await new Promise<void>(resolve => releases.push(resolve));
          return [skill];
        },
        registryRevision: async () => 9,
      },
      skillAccessEnforcement: {
        listGrantedSkillIds: async () => new Set(['skill-finance']),
      },
    }));

    const response = callRoute(router, 'GET', '/runtime-context', {
      query: { departmentId, capabilityVersion: '3', nativeSkills: '1' },
      locals: {
        userId: 'user-1',
        companyId: 'company-1',
        aiRole: 'MEMBER',
        isPiRuntimeLease: true,
        runtimeDepartmentId: departmentId,
      },
    });
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(started, ['native']);
    releases.splice(0).forEach(release => release());
    const result = await response;
    assert.equal(result.status, 200);
    assert.equal(result.body.data.nativeSkillBootstrap.skills[0].slug, 'finance-ops-core');
    assert.deepEqual(result.body.data.capabilityBootstrap.availableSkills, []);
    assert.deepEqual(result.body.data.capabilityBootstrap.families[0].skills, []);
    assert.deepEqual(result.body.data.capabilityBootstrap.preferredSkills, []);
    assert.deepEqual(result.body.data.capabilityBootstrap.routingHints, []);
    assert.deepEqual(result.body.data.capabilityBootstrap.availableTools, [{
      toolId: 'zohoBooks',
      actions: ['read'],
    }]);
  });

  it('rechecks authority but skips an unchanged native catalogue binding', async () => {
    const departmentId = '5d649f61-d5ea-4fd6-a52e-7166c33fb1cd';
    let catalogueReads = 0;
    let permissionReads = 0;
    let grantReads = 0;
    let grantedSkillIds = new Set(['skill-finance']);
    const router = createDesktopAuthRoutes(makeDeps({
      prisma: {
        departmentMembership: {
          findFirst: async () => ({
            department: { id: departmentId, name: 'Finance', slug: 'finance', agentConfig: null },
          }),
        },
      },
      permissions: {
        resolve: async () => {
          permissionReads += 1;
          return {
            ok: true,
            value: {
              allowedToolIds: new Set(['zohoBooks']),
              allowedActionsByTool: new Map([['zohoBooks', new Set(['read'])]]),
              decisions: [],
            },
          };
        },
      },
      skillCatalog: {
        listVisible: async () => {
          catalogueReads += 1;
          return [{
            id: 'skill-finance',
            slug: 'finance-ops-core',
            name: 'Finance Ops Core',
            description: 'Route broad finance questions.',
            instructions: '# Finance Ops',
            toolIds: ['zohoBooks'],
            aliases: [],
            tags: [],
            revision: 3,
          }];
        },
        registryRevision: async () => 9,
      },
      skillAccessEnforcement: {
        listGrantedSkillIds: async () => {
          grantReads += 1;
          return grantedSkillIds;
        },
      },
    }));
    const request = {
      query: { departmentId, capabilityVersion: '3', nativeSkills: '1' },
      locals: {
        userId: 'user-1',
        companyId: 'company-1',
        aiRole: 'MEMBER',
        channel: 'lark',
        isPiRuntimeLease: true,
        runtimeDepartmentId: departmentId,
      },
    };

    const first = await callRoute(router, 'GET', '/runtime-context', request);
    const binding = first.body.data.nativeSkillBinding;
    assert.match(binding, /^[a-f0-9]{64}$/);
    assert.ok(first.body.data.nativeSkillBootstrap);

    const warm = await callRoute(router, 'GET', '/runtime-context', {
      ...request,
      headers: { 'x-divo-native-skill-binding': binding },
    });
    assert.equal(warm.status, 200);
    assert.equal(warm.body.data.nativeSkillsUnchanged, true);
    assert.equal(warm.body.data.nativeSkillBootstrap, undefined);
    assert.equal(catalogueReads, 1);
    assert.equal(permissionReads, 2);
    assert.equal(grantReads, 2);

    grantedSkillIds = new Set();
    const revoked = await callRoute(router, 'GET', '/runtime-context', {
      ...request,
      headers: { 'x-divo-native-skill-binding': binding },
    });
    assert.equal(revoked.status, 200);
    assert.notEqual(revoked.body.data.nativeSkillBinding, binding);
    assert.ok(revoked.body.data.nativeSkillBootstrap);
    assert.equal(catalogueReads, 2);
  });

  it('breaks the controller skills phase into its actual backend reads', async () => {
    const departmentId = '5d649f61-d5ea-4fd6-a52e-7166c33fb1cd';
    const spans: Array<Record<string, any>> = [];
    const store: RunLatencySpanStore = {
      findOwnedIdByRequestId: async () => 'execution-1',
      insertSpans: async batch => { spans.push(...batch); },
    };
    const router = createDesktopAuthRoutes(makeDeps({
      prisma: {
        departmentMembership: {
          findFirst: async () => ({
            department: { id: departmentId, name: 'Operations', slug: 'operations', agentConfig: null },
          }),
        },
      },
      permissions: {
        resolve: async () => ({
          ok: true,
          value: {
            allowedToolIds: new Set<string>(),
            allowedActionsByTool: new Map(),
            decisions: [],
            department: { roleSlug: 'MEMBER' },
          },
        }),
      },
      runLatencyRecorder: new RunLatencyRecorder(store, noopLogger),
    }));

    const result = await callRoute(router, 'GET', '/runtime-context', {
      query: { departmentId, capabilityVersion: '3', nativeSkills: '1' },
      locals: {
        userId: 'user-1',
        companyId: 'company-1',
        aiRole: 'MEMBER',
        isPiRuntimeLease: true,
        runtimeRunId: 'run-1',
        runtimeDepartmentId: departmentId,
      },
    });
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(result.status, 200);
    assert.ok(spans.some(span => span.name === 'runtime.context.personal-memory'));
    assert.ok(spans.some(span => span.name === 'runtime.context.membership'));
    assert.ok(spans.some(span => span.name === 'runtime.context.permission'));
    assert.ok(spans.some(span => span.name === 'runtime.context.native-skills'));
    assert.equal(spans.every(span => span.parentSpanId === 'controller.phase.skills'), true);
  });

  it('returns complete native skill files only to the pinned Pi runtime lease', async () => {
    const permissionCalls: unknown[] = [];
    const departmentId = '5d649f61-d5ea-4fd6-a52e-7166c33fb1cd';
    const router = createDesktopAuthRoutes(makeDeps({
      prisma: {
        departmentMembership: {
          findFirst: async () => ({
            department: { id: departmentId, name: 'Finance', slug: 'finance', agentConfig: null },
          }),
        },
      },
      permissions: {
        resolve: async (input: unknown) => {
          permissionCalls.push(input);
          return {
            ok: true,
            value: {
              allowedToolIds: new Set(['zohoBooks']),
              allowedActionsByTool: new Map([['zohoBooks', new Set(['read'])]]),
              decisions: [],
              department: { roleSlug: 'MEMBER' },
            },
          };
        },
      },
      skillCatalog: {
        listVisible: async (input: Record<string, unknown>) => {
          assert.equal(input.failClosed, true);
          assert.equal(input.complete, true);
          assert.equal(input.limit, undefined);
          assert.equal(input.departmentId, departmentId);
          assert.equal(input.includeGrantedDepartments, undefined);
          return [{
            id: 'skill-finance',
            slug: 'finance-ops-core',
            name: 'Finance Ops Core',
            description: 'Route broad finance questions.',
            instructions: '# Finance Ops\n\nUse verified records.',
            toolIds: ['zohoBooks'],
            aliases: [],
            tags: ['router'],
            revision: 3,
          }];
        },
        registryRevision: async () => 9,
      },
      skillAccessEnforcement: {
        listGrantedSkillIds: async () => new Set(['skill-finance']),
      },
    }));

    const result = await callRoute(router, 'GET', '/runtime-context', {
      query: { departmentId, capabilityVersion: '3', nativeSkills: '1' },
      locals: {
        userId: 'user-1',
        companyId: 'company-1',
        aiRole: 'MEMBER',
        isPiRuntimeLease: true,
        runtimeDepartmentId: departmentId,
      },
    });

    assert.equal(result.status, 200);
    assert.equal((permissionCalls[0] as { channel: string }).channel, 'lark');
    assert.deepEqual(result.body.data.nativeSkillBootstrap, {
      registryRevision: 9,
      skills: [{
        id: 'skill-finance',
        slug: 'finance-ops-core',
        name: 'Finance Ops Core',
        description: 'Route broad finance questions.',
        instructions: '# Finance Ops\n\nUse verified records.',
        revision: 3,
      }],
    });
  });

  it('bounds native skills by priority order and bytes instead of aborting the run', async () => {
    const departmentId = '5d649f61-d5ea-4fd6-a52e-7166c33fb1cd';
    const { events, logger } = captureLogger();
    let catalogue = Array.from({ length: 101 }, (_, index) => ({
      id: `skill-${index}`,
      slug: `skill-${index}`,
      name: `Skill ${index}`,
      description: 'Safe description',
      instructions: 'Use governed tools.',
      toolIds: [],
      aliases: [],
      tags: [],
      revision: 1,
    }));
    const router = createDesktopAuthRoutes(makeDeps({
      logger,
      prisma: {
        departmentMembership: {
          findFirst: async () => ({
            department: { id: departmentId, name: 'Finance', slug: 'finance', agentConfig: null },
          }),
        },
      },
      permissions: {
        resolve: async () => ({
          ok: true,
          value: {
            allowedToolIds: new Set(),
            allowedActionsByTool: new Map(),
            decisions: [],
            department: { roleSlug: 'MEMBER' },
          },
        }),
      },
      skillCatalog: {
        listVisible: async () => catalogue,
        registryRevision: async () => 9,
      },
    }));
    const request = {
      query: { departmentId, capabilityVersion: '3', nativeSkills: '1' },
      locals: {
        userId: 'user-1',
        companyId: 'company-1',
        aiRole: 'MEMBER',
        isPiRuntimeLease: true,
        runtimeDepartmentId: departmentId,
      },
    };

    const countBounded = await callRoute(router, 'GET', '/runtime-context', request);
    assert.equal(countBounded.status, 200);
    assert.equal(countBounded.body.data.nativeSkillBootstrap.skills.length, 100);
    assert.equal(countBounded.body.data.nativeSkillBootstrap.skills.at(-1).slug, 'skill-99');

    catalogue = catalogue.slice(0, 30).map(skill => ({
      ...skill,
      instructions: 'x'.repeat(90_000),
    }));
    const byteBounded = await callRoute(router, 'GET', '/runtime-context', request);
    assert.equal(byteBounded.status, 200);
    assert.equal(byteBounded.body.data.nativeSkillBootstrap.skills.length, 22);
    assert.equal(events.filter(event => event === 'runtime.native_skills.bounded').length, 2);
  });

  it('does not expose native skill bodies to an ordinary member session', async () => {
    const departmentId = '5d649f61-d5ea-4fd6-a52e-7166c33fb1cd';
    const router = createDesktopAuthRoutes(makeDeps());
    const result = await callRoute(router, 'GET', '/runtime-context', {
      query: { departmentId, capabilityVersion: '3', nativeSkills: '1' },
      locals: { userId: 'user-1', companyId: 'company-1', runtimeDepartmentId: departmentId },
    });

    assert.equal(result.status, 403);
    assert.equal(result.body.success, false);
  });

  it('fails the native bootstrap instead of returning a partial catalogue', async () => {
    const departmentId = '5d649f61-d5ea-4fd6-a52e-7166c33fb1cd';
    const router = createDesktopAuthRoutes(makeDeps({
      prisma: {
        departmentMembership: {
          findFirst: async () => ({
            department: { id: departmentId, name: 'Finance', slug: 'finance', agentConfig: null },
          }),
        },
      },
      permissions: {
        resolve: async () => ({
          ok: true,
          value: {
            allowedToolIds: new Set(),
            allowedActionsByTool: new Map(),
            decisions: [],
            department: { roleSlug: 'MEMBER' },
          },
        }),
      },
      skillCatalog: {
        listVisible: async () => { throw new Error('catalogue unavailable'); },
        registryRevision: async () => 9,
      },
    }));
    const result = await callRoute(router, 'GET', '/runtime-context', {
      query: { departmentId, capabilityVersion: '3', nativeSkills: '1' },
      locals: {
        userId: 'user-1',
        companyId: 'company-1',
        aiRole: 'MEMBER',
        isPiRuntimeLease: true,
        runtimeDepartmentId: departmentId,
      },
    });

    assert.equal(result.status, 500);
    assert.equal(result.body.data, undefined);
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
    const { surface: _surface, ...context } = result.body.data as Record<string, unknown>;
    assert.deepEqual(context, {
      departmentId: '5d649f61-d5ea-4fd6-a52e-7166c33fb1cd',
      departmentName: 'Finance',
      personaPrompt: '',
      version: null,
      personalMemory: [],
    });
  });
});

describe('desktop password sign-in', () => {
  const require_ = createRequire(import.meta.url);
  const bcrypt = require_('bcryptjs') as {
    hashSync(input: string, rounds: number): string;
  };
  const PASSWORD = 'correct-horse-battery';
  const HASH = bcrypt.hashSync(PASSWORD, 4);

  /**
   * `password` holds an HMAC digest rather than a bcrypt hash for an account
   * Lark provisioned — that person never chose a password. Copied from the
   * shape `lark.exchange.user_created` writes.
   */
  const LARK_PROVISIONED_PASSWORD = createHmac('sha256', 'irrelevant').update('x').digest('hex');

  const loginPrisma = (user: { password: string } | null, membership: unknown) => ({
    user: { findUnique: async () => (user ? { id: 'user-1', email: 'a@acme.co', name: 'A', ...user } : null) },
    adminMembership: { findFirst: async () => membership },
    department: { findMany: async () => [] },
    memberSession: { create: async () => ({}) },
  });

  it('issues a member session for valid credentials', async () => {
    const router = createDesktopAuthRoutes(makeDeps({
      prisma: loginPrisma({ password: HASH }, { companyId: 'company-1', role: 'MEMBER' }),
    }));

    const result = await callRoute(router, 'POST', '/login', {
      body: { email: 'a@acme.co', password: PASSWORD },
    });

    assert.equal(result.status, 200);
    assert.equal(typeof result.body.data.token, 'string');
    assert.equal(result.body.data.session.authProvider, 'password');
    // No Lark identity on this session, and the client is told so rather than
    // left to discover that the person's Lark chat does not work.
    assert.equal(result.body.data.session.larkOpenId, null);
  });

  it('gives an unknown email and a wrong password the same answer', async () => {
    const wrongPassword = createDesktopAuthRoutes(makeDeps({
      prisma: loginPrisma({ password: HASH }, { companyId: 'company-1', role: 'MEMBER' }),
    }));
    const unknownEmail = createDesktopAuthRoutes(makeDeps({
      prisma: loginPrisma(null, null),
    }));

    const a = await callRoute(wrongPassword, 'POST', '/login', {
      body: { email: 'a@acme.co', password: 'not-it' },
    });
    const b = await callRoute(unknownEmail, 'POST', '/login', {
      body: { email: 'nobody@acme.co', password: PASSWORD },
    });

    assert.equal(a.status, 401);
    assert.equal(b.status, 401);
    // Identical, so this route cannot be used to discover who has an account.
    assert.equal(a.body.message, b.body.message);
  });

  it('refuses an account Lark provisioned, whose stored password is not a hash', async () => {
    const router = createDesktopAuthRoutes(makeDeps({
      prisma: loginPrisma(
        { password: LARK_PROVISIONED_PASSWORD },
        { companyId: 'company-1', role: 'MEMBER' },
      ),
    }));

    // The digest itself, which is the one value most likely to be guessed if
    // the shape were ever compared directly.
    const result = await callRoute(router, 'POST', '/login', {
      body: { email: 'a@acme.co', password: LARK_PROVISIONED_PASSWORD },
    });

    assert.equal(result.status, 401);
  });

  it('refuses an account with no active workspace membership', async () => {
    const router = createDesktopAuthRoutes(makeDeps({
      prisma: loginPrisma({ password: HASH }, null),
    }));

    const result = await callRoute(router, 'POST', '/login', {
      body: { email: 'a@acme.co', password: PASSWORD },
    });

    // 403 and not 401: the credentials were right, so saying so leaks nothing
    // this caller does not already know, and "wrong password" would be a lie.
    assert.equal(result.status, 403);
  });
});

describe('what a runtime lease resolves to', () => {
  const leaseLocals = {
    userId:    'user-1',
    companyId: 'company-1',
    aiRole:    'MEMBER',
    channel:   'lark',
    isPiRuntimeLease:        true,
    runtimeInstanceId:       'instance-1',
    runtimeThreadId:         'oc_chat:thread:om_root',
    runtimeRunId:            'run-1',
    runtimeChatId:           'oc_chat',
    runtimeContextAudience:  'private',
    runtimeDepartmentId:     'department-1',
  };

  /**
   * Every query `/me` runs that a container has never read. Each throws, so a
   * route that still assembled a desktop payload fails the test loudly instead
   * of quietly costing a turn the round trips it was meant to stop paying.
   */
  const refuseDesktopPayload = {
    user:    { findUnique: async () => { throw new Error('a run does not read the member profile'); } },
    company: { findUnique: async () => { throw new Error('a run does not read the company record'); } },
  };
  const refuseConnectionListing = {
    listAccessibleLarkConnections:   async () => { throw new Error('a run does not read connected accounts'); },
    listAccessibleGoogleConnections: async () => { throw new Error('a run does not read connected accounts'); },
  };

  it('answers with the run facts the middleware established and the departments it may act in', async () => {
    const router = createDesktopAuthRoutes(makeDeps({
      prisma: {
        ...refuseDesktopPayload,
        departmentMembership: {
          findMany: async () => [
            { department: { id: 'department-1', name: 'Finance' } },
            { department: { id: 'department-2', name: 'Sales' } },
          ],
        },
      },
      connectionRepo: refuseConnectionListing,
    }));

    const result = await callRoute(router, 'GET', '/runtime-session', { locals: { ...leaseLocals } });

    assert.equal(result.status, 200);
    assert.deepEqual(result.body.data, {
      userId:    'user-1',
      companyId: 'company-1',
      role:      'MEMBER',
      runtime: {
        channel:         'lark',
        instanceId:      'instance-1',
        threadId:        'oc_chat:thread:om_root',
        runId:           'run-1',
        chatId:          'oc_chat',
        contextAudience: 'private',
        departmentId:    'department-1',
      },
      // Id and name only. Role and manager status stay out: a run's authority
      // is resolved per tool call by the gateway, never carried in from startup.
      departments: [
        { id: 'department-1', name: 'Finance' },
        { id: 'department-2', name: 'Sales' },
      ],
    });
  });

  it('refuses a caller that is not a runtime lease', async () => {
    const router = createDesktopAuthRoutes(makeDeps({
      prisma: {
        departmentMembership: {
          findMany: async () => { throw new Error('a person is not a run'); },
        },
      },
    }));

    // A signed-in person reaching this would be handed a run's identity claims
    // for a run that is not theirs — and `channel` is the only thing separating
    // the two, because both arrive as a valid member session.
    const result = await callRoute(router, 'GET', '/runtime-session', {
      locals: { userId: 'user-1', companyId: 'company-1', aiRole: 'MEMBER', channel: 'desktop' },
    });

    assert.equal(result.status, 403);
    assert.equal(result.body.success, false);
  });

  it('does not let a container reach the member payload it used to resolve leases through', () => {
    // `/me` carries the member's email, name, avatar and every connected Lark
    // and Google account. It was reachable from inside a container for one
    // reason — it was where a lease got resolved — and that reason is gone.
    assert.equal(allowsPiRuntimeLease({ method: 'GET', path: '/me' } as any), false);
    assert.equal(allowsPiRuntimeLease({ method: 'GET', path: '/runtime-session' } as any), true);
    assert.equal(allowsPiRuntimeLease({ method: 'GET', path: '/runtime-context' } as any), true);
    // Read-only, and only these two: a lease is held by whatever the model ran.
    assert.equal(allowsPiRuntimeLease({ method: 'POST', path: '/runtime-session' } as any), false);
    assert.equal(allowsPiRuntimeLease({ method: 'GET', path: '/handoff' } as any), false);
  });
});

describe('desktop /me reports the department role', () => {
  /**
   * Company role is the ceiling; leading a department is a separate axis. The
   * web shell decides whether someone gets a Team scope from the second one,
   * and cannot derive it from the first — so /me has to carry both.
   */
  const mePrisma = (memberships: unknown[]) => ({
    user:    { findUnique: async () => ({ id: 'user-1', email: 'a@acme.co', name: 'A' }) },
    company: { findUnique: async () => ({ name: 'Acme Technologies' }) },
    departmentMembership: { findMany: async () => memberships },
  });

  const connectionRepo = {
    listAccessibleLarkConnections:   async () => ({ ok: true, value: [] }),
    listAccessibleGoogleConnections: async () => ({ ok: true, value: [] }),
  };

  it('marks the department a person manages', async () => {
    const router = createDesktopAuthRoutes(makeDeps({
      connectionRepo,
      prisma: mePrisma([
        { department: { id: 'd_fin', name: 'Finance' }, role: { slug: 'MANAGER', name: 'Manager' } },
        { department: { id: 'd_ops', name: 'Operations' }, role: { slug: 'MEMBER', name: 'Member' } },
      ]),
    }));

    const result = await callRoute(router, 'GET', '/me', {
      locals: { userId: 'user-1', companyId: 'company-1', aiRole: 'MEMBER' },
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.data.companyName, 'Acme Technologies');
    assert.deepEqual(result.body.data.departments, [
      { id: 'd_fin', name: 'Finance', roleSlug: 'MANAGER', roleName: 'Manager', isManager: true },
      { id: 'd_ops', name: 'Operations', roleSlug: 'MEMBER', roleName: 'Member', isManager: false },
    ]);
  });

  it('keys manager off the slug, not the editable role name', async () => {
    const router = createDesktopAuthRoutes(makeDeps({
      connectionRepo,
      // An admin renamed the MEMBER role to "Team Manager". The label changed;
      // the authority did not, and only the slug says so.
      prisma: mePrisma([
        { department: { id: 'd_fin', name: 'Finance' }, role: { slug: 'MEMBER', name: 'Team Manager' } },
      ]),
    }));

    const result = await callRoute(router, 'GET', '/me', {
      locals: { userId: 'user-1', companyId: 'company-1', aiRole: 'MEMBER' },
    });

    assert.equal(result.body.data.departments[0].isManager, false);
  });

  /*
   * The model list a member sees.
   *
   * Labels used to come from GET /api/admin/proxy/models, which is behind
   * adminAuth — so a plain member got a 403, the web UI swallowed it, and the
   * settings screen listed `deepseek-v4-flash` instead of "Flash". The member
   * route carries the catalogue fields itself now.
   */
  describe('model options', () => {
    const policyPrisma = (policy: { allowedModels: string[]; blocked: boolean } | null) => ({
      memberProxyPolicy: { findUnique: async () => policy },
    });

    it('carries a label for every model the member is allowed', async () => {
      const router = createDesktopAuthRoutes(makeDeps({
        prisma: policyPrisma({ allowedModels: ['deepseek-v4-pro', 'deepseek-v4-flash'], blocked: false }),
      }));

      const result = await callRoute(router, 'GET', '/model-options', {
        locals: { userId: 'user-1', companyId: 'company-1' },
      });

      assert.equal(result.status, 200);
      const models = result.body.data.models as { id: string; label: string }[];
      assert.equal(models.length, 2);
      for (const model of models) {
        assert.ok(model.label.length > 0, `${model.id} has no label`);
        assert.notEqual(model.label, model.id, `${model.id} fell back to its raw id`);
      }
    });

    it('lists only the models the member actually holds', async () => {
      const router = createDesktopAuthRoutes(makeDeps({
        prisma: policyPrisma({ allowedModels: ['deepseek-v4-flash'], blocked: false }),
      }));

      const result = await callRoute(router, 'GET', '/model-options', {
        locals: { userId: 'user-1', companyId: 'company-1' },
      });

      assert.deepEqual(
        (result.body.data.models as { id: string }[]).map(m => m.id),
        ['deepseek-v4-flash'],
      );
    });

    it('never reports pricing to a member', async () => {
      const router = createDesktopAuthRoutes(makeDeps({
        prisma: policyPrisma({ allowedModels: ['deepseek-v4-pro'], blocked: false }),
      }));

      const result = await callRoute(router, 'GET', '/model-options', {
        locals: { userId: 'user-1', companyId: 'company-1' },
      });

      const [model] = result.body.data.models as Record<string, unknown>[];
      assert.deepEqual(Object.keys(model!).sort(), [
        'defaultReasoningEffort',
        'id',
        'label',
        'provider',
        'reasoningEfforts',
        'vision',
      ]);
    });

    it('offers Flash, Pro, and Luna when no policy is stored', async () => {
      const router = createDesktopAuthRoutes(makeDeps({ prisma: policyPrisma(null) }));

      const result = await callRoute(router, 'GET', '/model-options', {
        locals: { userId: 'user-1', companyId: 'company-1' },
      });

      assert.deepEqual(result.body.data.allowedModels, ['deepseek-v4-flash', 'deepseek-v4-pro', 'gpt-5.6-luna']);
      assert.equal((result.body.data.models as { label: string }[])[0]!.label.length > 0, true);
    });
  });
});
