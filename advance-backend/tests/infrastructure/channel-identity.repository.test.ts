import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ChannelIdentityRepository } from '../../src/infrastructure/persistence/channel-identity.repository';
import type { CachePort } from '../../src/shared/cache.ts';
import { ok, err } from '../../src/shared/result.ts';
import type { ResolvedUserIdentity } from '../../src/infrastructure/persistence/channel-identity.repository.ts';

function makeDb(overrides: Record<string, unknown>) {
  const db: Record<string, any> = {
    channelIdentity: {
      findFirst: async () => null,
    },
    larkTenantBinding: {
      findFirst: async ({ where }: any) => where.larkTenantKey
        ? { companyId: `company-${where.larkTenantKey}` }
        : null,
    },
    integrationConnection: {
      findFirst: async () => null,
      findMany: async () => [],
    },
    userDepartmentPreference: {
      findUnique: async () => null,
    },
    user: {
      findUnique: async () => null,
      create: async () => ({ id: 'created-user' }),
    },
    adminMembership: {
      findFirst: async () => ({ role: 'MEMBER' }),
      create: async (input: any) => ({ role: input.data.role }),
    },
    ...overrides,
  };
  db['$transaction'] = async (fn: (tx: unknown) => Promise<unknown>) => fn(db);
  return db;
}

// ── Cache helpers ──────────────────────────────────────────────────────────────

const OPEN_ID = 'ou_cache_test';
const CACHE_KEY = `lark:id:v2:${OPEN_ID}`;
const TENANT_CACHE_KEY = `lark:id:v3:tenant-1:${OPEN_ID}`;

const resolvedIdentity: ResolvedUserIdentity = {
  userId: 'user-1',
  companyId: 'company-1',
  aiRole: 'MEMBER',
  channel: 'lark',
  larkOpenId: OPEN_ID,
};

function makeIdentityDb(overrides: Record<string, unknown> = {}) {
  return {
    channelIdentity: {
      findFirst: async () => ({
        id: 'ci-1',
        aiRole: 'MEMBER',
        channel: 'lark',
        companyId: 'company-1',
      }),
    },
    larkTenantBinding: {
      findFirst: async ({ where }: any) => where.larkTenantKey
        ? { companyId: `company-${where.larkTenantKey}` }
        : null,
    },
    integrationConnection: {
      findFirst: async () => ({ ownerUserId: 'user-1' }),
      findMany: async () => [{ ownerUserId: 'user-1', ownerUser: { email: 'user@example.com' } }],
    },
    userDepartmentPreference: {
      findUnique: async () => null,
    },
    user: {
      findUnique: async () => null,
      create: async () => ({ id: 'created-user' }),
    },
    adminMembership: {
      findFirst: async () => ({ role: 'MEMBER' }),
      create: async (input: any) => ({ role: input.data.role }),
    },
    ...overrides,
  };
}

function makeCache(store = new Map<string, unknown>()): CachePort & {
  store: Map<string, unknown>;
  delCalls: string[];
  scanDelCalls: string[];
} {
  const delCalls: string[] = [];
  const scanDelCalls: string[] = [];
  return {
    store,
    delCalls,
    scanDelCalls,
    get: async (k) => ok(store.has(k) ? (store.get(k) as any) : null),
    set: async (k, v) => { store.set(k, v); return ok(undefined); },
    setNx: async (k, v) => { if (store.has(k)) return ok(false); store.set(k, v); return ok(true); },
    del: async (k) => { delCalls.push(k); store.delete(k); return ok(undefined); },
    scanDel: async (pattern) => { scanDelCalls.push(pattern); return ok(0); },
  };
}

function makeFailingCache(): CachePort {
  return {
    get: async () => err({ kind: 'infra', source: 'redis', operation: 'get', cause: new Error('redis down') } as any),
    set: async () => err({ kind: 'infra', source: 'redis', operation: 'set', cause: new Error('redis down') } as any),
    setNx: async () => err({ kind: 'infra', source: 'redis', operation: 'setNx', cause: new Error('redis down') } as any),
    del: async () => err({ kind: 'infra', source: 'redis', operation: 'del', cause: new Error('redis down') } as any),
    scanDel: async () => err({ kind: 'infra', source: 'redis', operation: 'scanDel', cause: new Error('redis down') } as any),
  };
}

