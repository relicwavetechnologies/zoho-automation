import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ScheduledDesktopChannelAdapter } from '../../src/infrastructure/channels/desktop/scheduled-desktop.adapter.ts';
import { asChatId, asCorrelationId } from '../../src/shared/ids.ts';
import type { Logger } from '../../src/shared/logger.ts';

const noopLogger: Logger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => noopLogger,
};

describe('ScheduledDesktopChannelAdapter', () => {
  it('persists a completed background result in the originating desktop conversation', async () => {
    let messageData: Record<string, unknown> | null = null;
    let threadUpdate: Record<string, unknown> | null = null;
    const tx = {
      desktopMessage: {
        create: async ({ data }: any) => {
          messageData = data;
          return { id: 'message-1' };
        },
      },
      desktopThread: {
        update: async (args: any) => {
          threadUpdate = args;
          return {};
        },
      },
    };
    const adapter = new ScheduledDesktopChannelAdapter({
      prisma: {
        ...tx,
        $transaction: async (fn: any) => fn(tx),
      } as never,
      logger: noopLogger,
    });

    const result = await adapter.sendFinalReply({
      channel: 'desktop',
      chatId: asChatId('thread-1'),
      correlationId: asCorrelationId('schedule-run-1'),
    }, {
      kind: 'final',
      text: 'Three exceptions need review.',
      format: 'markdown',
    });

    assert.equal(result.ok, true);
    assert.deepEqual(messageData, {
      threadId: 'thread-1',
      role: 'assistant',
      content: 'Three exceptions need review.',
      metadata: { format: 'markdown', source: 'scheduled_workflow' },
    });
    assert.equal((threadUpdate as any).where.id, 'thread-1');
    assert.ok((threadUpdate as any).data.lastMessageAt instanceof Date);
  });
});
