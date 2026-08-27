import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BroadcastsRepository } from '../../src/infrastructure/persistence/broadcasts.repository.ts';

describe('BroadcastsRepository terminal monotonicity', () => {
  it('does not let a stale live poll overwrite a terminal result', async () => {
    let status = 'sending';
    let recipientWrites = 0;
    const tx = {
      whatsappBroadcast: {
        updateMany: async (args: any) => {
          const live = args.where.status.in.includes(status);
          if (!live) return { count: 0 };
          status = args.data.status;
          return { count: 1 };
        },
      },
      whatsappBroadcastRecipient: {
        updateMany: async () => { recipientWrites += 1; return { count: 1 }; },
      },
    };
    const db = {
      $transaction: async (run: (client: typeof tx) => Promise<void>) => run(tx),
    } as any;
    const repo = new BroadcastsRepository(db);

    await repo.applyBatchStatus({
      broadcastId: 'b-1', status: 'cancelled', sent: 1, failed: 0,
      completedAt: new Date(), results: [],
    });
    await repo.applyBatchStatus({
      broadcastId: 'b-1', status: 'sending', sent: 0, failed: 0,
      completedAt: null,
      results: [{ waChatId: '1@c.us', status: 'pending' }],
    });

    assert.equal(status, 'cancelled');
    assert.equal(recipientWrites, 0, 'stale recipient results are ignored too');
  });
});
