import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelDeliveryRepository } from '../../src/infrastructure/persistence/channel-delivery.repository.ts';

const INPUT = {
  channel: 'lark',
  idempotencyKey: 'corr-1:final:0',
  runKey: 'corr-1',
  purpose: 'final' as const,
};

const row = (over: Record<string, unknown> = {}) => ({
  id: 'delivery-1',
  status: 'pending',
  attempts: 1,
  firstAttemptAt: new Date('2026-07-26T00:00:00.000Z'),
  providerMessageId: null,
  ...over,
});

describe('ChannelDeliveryRepository.reserve', () => {
  it('creates and claims a record on the first attempt', async () => {
    let createInput: any;
    const repo = new ChannelDeliveryRepository({
      channelDelivery: {
        findUnique: async () => null,
        create: async (input: any) => { createInput = input; return row(); },
      },
    } as any);

    const result = await repo.reserve({ ...INPUT, companyId: 'co-1', chatId: 'oc_1' });

    assert.ok(result.ok && result.value.outcome === 'reserved');
    assert.equal(createInput.data.status, 'sending');
    assert.equal(createInput.data.attempts, 1);
    assert.equal(createInput.data.idempotencyKey, 'corr-1:final:0');
    assert.ok(createInput.data.startedAt instanceof Date);
  });

  it('reports an already-delivered segment instead of letting it send again', async () => {
    const repo = new ChannelDeliveryRepository({
      channelDelivery: {
        findUnique: async () => row({ status: 'delivered', providerMessageId: 'om_sent' }),
      },
    } as any);

    const result = await repo.reserve(INPUT);

    // This is the outcome the whole model exists for: a retry after a lost HTTP
    // response must learn the user already has the answer.
    assert.ok(result.ok);
    assert.equal(result.value.outcome, 'delivered');
    if (result.value.outcome === 'delivered') {
      assert.equal(result.value.record.providerMessageId, 'om_sent');
    }
  });

  it('reports a live attempt distinctly from a finished one', async () => {
    const repo = new ChannelDeliveryRepository({
      channelDelivery: {
        findUnique: async (args: any) =>
          args.select?.status && args.where?.id
            ? row({ status: 'sending' })
            : row({ status: 'sending' }),
        updateMany: async () => ({ count: 0 }),
      },
    } as any);

    const result = await repo.reserve(INPUT);

    // A caller that cannot tell "someone else is sending" from "already sent"
    // either duplicates the reply or drops it.
    assert.deepEqual(result, { ok: true, value: { outcome: 'inFlight' } });
  });

  it('re-reads before concluding, so a race lost to a delivery is not read as in-flight', async () => {
    let call = 0;
    const repo = new ChannelDeliveryRepository({
      channelDelivery: {
        findUnique: async () => {
          call += 1;
          return call === 1
            ? row({ status: 'sending' })
            : row({ status: 'delivered', providerMessageId: 'om_race' });
        },
        updateMany: async () => ({ count: 0 }),
      },
    } as any);

    const result = await repo.reserve(INPUT);

    assert.ok(result.ok);
    assert.equal(result.value.outcome, 'delivered');
  });

  it('only re-claims a stale send, and says so in the predicate', async () => {
    let updateInput: any;
    const repo = new ChannelDeliveryRepository({
      channelDelivery: {
        findUnique: async () => row({ status: 'sending', attempts: 2 }),
        updateMany: async (input: any) => { updateInput = input; return { count: 1 }; },
      },
    } as any);

    const result = await repo.reserve(INPUT, { staleSendingAfterMs: 30_000 });

    assert.ok(result.ok && result.value.outcome === 'reserved');
    assert.deepEqual(updateInput.where.status, { notIn: ['delivered', 'abandoned'] });
    const or = updateInput.where.OR;
    assert.deepEqual(or[0], { status: { not: 'sending' } });
    assert.deepEqual(or[1], { startedAt: null });
    assert.ok(or[2].startedAt.lt instanceof Date);
    assert.ok(or[2].startedAt.lt.getTime() <= Date.now() - 30_000);
    assert.deepEqual(updateInput.data.attempts, { increment: 1 });
  });

  it('does not resurrect a delivery that was abandoned', async () => {
    const repo = new ChannelDeliveryRepository({
      channelDelivery: { findUnique: async () => row({ status: 'abandoned' }) },
    } as any);

    assert.deepEqual(await repo.reserve(INPUT), {
      ok: true, value: { outcome: 'abandoned' },
    });
  });

  it('keeps a failed reservation inside the repository error boundary', async () => {
    const repo = new ChannelDeliveryRepository({
      channelDelivery: {
        findUnique: async () => { throw new Error('database unavailable'); },
      },
    } as any);

    const result = await repo.reserve(INPUT);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.payload.op, 'channelDelivery.reserve');
    }
  });
});

describe('ChannelDeliveryRepository.markDelivered', () => {
  it('records the provider message and clears retry state', async () => {
    let updateInput: any;
    const repo = new ChannelDeliveryRepository({
      channelDelivery: {
        updateMany: async (input: any) => { updateInput = input; return { count: 1 }; },
      },
    } as any);

    await repo.markDelivered('delivery-1', 'om_1');

    assert.equal(updateInput.data.status, 'delivered');
    assert.equal(updateInput.data.providerMessageId, 'om_1');
    assert.equal(updateInput.data.nextAttemptAt, null);
    assert.equal(updateInput.data.ambiguous, false);
  });

  it('lets a send that was given up on be recorded as delivered after all', async () => {
    let updateInput: any;
    const repo = new ChannelDeliveryRepository({
      channelDelivery: {
        updateMany: async (input: any) => { updateInput = input; return { count: 1 }; },
      },
    } as any);

    await repo.markDelivered('delivery-1', 'om_late');

    // `abandoned` is a decision to stop trying, not a claim that nothing
    // arrived. If it turns out to have landed, that is the truth.
    assert.deepEqual(updateInput.where.status, { not: 'delivered' });
  });
});

