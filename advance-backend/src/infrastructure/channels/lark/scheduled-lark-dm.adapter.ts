import type {
  ChannelAdapter,
  ConversationHandle,
  ReplyHandle,
  StatusHandle,
} from '../../../application/channels/channel.adapter';
import type { IncomingMessage } from '../../../domain/channel/incoming-message';
import type { FinalReply, StatusUpdate } from '../../../domain/channel/outbound';
import { ChannelError } from '../../../shared/errors';
import { asMessageId } from '../../../shared/ids';
import type { Logger } from '../../../shared/logger';
import { err, ok, type Result } from '../../../shared/result';
import { planFinalCards } from './lark-card.builder';

export interface ScheduledLarkDmClient {
  sendCardToOpenId(openId: string, cardContent: string): Promise<{ messageId: string }>;
}

/**
 * Headless Lark delivery for scheduled work created outside a Lark chat.
 * The conversation chatId is deliberately the authenticated creator's open_id;
 * this adapter is the only boundary that interprets it as an open_id rather
 * than a chat_id.
 */
export class ScheduledLarkDmChannelAdapter implements ChannelAdapter {
  readonly key = 'lark' as const;

  constructor(private readonly deps: {
    client: ScheduledLarkDmClient;
    logger: Logger;
  }) {}

  parseIncoming(): Result<IncomingMessage, ChannelError> {
    return err(new ChannelError({
      channel: 'lark',
      stage: 'parse_incoming',
      reason: 'not_supported',
      message: 'Scheduled Lark DM messages are constructed by the scheduler.',
    }));
  }

  async sendStatus(
    conversation: ConversationHandle,
    _update: StatusUpdate,
  ): Promise<Result<StatusHandle, ChannelError>> {
    return ok({
      channel: 'lark',
      messageId: asMessageId(`scheduled-status-${String(conversation.correlationId)}`),
      correlationId: conversation.correlationId,
    });
  }

  async editStatus(
    handle: StatusHandle,
    _update: StatusUpdate,
  ): Promise<Result<StatusHandle, ChannelError>> {
    return ok(handle);
  }

  async sendFinalReply(
    conversation: ConversationHandle,
    reply: FinalReply,
  ): Promise<Result<ReplyHandle, ChannelError>> {
    try {
      let firstMessageId = '';
      for (const segment of planFinalCards({
        markdown: reply.text,
        ...(reply.branding ? { branding: reply.branding } : {}),
        ...(reply.actions ? { actions: reply.actions } : {}),
        ...(reply.executionTrace ? { executionTrace: reply.executionTrace } : {}),
      })) {
        const sent = await this.deps.client.sendCardToOpenId(
          String(conversation.chatId),
          segment.payload,
        );
        firstMessageId ||= sent.messageId;
      }
      return ok({ channel: 'lark', messageId: asMessageId(firstMessageId) });
    } catch (error) {
      this.deps.logger.error('scheduled_lark_dm.delivery_failed', {
        creatorOpenId: String(conversation.chatId),
        error: error instanceof Error ? error.message : String(error),
      });
      return err(new ChannelError({
        channel: 'lark',
        stage: 'send_final',
        reason: 'upstream_5xx',
        cause: error,
        message: 'Could not deliver the scheduled result to the creator\'s Lark DM.',
      }));
    }
  }
}
