import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LarkIngressWorker } from '../../../src/application/lark-ingress/lark-ingress.worker.ts';
import { ok } from '../../../src/shared/result.ts';
import type { Logger } from '../../../src/shared/logger.ts';

const noopLogger: Logger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  child: () => noopLogger,
};

describe('LarkIngressWorker', () => {
  it('completes a claimed durable receipt only after processing finishes', async () => {
    const events: string[] = [];
    const receipt = {
      receiptId: 'receipt-1',
      tenantKey: 'tenant-1',
      messageId: 'message-1',
      payload: {},
      attempts: 1,
      acceptedAt: new Date(),
    };
    const worker = new LarkIngressWorker({
      redisUrl: 'redis://unused',
      queue: {} as any,
      receiptRepo: {
        claim: async () => {
          events.push('claim');
          return ok({ outcome: 'claimed', receipt });
        },
        markCompleted: async () => {
          events.push('complete');
          return ok(undefined);
        },
        markFailed: async () => ok(undefined),
      } as any,
      processReceipt: async () => {
        events.push('process');
      },
      logger: noopLogger,
    });

    await worker.process({ data: { receiptId: 'receipt-1' } } as any);

    assert.deepEqual(events, ['claim', 'process', 'complete']);
  });

  it('persists failure and rethrows so BullMQ can retry', async () => {
    const error = new Error('provider unavailable');
    let failedWith: unknown;
    const worker = new LarkIngressWorker({
      redisUrl: 'redis://unused',
      queue: {} as any,
      receiptRepo: {
        claim: async () => ok({
          outcome: 'claimed',
          receipt: {
            receiptId: 'receipt-1',
            tenantKey: 'tenant-1',
            messageId: 'message-1',
            payload: {},
            attempts: 1,
            acceptedAt: new Date(),
          },
        }),
        markCompleted: async () => ok(undefined),
        markFailed: async (_receiptId: string, value: unknown) => {
          failedWith = value;
          return ok(undefined);
        },
      } as any,
      processReceipt: async () => {
        throw error;
      },
      logger: noopLogger,
    });

    await assert.rejects(
      worker.process({ data: { receiptId: 'receipt-1' } } as any),
      error,
    );
    assert.equal(failedWith, error);
  });

  const failingWorker = (acceptedAt: Date, capture: (options: unknown) => void) =>
    new LarkIngressWorker({
      redisUrl: 'redis://unused',
      queue: {} as any,
      receiptRepo: {
        claim: async () => ok({
          outcome: 'claimed',
          receipt: {
            receiptId: 'receipt-1',
            tenantKey: 'tenant-1',
            messageId: 'message-1',
            payload: {},
            attempts: 40,
            acceptedAt,
          },
        }),
        markCompleted: async () => ok(undefined),
        markFailed: async (_id: string, _error: unknown, options: unknown) => {
          capture(options);
          return ok(undefined);
        },
      } as any,
      processReceipt: async () => { throw new Error('provider unavailable'); },
      retryWindowMs: 60_000,
      logger: noopLogger,
    });

  it('keeps a receipt retryable inside its window however many attempts it burned', async () => {
    let failedOptions: unknown;
    // 40 attempts already spent: an attempt-counted budget would have dropped
    // this message, but a provider outage seconds old must stay recoverable.
    const worker = failingWorker(new Date(Date.now() - 5_000), o => { failedOptions = o; });

    await assert.rejects(worker.process({ data: { receiptId: 'receipt-1' } } as any));

    assert.deepEqual(failedOptions, { terminal: false });
  });

  it('dead-letters a receipt once its retry window has elapsed', async () => {
    let failedOptions: unknown;
    const worker = failingWorker(new Date(Date.now() - 120_000), o => { failedOptions = o; });

    await assert.rejects(worker.process({ data: { receiptId: 'receipt-1' } } as any));

    assert.deepEqual(failedOptions, { terminal: true });
  });

  it('retires receipts stranded past the window instead of leaving them invisible', async () => {
    const retired: Array<{ id: string; options: unknown }> = [];
    const recovered: string[] = [];
    const worker = new LarkIngressWorker({
      redisUrl: 'redis://unused',
      queue: { recover: async (id: string) => { recovered.push(id); return id; } } as any,
      receiptRepo: {
        listExhausted: async () => ok(['receipt-stranded']),
        listRecoverable: async () => ok(['receipt-live']),
        markFailed: async (id: string, _error: unknown, options: unknown) => {
          retired.push({ id, options });
          return ok(undefined);
        },
      } as any,
      processReceipt: async () => {},
      retryWindowMs: 60_000,
      logger: noopLogger,
    });

    await worker.reconcile();

    assert.deepEqual(retired, [{ id: 'receipt-stranded', options: { terminal: true } }]);
    assert.deepEqual(recovered, ['receipt-live']);
  });

  it('completes the job for a receipt another attempt already finished', async () => {
    let processed = false;
    const worker = new LarkIngressWorker({
      redisUrl: 'redis://unused',
      queue: {} as any,
      receiptRepo: {
        claim: async () => ok({ outcome: 'terminal' }),
      } as any,
      processReceipt: async () => { processed = true; },
      logger: noopLogger,
    });

    await worker.process({ data: { receiptId: 'receipt-1' } } as any);

    assert.equal(processed, false);
  });

  it('fails the job when another worker holds the lease, so it is retried', async () => {
    let processed = false;
    const worker = new LarkIngressWorker({
      redisUrl: 'redis://unused',
      queue: {} as any,
      receiptRepo: {
        claim: async () => ok({ outcome: 'leased' }),
      } as any,
      processReceipt: async () => { processed = true; },
      logger: noopLogger,
    });

    // Returning normally here would complete the BullMQ job, and `recover`
    // only re-drives failed jobs — so a worker killed mid-run would leave the
    // receipt unreachable and the user's message silently unanswered.
    await assert.rejects(
      worker.process({ data: { receiptId: 'receipt-1' } } as any),
      /leased by another worker/,
    );
    assert.equal(processed, false);
  });

  it('scopes both recovery queries to the same retry window', async () => {
    const listedOptions: unknown[] = [];
    const worker = new LarkIngressWorker({
      redisUrl: 'redis://unused',
      queue: { recover: async (id: string) => id } as any,
      receiptRepo: {
        listExhausted: async (_limit: number, options: unknown) => {
          listedOptions.push(options);
          return ok([]);
        },
        listRecoverable: async (_limit: number, options: unknown) => {
          listedOptions.push(options);
          return ok([]);
        },
      } as any,
      processReceipt: async () => {},
      retryWindowMs: 7_000,
      logger: noopLogger,
    });

    await worker.reconcile();

    // A window mismatch would leave receipts in neither set — retried by
    // nobody and retired by nobody.
    assert.deepEqual(listedOptions, [{ retryWindowMs: 7_000 }, { retryWindowMs: 7_000 }]);
  });

  it('recovers every unfinished or failed receipt with stable queue identity', async () => {
    const recovered: string[] = [];
    const worker = new LarkIngressWorker({
      redisUrl: 'redis://unused',
      queue: {
        recover: async (receiptId: string) => {
          recovered.push(receiptId);
          return `lark_ingress_${receiptId}`;
        },
      } as any,
      receiptRepo: {
        listExhausted: async () => ok([]),
        listRecoverable: async () => ok(['receipt-1', 'receipt-2']),
      } as any,
      processReceipt: async () => {},
      logger: noopLogger,
    });

    await worker.reconcile();

    assert.deepEqual(recovered, ['receipt-1', 'receipt-2']);
  });
});
