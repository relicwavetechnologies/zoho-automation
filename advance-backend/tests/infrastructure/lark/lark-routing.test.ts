import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from '../../../src/domain/channel/incoming-message.ts';
import {
  buildLarkDeliveryTarget,
  buildLarkExecutionLaneKey,
  buildLarkRoutingKeys,
} from '../../../src/infrastructure/channels/lark/lark-routing.ts';
import { asChatId, asCorrelationId, asMessageId } from '../../../src/shared/ids.ts';

function incoming(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    channel: 'lark',
    messageId: asMessageId('om_trigger'),
    chatId: asChatId('oc_room'),
    chatType: 'group',
    tenantKey: 'tenant-1',
    appId: 'app-1',
    userExternalId: 'ou_alice',
    senderType: 'user',
    text: 'help',
    attachments: [],
    timestamp: '2026-07-25T00:00:00.000Z',
    traceId: asCorrelationId('corr-1'),
    mentions: [],
    mentionsSelf: true,
    raw: {},
    ...overrides,
  };
}

describe('Lark routing keys', () => {
  it('keeps one user on the same runtime lane across group threads', () => {
    const first = buildLarkExecutionLaneKey({
      companyId: 'company-1',
      userId: 'user-1',
    });
    const second = buildLarkExecutionLaneKey({
      companyId: 'company-1',
      userId: 'user-1',
    });
    assert.equal(first, second);
  });

  it('separates different users in the same company', () => {
    const alice = buildLarkExecutionLaneKey({
      companyId: 'company-1',
      userId: 'user-alice',
    });
    const bob = buildLarkExecutionLaneKey({
      companyId: 'company-1',
      userId: 'user-bob',
    });
    assert.notEqual(alice, bob);
  });

  it('keeps inline group turns on the requester lane and out of threads', () => {
    const first = buildLarkRoutingKeys({
      companyId: 'company-1',
      userId: 'user-alice',
      incoming: incoming({
        messageId: asMessageId('om_1'),
        userExternalId: 'ou_alice',
        groupReplyMode: 'inline',
      }),
    });
    const second = buildLarkRoutingKeys({
      companyId: 'company-1',
      userId: 'user-alice',
      incoming: incoming({
        messageId: asMessageId('om_2'),
        userExternalId: 'ou_alice',
        groupReplyMode: 'inline',
      }),
    });

    assert.equal(first.executionLaneKey, second.executionLaneKey);
    assert.equal(first.deliveryTarget.replyInThread, false);
  });

  it('keeps different users in one thread on separate lanes', () => {
    const alice = buildLarkExecutionLaneKey({
      companyId: 'company-1',
      userId: 'user-alice',
    });
    const bob = buildLarkExecutionLaneKey({
      companyId: 'company-1',
      userId: 'user-bob',
    });
    assert.notEqual(alice, bob);
  });

  it('keeps one user stable across rooms and threads', () => {
    const first = buildLarkExecutionLaneKey({
      companyId: 'company-1',
      userId: 'user-alice',
    });
    const second = buildLarkExecutionLaneKey({
      companyId: 'company-1',
      userId: 'user-alice',
    });
    assert.equal(first, second);
  });

  it('includes company identity in the runtime lane', () => {
    const first = buildLarkExecutionLaneKey({
      companyId: 'company-1',
      userId: 'user-alice',
    });
    const second = buildLarkExecutionLaneKey({
      companyId: 'company-2',
      userId: 'user-alice',
    });
    assert.notEqual(first, second);
  });

  it('anchors delivery to the trigger and thread, never the direct parent', () => {
    const base = incoming({
      messageId: asMessageId('om_trigger'),
      parentMessageId: asMessageId('om_parent_1'),
      rootMessageId: asMessageId('om_root'),
      threadId: 'omt_1',
    });
    const first = buildLarkDeliveryTarget({ companyId: 'company-1', incoming: base });
    const changedParent = buildLarkDeliveryTarget({
      companyId: 'company-1',
      incoming: { ...base, parentMessageId: asMessageId('om_parent_2') },
    });
    const changedTrigger = buildLarkDeliveryTarget({
      companyId: 'company-1',
      incoming: { ...base, messageId: asMessageId('om_trigger_2') },
    });

    assert.equal(first.key, changedParent.key);
    assert.notEqual(first.key, changedTrigger.key);
    assert.deepEqual(first.target, {
      chatId: 'oc_room',
      triggeringMessageId: 'om_trigger',
      rootMessageId: 'om_root',
      threadId: 'omt_1',
      replyInThread: true,
    });
  });

  it('includes company and installation identity in the room key', () => {
    const keys = buildLarkRoutingKeys({
      companyId: 'company-1',
      userId: 'user-alice',
      incoming: incoming(),
    });
    assert.equal(
      keys.roomKey,
      '["lark","room","company-1","tenant-1","app-1","oc_room"]',
    );
  });
});
