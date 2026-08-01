import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';

import { createDesktopAuthRoutes } from '../../src/http/desktop/desktop-auth.routes.ts';
import { LARK_USER_OAUTH_SCOPES, LarkOAuthService } from '../../src/infrastructure/lark/lark-oauth.service.ts';
import { ZohoTokenService } from '../../src/infrastructure/zoho/zoho-token.service.ts';

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
    canvaMcpOAuthService: {} as any,
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
    sessionTtlMinutes: 480,
    ...overrides,
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
    assert.deepEqual(revoked, [{ companyId: 'company-1', connectionId: 'canva-1', provider: 'canva' }]);
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
          return { ok: true, value: {} };
        },
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

    const callback = await callRoute(router, 'GET', '/google/callback', {
      query: { code: 'google-code', state },
    });

    assert.equal(callback.status, 200);
    assert.equal(exchangedRedirectUri, authorizeRedirectUri);
    assert.equal(storedConnection?.['scope'], 'openid https://www.googleapis.com/auth/spreadsheets');
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
        company: { findFirst: async () => ({ id: 'company-1' }) },
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
        findLarkConnectionOwner: async () => ({ ok: true, value: null }),
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
        company: { findFirst: async () => ({ id: 'company-1' }) },
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
    assert.deepEqual(result.body.data, {
      departmentId: '5d649f61-d5ea-4fd6-a52e-7166c33fb1cd',
      departmentName: 'Finance',
      personaPrompt: 'Prefer verified records.',
      version: '2026-07-11T10:00:00.000Z',
      personalMemory: [],
    });
  });

  it('returns a bounded backend personal snapshot without requiring a selected department', async () => {
    const calls: unknown[] = [];
    const router = createDesktopAuthRoutes(makeDeps({
      memory: {
        getPersonalSnapshot: async (input: unknown) => {
          calls.push(input);
          return ['User prefers concise weekly summaries.'];
        },
      },
    }));
    const result = await callRoute(router, 'GET', '/runtime-context', {
      locals: { userId: 'user-1', companyId: 'company-1' },
    });

    assert.equal(result.status, 200);
    assert.deepEqual(result.body.data, {
      departmentId: null,
      departmentName: null,
      personaPrompt: '',
      version: null,
      personalMemory: ['User prefers concise weekly summaries.'],
    });
    assert.deepEqual(calls, [{
      userId: 'user-1',
      companyId: 'company-1',
      limit: 12,
      maxFactChars: 500,
      maxTotalChars: 2_200,
    }]);
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
      personalMemory: [],
    });
  });
});
