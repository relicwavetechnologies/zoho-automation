import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BroadcastsRepository } from '../../src/infrastructure/persistence/broadcasts.repository.ts';

describe('BroadcastsRepository progress monotonicity', () => {
  it('does not let a stale live poll overwrite a terminal result', async () => {
    let status = 'sending';
    let sent = 0;
    let failed = 0;
    let recipientWrites = 0;
    const tx = {
      $queryRaw: async () => [{ lock_result: '' }],
      whatsappBroadcast: {
        findUnique: async () => ({ status, sent, failed }),
        updateMany: async (args: any) => {
          if (args.where.status !== status) return { count: 0 };
          status = args.data.status;
          sent = args.data.sent;
          failed = args.data.failed;
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

  it('does not let a stale pending poll move sending back to queued', async () => {
    let status = 'queued';
    let sent = 0;
    let failed = 0;
    let recipientWrites = 0;
    const tx = {
      $queryRaw: async () => [{ lock_result: '' }],
      whatsappBroadcast: {
        findUnique: async () => ({ status, sent, failed }),
        updateMany: async (args: any) => {
          if (args.where.status !== status) return { count: 0 };
          status = args.data.status;
          sent = args.data.sent;
          failed = args.data.failed;
          return { count: 1 };
        },
      },
      whatsappBroadcastRecipient: {
        updateMany: async () => { recipientWrites += 1; return { count: 1 }; },
      },
    };
    const repo = new BroadcastsRepository({
      $transaction: async (run: (client: typeof tx) => Promise<void>) => run(tx),
    } as any);

    await repo.applyBatchStatus({
      broadcastId: 'b-1', status: 'sending', sent: 1, failed: 0,
      completedAt: null,
      results: [{ waChatId: '1@c.us', status: 'sent' }],
    });
    await repo.applyBatchStatus({
      broadcastId: 'b-1', status: 'queued', sent: 0, failed: 0,
      completedAt: null,
      results: [{ waChatId: '1@c.us', status: 'pending' }],
    });

    assert.equal(status, 'sending');
    assert.equal(recipientWrites, 1, 'the stale pending result is ignored');
  });

  it('does not let an older sending snapshot lower counters or recipient state', async () => {
    let status = 'sending';
    let sent = 0;
    let failed = 0;
    let recipientStatus = 'pending';
    const tx = {
      $queryRaw: async () => [{ lock_result: '' }],
      whatsappBroadcast: {
        findUnique: async () => ({ status, sent, failed }),
        updateMany: async (args: any) => {
          if (args.where.status !== status) return { count: 0 };
          status = args.data.status;
          sent = args.data.sent;
          failed = args.data.failed;
          return { count: 1 };
        },
      },
      whatsappBroadcastRecipient: {
        updateMany: async (args: any) => {
          if (!args.where.status.in.includes(recipientStatus)) return { count: 0 };
          recipientStatus = args.data.status;
          return { count: 1 };
        },
      },
    };
    const repo = new BroadcastsRepository({
      $transaction: async (run: (client: typeof tx) => Promise<void>) => run(tx),
    } as any);

    await repo.applyBatchStatus({
      broadcastId: 'b-1', status: 'sending', sent: 10, failed: 0,
      completedAt: null,
      results: [{ waChatId: '1@c.us', status: 'sent' }],
    });
    await repo.applyBatchStatus({
      broadcastId: 'b-1', status: 'sending', sent: 5, failed: 0,
      completedAt: null,
      results: [{ waChatId: '1@c.us', status: 'pending' }],
    });

    assert.equal(status, 'sending');
    assert.equal(sent, 10);
    assert.equal(recipientStatus, 'sent');
  });
});
