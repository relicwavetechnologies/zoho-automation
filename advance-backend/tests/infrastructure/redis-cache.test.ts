import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RedisCache } from '../../src/infrastructure/cache/redis-cache';

describe('RedisCache.take', () => {
  it('uses one atomic GETDEL and parses the consumed value', async () => {
    const calls: unknown[][] = [];
    const cache = new RedisCache({
      call: async (...args: unknown[]) => {
        calls.push(args);
        return JSON.stringify({ nonce: 'one-time' });
      },
    } as never);

    const result = await cache.take<{ nonce: string }>('oauth:nonce:1');

    assert.ok(result.ok);
    assert.deepEqual(result.value, { nonce: 'one-time' });
    assert.deepEqual(calls, [['GETDEL', 'oauth:nonce:1']]);
  });

  it('fails closed on Redis errors and treats corrupt consumed state as absent', async () => {
    const broken = new RedisCache({ call: async () => { throw new Error('redis down'); } } as never);
    const brokenResult = await broken.take('oauth:nonce:1');
    assert.equal(brokenResult.ok, false);

    const corrupt = new RedisCache({ call: async () => '{not-json' } as never);
    const corruptResult = await corrupt.take('oauth:nonce:1');
    assert.ok(corruptResult.ok);
    assert.equal(corruptResult.value, null);
  });
});
