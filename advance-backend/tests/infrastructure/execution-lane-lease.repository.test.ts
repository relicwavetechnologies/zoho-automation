import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionLaneLeaseRepository } from '../../src/infrastructure/persistence/execution-lane-lease.repository.ts';

const INPUT = { channel: 'lark', laneKey: 'lane-a', ownerId: 'worker-1', ttlMs: 60_000 };

const row = (over: Record<string, unknown> = {}) => ({
  id: 'lease-1',
  ownerId: 'worker-2',
  fencingToken: 3,
  expiresAt: new Date(Date.now() + 30_000),
  releasedAt: null,
  ...over,
});

describe('ExecutionLaneLeaseRepository.acquire', () => {
  it('opens a lane nobody holds', async () => {
    let created: any;
    const repo = new ExecutionLaneLeaseRepository({
      executionLaneLease: {
        findUnique: async () => null,
        create: async (input: any) => {
          created = input;
          return { fencingToken: 1, expiresAt: input.data.expiresAt };
        },
      },
    } as any);

    const result = await repo.acquire(INPUT);

    assert.ok(result.ok && result.value.outcome === 'acquired');
    assert.equal(created.data.ownerId, 'worker-1');
    assert.equal(created.data.fencingToken, 1);
  });

  it('refuses a lane whose owner is still alive', async () => {
    const repo = new ExecutionLaneLeaseRepository({
      executionLaneLease: { findUnique: async () => row() },
    } as any);

    const result = await repo.acquire(INPUT);

    // The whole point: a second replica must not run this lane.
    assert.ok(result.ok);
    assert.equal(result.value.outcome, 'held');
    if (result.value.outcome === 'held') {
      assert.equal(result.value.ownerId, 'worker-2');
    }
  });

  it('takes over a lane whose owner has gone silent, and bumps the fence', async () => {
    let update: any;
    const repo = new ExecutionLaneLeaseRepository({
      executionLaneLease: {
        findUnique: async () => row({ expiresAt: new Date(Date.now() - 1_000) }),
        updateMany: async (input: any) => { update = input; return { count: 1 }; },
      },
    } as any);

    const result = await repo.acquire(INPUT);

    assert.ok(result.ok && result.value.outcome === 'acquired');
    // The bump is what makes the dead owner's later publish detectable.
    assert.equal(result.value.lease.fencingToken, 4);
    assert.equal(update.data.fencingToken, 4);
    assert.equal(update.where.fencingToken, 3, 'guarded against a concurrent takeover');
  });

  it('takes over a released lane immediately rather than waiting for expiry', async () => {
    const repo = new ExecutionLaneLeaseRepository({
      executionLaneLease: {
        findUnique: async () => row({ releasedAt: new Date() }),
        updateMany: async () => ({ count: 1 }),
      },
    } as any);

    const result = await repo.acquire(INPUT);

    assert.ok(result.ok && result.value.outcome === 'acquired');
  });

  it('reports held when another worker wins the takeover race', async () => {
    let reads = 0;
    const repo = new ExecutionLaneLeaseRepository({
      executionLaneLease: {
        findUnique: async () => {
          reads += 1;
          return reads === 1
            ? row({ expiresAt: new Date(Date.now() - 1_000) })
            : { ownerId: 'worker-3', expiresAt: new Date(Date.now() + 60_000) };
        },
        updateMany: async () => ({ count: 0 }),
      },
    } as any);

    const result = await repo.acquire(INPUT);

    // Both saw the same expired lease; only one write can match the predicate.
    assert.ok(result.ok);
    assert.equal(result.value.outcome, 'held');
    if (result.value.outcome === 'held') assert.equal(result.value.ownerId, 'worker-3');
  });

  it('resolves a unique-constraint collision into a verdict, not an error', async () => {
    let created = false;
    const repo = new ExecutionLaneLeaseRepository({
      executionLaneLease: {
        findUnique: async () => (created
          ? row({ ownerId: 'worker-9', expiresAt: new Date(Date.now() + 60_000) })
          : null),
        create: async () => {
          created = true;
          throw Object.assign(new Error('duplicate'), { code: 'P2002' });
        },
      },
    } as any);

    const result = await repo.acquire(INPUT);

    // Surfacing this as an error would read to the caller as "the lease system
    // is down", and the only safe response to that is to not run at all.
    assert.ok(result.ok);
    assert.equal(result.value.outcome, 'held');
  });

  it('still reports a genuine database failure as an error', async () => {
    const repo = new ExecutionLaneLeaseRepository({
      executionLaneLease: {
        findUnique: async () => null,
        create: async () => { throw new Error('connection refused'); },
      },
    } as any);

    assert.equal((await repo.acquire(INPUT)).ok, false);
  });
});

