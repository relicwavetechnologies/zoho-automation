import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDeliveryKey,
  toProviderIdempotencyKey,
} from '../../src/domain/channel/delivery-key.ts';

describe('delivery key', () => {
  it('is the same for two attempts at the same segment', () => {
    // The entire point: a retry must compute the key the first attempt used, or
    // it identifies nothing and the resend becomes a second reply.
    const first = buildDeliveryKey({ runKey: 'corr-1', purpose: 'final' });
    const retry = buildDeliveryKey({ runKey: 'corr-1', purpose: 'final' });
    assert.equal(first, retry);
  });

  it('separates the parts of one answer', () => {
    const final = buildDeliveryKey({ runKey: 'corr-1', purpose: 'final' });
    const firstContinuation = buildDeliveryKey({
      runKey: 'corr-1', purpose: 'continuation', segmentIndex: 1,
    });
    const secondContinuation = buildDeliveryKey({
      runKey: 'corr-1', purpose: 'continuation', segmentIndex: 2,
    });

    // A long reply spans several cards; card three failing must not resend
    // cards one and two.
    assert.equal(new Set([final, firstContinuation, secondContinuation]).size, 3);
  });

  it('separates two runs in the same conversation', () => {
    assert.notEqual(
      buildDeliveryKey({ runKey: 'corr-1', purpose: 'final' }),
      buildDeliveryKey({ runKey: 'corr-2', purpose: 'final' }),
    );
  });

  it('treats a missing segment index as the first segment', () => {
    assert.equal(
      buildDeliveryKey({ runKey: 'corr-1', purpose: 'continuation' }),
      buildDeliveryKey({ runKey: 'corr-1', purpose: 'continuation', segmentIndex: 0 }),
    );
  });
});

describe('provider idempotency key', () => {
  const hash = (input: string) => `h${input.length}${input.slice(0, 8)}`.padEnd(60, 'x');

  it('passes a short key through unchanged', () => {
    const key = buildDeliveryKey({ runKey: 'corr-1', purpose: 'final' });
    assert.equal(toProviderIdempotencyKey(key, hash), key);
  });

  it('hashes a key Lark would reject and keeps it within the limit', () => {
    const long = buildDeliveryKey({ runKey: 'c'.repeat(80), purpose: 'final' });
    const provider = toProviderIdempotencyKey(long, hash);

    assert.ok(provider.length <= 50, `expected <= 50 chars, got ${provider.length}`);
    assert.notEqual(provider, long);
  });

  it('hashes the same long key to the same value', () => {
    // A hashed key is still an idempotency key; if it varied per attempt the
    // truncation would have quietly removed the guarantee.
    const long = buildDeliveryKey({ runKey: 'c'.repeat(80), purpose: 'final' });
    assert.equal(
      toProviderIdempotencyKey(long, hash),
      toProviderIdempotencyKey(long, hash),
    );
  });
});
