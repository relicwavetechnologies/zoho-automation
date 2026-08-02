import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RunOriginStore, type RunOrigin } from '../../src/application/connections/run-origin.store';
import type { CachePort } from '../../src/shared/cache';
import { ok } from '../../src/shared/result';

function fakeCache(): CachePort & { entries: Map<string, { value: unknown; ttl?: number }> } {
  const entries = new Map<string, { value: unknown; ttl?: number }>();
  return {
    entries,
    async get<T>(key: string) {
      return ok((entries.get(key)?.value ?? null) as T | null);
    },
    async set<T>(key: string, value: T, ttlSeconds?: number) {
      entries.set(key, { value, ...(ttlSeconds ? { ttl: ttlSeconds } : {}) });
      return ok(undefined);
    },
    async setNx() { return ok(true); },
    async del(key: string) { entries.delete(key); return ok(undefined); },
    async scanDel() { return ok(0); },
  };
}

const ORIGIN: RunOrigin = {
  version: 1,
  companyId: 'co-1',
  userId: 'user-1',
  larkOpenId: 'ou_user',
  larkTenantKey: 'tenant-1',
  chatId: 'oc_chat',
  chatType: 'p2p',
  originalMessageId: 'om_request',
  replyInThread: false,
  originalRequest: 'Forward my invoices to finance',
};

describe('RunOriginStore', () => {
  it('returns the origin a run recorded, under a run-scoped key', async () => {
    const cache = fakeCache();
    const store = new RunOriginStore(cache);

    assert.equal(await store.remember('run-1', ORIGIN), true);
    assert.deepEqual(
      await store.recall({ runId: 'run-1', companyId: 'co-1', userId: 'user-1' }),
      ORIGIN,
    );
    assert.equal([...cache.entries.keys()][0], 'run-origin:v1:run-1');
  });

  it('expires the record rather than keeping the ask indefinitely', async () => {
    const cache = fakeCache();
    await new RunOriginStore(cache).remember('run-1', ORIGIN);
    const stored = cache.entries.get('run-origin:v1:run-1');
    assert.ok(stored?.ttl && stored.ttl > 0);
  });

  it('retains a Google authorization action when the same run is recorded again', async () => {
    const store = new RunOriginStore(fakeCache());
    await store.remember('run-1', ORIGIN);
    await store.attachGoogleAuthorization({
      runId: 'run-1',
      companyId: 'co-1',
      userId: 'user-1',
      intentId: 'intent-1',
      authorizeUrl: 'https://accounts.google.com/o/oauth2/auth?state=opaque',
    });

    await store.remember('run-1', ORIGIN);

    assert.deepEqual(
      (await store.recall({
        runId: 'run-1',
        companyId: 'co-1',
        userId: 'user-1',
      }))?.googleAuthorization,
      {
        intentId: 'intent-1',
        authorizeUrl: 'https://accounts.google.com/o/oauth2/auth?state=opaque',
      },
    );
  });

  it('refuses to hand a run origin to a different member or company', async () => {
    const store = new RunOriginStore(fakeCache());
    await store.remember('run-1', ORIGIN);

    // Learning a run ID must not be enough: a card sent from this origin goes
    // into its chat and re-runs its ask, so a mismatched caller gets nothing.
    assert.equal(
      await store.recall({ runId: 'run-1', companyId: 'co-1', userId: 'user-2' }),
      undefined,
    );
    assert.equal(
      await store.recall({ runId: 'run-1', companyId: 'co-2', userId: 'user-1' }),
      undefined,
    );
  });

  it('reports an unknown run rather than inventing one', async () => {
    const store = new RunOriginStore(fakeCache());
    assert.equal(
      await store.recall({ runId: 'never-written', companyId: 'co-1', userId: 'user-1' }),
      undefined,
    );
  });

  it('declines to store an ask it could only keep in truncated form', async () => {
    const cache = fakeCache();
    const store = new RunOriginStore(cache);

    // A continuation re-runs originalRequest verbatim. Half an instruction is
    // worse than none, so the run simply has no origin and the member is told
    // to connect Google themselves.
    const stored = await store.remember('run-1', {
      ...ORIGIN,
      originalRequest: 'x'.repeat(16_001),
    });

    assert.equal(stored, false);
    assert.equal(cache.entries.size, 0);
  });
});
