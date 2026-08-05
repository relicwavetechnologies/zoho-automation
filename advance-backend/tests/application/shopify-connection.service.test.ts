import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ShopifyConnectionError, ShopifyConnectionService } from '../../src/application/shopify/shopify-connection.service';
import { ok } from '../../src/shared/result';

const baseConnection = {
  id: '11111111-1111-4111-8111-111111111111',
  companyId: 'company-1',
  provider: 'shopify',
  ownerType: 'user',
  ownerUserId: 'user-1',
  label: 'Test Store',
  accountName: 'Test Store',
  externalAccountId: 'test-store.myshopify.com',
  status: 'connected',
  scopes: ['read_reports', 'read_orders', 'read_customers'],
  accessToken: 'access-v1',
  refreshToken: 'refresh-v1',
  tokenType: 'offline',
  accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
  refreshTokenExpiresAt: new Date(Date.now() + 86_400_000),
  tokenVersion: 0,
  tokenMetadata: { apiVersion: '2026-07' },
  connectedAt: new Date(),
} as const;

describe('ShopifyConnectionService', () => {
  it('fails closed when the requested store is not accessible to the member', async () => {
    const service = buildService({ find: null });

    await assert.rejects(
      service.resolve(resolveInput()),
      (error: unknown) => error instanceof ShopifyConnectionError && error.code === 'inaccessible',
    );
  });

  it('enforces provider scopes after connection-level access is resolved', async () => {
    const service = buildService({ find: { ...baseConnection, scopes: ['read_reports'] } });

    await assert.rejects(
      service.resolve(resolveInput({ requiredScopes: ['read_customers'] })),
      (error: unknown) => error instanceof ShopifyConnectionError && error.code === 'missing_scope',
    );
  });

  it('single-flights rotating refresh tokens and reloads the CAS winner', async () => {
    const expired = { ...baseConnection, accessTokenExpiresAt: new Date(Date.now() - 1_000) };
    const winner = {
      ...baseConnection,
      accessToken: 'access-v2',
      refreshToken: 'refresh-v2',
      tokenVersion: 1,
    };
    let finds = 0;
    let refreshes = 0;
    let swaps = 0;
    const repository = {
      findAccessibleShopifyConnection: async () => ok(++finds <= 2 ? expired : winner),
      compareAndSwapShopifyTokens: async (input: Record<string, unknown>) => {
        swaps += 1;
        assert.equal(input['expectedTokenVersion'], 0);
        assert.equal(input['refreshToken'], 'refresh-v2');
        return ok(true);
      },
      acquireShopifyRefreshLease: async () => ok(true),
      releaseShopifyRefreshLease: async () => ok(undefined),
      markShopifyReauthorizationRequired: async () => ok(undefined),
      touchLastUsed: async () => ok(undefined),
    };
    const oauth = {
      refresh: async (input: Record<string, unknown>) => {
        refreshes += 1;
        assert.equal(input['refreshToken'], 'refresh-v1');
        await new Promise(resolve => setTimeout(resolve, 10));
        return {
          accessToken: 'access-v2',
          refreshToken: 'refresh-v2',
          scopes: [...baseConnection.scopes],
          accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
          refreshTokenExpiresAt: new Date(Date.now() + 86_400_000),
        };
      },
    };
    const service = new ShopifyConnectionService({
      repository: repository as never,
      oauth: oauth as never,
    });

    const [first, second] = await Promise.all([
      service.resolve(resolveInput()),
      service.resolve(resolveInput()),
    ]);

    assert.equal(refreshes, 1);
    assert.equal(swaps, 1);
    assert.equal(first.accessToken, 'access-v2');
    assert.equal(second.accessToken, 'access-v2');
  });

  it('reloads a concurrent process winner when its own token CAS loses', async () => {
    const expired = { ...baseConnection, accessTokenExpiresAt: new Date(Date.now() - 1_000) };
    const winner = { ...baseConnection, accessToken: 'winner-token', tokenVersion: 1 };
    let finds = 0;
    const service = new ShopifyConnectionService({
      repository: {
        findAccessibleShopifyConnection: async () => ok(++finds === 1 ? expired : winner),
        compareAndSwapShopifyTokens: async () => ok(false),
        acquireShopifyRefreshLease: async () => ok(true),
        releaseShopifyRefreshLease: async () => ok(undefined),
        markShopifyReauthorizationRequired: async () => ok(undefined),
      } as never,
      oauth: {
        refresh: async () => ({
          accessToken: 'loser-token',
          refreshToken: 'loser-refresh',
          scopes: [...baseConnection.scopes],
          accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
          refreshTokenExpiresAt: new Date(Date.now() + 86_400_000),
        }),
      } as never,
    });

    const resolved = await service.resolve(resolveInput());
    assert.equal(resolved.accessToken, 'winner-token');
  });

  it('uses the durable lease to prevent refresh calls across backend instances', async () => {
    const expired = { ...baseConnection, accessTokenExpiresAt: new Date(Date.now() - 1_000) };
    let current = expired;
    let leaseHeld = false;
    let refreshes = 0;
    const repository = {
      findAccessibleShopifyConnection: async () => ok(current),
      acquireShopifyRefreshLease: async () => {
        if (leaseHeld) return ok(false);
        leaseHeld = true;
        return ok(true);
      },
      releaseShopifyRefreshLease: async () => { leaseHeld = false; return ok(undefined); },
      markShopifyReauthorizationRequired: async () => ok(undefined),
      compareAndSwapShopifyTokens: async () => {
        current = { ...expired, accessToken: 'shared-winner', tokenVersion: 1, accessTokenExpiresAt: new Date(Date.now() + 3_600_000) };
        return ok(true);
      },
    };
    const oauth = {
      refresh: async () => {
        refreshes += 1;
        await new Promise(resolve => setTimeout(resolve, 25));
        return {
          accessToken: 'shared-winner',
          refreshToken: 'shared-refresh',
          scopes: [...baseConnection.scopes],
          accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
          refreshTokenExpiresAt: new Date(Date.now() + 86_400_000),
        };
      },
    };
    const first = new ShopifyConnectionService({ repository: repository as never, oauth: oauth as never });
    const second = new ShopifyConnectionService({ repository: repository as never, oauth: oauth as never });

    const [left, right] = await Promise.all([first.resolve(resolveInput()), second.resolve(resolveInput())]);

    assert.equal(refreshes, 1);
    assert.equal(left.accessToken, 'shared-winner');
    assert.equal(right.accessToken, 'shared-winner');
  });

  it('takes over an expired durable lease after the original process disappears', async () => {
    let nowMs = Date.now();
    const initialNow = nowMs;
    let current = { ...baseConnection, accessTokenExpiresAt: new Date(initialNow - 1_000) };
    let refreshes = 0;
    const repository = {
      findAccessibleShopifyConnection: async () => ok(current),
      acquireShopifyRefreshLease: async () => ok(nowMs >= initialNow + 20),
      releaseShopifyRefreshLease: async () => ok(undefined),
      markShopifyReauthorizationRequired: async () => ok(undefined),
      compareAndSwapShopifyTokens: async () => {
        current = { ...current, accessToken: 'takeover-token', tokenVersion: 1, accessTokenExpiresAt: new Date(nowMs + 3_600_000) };
        return ok(true);
      },
    };
    const service = new ShopifyConnectionService({
      repository: repository as never,
      oauth: {
        refresh: async () => {
          refreshes += 1;
          return {
            accessToken: 'takeover-token', refreshToken: 'takeover-refresh', scopes: [...baseConnection.scopes],
            accessTokenExpiresAt: new Date(nowMs + 3_600_000), refreshTokenExpiresAt: new Date(nowMs + 86_400_000),
          };
        },
      } as never,
      refreshLeaseMs: 20,
      refreshPollMs: 5,
      nowMs: () => nowMs,
      wait: async ms => { nowMs += ms; },
    });

    const resolved = await service.resolve(resolveInput());
    assert.equal(resolved.accessToken, 'takeover-token');
    assert.equal(refreshes, 1);
  });

  it('requires reconnect instead of using an expired refresh authorization', async () => {
    const service = buildService({
      find: {
        ...baseConnection,
        accessTokenExpiresAt: new Date(Date.now() - 1_000),
        refreshTokenExpiresAt: new Date(Date.now() - 1_000),
      },
    });

    await assert.rejects(
      service.resolve(resolveInput()),
      (error: unknown) => error instanceof ShopifyConnectionError && error.code === 'authorization_required',
    );
  });
});

function resolveInput(overrides: Partial<{
  companyId: string;
  userId: string;
  connectionId: string;
  requiredScopes: readonly string[];
}> = {}) {
  return {
    companyId: 'company-1',
    userId: 'user-1',
    connectionId: baseConnection.id,
    requiredScopes: ['read_reports'],
    ...overrides,
  };
}

function buildService(input: { find: typeof baseConnection | Record<string, unknown> | null }) {
  return new ShopifyConnectionService({
    repository: {
      findAccessibleShopifyConnection: async () => ok(input.find),
      touchLastUsed: async () => ok(undefined),
    } as never,
    oauth: { refresh: async () => { throw new Error('unexpected refresh'); } } as never,
  });
}
