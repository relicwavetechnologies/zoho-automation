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
        }),
      },
    } as any);

    const result = await repo.claim('receipt-1');

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.value, {
        receiptId: 'receipt-1',
        tenantKey: 'tenant-1',
        messageId: 'message-1',
        payload: { header: { event_id: 'event-1' } },
      });
    }
    assert.deepEqual(updateInput, {
      where: { id: 'receipt-1', status: { not: 'completed' } },
      data: {
        status: 'processing',
        attempts: { increment: 1 },
        startedAt: updateInput && (updateInput as any).data.startedAt,
        lastError: null,
      },
    });
    assert.ok((updateInput as any).data.startedAt instanceof Date);
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
    assert.deepEqual(findInput, {
      where: {
        channel: 'lark',
        status: { in: ['accepted', 'processing', 'failed'] },
      },
      orderBy: { acceptedAt: 'asc' },
      take: 50,
      select: { id: true },
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
        status: { not: 'completed' },
      },
      data: {
        status: 'failed',
        lastError: 'completion response lost',
      },
    });
  });
});