describe('ChannelIdentityRepository.resolveByUserId', () => {
  it('resolves an internal member without requiring a Lark connection', async () => {
    const repo = new ChannelIdentityRepository(makeDb({
      integrationConnection: {
        findFirst: async ({ where }: any) => {
          assert.equal(where.companyId, 'company-1');
          assert.equal(where.ownerUserId, 'user-1');
          return null;
        },
      },
      adminMembership: {
        findFirst: async ({ where }: any) => {
          assert.deepEqual(
            { userId: where.userId, companyId: where.companyId, isActive: where.isActive },
            { userId: 'user-1', companyId: 'company-1', isActive: true },
          );
          return { role: 'MEMBER' };
        },
      },
    }) as any);

    const result = await repo.resolveByUserId('user-1', 'company-1');

    assert.equal(result.ok, true);
    assert.deepEqual(result.ok ? result.value : undefined, {
      userId: 'user-1',
      companyId: 'company-1',
      aiRole: 'MEMBER',
      channel: 'internal',
    });
  });

  it('fails closed when the user is not active in the requested company', async () => {
    let connectionQueried = false;
    const repo = new ChannelIdentityRepository(makeDb({
      adminMembership: { findFirst: async () => null },
      integrationConnection: {
        findFirst: async () => {
          connectionQueried = true;
          return { externalAccountId: 'ou_other' };
        },
      },
    }) as any);

    const result = await repo.resolveByUserId('user-1', 'company-2');

    assert.equal(result.ok, true);
    assert.equal(result.ok ? result.value : undefined, null);
    assert.equal(connectionQueried, false);
  });
});

// ── Cache tests for resolveByLarkOpenId ────────────────────────────────────────

