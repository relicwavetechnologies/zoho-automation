import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Job } from 'bullmq';
import { isFinalFailedAttempt } from '../../src/shared/queue-retry';

const job = (attemptsMade: number, attempts?: number) =>
  ({ attemptsMade, opts: { attempts } }) as Pick<Job, 'attemptsMade' | 'opts'>;

describe('isFinalFailedAttempt', () => {
  it('waits for BullMQ to exhaust its retries before declaring a job dead', () => {
    // In a `failed` handler the count is already incremented, so the second
    // failure of a three-attempt job used to be reported as terminal — marking
    // a Teach session failed while a third, often successful, attempt was
    // still queued.
    assert.equal(isFinalFailedAttempt(job(1, 3)), false);
    assert.equal(isFinalFailedAttempt(job(2, 3)), false);
    assert.equal(isFinalFailedAttempt(job(3, 3)), true);
  });

  it('treats an unconfigured job as single-attempt', () => {
    assert.equal(isFinalFailedAttempt(job(1)), true);
    assert.equal(isFinalFailedAttempt(undefined), false);
  });

  it('knows BullMQ will not retry a stalled job whatever the attempt count says', () => {
    // A stall arrives as UnrecoverableError, which BullMQ refuses to retry.
    // Reporting "1 of 3, it will try again" left Teach sessions sitting in
    // `ingesting` with nothing left in the system to move them.
    const stalled = new Error('job stalled more than allowable limit');
    stalled.name = 'UnrecoverableError';

    assert.equal(isFinalFailedAttempt(job(1, 3), stalled), true);
    assert.equal(isFinalFailedAttempt(job(1, 3), new Error('openai 500')), false);
  });
});
