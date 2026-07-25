import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LarkApiError } from '../../../src/infrastructure/channels/lark/clients/lark-http.client.ts';
import {
  classifyDeliveryFailure,
  deliveryBudgetExhausted,
  nextDeliveryDelayMs,
  DEFAULT_DELIVERY_BACKOFF,
} from '../../../src/infrastructure/channels/lark/lark-delivery-policy.ts';

describe('delivery failure classification', () => {
  it('treats a transport failure as retryable and genuinely unknown', () => {
    assert.deepEqual(classifyDeliveryFailure(new Error('socket hang up')), {
      retryable: true, ambiguous: true, reason: 'network',
    });
    assert.deepEqual(classifyDeliveryFailure(new LarkApiError('no response', 0)), {
      retryable: true, ambiguous: true, reason: 'network',
    });
  });

  it('treats rate limiting as retryable but not ambiguous', () => {
    // Rejected before delivery, so a resend cannot duplicate anything.
    assert.deepEqual(classifyDeliveryFailure(new LarkApiError('slow down', 429)), {
      retryable: true, ambiguous: false, reason: 'rate_limited',
    });
  });

  it('treats a provider error as retryable and ambiguous', () => {
    // Lark answered, so it received the request; whether it acted first is not
    // knowable from here.
    const verdict = classifyDeliveryFailure(new LarkApiError('boom', 503));
    assert.equal(verdict.retryable, true);
    assert.equal(verdict.ambiguous, true);
    assert.equal(verdict.reason, 'provider_error');
  });

  it('does not retry a request Lark understood and refused', () => {
    const verdict = classifyDeliveryFailure(new LarkApiError('bad card', 400));
    assert.equal(verdict.retryable, false);
    assert.equal(verdict.ambiguous, false);
    assert.equal(verdict.reason, 'invalid_request');
  });

  it('does not retry an authorization failure', () => {
    for (const status of [401, 403]) {
      const verdict = classifyDeliveryFailure(new LarkApiError('nope', status));
      assert.equal(verdict.retryable, false, `status ${status}`);
      assert.equal(verdict.reason, 'not_permitted');
    }
  });

  it('stops retrying a chat the bot can no longer post to', () => {
    // A 200-with-error-code that would otherwise look retryable. Retrying until
    // the budget expires would just delay the same outcome.
    const verdict = classifyDeliveryFailure(new LarkApiError('bot not in chat', 500, 230001));
    assert.equal(verdict.retryable, false);
    assert.equal(verdict.reason, 'not_permitted');
  });

  it('trusts the status for an unrecognised Lark code', () => {
    // The default has to be to keep retrying transient-looking failures;
    // widening the terminal list turns an outage into a permanent failure.
    const verdict = classifyDeliveryFailure(new LarkApiError('odd', 500, 999999));
    assert.equal(verdict.retryable, true);
  });

  it('separates "might have arrived" from "worth trying again"', () => {
    // The two questions are independent, which is why one boolean cannot answer
    // both: rate limiting is retryable and certain, a 400 is neither.
    const rateLimited = classifyDeliveryFailure(new LarkApiError('slow', 429));
    const refused = classifyDeliveryFailure(new LarkApiError('bad', 400));
    const network = classifyDeliveryFailure(new Error('ECONNRESET'));

    assert.deepEqual(
      [rateLimited, refused, network].map(v => [v.retryable, v.ambiguous]),
      [[true, false], [false, false], [true, true]],
    );
  });
});

describe('delivery backoff', () => {
  it('grows exponentially and stops at the ceiling', () => {
    const noJitter = () => 1;
    const delays = [1, 2, 3, 4, 5, 10].map(a => nextDeliveryDelayMs(a, noJitter));

    assert.deepEqual(delays.slice(0, 4), [1_000, 2_000, 4_000, 8_000]);
    assert.equal(delays.at(-1), DEFAULT_DELIVERY_BACKOFF.maxDelayMs);
  });

  it('spreads retries across the whole window', () => {
    // A Lark outage fails every in-flight delivery at once. Full-range jitter
    // is what stops them all marching back in step.
    assert.equal(nextDeliveryDelayMs(3, () => 0), 0);
    assert.equal(nextDeliveryDelayMs(3, () => 0.5), 2_000);
    assert.equal(nextDeliveryDelayMs(3, () => 1), 4_000);
  });

  it('never returns a negative delay for a first attempt', () => {
    assert.equal(nextDeliveryDelayMs(0, () => 1), DEFAULT_DELIVERY_BACKOFF.baseDelayMs);
  });
});

describe('delivery budget', () => {
  const start = new Date('2026-07-26T00:00:00.000Z');

  it('is measured from the first attempt, not the attempt count', () => {
    const withinWindow = new Date(start.getTime() + 9 * 60_000);
    const pastWindow = new Date(start.getTime() + 11 * 60_000);

    assert.equal(deliveryBudgetExhausted(start, withinWindow), false);
    assert.equal(deliveryBudgetExhausted(start, pastWindow), true);
  });

  it('expires exactly at the window boundary', () => {
    const boundary = new Date(start.getTime() + DEFAULT_DELIVERY_BACKOFF.retryWindowMs);
    assert.equal(deliveryBudgetExhausted(start, boundary), true);
  });
});