describe('ChannelIdentityRepository.resolveByLarkOpenId (cache)', () => {
  it('cache miss: resolves the canonical Lark connection and populates cache', async () => {
    let ciFindCalls = 0, connectionCalls = 0, deptPrefCalls = 0;
    const db = makeIdentityDb({
      channelIdentity: { findFirst: async () => { ciFindCalls++; return { id: 'ci-1', aiRole: 'MEMBER', channel: 'lark', companyId: 'company-1' }; } },
      integrationConnection: { findMany: async () => { connectionCalls++; return [{ ownerUserId: 'user-1', ownerUser: { email: 'user@example.com' } }]; } },
      userDepartmentPreference: { findUnique: async () => { deptPrefCalls++; return null; } },
    });
    const cache = makeCache();
    const repo = new ChannelIdentityRepository(db as any, cache);

    const result = await repo.resolveByLarkOpenId(OPEN_ID);
    await new Promise(r => setImmediate(r));

    assert.ok(result.ok);
    assert.ok(result.value !== null);
    assert.equal(ciFindCalls, 1, 'channelIdentity.findFirst must be called once');
    assert.equal(connectionCalls, 1, 'integrationConnection.findMany must be called once');
    assert.equal(deptPrefCalls, 1, 'userDepartmentPreference.findUnique must be called once');
    assert.ok(cache.store.has(CACHE_KEY), 'resolved identity should be cached');
  });

  it('prefers the connection owner whose Divo email matches the Lark identity', async () => {
    let membershipUserId: string | undefined;
    const db = makeIdentityDb({
      channelIdentity: {
        findFirst: async () => ({
          id: 'ci-1',
          aiRole: 'MEMBER',
          channel: 'lark',
          companyId: 'company-1',
          email: 'admin@example.com',
        }),
      },
      integrationConnection: {
        findMany: async () => [
          { ownerUserId: 'legacy-user', ownerUser: { email: 'lark-placeholder@identity.divo.invalid' } },
          { ownerUserId: 'admin-user', ownerUser: { email: 'ADMIN@example.com' } },
        ],
      },
      adminMembership: {
        findFirst: async (input: any) => {
          membershipUserId = input.where.userId;
          return { role: 'COMPANY_ADMIN' };
        },
      },
    });
    const repo = new ChannelIdentityRepository(db as any);

    const result = await repo.resolveByLarkOpenId(OPEN_ID);

    assert.ok(result.ok);
    assert.equal(result.value?.userId, 'admin-user');
    assert.equal(result.value?.aiRole, 'COMPANY_ADMIN');
    assert.equal(membershipUserId, 'admin-user');
  });

  it('fails closed when duplicate Lark owners are ambiguous and identity email is unavailable', async () => {
    const db = makeIdentityDb({
      integrationConnection: {
        findMany: async () => [
          { ownerUserId: 'user-1', ownerUser: { email: 'one@example.com' } },
          { ownerUserId: 'user-2', ownerUser: { email: 'two@example.com' } },
        ],
      },
    });
    const repo = new ChannelIdentityRepository(db as any);

    const result = await repo.resolveByLarkOpenId(OPEN_ID);

    assert.ok(result.ok);
    assert.equal(result.value, null);
  });

  it('cache hit: revalidates live company membership before returning the cached identity', async () => {
    let dbCalls = 0;
    const db = makeIdentityDb({
      channelIdentity: { findFirst: async () => { dbCalls++; return null; } },
      integrationConnection: { findMany: async () => { dbCalls++; return []; } },
      userDepartmentPreference: { findUnique: async () => { dbCalls++; return null; } },
      adminMembership: { findFirst: async () => { dbCalls++; return { role: 'COMPANY_ADMIN' }; } },
    });
    const store = new Map<string, unknown>([[CACHE_KEY, resolvedIdentity]]);
    const cache = makeCache(store);
    const repo = new ChannelIdentityRepository(db as any, cache);

    const result = await repo.resolveByLarkOpenId(OPEN_ID);

    assert.ok(result.ok);
    assert.deepEqual(result.value, { ...resolvedIdentity, aiRole: 'COMPANY_ADMIN' });
    assert.equal(dbCalls, 1, 'cache hits must still revalidate the live membership role');
  });

  it('null result (identity not found) is NOT cached', async () => {
    const db = makeIdentityDb({
      channelIdentity: { findFirst: async () => null },
    });
    const cache = makeCache();
    const repo = new ChannelIdentityRepository(db as any, cache);

    const result = await repo.resolveByLarkOpenId(OPEN_ID);
    await new Promise(r => setImmediate(r));

    assert.ok(result.ok);
    assert.equal(result.value, null);
    assert.ok(!cache.store.has(CACHE_KEY), 'null result must NOT be cached');
  });

  it('null result when no active generic connection exists is NOT cached', async () => {
    const db = makeIdentityDb({
      integrationConnection: { findMany: async () => [] },
    });
    const cache = makeCache();
    const repo = new ChannelIdentityRepository(db as any, cache);

    const result = await repo.resolveByLarkOpenId(OPEN_ID);
    await new Promise(r => setImmediate(r));

    assert.ok(result.ok);
    assert.equal(result.value, null);
    assert.ok(!cache.store.has(CACHE_KEY), 'null result (missing connection) must NOT be cached');
  });

  it('cache error falls through to DB queries', async () => {
    let dbCalls = 0;
    const db = makeIdentityDb({
      channelIdentity: { findFirst: async () => { dbCalls++; return { id: 'ci-1', aiRole: 'MEMBER', channel: 'lark', companyId: 'company-1' }; } },
      integrationConnection: { findMany: async () => { dbCalls++; return [{ ownerUserId: 'user-1', ownerUser: { email: 'user@example.com' } }]; } },
      userDepartmentPreference: { findUnique: async () => { dbCalls++; return null; } },
    });
    const repo = new ChannelIdentityRepository(db as any, makeFailingCache());

    const result = await repo.resolveByLarkOpenId(OPEN_ID);

    assert.ok(result.ok);
    assert.ok(result.value !== null);
    assert.ok(dbCalls >= 2, 'should fall back to DB when cache errors');
  });
});

