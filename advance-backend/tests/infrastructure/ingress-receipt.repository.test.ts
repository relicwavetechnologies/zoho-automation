import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IngressReceiptRepository } from '../../src/infrastructure/persistence/ingress-receipt.repository.ts';

describe('IngressReceiptRepository', () => {
  it('stores a tenant-scoped payload for a new delivery', async () => {
    let createInput: unknown;
    const repo = new IngressReceiptRepository({
      ingressIdempotencyKey: {
        create: async (input: unknown) => {
          createInput = input;
          return { id: 'receipt-1' };
        },
      },
    } as any);

    const result = await repo.accept({
      channel: 'lark',
      tenantKey: 'tenant-1',
      eventId: 'event-1',
      messageId: 'message-1',
      payload: { header: { event_id: 'event-1' } },
    });

    assert.deepEqual(result, {
      ok: true,
      value: { receiptId: 'receipt-1', isNew: true },
    });
    assert.deepEqual(createInput, {
      data: {
        channel: 'lark',
        tenantKey: 'tenant-1',
        eventId: 'event-1',
        messageId: 'message-1',
        payloadJson: { header: { event_id: 'event-1' } },
      },
      select: { id: true },
    });
  });

  it('returns the existing tenant-scoped receipt after a unique race', async () => {
    let lookup: unknown;
    const repo = new IngressReceiptRepository({
      ingressIdempotencyKey: {
        create: async () => {
          throw Object.assign(new Error('duplicate'), { code: 'P2002' });
        },
        findUnique: async (input: unknown) => {
          lookup = input;
          return { id: 'receipt-existing' };
        },
      },
    } as any);

    const result = await repo.accept({
      channel: 'lark',
      tenantKey: 'tenant-2',
      messageId: 'message-1',
      payload: {},
    });

    assert.deepEqual(result, {
      ok: true,
      value: { receiptId: 'receipt-existing', isNew: false },
    });
    assert.deepEqual(lookup, {
      where: {
        channel_tenantKey_messageId: {
          channel: 'lark',
          tenantKey: 'tenant-2',
          messageId: 'message-1',
        },
      },
      select: { id: true },
    });
  });

  it('keeps a failed duplicate lookup inside the repository error boundary', async () => {
    const repo = new IngressReceiptRepository({
      ingressIdempotencyKey: {
        create: async () => {
          throw Object.assign(new Error('duplicate'), { code: 'P2002' });
        },
        findUnique: async () => {
          throw new Error('database unavailable');
        },
      },
    } as any);

    const result = await repo.accept({
      channel: 'lark',
      tenantKey: 'tenant-1',
      messageId: 'message-1',
      payload: {},
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.payload.op, 'ingressReceipt.findDuplicate');
      assert.equal(result.error.message, 'database unavailable');
    }
  });

  it('atomically claims unfinished work and exposes its persisted payload', async () => {
    let updateInput: unknown;
    const repo = new IngressReceiptRepository({
      ingressIdempotencyKey: {
        updateMany: async (input: unknown) => {
          updateInput = input;
          return { count: 1 };
        },
        findUnique: async () => ({
          id: 'receipt-1',
          tenantKey: 'tenant-1',
          messageId: 'message-1',
          payloadJson: { header: { event_id: 'event-1' } },
          attempts: 3,
          acceptedAt: new Date('2026-07-25T10:00:00Z'),
        }),
      },
    } as any);

    const result = await repo.claim('receipt-1', { staleProcessingAfterMs: 60_000 });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.value, {
        outcome: 'claimed',
        receipt: {
          receiptId: 'receipt-1',
          tenantKey: 'tenant-1',
          messageId: 'message-1',
          payload: { header: { event_id: 'event-1' } },
          attempts: 3,
          acceptedAt: new Date('2026-07-25T10:00:00Z'),
        },
      });
    }
    const where = (updateInput as any).where;
    assert.equal(where.id, 'receipt-1');
    assert.deepEqual(where.status, { notIn: ['completed', 'dead'] });
    assert.deepEqual((updateInput as any).data, {
      status: 'processing',
      attempts: { increment: 1 },
      startedAt: (updateInput as any).data.startedAt,
      lastError: null,
    });
    assert.ok((updateInput as any).data.startedAt instanceof Date);
  });

  it('reports a live lease distinctly from a finished receipt', async () => {
    let updateInput: unknown;
    const repo = new IngressReceiptRepository({
      ingressIdempotencyKey: {
        updateMany: async (input: unknown) => {
          updateInput = input;
          return { count: 0 };
        },
        findUnique: async () => ({ status: 'processing' }),
      },
    } as any);

    const result = await repo.claim('receipt-1', { staleProcessingAfterMs: 60_000 });

    // The caller must be able to tell these apart: a finished receipt means the
    // job may complete, a leased one means it must be retried instead.
    assert.deepEqual(result, { ok: true, value: { outcome: 'leased' } });
    // The lease predicate is what makes a second claim fail: a `processing` row
    // is only re-claimable once its owner has gone silent past the threshold.
    const or = (updateInput as any).where.OR;
    assert.deepEqual(or[0], { status: { not: 'processing' } });
    assert.deepEqual(or[1], { startedAt: null });
    assert.ok(or[2].startedAt.lt instanceof Date);
    assert.ok(or[2].startedAt.lt.getTime() <= Date.now() - 60_000);
  });

  it('reports a completed or dead receipt as terminal', async () => {
    const repo = new IngressReceiptRepository({
      ingressIdempotencyKey: {
        updateMany: async () => ({ count: 0 }),
        findUnique: async () => ({ status: 'dead' }),
      },
    } as any);

    const result = await repo.claim('receipt-1');

    assert.deepEqual(result, { ok: true, value: { outcome: 'terminal' } });
  });

  it('refuses to resurrect a dead receipt with a retryable failure', async () => {
    let updateInput: unknown;
    const repo = new IngressReceiptRepository({
      ingressIdempotencyKey: {
        updateMany: async (input: unknown) => {
          updateInput = input;
          return { count: 0 };
        },
      },
    } as any);

    await repo.markFailed('receipt-1', new Error('provider blip'), { terminal: false });

    assert.deepEqual((updateInput as any).where.status, { notIn: ['completed', 'dead'] });
  });

  it('excludes receipts a live worker still holds from retirement', async () => {
    let findInput: unknown;
    const repo = new IngressReceiptRepository({
      ingressIdempotencyKey: {
        findMany: async (input: unknown) => {
          findInput = input;
          return [];
        },
      },
    } as any);

    await repo.listExhausted(100, { retryWindowMs: 60_000, staleProcessingAfterMs: 30_000 });

    // A long turn crossing the window boundary must not be logged as dead while
    // it is still running and about to overwrite that status with its outcome.
    const or = (findInput as any).where.OR;
    assert.deepEqual(or[0], { status: { not: 'processing' } });
    assert.deepEqual(or[1], { startedAt: null });
    assert.ok(or[2].startedAt.lt instanceof Date);
  });

  it('lists accepted, interrupted, and failed Lark receipts for recovery', async () => {
    let findInput: unknown;
    const repo = new IngressReceiptRepository({
      ingressIdempotencyKey: {
        findMany: async (input: unknown) => {
          findInput = input;
          return [{ id: 'receipt-1' }, { id: 'receipt-2' }];
        },
      },
    } as any);

    const result = await repo.listRecoverable(50);

    assert.deepEqual(result, { ok: true, value: ['receipt-1', 'receipt-2'] });
    const input = findInput as any;
    assert.equal(input.take, 50);
    assert.deepEqual(input.orderBy, { acceptedAt: 'asc' });
    assert.deepEqual(input.select, { id: true });
    assert.equal(input.where.channel, 'lark');
    assert.deepEqual(input.where.status, { in: ['accepted', 'processing', 'failed'] });
    assert.ok(input.where.acceptedAt.gte instanceof Date);
  });

  it('excludes receipts past their retry window so poison rows cannot starve recovery', async () => {
    let findInput: unknown;
    const repo = new IngressReceiptRepository({
      ingressIdempotencyKey: {
        findMany: async (input: unknown) => {
          findInput = input;
          return [];
        },
      },
    } as any);

    await repo.listRecoverable(100, { retryWindowMs: 60_000 });

    const where = (findInput as any).where;
    assert.equal(where.channel, 'lark');
    assert.deepEqual(where.status, { in: ['accepted', 'processing', 'failed'] });
    assert.ok(where.acceptedAt.gte instanceof Date);
    assert.ok(where.acceptedAt.gte.getTime() <= Date.now() - 60_000);
  });

  it('surfaces stranded receipts past the window so they can be retired', async () => {
    let findInput: unknown;
    const repo = new IngressReceiptRepository({
      ingressIdempotencyKey: {
        findMany: async (input: unknown) => {
          findInput = input;
          return [{ id: 'receipt-stranded' }];
        },
      },
    } as any);

    const result = await repo.listExhausted(100, { retryWindowMs: 60_000 });

    assert.deepEqual(result, { ok: true, value: ['receipt-stranded'] });
    const where = (findInput as any).where;
    // Deliberately the complement of listRecoverable: a receipt a killed worker
    // left in `processing` is past saving by retry but must not stay invisible.
    assert.deepEqual(where.status, { in: ['accepted', 'processing', 'failed'] });
    assert.ok(where.acceptedAt.lt instanceof Date);
  });

  it('dead-letters a terminal failure instead of leaving it retryable', async () => {
    let updateInput: unknown;
    const repo = new IngressReceiptRepository({
      ingressIdempotencyKey: {
        updateMany: async (input: unknown) => {
          updateInput = input;
          return { count: 1 };
        },
      },
    } as any);

    await repo.markFailed('receipt-1', new Error('payload permanently invalid'), {
      terminal: true,
    });

    assert.deepEqual((updateInput as any).data, {
      status: 'dead',
      lastError: 'payload permanently invalid',
    });
  });

  it('never overwrites a receipt that another attempt already completed', async () => {
    let updateInput: unknown;
    const repo = new IngressReceiptRepository({
      ingressIdempotencyKey: {
        updateMany: async (input: unknown) => {
          updateInput = input;
          return { count: 0 };
        },
      },
    } as any);

    const result = await repo.markFailed('receipt-1', new Error('completion response lost'));

    assert.deepEqual(result, { ok: true, value: undefined });
    assert.deepEqual(updateInput, {
      where: {
        id: 'receipt-1',
        status: { notIn: ['completed', 'dead'] },
      },
      data: {
        status: 'failed',
        lastError: 'completion response lost',
      },
    });
  });
});
