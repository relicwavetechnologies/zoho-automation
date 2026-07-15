/**
 * GoogleOAuthService — unit tests
 *
 * All HTTP calls are mocked via globalThis.fetch override.
 * CachePort is an in-memory double.
 *
 * Env is loaded from .env via dotenv; HTTP is fully mocked so no real API
 * calls are made regardless of what credentials are present.
 */

import 'dotenv/config';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { GoogleOAuthService } from '../../../src/infrastructure/google/google-oauth.service';
import { GOOGLE_SCOPE, GOOGLE_WORKSPACE_OAUTH_SCOPES } from '../../../src/domain/google/google-workspace-scope';
import type { CachePort } from '../../../src/shared/cache';
import { ok } from '../../../src/shared/result';

// ─── Env — loaded from dotenv; fallbacks keep unit tests self-contained ───────

const BASE_ENV: any = {
  ...process.env,
  // Ensure required Google OAuth fields are always present for unit tests
  GOOGLE_OAUTH_CLIENT_ID:     process.env['GOOGLE_OAUTH_CLIENT_ID']     ?? 'unit-test-client-id',
  GOOGLE_OAUTH_CLIENT_SECRET: process.env['GOOGLE_OAUTH_CLIENT_SECRET'] ?? 'unit-test-client-secret',
  GOOGLE_OAUTH_REDIRECT_URI:  process.env['GOOGLE_OAUTH_REDIRECT_URI']  ?? 'https://example.com/callback',
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
    async setNx(key: string, value: unknown) { if (store.has(key)) return ok(false); store.set(key, value); return ok(true); },
    async del(key: string) { store.delete(key); return ok(undefined); },
    async scanDel() { return ok(0); },
  };
}

// ─── Fetch mock helper ────────────────────────────────────────────────────────