describe('ChannelIdentityRepository.resolveByLarkTenantIdentity', () => {
  it('keeps identical open IDs isolated by Lark tenant', async () => {
    const connectionQueries: Array<Record<string, unknown>> = [];
    const db = makeIdentityDb({
      larkTenantBinding: {
        findFirst: async () => ({ companyId: 'company-shared' }),
      },
      channelIdentity: {
        findFirst: async ({ where }: any) => ({
          id: `ci-${where.externalTenantId}`,
          aiRole: 'MEMBER',
          channel: 'lark',
          companyId: 'company-shared',
        }),
      },
      integrationConnection: {
        findMany: async ({ where }: any) => {
          connectionQueries.push(where);
          return [{
          ownerUserId: `user-${where.tokenMetadata.equals}`,
          ownerUser: { email: 'user@example.com' },
          }];
        },
      },
    });
    const cache = makeCache();
    const repo = new ChannelIdentityRepository(db as any, cache);

    const first = await repo.resolveByLarkTenantIdentity(OPEN_ID, 'tenant-1');
    const second = await repo.resolveByLarkTenantIdentity(OPEN_ID, 'tenant-2');
    await new Promise(r => setImmediate(r));

    assert.ok(first.ok && first.value);
    assert.ok(second.ok && second.value);
    assert.equal(first.value.companyId, 'company-shared');
    assert.equal(second.value.companyId, 'company-shared');
    assert.notEqual(first.value.userId, second.value.userId);
    assert.deepEqual(
      connectionQueries.map(where => where.tokenMetadata),
      [
        { path: ['larkTenantKey'], equals: 'tenant-1' },
        { path: ['larkTenantKey'], equals: 'tenant-2' },
      ],
    );
    assert.ok(cache.store.has(TENANT_CACHE_KEY));
    assert.ok(cache.store.has(`lark:id:v3:tenant-2:${OPEN_ID}`));
  });

  it('scopes first-touch login preparation to the same tenant', async () => {
    let where: Record<string, unknown> | undefined;
    const db = makeDb({
      channelIdentity: {
        findFirst: async (input: any) => {
          where = input.where;
          return null;
        },
      },
    });
    const repo = new ChannelIdentityRepository(db as any);

    const result = await repo.prepareLarkLogin(OPEN_ID, 'tenant-1');

    assert.ok(result.ok);
    assert.equal(result.value, null);
    assert.deepEqual(where, {
      channel: 'lark',
      larkOpenId: OPEN_ID,
      externalTenantId: 'tenant-1',
      companyId: 'company-tenant-1',
    });
  });

  it('rejects first-touch login when the tenant binding is inactive', async () => {
    let identityQueried = false;
    const db = makeDb({
      larkTenantBinding: { findFirst: async () => null },
      channelIdentity: {
        findFirst: async () => {
          identityQueried = true;
          return null;
        },
      },
    });
    const repo = new ChannelIdentityRepository(db as any);

    const result = await repo.prepareLarkLogin(OPEN_ID, 'tenant-1');

    assert.ok(result.ok);
    assert.equal(result.value, null);
    assert.equal(identityQueried, false);
  });

  it('rejects a retained identity when its tenant binding is inactive', async () => {
    let identityQueried = false;
    const db = makeIdentityDb({
      larkTenantBinding: { findFirst: async () => null },
      channelIdentity: {
        findFirst: async () => {
          identityQueried = true;
          return {
            id: 'ci-stale',
            aiRole: 'MEMBER',
            channel: 'lark',
            companyId: 'company-1',
          };
        },
      },
    });
    const repo = new ChannelIdentityRepository(db as any);

    const result = await repo.resolveByLarkTenantIdentity(OPEN_ID, 'inactive-tenant');

    assert.ok(result.ok);
    assert.equal(result.value, null);
    assert.equal(identityQueried, false);
  });
});

