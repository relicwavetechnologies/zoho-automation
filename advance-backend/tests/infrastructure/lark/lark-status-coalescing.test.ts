import test from 'node:test';
import assert from 'node:assert/strict';

import { createCoalescedPublisher } from '../../../src/infrastructure/channels/lark/lark.webhook.routes.ts';

function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

test('everything raised during one publish collapses into a single follow-up', async () => {
  const gate = deferred();
  let calls = 0;
  const publisher = createCoalescedPublisher(
    async () => { calls += 1; await gate.promise; },
    error => assert.fail(`unexpected: ${String(error)}`),
  );

  publisher.queue();
  // Three more states arrive while the first card is still in the air. Each one
  // supersedes the last, so they owe Lark one more call between them, not three.
  publisher.queue();
  publisher.queue();
  publisher.queue();
  assert.equal(calls, 1, 'a publish must not start while one is in flight');

  gate.release();
  await publisher.settle();
  assert.equal(calls, 2);
});

test('settle waits for the follow-up, not just the publish in flight', async () => {
  const gate = deferred();
  const observed: number[] = [];
  let calls = 0;
  const publisher = createCoalescedPublisher(
    async () => { calls += 1; await gate.promise; observed.push(calls); },
    error => assert.fail(`unexpected: ${String(error)}`),
  );

  publisher.queue();
  publisher.queue();
  gate.release();
  await publisher.settle();

  // Both had to finish before settle returned, or the answer would go out while
  // the card still showed the run mid-flight.
  assert.deepEqual(observed, [1, 2]);
});

test('a failed publish is reported without stranding the ones after it', async () => {
  const errors: unknown[] = [];
  let calls = 0;
  const publisher = createCoalescedPublisher(
    async () => { calls += 1; throw new Error('lark unavailable'); },
    error => errors.push(error),
  );

  publisher.queue();
  await publisher.settle();
  assert.equal(errors.length, 1);

  // The slot has to be free again. If a settled publish stayed parked in it,
  // every later card would silently coalesce into a follow-up that never runs,
  // and settle would spin on a promise that is already done.
  publisher.queue();
  await publisher.settle();
  assert.equal(calls, 2);
  assert.equal(errors.length, 2);
});

test('a publish that throws before it ever suspends leaves the slot usable', { timeout: 5_000 }, async () => {
  // The one case that strands a naive implementation: this never reaches an
  // await, so it finishes during the very call that starts it — before its own
  // promise has been stored. Clearing the slot unconditionally would then park
  // an already-settled promise there, and settle would spin on it forever.
  const errors: unknown[] = [];
  let calls = 0;
  const publisher = createCoalescedPublisher(
    (() => { calls += 1; throw new Error('serialized nothing'); }) as () => Promise<void>,
    error => errors.push(error),
  );

  publisher.queue();
  await publisher.settle();
  publisher.queue();
  await publisher.settle();

  assert.equal(calls, 2);
  assert.equal(errors.length, 2);
});

/*
 * Urgency survives coalescing.
 *
 * The reducer is the only thing that knows a frame changed something a reader
 * is looking straight at, and it says so once. Several queued frames become one
 * publish, so if the urgency were read from whichever frame happened to be last
 * it would be lost exactly when the run is busiest — which is when it matters.
 */
test('carries urgency into the publish that coalesced it', { timeout: 5_000 }, async () => {
  const seen: boolean[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let first = true;

  const publisher = createCoalescedPublisher(
    async urgent => {
      seen.push(urgent);
      if (first) { first = false; await gate; }
    },
    () => {},
  );

  publisher.queue();          // starts, and parks on the gate
  publisher.queue(true);      // urgent, coalesced into the next publish
  publisher.queue();          // ordinary, must not clear the urgency above
  release();
  await publisher.settle();

  assert.deepEqual(seen, [false, true]);
});

test('spends urgency once rather than sticking to every later publish', async () => {
  const seen: boolean[] = [];
  const publisher = createCoalescedPublisher(async urgent => { seen.push(urgent); }, () => {});

  publisher.queue(true);
  await publisher.settle();
  publisher.queue();
  await publisher.settle();

  assert.deepEqual(seen, [true, false]);
});
