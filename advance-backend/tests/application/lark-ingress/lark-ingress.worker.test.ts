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
    };
    const worker = new LarkIngressWorker({
      redisUrl: 'redis://unused',
      queue: {} as any,
      receiptRepo: {
        claim: async () => {
          events.push('claim');
          return ok(receipt);
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
          receiptId: 'receipt-1',
          tenantKey: 'tenant-1',
          messageId: 'message-1',
          payload: {},
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
        listRecoverable: async () => ok(['receipt-1', 'receipt-2']),
      } as any,
      processReceipt: async () => {},
      logger: noopLogger,
    });

    await worker.reconcile();

    assert.deepEqual(recovered, ['receipt-1', 'receipt-2']);
  });
});
