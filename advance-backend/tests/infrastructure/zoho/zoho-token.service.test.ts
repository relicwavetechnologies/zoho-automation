/**
 * ZohoTokenService — unit tests
 *
 * All HTTP calls are mocked via globalThis.fetch override.
 * CachePort is an in-memory double.
 * ZohoConnectionRepository is a hand-written stub.
 *
 * Env is loaded from .env via dotenv; HTTP is fully mocked so no real API
 * calls are made regardless of what credentials are present.
 */

import 'dotenv/config';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ZohoTokenService } from '../../../src/infrastructure/zoho/zoho-token.service';
import type { ZohoConnectionRepository, ActiveZohoConnection } from '../../../src/infrastructure/zoho/zoho-connection.repository';
import type { CachePort } from '../../../src/shared/cache';
import { ok } from '../../../src/shared/result';

// ─── Env — loaded from dotenv; fallbacks keep unit tests self-contained ───────

const BASE_ENV: any = {
  ...process.env,
  // Ensure required Zoho fields are always populated for unit tests
  ZOHO_CLIENT_ID:         process.env['ZOHO_CLIENT_ID']         ?? 'unit-test-client-id',
  ZOHO_CLIENT_SECRET:     process.env['ZOHO_CLIENT_SECRET']     ?? 'unit-test-client-secret',
  ZOHO_ACCOUNTS_BASE_URL: process.env['ZOHO_ACCOUNTS_BASE_URL'] ?? 'https://accounts.zoho.com',
  ZOHO_API_BASE_URL:      process.env['ZOHO_API_BASE_URL']      ?? 'https://www.zohoapis.com',
};

// ─── Logger stub ──────────────────────────────────────────────────────────────

const nullLogger = {
  child: () => nullLogger,
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
} as any;

// ─── In-memory cache ──────────────────────────────────────────────────────────

function makeCache(): CachePort & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  return {
    store,
    async get<T>(key: string) { return ok(store.has(key) ? (store.get(key) as T) : null); },
    async set<T>(key: string, value: T) { store.set(key, value); return ok(undefined); },
    async del(key: string) { store.delete(key); return ok(undefined); },
    async scanDel() { return ok(0); },
  };
}

// ─── Connection repository stub ───────────────────────────────────────────────

interface MockRepo {
  repo: ZohoConnectionRepository;
  connections: Map<string, ActiveZohoConnection | null>;
  updateTokensCalls: Array<Parameters<ZohoConnectionRepository['updateTokens']>[0]>;
  setFailureCalls: Array<{ companyId: string; environment: string; code: string }>;
}

function makeRepo(
  defaultConn: ActiveZohoConnection | null = null,
): MockRepo {
  const connections = new Map<string, ActiveZohoConnection | null>();
  connections.set('default', defaultConn);
  const updateTokensCalls: MockRepo['updateTokensCalls'] = [];
  const setFailureCalls:   MockRepo['setFailureCalls']   = [];

  const repo: ZohoConnectionRepository = {
    async findActive(companyId, environment = 'prod') {
      const key = `${companyId}:${environment}`;
      const conn = connections.has(key) ? connections.get(key)! : connections.get('default')!;
      return ok(conn);
    },
    async updateTokens(opts) {
      updateTokensCalls.push(opts);
      return ok(undefined);
    },
    async setFailureCode(companyId, environment, code) {
      setFailureCalls.push({ companyId, environment, code });
    },
  } as unknown as ZohoConnectionRepository;

  return { repo, connections, updateTokensCalls, setFailureCalls };
}

// ─── Fetch mock helper ────────────────────────────────────────────────────────

