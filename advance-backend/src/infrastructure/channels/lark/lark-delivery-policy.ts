/**
 * How a failed send should be treated.
 *
 * The adapter previously asked one question — is this failure ambiguous? — and
 * used the answer for everything. That conflates two independent facts. "Did it
 * maybe arrive?" decides whether a resend risks duplication. "Is it worth trying
 * again?" decides whether to retry at all. A 400 for a malformed card is
 * unambiguous *and* hopeless; a socket hang-up is ambiguous *and* worth
 * retrying. Deciding both from one boolean means one of them is wrong.
 */

import { LarkApiError } from './clients/lark-http.client';

export interface DeliveryFailureVerdict {
  /** Whether another attempt could plausibly succeed. */
  readonly retryable: boolean;
  /**
   * Whether the message may already have reached the user. A resend is then a
   * choice between a possible duplicate and a possible silence.
   */
  readonly ambiguous: boolean;
  /** Short machine-readable cause, for telemetry and operator triage. */
  readonly reason:
    | 'network'
    | 'rate_limited'
    | 'provider_error'
    | 'invalid_request'
    | 'not_permitted'
    | 'unknown';
}

/**
 * Lark error codes that are terminal despite arriving with a retryable-looking
 * HTTP status. Kept explicit: the default for an unrecognised code is to trust
 * the status, and silently widening this list would turn transient outages into
 * permanent failures.
 */
const TERMINAL_LARK_CODES = new Set<number>([
  230001, // bot not in chat
  230002, // bot forbidden in this chat
  230013, // chat has been disbanded
  232001, // message withdrawn / not found
]);

export const classifyDeliveryFailure = (error: unknown): DeliveryFailureVerdict => {
  if (!(error instanceof LarkApiError)) {
    // No HTTP status at all: the request never produced a response we can read,
    // so the send may or may not have landed.
    return { retryable: true, ambiguous: true, reason: 'network' };
  }

  // The client uses status 0 for transport failures — a request that left but
  // whose response never arrived. Retryable and genuinely unknown.
  if (error.status === 0) {
    return { retryable: true, ambiguous: true, reason: 'network' };
  }

  if (error.code !== undefined && TERMINAL_LARK_CODES.has(error.code)) {
    return { retryable: false, ambiguous: false, reason: 'not_permitted' };
  }

  if (error.status === 429) {
    // Rejected before delivery, so not ambiguous — it definitely did not send.
    return { retryable: true, ambiguous: false, reason: 'rate_limited' };
  }

  if (error.status >= 500) {
    // Lark answered, so the request was received; whether it acted on it before
    // failing is not knowable from here.
    return { retryable: true, ambiguous: true, reason: 'provider_error' };
  }

  if (error.status === 401 || error.status === 403) {
    return { retryable: false, ambiguous: false, reason: 'not_permitted' };
  }

  if (error.status >= 400) {
    // Ordinary 4xx: the request was understood and refused. Retrying the same
    // bytes will be refused the same way.
    return { retryable: false, ambiguous: false, reason: 'invalid_request' };
  }

  return { retryable: false, ambiguous: false, reason: 'unknown' };
};

export interface DeliveryBackoffPolicy {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** Measured from the first attempt, like the ingress retry window. */
  readonly retryWindowMs: number;
}

export const DEFAULT_DELIVERY_BACKOFF: DeliveryBackoffPolicy = {
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
  retryWindowMs: 10 * 60_000,
};

/**
 * Delay before attempt number `attempts + 1`, with jitter.
 *
 * Jitter is full-range rather than a small wobble because the failure mode this
 * guards against is correlated: a Lark outage fails every in-flight delivery at
 * once, and a fixed backoff would march them all back in lockstep.
 *
 * `random` is injected so the schedule is testable; production passes
 * `Math.random`.
 */
export const nextDeliveryDelayMs = (
  attempts: number,
  random: () => number,
  policy: DeliveryBackoffPolicy = DEFAULT_DELIVERY_BACKOFF,
): number => {
  const exponential = policy.baseDelayMs * 2 ** Math.max(0, attempts - 1);
  const ceiling = Math.min(exponential, policy.maxDelayMs);
  return Math.round(ceiling * random());
};

/**
 * Whether this delivery has run out of time.
 *
 * Bounded by elapsed time rather than attempt count, for the reason Wave 2
 * settled on: an attempt budget is spent in seconds during a real outage, while
 * a time budget still describes how long a user might wait.
 */
export const deliveryBudgetExhausted = (
  firstAttemptAt: Date,
  now: Date,
  policy: DeliveryBackoffPolicy = DEFAULT_DELIVERY_BACKOFF,
): boolean => now.getTime() - firstAttemptAt.getTime() >= policy.retryWindowMs;
