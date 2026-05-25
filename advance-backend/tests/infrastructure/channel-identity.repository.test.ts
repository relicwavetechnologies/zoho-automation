import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ChannelIdentityRepository } from '../../src/infrastructure/persistence/channel-identity.repository';
import type { CachePort } from '../../src/shared/cache.ts';
import { ok, err } from '../../src/shared/result.ts';
import type { ResolvedUserIdentity } from '../../src/infrastructure/persistence/channel-identity.repository.ts';

function makeDb(overrides: Record<string, unknown>) {
  return {
    channelIdentity: {
      findFirst: async () => null,
    },
    larkUserAuthLink: {
      findFirst: async () => null,
    },
    userDepartmentPreference: {
      findUnique: async () => null,
    },
    user: {
      findUnique: async () => null,
      create: async () => ({ id: 'created-user' }),
    },
    ...overrides,
  };
}

// ── Cache helpers ──────────────────────────────────────────────────────────────

const OPEN_ID = 'ou_cache_test';
const CACHE_KEY = `lark:id:v1:${OPEN_ID}`;

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
    larkUserAuthLink: {
      findFirst: async () => ({ userId: 'user-1' }),
    },
    userDepartmentPreference: {
      findUnique: async () => null,
    },
    user: {
      findUnique: async () => null,
      create: async () => ({ id: 'created-user' }),
    },
    ...overrides,
  };
}

function makeCache(store = new Map<string, unknown>()): CachePort & { store: Map<string, unknown>; delCalls: string[] } {
  const delCalls: string[] = [];
  return {
    store,
    delCalls,
    get: async (k) => ok(store.has(k) ? (store.get(k) as any) : null),
    set: async (k, v) => { store.set(k, v); return ok(undefined); },
    setNx: async (k, v) => { if (store.has(k)) return ok(false); store.set(k, v); return ok(true); },
    del: async (k) => { delCalls.push(k); store.delete(k); return ok(undefined); },
    scanDel: async () => ok(0),
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

// ── Cache tests for resolveByLarkOpenId ────────────────────────────────────────

describe('ChannelIdentityRepository.resolveByLarkOpenId (cache)', () => {
  it('cache miss: fires all 3 DB queries and populates cache', async () => {
    let ciFindCalls = 0, authLinkCalls = 0, deptPrefCalls = 0;
    const db = makeIdentityDb({
      channelIdentity: { findFirst: async () => { ciFindCalls++; return { id: 'ci-1', aiRole: 'MEMBER', channel: 'lark', companyId: 'company-1' }; } },
      larkUserAuthLink: { findFirst: async () => { authLinkCalls++; return { userId: 'user-1' }; } },
      userDepartmentPreference: { findUnique: async () => { deptPrefCalls++; return null; } },
    });
    const cache = makeCache();
    const repo = new ChannelIdentityRepository(db as any, cache);

    const result = await repo.resolveByLarkOpenId(OPEN_ID);
    await new Promise(r => setImmediate(r));

    assert.ok(result.ok);
    assert.ok(result.value !== null);
    assert.equal(ciFindCalls, 1, 'channelIdentity.findFirst must be called once');
    assert.equal(authLinkCalls, 1, 'larkUserAuthLink.findFirst must be called once');
    assert.equal(deptPrefCalls, 1, 'userDepartmentPreference.findUnique must be called once');
    assert.ok(cache.store.has(CACHE_KEY), 'resolved identity should be cached');
  });

  it('cache hit: returns cached result without querying DB', async () => {
    let dbCalls = 0;
    const db = makeIdentityDb({
      channelIdentity: { findFirst: async () => { dbCalls++; return null; } },
      larkUserAuthLink: { findFirst: async () => { dbCalls++; return null; } },
      userDepartmentPreference: { findUnique: async () => { dbCalls++; return null; } },
    });
    const store = new Map<string, unknown>([[CACHE_KEY, resolvedIdentity]]);
    const cache = makeCache(store);
    const repo = new ChannelIdentityRepository(db as any, cache);

    const result = await repo.resolveByLarkOpenId(OPEN_ID);

    assert.ok(result.ok);
    assert.deepEqual(result.value, resolvedIdentity);
    assert.equal(dbCalls, 0, 'no DB queries should fire on cache hit');
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

  it('null result when authLink missing is NOT cached', async () => {
    const db = makeIdentityDb({
      larkUserAuthLink: { findFirst: async () => null },
    });
    const cache = makeCache();
    const repo = new ChannelIdentityRepository(db as any, cache);

    const result = await repo.resolveByLarkOpenId(OPEN_ID);
    await new Promise(r => setImmediate(r));

    assert.ok(result.ok);
    assert.equal(result.value, null);
    assert.ok(!cache.store.has(CACHE_KEY), 'null result (missing auth link) must NOT be cached');
  });

  it('cache error falls through to DB queries', async () => {
    let dbCalls = 0;
    const db = makeIdentityDb({
      channelIdentity: { findFirst: async () => { dbCalls++; return { id: 'ci-1', aiRole: 'MEMBER', channel: 'lark', companyId: 'company-1' }; } },
      larkUserAuthLink: { findFirst: async () => { dbCalls++; return { userId: 'user-1' }; } },
      userDepartmentPreference: { findUnique: async () => { dbCalls++; return null; } },
    });
    const repo = new ChannelIdentityRepository(db as any, makeFailingCache());

    const result = await repo.resolveByLarkOpenId(OPEN_ID);

    assert.ok(result.ok);
    assert.ok(result.value !== null);
    assert.ok(dbCalls >= 2, 'should fall back to DB when cache errors');
  });
});

describe('ChannelIdentityRepository.invalidateIdentityCache', () => {
  it('calls del on the correct cache key', async () => {
    const cache = makeCache(new Map([[CACHE_KEY, resolvedIdentity]]));
    const repo = new ChannelIdentityRepository(makeIdentityDb() as any, cache);

    await repo.invalidateIdentityCache(OPEN_ID);

    assert.ok(cache.delCalls.includes(CACHE_KEY), 'should call del with identity cache key');
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