describe('ExecutionLaneLeaseRepository.heartbeat', () => {
  it('extends a lease that is still ours', async () => {
    let update: any;
    const repo = new ExecutionLaneLeaseRepository({
      executionLaneLease: {
        updateMany: async (input: any) => { update = input; return { count: 1 }; },
      },
    } as any);

    const result = await repo.heartbeat(
      { laneKey: 'lane-a', ownerId: 'worker-1', fencingToken: 2, expiresAt: new Date() },
      { channel: 'lark', ttlMs: 60_000 },
    );

    assert.deepEqual(result, { ok: true, value: true });
    assert.equal(update.where.ownerId, 'worker-1');
    assert.equal(update.where.fencingToken, 2, 'a superseded token renews nothing');
  });

  it('reports a lost lane as false rather than as an error', async () => {
    const repo = new ExecutionLaneLeaseRepository({
      executionLaneLease: { updateMany: async () => ({ count: 0 }) },
    } as any);

    const result = await repo.heartbeat(
      { laneKey: 'lane-a', ownerId: 'worker-1', fencingToken: 1, expiresAt: new Date() },
      { channel: 'lark', ttlMs: 60_000 },
    );

    // "You were superseded" and "the database is unreachable" demand opposite
    // responses: stop working, versus keep working and try again.
    assert.deepEqual(result, { ok: true, value: false });
  });
});

describe('ExecutionLaneLeaseRepository.holdsLane', () => {
  const lease = {
    laneKey: 'lane-a', ownerId: 'worker-1', fencingToken: 2, expiresAt: new Date(),
  };

  it('confirms a live lease held by us', async () => {
    const repo = new ExecutionLaneLeaseRepository({
      executionLaneLease: {
        findUnique: async () => ({
          ownerId: 'worker-1',
          fencingToken: 2,
          releasedAt: null,
          expiresAt: new Date(Date.now() + 30_000),
        }),
      },
    } as any);

    assert.deepEqual(await repo.holdsLane(lease, 'lark'), { ok: true, value: true });
  });

  it('denies a lease whose fence has moved on', async () => {
    const repo = new ExecutionLaneLeaseRepository({
      executionLaneLease: {
        findUnique: async () => ({
          ownerId: 'worker-1',
          fencingToken: 3,
          releasedAt: null,
          expiresAt: new Date(Date.now() + 30_000),
        }),
      },
    } as any);

    // Same owner ID, newer acquisition: this run was superseded by a later one.
    assert.deepEqual(await repo.holdsLane(lease, 'lark'), { ok: true, value: false });
  });

  it('denies an expired lease even when nobody else has taken it', async () => {
    const repo = new ExecutionLaneLeaseRepository({
      executionLaneLease: {
        findUnique: async () => ({
          ownerId: 'worker-1',
          fencingToken: 2,
          releasedAt: null,
          expiresAt: new Date(Date.now() - 1),
        }),
      },
    } as any);

    assert.deepEqual(await repo.holdsLane(lease, 'lark'), { ok: true, value: false });
  });
});

describe('ExecutionLaneLeaseRepository.release', () => {
  it('only releases our own lease', async () => {
    let update: any;
    const repo = new ExecutionLaneLeaseRepository({
      executionLaneLease: {
        updateMany: async (input: any) => { update = input; return { count: 1 }; },
      },
    } as any);

    await repo.release(
      { laneKey: 'lane-a', ownerId: 'worker-1', fencingToken: 2, expiresAt: new Date() },
      'lark',
    );

    // Without the owner and token guard, a worker that already lost the lane
    // would free it out from under whoever took it.
    assert.equal(update.where.ownerId, 'worker-1');
    assert.equal(update.where.fencingToken, 2);
    assert.ok(update.data.releasedAt instanceof Date);
  });
});
