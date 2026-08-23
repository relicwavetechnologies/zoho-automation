import type { Logger } from '../../../shared/logger';
import type { ChannelIdentityRepoPort } from '../../persistence/channel-identity.repository';
import type { LarkChannelAdapter } from './lark.adapter';
import { resolveAuthenticatedCardActor } from './lark-card-actor';
import type { LarkDecisionCardHandler } from './lark-decision-card.handler';
import type { LarkDecisionActionJobPayload } from './lark-decision-action.queue';

export class LarkDecisionActionProcessor {
  private readonly log: Logger;

  constructor(private readonly deps: {
    readonly handler: LarkDecisionCardHandler;
    readonly identities: ChannelIdentityRepoPort;
    readonly lark: Pick<LarkChannelAdapter, 'sendToChatId' | 'updateMessageById'>;
    readonly logger: Logger;
  }) {
    this.log = deps.logger.child({ module: 'lark-decision-action' });
  }

  async process(payload: LarkDecisionActionJobPayload): Promise<void> {
    const actor = await resolveAuthenticatedCardActor(
      payload.cardEvent,
      payload.envelope,
      payload.eventHeader,
      this.deps.identities,
    );
    if (!actor) {
      await this.deliverError(payload.cardEvent, 'Divo could not verify this Lark action.');
      return;
    }
    const result = await this.deps.handler.handle(payload.cardEvent, {
      tenantKey: actor.tenantKey,
      openId: actor.openId,
      userId: actor.userId,
      companyId: actor.companyId,
      ...(actor.displayName ? { displayName: actor.displayName } : {}),
    });
    if (result.replaceSourceCard) {
      await this.replaceSourceCard(payload.cardEvent, result.responseBody);
      return;
    }
    const response = asRecord(result.responseBody);
    const toast = asRecord(response['toast']);
    if (toast['type'] === 'error' && typeof toast['content'] === 'string') {
      await this.deliverError(payload.cardEvent, toast['content']);
    }
  }

  async finalizeFailure(payload: LarkDecisionActionJobPayload, error: unknown): Promise<void> {
    this.log.error('decision_action.exhausted', {
      error: error instanceof Error ? error.message : String(error),
    });
    await this.deliverError(
      payload.cardEvent,
      'Divo could not complete that decision after retrying. Please try again.',
    ).catch(deliveryError => this.log.error('decision_action.failure_notice_failed', {
      error: deliveryError instanceof Error ? deliveryError.message : String(deliveryError),
    }));
  }

  private async replaceSourceCard(cardEvent: unknown, responseBody: unknown): Promise<void> {
    const response = asRecord(responseBody);
    const card = asRecord(response['card']);
    const cardData = card['type'] === 'raw' ? card['data'] : undefined;
    if (!cardData) return;
    const event = asRecord(cardEvent);
    const context = asRecord(event['context']);
    const sourceMessageId = asString(context['open_message_id']) ?? asString(event['open_message_id']);
    if (!sourceMessageId) throw new Error('Decision card callback is missing its source message ID.');
    const updated = await this.deps.lark.updateMessageById(
      sourceMessageId,
      JSON.stringify({ msg_type: 'interactive', card: cardData }),
    );
    if (!updated.ok) throw updated.error;
  }

  private async deliverError(cardEvent: unknown, content: string): Promise<void> {
    const event = asRecord(cardEvent);
    const chatId = asString(asRecord(event['context'])['open_chat_id']);
    if (!chatId) throw new Error('Decision card callback is missing its chat ID.');
    const sent = await this.deps.lark.sendToChatId(chatId, content);
    if (!sent.ok) throw sent.error;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