describe('ChannelIdentityRepository.invalidateIdentityCache', () => {
  it('calls del on the correct cache key', async () => {
    const cache = makeCache(new Map([[CACHE_KEY, resolvedIdentity]]));
    const repo = new ChannelIdentityRepository(makeIdentityDb() as any, cache);

    await repo.invalidateIdentityCache(OPEN_ID);

    assert.ok(cache.delCalls.includes(CACHE_KEY), 'should call del with identity cache key');
    assert.ok(
      cache.scanDelCalls.includes(`lark:id:v3:*:${OPEN_ID}`),
      'should invalidate tenant-scoped identity cache keys',
    );
    assert.ok(!cache.store.has(CACHE_KEY), 'cached entry should be removed');
  });
});

// ── Existing prepareLarkLogin tests ────────────────────────────────────────────

describe('ChannelIdentityRepository.prepareLarkLogin', () => {
  it('returns null for an unknown Lark identity', async () => {
    const repo = new ChannelIdentityRepository(makeDb({}) as any);

    const result = await repo.prepareLarkLogin('ou_missing');

    assert.equal(result.ok, true);
    assert.equal(result.ok ? result.value : undefined, null);
  });

  it('returns missing_email when the synced Lark contact has no email', async () => {
    const repo = new ChannelIdentityRepository(makeDb({
      channelIdentity: {
        findFirst: async () => ({
          aiRole: 'MEMBER',
          companyId: 'company-1',
          displayName: 'No Email',
          email: null,
          larkOpenId: 'ou_1',
        }),
      },
    }) as any);

    const result = await repo.prepareLarkLogin('ou_1');

    assert.equal(result.ok, true);
    assert.deepEqual(result.ok ? result.value : undefined, {
      status: 'missing_email',
      companyId: 'company-1',
      aiRole: 'MEMBER',
      larkOpenId: 'ou_1',
      displayName: 'No Email',
    });
  });

  it('uses an existing Divo user matched by normalized email', async () => {
    const repo = new ChannelIdentityRepository(makeDb({
      channelIdentity: {
        findFirst: async () => ({
          aiRole: 'COMPANY_ADMIN',
          companyId: 'company-1',
          displayName: 'Shivam Bhateja',
          email: 'Shivam@EmiacTech.com ',
          larkOpenId: 'ou_shivam',
        }),
      },
      user: {
        findUnique: async (input: any) => {
          assert.deepEqual(input.where, { email: 'shivam@emiactech.com' });
          return { id: 'user-1' };
        },
        create: async () => {
          throw new Error('should not create user');
        },
      },
      adminMembership: {
        findFirst: async () => ({ role: 'COMPANY_ADMIN' }),
        create: async () => { throw new Error('should not create membership'); },
      },
    }) as any);

    const result = await repo.prepareLarkLogin('ou_shivam');

    assert.equal(result.ok, true);
    assert.deepEqual(result.ok ? result.value : undefined, {
      status: 'ready',
      userId: 'user-1',
      companyId: 'company-1',
      aiRole: 'COMPANY_ADMIN',
      larkOpenId: 'ou_shivam',
      displayName: 'Shivam Bhateja',
      email: 'shivam@emiactech.com',
      createdUser: false,
    });
  });

  it('creates a placeholder Divo user for a known Lark contact without one', async () => {
    let createInput: any;
    const repo = new ChannelIdentityRepository(makeDb({
      channelIdentity: {
        findFirst: async () => ({
          aiRole: 'MEMBER',
          companyId: 'company-1',
          displayName: 'New User',
          email: 'new@example.com',
          larkOpenId: 'ou_new',
        }),
      },
      user: {
        findUnique: async () => null,
        create: async (input: any) => {
          createInput = input;
          return { id: 'created-user' };
        },
      },
    }) as any);

    const result = await repo.prepareLarkLogin('ou_new');

    assert.equal(result.ok, true);
    assert.equal(createInput.data.email, 'new@example.com');
    assert.equal(createInput.data.name, 'New User');
    assert.match(createInput.data.password, /^lark-oauth-pending:/);
    assert.deepEqual(result.ok ? result.value : undefined, {
      status: 'ready',
      userId: 'created-user',
      companyId: 'company-1',
      aiRole: 'MEMBER',
      larkOpenId: 'ou_new',
      displayName: 'New User',
      email: 'new@example.com',
      createdUser: true,
    });
  });
});
