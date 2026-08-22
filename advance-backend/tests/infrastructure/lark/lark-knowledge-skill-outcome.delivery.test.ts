import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LarkKnowledgeSkillOutcomeDelivery } from '../../../src/infrastructure/channels/lark/lark-knowledge-skill-outcome.delivery.ts';
import { noopLogger } from '../../tools/tool-test.helpers.ts';

describe('Lark knowledge skill outcome delivery', () => {
  it('recovers the exact linked-authority revision and delivers a headerless card plus DM once', async () => {
    const reserved: string[] = [];
    const delivered: string[] = [];
    const cards: string[] = [];
    const messages: Array<{ openId: string; content: string; idempotencyKey?: string }> = [];
    const service = new LarkKnowledgeSkillOutcomeDelivery({
      approvals: {
        findById: async () => ({ ok: true, value: terminalRow() }),
        listDeliverableLarkSkillOutcomeIds: async () => ['decision-1'],
      },
      deliveries: {
        reserve: async input => {
          reserved.push(input.idempotencyKey);
          return {
            ok: true,
            value: {
              outcome: 'reserved',
              record: {
                deliveryId: `delivery-${reserved.length}`,
                claimAttempt: 1,
                attempts: 1,
                firstAttemptAt: new Date(),
              },
            },
          };
        },
        markDelivered: async id => { delivered.push(id); return { ok: true, value: 'applied' }; },
        markFailed: async () => ({ ok: true, value: 'applied' }),
      },
      lark: {
        updateMessageById: async (_messageId, card) => { cards.push(card); return { ok: true, value: undefined }; },
        sendDmToOpenId: async (openId, content, idempotencyKey) => {
          messages.push({ openId, content, idempotencyKey });
          return { ok: true, value: 'om_completion' };
        },
      },
      logger: noopLogger,
    } as never);

    await service.deliverPending();

    assert.deepEqual(reserved, [
      'knowledge-skill-review:decision-1:card',
      'knowledge-skill-review:decision-1:message',
    ]);
    assert.deepEqual(delivered, ['delivery-1', 'delivery-2']);
    assert.equal(JSON.parse(cards[0]!).card.includes('"header"'), false);
    assert.match(cards[0]!, /revision 2/);
    assert.deepEqual(messages.map(message => ({
      openId: message.openId,
      content: message.content,
    })), [{
      openId: 'ou_requester',
      content: 'Updated Cursor Design HTML at revision 2. Divo will use it from the next turn.',
    }]);
    assert.ok((messages[0]!.idempotencyKey?.length ?? 0) <= 50);
  });

  it('records a transient DM failure and succeeds when recovery retries it', async () => {
    let attempt = 0;
    const failures: unknown[] = [];
    const completions: string[] = [];
    const row = { ...terminalRow(), decisionMessageId: null };
    const service = new LarkKnowledgeSkillOutcomeDelivery({
      approvals: {
        findById: async () => ({ ok: true, value: row }),
        listDeliverableLarkSkillOutcomeIds: async () => ['decision-1'],
      },
      deliveries: {
        reserve: async () => {
          attempt += 1;
          return {
            ok: true,
            value: {
              outcome: 'reserved',
              record: {
                deliveryId: 'delivery-message',
                claimAttempt: attempt,
                attempts: attempt,
                firstAttemptAt: new Date(),
              },
            },
          };
        },
        markDelivered: async id => { completions.push(id); return { ok: true, value: 'applied' }; },
        markFailed: async (_id, error, options) => {
          failures.push({ error, options });
          return { ok: true, value: 'applied' };
        },
      },
      lark: {
        updateMessageById: async () => ({ ok: true, value: undefined }),
        sendDmToOpenId: async () => attempt === 1
          ? { ok: false, error: new Error('network unavailable') }
          : { ok: true, value: 'om_completion' },
      },
      logger: noopLogger,
      random: () => 0.5,
    } as never);

    await service.deliver('decision-1');
    await service.deliverPending();

    assert.equal(failures.length, 1);
    assert.equal((failures[0] as any).options.terminal, false);
    assert.ok((failures[0] as any).options.nextAttemptAt instanceof Date);
    assert.deepEqual(completions, ['delivery-message']);
  });
});

function terminalRow() {
  return {
    id: 'decision-1',
    companyId: 'company-1',
    conversationId: 'conversation-1',
    runId: 'run-1',
    toolId: 'knowledge',
    actionGroup: 'update',
    kind: 'knowledge_skill_review',
    summary: 'Update Cursor Design HTML',
    payloadJson: {},
    metadataJson: {
      sourceChannel: 'lark',
      requesterLarkOpenId: 'ou_requester',
      requesterName: 'Abhishek Verma',
    },
    status: 'consumed',
    channel: 'lark',
    requestedBy: 'user-1',
    approvedBy: 'user-1',
    approvedAt: new Date(),
    rejectedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    executionResultJson: {
      ok: true,
      status: 'success',
      data: {
        result: {
          message: 'Updated Cursor Design HTML at revision 2. Divo will use it from the next turn.',
        },
      },
    },
    responseJson: {},
    idempotencyKey: 'idem-1',
    decisionMessageId: 'om_decision',
    resolutionReason: null,
    createdAt: new Date(),
    updatedAt: new Date('2026-08-22T01:23:00.000Z'),
  };
}
