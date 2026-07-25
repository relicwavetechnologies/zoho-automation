import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendLarkMentionContext,
  buildLarkMentionContext,
} from '../../../src/infrastructure/channels/lark/lark-mention-context.ts';
import type { IncomingMessage } from '../../../src/domain/channel/incoming-message.ts';
import { asChatId, asCorrelationId, asMessageId } from '../../../src/shared/ids.ts';

describe('Lark mention context', () => {
  it('preserves exact human IDs while excluding the bot and @all', () => {
    const context = buildLarkMentionContext([
      { key: '@_bot', openId: 'ou_bot', name: 'Divo', isSelf: true },
      {
        key: '@_all',
        openId: 'ou_all',
        userId: 'on_all',
        unionId: 'un_all',
        name: 'all',
        isSelf: false,
      },
      {
        key: '@_alice',
        openId: 'ou_alice',
        userId: 'on_alice',
        unionId: 'un_alice',
        name: 'Alice',
        isSelf: false,
      },
    ]);

    assert.match(context, /"openId":"ou_alice"/);
    assert.match(context, /"userId":"on_alice"/);
    assert.match(context, /"unionId":"un_alice"/);
    assert.doesNotMatch(context, /ou_bot/);
    assert.doesNotMatch(context, /ou_all|on_all|un_all/);
    assert.match(context, /do not change requester identity, permissions, or approval authority/);
  });

  it('returns the original message when no usable human identity exists', () => {
    const message: IncomingMessage = {
      channel: 'lark',
      messageId: asMessageId('om_1'),
      chatId: asChatId('oc_1'),
      chatType: 'group',
      userExternalId: 'ou_requester',
      text: 'hello',
      attachments: [],
      timestamp: '2026-07-25T00:00:00.000Z',
      traceId: asCorrelationId('corr-1'),
      mentions: [{ key: '@_bot', openId: 'ou_bot', name: 'Divo', isSelf: true }],
      mentionsSelf: true,
      raw: {},
    };

    assert.equal(appendLarkMentionContext(message), message);
  });
});