describe('ChannelDeliveryRepository.markFailed', () => {
  it('schedules another attempt without closing the record', async () => {
    let updateInput: any;
    const repo = new ChannelDeliveryRepository({
      channelDelivery: {
        updateMany: async (input: any) => { updateInput = input; return { count: 1 }; },
      },
    } as any);
    const nextAttemptAt = new Date('2026-07-26T00:05:00.000Z');

    await repo.markFailed('delivery-1', new Error('503'), { ambiguous: true, nextAttemptAt });

    assert.equal(updateInput.data.status, 'failed');
    assert.equal(updateInput.data.ambiguous, true);
    assert.equal(updateInput.data.nextAttemptAt, nextAttemptAt);
    assert.deepEqual(updateInput.where.status, { notIn: ['delivered', 'abandoned'] });
  });

  it('never lets a late failure walk back a delivered message', async () => {
    let updateInput: any;
    const repo = new ChannelDeliveryRepository({
      channelDelivery: {
        updateMany: async (input: any) => { updateInput = input; return { count: 0 }; },
      },
    } as any);

    await repo.markFailed('delivery-1', new Error('too late'), { terminal: true });

    assert.equal(updateInput.data.status, 'abandoned');
    assert.deepEqual(updateInput.where.status, { not: 'delivered' });
  });

  it('truncates a long provider error rather than storing it whole', async () => {
    let updateInput: any;
    const repo = new ChannelDeliveryRepository({
      channelDelivery: {
        updateMany: async (input: any) => { updateInput = input; return { count: 1 }; },
      },
    } as any);

    await repo.markFailed('delivery-1', new Error('x'.repeat(2_000)));

    assert.equal(updateInput.data.lastError.length, 500);
  });
});

describe('ChannelDeliveryRepository.listRetryable', () => {
  it('returns deliveries whose backoff has elapsed, oldest first', async () => {
    let findInput: any;
    const repo = new ChannelDeliveryRepository({
      channelDelivery: {
        findMany: async (input: any) => { findInput = input; return [{ id: 'd-1' }, { id: 'd-2' }]; },
      },
    } as any);
    const now = new Date('2026-07-26T00:10:00.000Z');

    const result = await repo.listRetryable(50, { channel: 'lark', now });

    assert.deepEqual(result, { ok: true, value: ['d-1', 'd-2'] });
    assert.equal(findInput.where.channel, 'lark');
    assert.deepEqual(findInput.where.status, { in: ['pending', 'sending', 'failed'] });
    assert.deepEqual(findInput.where.OR, [
      { nextAttemptAt: null },
      { nextAttemptAt: { lte: now } },
    ]);
    assert.deepEqual(findInput.orderBy, { firstAttemptAt: 'asc' });
    assert.equal(findInput.take, 50);
  });

  it('excludes deliveries that are finished or given up on', async () => {
    let findInput: any;
    const repo = new ChannelDeliveryRepository({
      channelDelivery: {
        findMany: async (input: any) => { findInput = input; return []; },
      },
    } as any);

    await repo.listRetryable(10);

    const statuses: string[] = findInput.where.status.in;
    assert.ok(!statuses.includes('delivered'));
    assert.ok(!statuses.includes('abandoned'));
  });
});

describe('ChannelDeliveryRepository.reserve under a create race', () => {
  /**
   * Both attempts see no row and both call create. One wins; the loser hits the
   * unique constraint. That constraint is the guard, so the loser must resolve
   * to a verdict — surfacing it as an error would be self-defeating, because
   * the adapter treats a broken guard as licence to send unguarded and both
   * attempts would deliver.
   */
  function racingDb(winnerStatus: string, providerMessageId: string | null = null) {
    let created = false;
    return {
      channelDelivery: {
        findUnique: async () => (created
          ? row({ status: winnerStatus, providerMessageId })
          : null),
        create: async () => {
          created = true;
          throw Object.assign(new Error('duplicate'), { code: 'P2002' });
        },
        updateMany: async () => ({ count: 0 }),
      },
    } as any;
  }

  it('resolves to delivered when the winner already sent', async () => {
    const repo = new ChannelDeliveryRepository(racingDb('delivered', 'om_winner'));

    const result = await repo.reserve(INPUT);

    assert.ok(result.ok);
    assert.equal(result.value.outcome, 'delivered');
    if (result.value.outcome === 'delivered') {
      assert.equal(result.value.record.providerMessageId, 'om_winner');
    }
  });

  it('resolves to inFlight while the winner is still sending', async () => {
    const repo = new ChannelDeliveryRepository(racingDb('sending'));

    const result = await repo.reserve(INPUT);

    // Not an error and not a licence to send: the other attempt has it.
    assert.deepEqual(result, { ok: true, value: { outcome: 'inFlight' } });
  });

  it('still reports a genuine database failure as an error', async () => {
    const repo = new ChannelDeliveryRepository({
      channelDelivery: {
        findUnique: async () => null,
        create: async () => { throw new Error('disk full'); },
      },
    } as any);

    const result = await repo.reserve(INPUT);

    // Only the unique-constraint collision is a verdict; everything else is
    // still a failure the caller must hear about.
    assert.equal(result.ok, false);
  });
});
