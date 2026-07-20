import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ScheduledLarkDmChannelAdapter } from '../../src/infrastructure/channels/lark/scheduled-lark-dm.adapter.ts';
import { asChatId, asCorrelationId } from '../../src/shared/ids.ts';
import type { Logger } from '../../src/shared/logger.ts';

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
};

describe('ScheduledLarkDmChannelAdapter', () => {
  it('sends the final result to the authenticated creator by open_id', async () => {
    const sends: Array<{ openId: string; content: string }> = [];
    const adapter = new ScheduledLarkDmChannelAdapter({
      client: {
        sendCardToOpenId: async (openId, content) => {
          sends.push({ openId, content });
          return { messageId: 'om_1' };
        },
      },
      logger: noopLogger,
    });

    const result = await adapter.sendFinalReply({
      channel: 'lark',
      chatId: asChatId('ou_creator'),
      correlationId: asCorrelationId('sched-run-1'),
    }, {
      kind: 'final',
      text: '# Daily summary\n\nTwo messages need attention.',
      format: 'markdown',
    });

    assert.equal(result.ok, true);
    assert.equal((result as any).value.messageId, 'om_1');
    assert.equal(sends.length, 1);
    assert.equal(sends[0]?.openId, 'ou_creator');
    assert.match(sends[0]?.content ?? '', /Daily summary/);
  });
});
