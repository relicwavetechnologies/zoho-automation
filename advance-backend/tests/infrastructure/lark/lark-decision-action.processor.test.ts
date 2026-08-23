import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LarkDecisionActionProcessor } from '../../../src/infrastructure/channels/lark/lark-decision-action.processor.ts';
import { noopLogger } from '../../tools/tool-test.helpers.ts';

const payload = {
  envelope: {
    header: { event_type: 'card.action.trigger', tenant_key: 'tenant-1' },
    event: { operator: { open_id: 'ou_requester' } },
  },
  eventHeader: { tenant_key: 'tenant-1', event_id: 'event-1' },
  cardEvent: {
    operator: { open_id: 'ou_requester' },
    context: { open_chat_id: 'oc_dm', open_message_id: 'om_decision' },
    action: { value: { kind: 'decision_answer' } },
  },
};

describe('Lark Decision action processor', () => {
  it('replaces the source card only for the next unanswered question', async () => {
    const updates: string[] = [];
    const processor = setup({
      replaceSourceCard: true,
      responseBody: {
        card: {
          type: 'raw',
          data: { schema: '2.0', body: { elements: [] } },
        },
      },
    }, updates);

    await processor.process(payload);

    assert.deepEqual(updates, ['om_decision']);
  });

  it('leaves terminal card delivery to the recoverable outcome owner', async () => {
    const updates: string[] = [];
    const processor = setup({
      replaceSourceCard: false,
      responseBody: {
        card: {
          type: 'raw',
          data: { schema: '2.0', body: { elements: [] } },
        },
      },
    }, updates);

    await processor.process(payload);

    assert.deepEqual(updates, []);
  });
});

function setup(
  handlerResult: { replaceSourceCard: boolean; responseBody: unknown },
  updates: string[],
) {
  return new LarkDecisionActionProcessor({
    handler: {
      handle: async () => handlerResult,
    },
    identities: {
      resolveByLarkTenantIdentity: async () => ({
        ok: true,
        value: {
          userId: 'user-1',
          companyId: 'company-1',
          aiRole: 'MEMBER',
          channel: 'lark',
          larkOpenId: 'ou_requester',
        },
      }),
    },
    lark: {
      updateMessageById: async (messageId: string) => {
        updates.push(messageId);
        return { ok: true, value: undefined };
      },
      sendToChatId: async () => ({ ok: true, value: 'om_error' }),
    },
    logger: noopLogger,
  } as never);
}