function mockFetch(responses: Array<{ status: number; body: unknown }>): typeof fetch {
  let call = 0;
  return async (_url, _init) => {
    const { status, body } = responses[call++ % responses.length]!;
    const bodyStr = JSON.stringify(body);
    return new Response(bodyStr, {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GoogleOAuthService', () => {
  let cache: ReturnType<typeof makeCache>;
  let svc: GoogleOAuthService;

  beforeEach(() => {
    cache = makeCache();
    svc = new GoogleOAuthService({ env: BASE_ENV, cache, logger: nullLogger });
  });

  describe('isConfigured()', () => {
    it('returns true when all credentials present', () => {
      assert.equal(svc.isConfigured(), true);
    });

    it('returns false when clientId missing', () => {
      const s = new GoogleOAuthService({
        env: { ...BASE_ENV, GOOGLE_OAUTH_CLIENT_ID: '' },
        cache,
        logger: nullLogger,
      });
      assert.equal(s.isConfigured(), false);
    });
  });

  describe('getAuthorizeUrl()', () => {
    it('builds correct consent URL', () => {
      const url = svc.getAuthorizeUrl({ state: 'abc123' });
      const clientId = BASE_ENV.GOOGLE_OAUTH_CLIENT_ID as string;
      assert(url.includes('accounts.google.com'));
      assert(url.includes(`client_id=${encodeURIComponent(clientId)}`));
      assert(url.includes('state=abc123'));
      assert(url.includes('access_type=offline'));
      assert(url.includes('response_type=code'));
    });

    it('requests the reviewed complete Workspace scope set from Divo OAuth', () => {
      const url = new URL(svc.getAuthorizeUrl({ state: 'scope-test' }));
      const scopes = new Set((url.searchParams.get('scope') ?? '').split(' '));
      assert.deepEqual(scopes, new Set(GOOGLE_WORKSPACE_OAUTH_SCOPES));
      assert(scopes.has(GOOGLE_SCOPE.sheetsFull));
      assert(scopes.has(GOOGLE_SCOPE.docsFull));
      assert(scopes.has(GOOGLE_SCOPE.slidesFull));
      assert(scopes.has(GOOGLE_SCOPE.formsResponsesReadonly));
      assert(scopes.has(GOOGLE_SCOPE.scriptProjects));
    });

    it('uses provided redirectUri', () => {
      const url = svc.getAuthorizeUrl({ state: 'x', redirectUri: 'https://custom.example.com/cb' });
      assert(url.includes('redirect_uri=https'));
      assert(url.includes('custom.example.com'));
    });
  });

  describe('exchangeAuthorizationCode()', () => {
    it('returns tokens on success', async () => {
      const origFetch = globalThis.fetch;
      try {
        globalThis.fetch = mockFetch([{
          status: 200,
          body: { access_token: 'at-123', refresh_token: 'rt-456', expires_in: 3600, token_type: 'Bearer', scope: 'email profile' },
        }]);
        const tokens = await svc.exchangeAuthorizationCode('auth-code-xyz');
        assert.equal(tokens.accessToken,  'at-123');
        assert.equal(tokens.refreshToken, 'rt-456');
        assert.equal(tokens.expiresIn,    3600);
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it('throws on error response', async () => {
      const origFetch = globalThis.fetch;
      try {
        globalThis.fetch = mockFetch([{ status: 400, body: { error: 'invalid_grant', error_description: 'Code expired' } }]);
        await assert.rejects(
          () => svc.exchangeAuthorizationCode('bad-code'),
          /Code expired/,
        );
      } finally {
        globalThis.fetch = origFetch;
      }
    });
  });

  describe('getValidAccessToken()', () => {
    const opts = { companyId: 'co1', userId: 'u1', refreshToken: 'rt-valid' };

    it('returns cached token when cache is warm', async () => {
      const expiresAtMs = Date.now() + 1_800_000; // 30 min
      await cache.set('google:token:co1:u1', { token: 'cached-at', expiresAtMs });
      const origFetch = globalThis.fetch;
      let fetchCalled = false;
      globalThis.fetch = async () => { fetchCalled = true; return new Response('{}', { status: 200 }); };
      try {
        const token = await svc.getValidAccessToken(opts);
        assert.equal(token, 'cached-at');
        assert.equal(fetchCalled, false);
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it('calls refresh when cache is cold', async () => {
      const origFetch = globalThis.fetch;
      try {
        globalThis.fetch = mockFetch([{
          status: 200,
          body: { access_token: 'fresh-at', expires_in: 3600, token_type: 'Bearer' },
        }]);
        const token = await svc.getValidAccessToken(opts);
        assert.equal(token, 'fresh-at');
        // Token should now be in cache
        const cached = await cache.get<{ token: string }>('google:token:co1:u1');
        assert(cached.ok && cached.value?.token === 'fresh-at');
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it('throws when refresh fails', async () => {
      const origFetch = globalThis.fetch;
      try {
        globalThis.fetch = mockFetch([{ status: 401, body: { error: 'invalid_client' } }]);
        await assert.rejects(() => svc.getValidAccessToken(opts), /invalid_client|token refresh/i);
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it('does not call refresh when cached token is still valid', async () => {
      const expiresAtMs = Date.now() + 600_000; // 10 min — beyond 60 s buffer
      await cache.set('google:token:co1:u1', { token: 'still-valid', expiresAtMs });
      const origFetch = globalThis.fetch;
      let fetchCalled = false;
      globalThis.fetch = async () => { fetchCalled = true; return new Response('{}', { status: 200 }); };
      try {
        const token = await svc.getValidAccessToken(opts);
        assert.equal(token, 'still-valid');
        assert.equal(fetchCalled, false);
      } finally {
        globalThis.fetch = origFetch;
      }
    });
  });

  describe('fetchUserInfo()', () => {
    it('returns sub, email, name on success', async () => {
      const origFetch = globalThis.fetch;
      try {
        globalThis.fetch = mockFetch([{ status: 200, body: { sub: 'uid-123', email: 'user@example.com', name: 'Test User' } }]);
        const info = await svc.fetchUserInfo('at-xyz');
        assert.equal(info.sub, 'uid-123');
        assert.equal(info.email, 'user@example.com');
        assert.equal(info.name, 'Test User');
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it('throws when sub is missing', async () => {
      const origFetch = globalThis.fetch;
      try {
        globalThis.fetch = mockFetch([{ status: 200, body: { email: 'no-sub@example.com' } }]);
        await assert.rejects(() => svc.fetchUserInfo('at-xyz'), /sub/i);
      } finally {
        globalThis.fetch = origFetch;
      }
    });
  });
});