function mockFetch(responses: Array<{ status: number; body: unknown }>): typeof fetch {
  let call = 0;
  return async (_url, _init) => {
    const { status, body } = responses[call++ % responses.length]!;
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

// ─── Sample connections ───────────────────────────────────────────────────────

function validConnection(overrides: Partial<ActiveZohoConnection> = {}): ActiveZohoConnection {
  return {
    id:          'conn-1',
    companyId:   'co1',
    environment: 'prod',
    scopes:      ['ZohoCRM.modules.ALL', 'ZohoBooks.fullaccess.all'],
    accessToken:          'valid-access-token',
    refreshToken:         'valid-refresh-token',
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000), // 1 hour from now
    ...overrides,
  };
}

function expiredConnection(overrides: Partial<ActiveZohoConnection> = {}): ActiveZohoConnection {
  return {
    id:          'conn-1',
    companyId:   'co1',
    environment: 'prod',
    scopes:      ['ZohoCRM.modules.ALL'],
    accessToken:          'expired-access-token',
    refreshToken:         'valid-refresh-token',
    accessTokenExpiresAt: new Date(Date.now() - 60_000), // 1 min ago (expired)
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ZohoTokenService', () => {
  let cache: ReturnType<typeof makeCache>;

  beforeEach(() => {
    cache = makeCache();
  });

  // ── isConfigured ─────────────────────────────────────────────────────────

  describe('isConfigured()', () => {
    it('returns true when ZOHO_CLIENT_ID and ZOHO_CLIENT_SECRET are set', () => {
      const { repo } = makeRepo();
      const svc = new ZohoTokenService(repo, cache, BASE_ENV, nullLogger);
      assert.equal(svc.isConfigured(), true);
    });

    it('returns false when ZOHO_CLIENT_ID is missing', () => {
      const { repo } = makeRepo();
      const svc = new ZohoTokenService(repo, cache, { ...BASE_ENV, ZOHO_CLIENT_ID: '' }, nullLogger);
      assert.equal(svc.isConfigured(), false);
    });

    it('returns false when ZOHO_CLIENT_SECRET is missing', () => {
      const { repo } = makeRepo();
      const svc = new ZohoTokenService(repo, cache, { ...BASE_ENV, ZOHO_CLIENT_SECRET: undefined }, nullLogger);
      assert.equal(svc.isConfigured(), false);
    });
  });

  // ── In-memory cache hit ───────────────────────────────────────────────────

  describe('getValidToken() — in-memory cache', () => {
    it('returns from in-memory on second call without hitting Redis or DB', async () => {
      // Seed Redis so the first call populates memCache
      const expiresAtMs = Date.now() + 3_600_000;
      await cache.set('zoho:token:co1:prod', { token: 'mem-cache-token', expiresAtMs });

      const mock = makeRepo();
      let repoCalls = 0;
      const origFindActive = mock.repo.findActive.bind(mock.repo);
      (mock.repo as any).findActive = async (...args: Parameters<typeof origFindActive>) => {
        repoCalls++;
        return origFindActive(...args);
      };
      const svc = new ZohoTokenService(mock.repo, cache, BASE_ENV, nullLogger);

      // First call → hits Redis, populates memCache
      const t1 = await svc.getValidToken('co1');
      assert.equal(t1, 'mem-cache-token');

      // Clear Redis so any second Redis hit would return nothing
      await cache.del('zoho:token:co1:prod');

      // Second call → must hit memCache, not Redis or DB
      const t2 = await svc.getValidToken('co1');
      assert.equal(t2, 'mem-cache-token');
      assert.equal(repoCalls, 0, 'DB should not be queried when memCache is warm');
    });
  });

  // ── Redis cache hit ───────────────────────────────────────────────────────

  describe('getValidToken() — Redis cache', () => {
    it('returns token from Redis without hitting DB or fetch', async () => {
      const expiresAtMs = Date.now() + 3_600_000;
      await cache.set('zoho:token:co1:prod', { token: 'redis-token', expiresAtMs });

      const mock = makeRepo(null); // No DB connection
      let repoCalls = 0;
      const origFindActive = mock.repo.findActive.bind(mock.repo);
      (mock.repo as any).findActive = async (...args: Parameters<typeof origFindActive>) => {
        repoCalls++;
        return origFindActive(...args);
      };

      const origFetch = globalThis.fetch;
      let fetchCalled = false;
      globalThis.fetch = async () => { fetchCalled = true; return new Response('{}', { status: 200 }); };
      try {
        const svc = new ZohoTokenService(mock.repo, cache, BASE_ENV, nullLogger);
        const token = await svc.getValidToken('co1');
        assert.equal(token, 'redis-token');
        assert.equal(repoCalls, 0,    'DB should not be queried when Redis cache is warm');
        assert.equal(fetchCalled, false, 'fetch should not be called when Redis cache is warm');
      } finally {
        globalThis.fetch = origFetch;
      }
    });
  });

  // ── DB token still valid (no refresh) ─────────────────────────────────────

  describe('getValidToken() — DB token still valid', () => {
    it('returns stored access token when it has not expired', async () => {
      const conn = validConnection(); // accessTokenExpiresAt is 1 hour from now
      const mock = makeRepo(conn);
      const origFetch = globalThis.fetch;
      let fetchCalled = false;
      globalThis.fetch = async () => { fetchCalled = true; return new Response('{}', { status: 200 }); };
      try {
        const svc = new ZohoTokenService(mock.repo, cache, BASE_ENV, nullLogger);
        const token = await svc.getValidToken('co1');
        assert.equal(token, 'valid-access-token');
        assert.equal(fetchCalled, false, 'fetch should not be called for valid DB token');
        assert.equal(mock.updateTokensCalls.length, 0, 'updateTokens should not be called');
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it('caches the DB token in Redis and memCache', async () => {
      const conn = validConnection();
      const mock = makeRepo(conn);
      const svc = new ZohoTokenService(mock.repo, cache, BASE_ENV, nullLogger);
      await svc.getValidToken('co1');

      const redisEntry = await cache.get<{ token: string }>('zoho:token:co1:prod');
      assert(redisEntry.ok && redisEntry.value?.token === 'valid-access-token', 'Redis should be populated after DB token hit');
    });
  });

  // ── Token refresh success ─────────────────────────────────────────────────

  describe('getValidToken() — token refresh', () => {
    it('calls Zoho refresh endpoint when token is expired and returns new token', async () => {
      const conn = expiredConnection(); // accessTokenExpiresAt is in the past
      const mock = makeRepo(conn);
      const origFetch = globalThis.fetch;
      try {
        globalThis.fetch = mockFetch([{
          status: 200,
          body: { access_token: 'fresh-token', expires_in: 3600, token_type: 'Bearer', scope: 'ZohoCRM.modules.ALL' },
        }]);
        const svc = new ZohoTokenService(mock.repo, cache, BASE_ENV, nullLogger);
        const token = await svc.getValidToken('co1');
        assert.equal(token, 'fresh-token');
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it('writes the refreshed token to DB via updateTokens', async () => {
      const conn = expiredConnection();
      const mock = makeRepo(conn);
      const origFetch = globalThis.fetch;
      try {
        globalThis.fetch = mockFetch([{
          status: 200,
          body: { access_token: 'fresh-token', expires_in: 3600 },
        }]);
        const svc = new ZohoTokenService(mock.repo, cache, BASE_ENV, nullLogger);
        await svc.getValidToken('co1');
        assert.equal(mock.updateTokensCalls.length, 1, 'updateTokens must be called exactly once');
        assert.equal(mock.updateTokensCalls[0]!.accessToken, 'fresh-token');
        assert.equal(mock.updateTokensCalls[0]!.companyId, 'co1');
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it('populates Redis cache after refresh', async () => {
      const conn = expiredConnection();
      const mock = makeRepo(conn);
      const origFetch = globalThis.fetch;
      try {
        globalThis.fetch = mockFetch([{
          status: 200,
          body: { access_token: 'fresh-token', expires_in: 3600 },
        }]);
        const svc = new ZohoTokenService(mock.repo, cache, BASE_ENV, nullLogger);
        await svc.getValidToken('co1');
        const cached = await cache.get<{ token: string }>('zoho:token:co1:prod');
        assert(cached.ok && cached.value?.token === 'fresh-token', 'Redis should contain the refreshed token');
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it('stores new refresh_token if returned by Zoho', async () => {
      const conn = expiredConnection();
      const mock = makeRepo(conn);
      const origFetch = globalThis.fetch;
      try {
        globalThis.fetch = mockFetch([{
          status: 200,
          body: { access_token: 'fresh-token', refresh_token: 'new-refresh-token', expires_in: 3600 },
        }]);
        const svc = new ZohoTokenService(mock.repo, cache, BASE_ENV, nullLogger);
        await svc.getValidToken('co1');
        const call = mock.updateTokensCalls[0]!;
        assert.equal(call.refreshToken, 'new-refresh-token');
      } finally {
        globalThis.fetch = origFetch;
      }
    });
  });

  // ── Refresh failure ───────────────────────────────────────────────────────

  describe('getValidToken() — refresh failure', () => {
    it('throws and records failure code when refresh returns 401', async () => {
      const conn = expiredConnection();
      const mock = makeRepo(conn);
      const origFetch = globalThis.fetch;
      try {
        globalThis.fetch = mockFetch([{
          status: 401,
          body: { error: 'invalid_client', error_description: 'Client credentials are invalid' },
        }]);
        const svc = new ZohoTokenService(mock.repo, cache, BASE_ENV, nullLogger);
        await assert.rejects(
          () => svc.getValidToken('co1'),
          /Client credentials are invalid|invalid_client|Zoho token refresh/i,
        );
        assert.equal(mock.setFailureCalls.length, 1, 'setFailureCode must be called on refresh failure');
        assert.equal(mock.setFailureCalls[0]!.companyId, 'co1');
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it('throws when no active connection found', async () => {
      const mock = makeRepo(null); // No connection in DB
      const svc = new ZohoTokenService(mock.repo, cache, BASE_ENV, nullLogger);
      await assert.rejects(
        () => svc.getValidToken('co-none'),
        /No active Zoho connection|connection/i,
      );
    });

    it('throws when connection has no refresh token', async () => {
      const conn = expiredConnection({ refreshToken: undefined });
      const mock = makeRepo(conn);
      const svc = new ZohoTokenService(mock.repo, cache, BASE_ENV, nullLogger);
      await assert.rejects(
        () => svc.getValidToken('co1'),
        /refresh token|no refresh/i,
      );
    });
  });

  // ── In-flight deduplication ───────────────────────────────────────────────

  describe('getValidToken() — in-flight deduplication', () => {
    it('issues only one fetch when concurrent calls race', async () => {
      const conn = expiredConnection();
      const mock = makeRepo(conn);
      const origFetch = globalThis.fetch;
      let fetchCallCount = 0;
      globalThis.fetch = async (url, init) => {
        fetchCallCount++;
        return new Response(JSON.stringify({ access_token: 'deduped-token', expires_in: 3600 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };
      try {
        const svc = new ZohoTokenService(mock.repo, cache, BASE_ENV, nullLogger);
        // Fire three concurrent calls — all should share the same in-flight promise
        const [t1, t2, t3] = await Promise.all([
          svc.getValidToken('co1'),
          svc.getValidToken('co1'),
          svc.getValidToken('co1'),
        ]);
        assert.equal(t1, 'deduped-token');
        assert.equal(t2, 'deduped-token');
        assert.equal(t3, 'deduped-token');
        // The DB is queried once per call (before the in-flight check) but fetch only once
        assert.equal(fetchCallCount, 1, 'Zoho refresh endpoint should be hit only once, not once per caller');
      } finally {
        globalThis.fetch = origFetch;
      }
    });
  });

  // ── exchangeAuthorizationCode ─────────────────────────────────────────────

  describe('exchangeAuthorizationCode()', () => {
    it('returns accessToken, expiresIn, and scopes on success', async () => {
      const { repo } = makeRepo();
      const svc = new ZohoTokenService(repo, cache, BASE_ENV, nullLogger);
      const origFetch = globalThis.fetch;
      try {
        globalThis.fetch = mockFetch([{
          status: 200,
          body: {
            access_token:  'new-at',
            refresh_token: 'new-rt',
            expires_in:    3600,
            scope:         'ZohoCRM.modules.ALL ZohoBooks.fullaccess.all',
            token_type:    'Bearer',
          },
        }]);
        const result = await svc.exchangeAuthorizationCode({
          companyId:         'co1',
          environment:       'prod',
          authorizationCode: 'auth-code-123',
        });
        assert.equal(result.accessToken,  'new-at');
        assert.equal(result.refreshToken, 'new-rt');
        assert.equal(result.expiresIn,    3600);
        assert.deepEqual(result.scopes, ['ZohoCRM.modules.ALL', 'ZohoBooks.fullaccess.all']);
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it('throws when Zoho returns an error', async () => {
      const { repo } = makeRepo();
      const svc = new ZohoTokenService(repo, cache, BASE_ENV, nullLogger);
      const origFetch = globalThis.fetch;
      try {
        globalThis.fetch = mockFetch([{
          status: 400,
          body: { error: 'invalid_code', error_description: 'Authorization code has expired' },
        }]);
        await assert.rejects(
          () => svc.exchangeAuthorizationCode({ companyId: 'co1', environment: 'prod', authorizationCode: 'stale-code' }),
          /Authorization code has expired|invalid_code/i,
        );
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it('throws when credentials are not configured', async () => {
      const { repo } = makeRepo();
      const svc = new ZohoTokenService(repo, cache, { ...BASE_ENV, ZOHO_CLIENT_ID: '' }, nullLogger);
      await assert.rejects(
        () => svc.exchangeAuthorizationCode({ companyId: 'co1', environment: 'prod', authorizationCode: 'code' }),
        /credentials not configured/i,
      );
    });

    it('handles numeric string expires_in from Zoho', async () => {
      const { repo } = makeRepo();
      const svc = new ZohoTokenService(repo, cache, BASE_ENV, nullLogger);
      const origFetch = globalThis.fetch;
      try {
        globalThis.fetch = mockFetch([{
          status: 200,
          body: { access_token: 'at', expires_in: '7200', scope: 'ZohoCRM.modules.ALL' },
        }]);
        const result = await svc.exchangeAuthorizationCode({
          companyId: 'co1', environment: 'prod', authorizationCode: 'code',
        });
        assert.equal(result.expiresIn, 7200, 'expires_in as string should be coerced to number');
      } finally {
        globalThis.fetch = origFetch;
      }
    });
  });
});
