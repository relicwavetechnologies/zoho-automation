import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LaneLeaseHolder } from '../../src/application/channels/lane-lease.holder.ts';
import { ok, err } from '../../src/shared/result.ts';
import { wrapInfra } from '../../src/shared/errors.ts';
import type { Logger } from '../../src/shared/logger.ts';

const silent: Logger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  child: () => silent,
};

const lease = {
  laneKey: 'lane-a', ownerId: 'worker-1', fencingToken: 1, expiresAt: new Date(Date.now() + 60_000),
};

const repo = (over: Record<string, unknown> = {}) => ({
  acquire: async () => ok({ outcome: 'acquired' as const, lease }),
  heartbeat: async () => ok(true),
  release: async () => ok(undefined),
  holdsLane: async () => ok(true),
  ...over,
}) as any;

const holder = (over: Record<string, unknown> = {}) => new LaneLeaseHolder({
  repo: repo(over),
  channel: 'lark',
  ownerId: 'worker-1',
  logger: silent,
  ttlMs: 60_000,
  heartbeatMs: 10_000,
});

describe('LaneLeaseHolder.withLane', () => {
  it('runs the task and releases the lane afterwards', async () => {
    let released = false;
    let ran = false;
    const subject = holder({ release: async () => { released = true; return ok(undefined); } });

    const outcome = await subject.withLane('lane-a', async () => { ran = true; });

    assert.equal(ran, true);
    assert.deepEqual(outcome, { outcome: 'ran' });
    assert.equal(released, true);
  });

  it('does not run at all when another worker holds the lane', async () => {
    let ran = false;
    const subject = holder({
      acquire: async () => ok({
        outcome: 'held' as const,
        ownerId: 'worker-2',
        expiresAt: new Date(Date.now() + 30_000),
      }),
    });

    const outcome = await subject.withLane('lane-a', async () => { ran = true; });

    // There is deliberately no "probably alone" path — that state is what turns
    // a second replica into two agents answering one message.
    assert.equal(ran, false);
    assert.equal(outcome.outcome, 'deferred');
  });

  it('releases the lane even when the task throws', async () => {
    let released = false;
    const subject = holder({ release: async () => { released = true; return ok(undefined); } });

    await assert.rejects(
      subject.withLane('lane-a', async () => { throw new Error('run failed'); }),
      /run failed/,
    );

    // A crashed run must free its lane now, not make the next message wait out
    // the full TTL.
    assert.equal(released, true);
  });

  it('refuses to run when the lease store cannot answer', async () => {
    let ran = false;
    const subject = holder({
      acquire: async () => err(wrapInfra('prisma', 'acquire', new Error('down'))),
    });

    await assert.rejects(subject.withLane('lane-a', async () => { ran = true; }));

    // An unreachable lease store is not permission to proceed. The message is
    // durable, so deferring costs latency while proceeding costs a duplicate.
    assert.equal(ran, false);
  });

  it('propagates an outer abort into the task', async () => {
    const outer = new AbortController();
    const subject = holder();
    let observed: boolean | undefined;

    await subject.withLane('lane-a', async (_lease, signal) => {
      outer.abort();
      observed = signal.aborted;
    }, outer.signal);

    assert.equal(observed, true);
  });

  it('starts already-aborted when the outer signal fired first', async () => {
    const outer = new AbortController();
    outer.abort();
    const subject = holder();
    let observed: boolean | undefined;

    await subject.withLane('lane-a', async (_lease, signal) => {
      observed = signal.aborted;
    }, outer.signal);

    assert.equal(observed, true);
  });
});

describe('LaneLeaseHolder.holdsLane', () => {
  it('reports a superseded lease as false', async () => {
    const subject = holder({ holdsLane: async () => ok(false) });
    assert.equal(await subject.holdsLane(lease), false);
  });

  it('throws when the answer is unknown, rather than reporting loss', async () => {
    const subject = holder({
      holdsLane: async () => err(wrapInfra('prisma', 'holdsLane', new Error('down'))),
    });

    // Returning false here would drop a legitimate reply on every hiccup.
    await assert.rejects(subject.holdsLane(lease));
  });
});
