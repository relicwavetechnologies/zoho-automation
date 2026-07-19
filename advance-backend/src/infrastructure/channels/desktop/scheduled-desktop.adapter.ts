import { Prisma, type PrismaClient } from '../../../generated/prisma';
import type {
  ChannelAdapter,
  ConversationHandle,
  ReplyHandle,
  StatusHandle,
} from '../../../application/channels/channel.adapter';
import type { IncomingMessage } from '../../../domain/channel/incoming-message';
import type { FinalReply, StatusUpdate } from '../../../domain/channel/outbound';
import { ChannelError } from '../../../shared/errors';
import { err, ok, type Result } from '../../../shared/result';
import { asMessageId } from '../../../shared/ids';
import type { Logger } from '../../../shared/logger';

/**
 * Headless desktop delivery for background schedules.
 * There may be no live webview when a schedule runs, so the durable
 * DesktopMessage row is the delivery mechanism. The app reads it when the
 * conversation is next opened or refreshed.
 */
export class ScheduledDesktopChannelAdapter implements ChannelAdapter {
  readonly key = 'desktop' as const;

  constructor(private readonly deps: { prisma: PrismaClient; logger: Logger }) {}

  parseIncoming(): Result<IncomingMessage, ChannelError> {
    return err(new ChannelError({
      channel: 'desktop',
      stage: 'parse_incoming',
      reason: 'not_supported',
      message: 'Scheduled desktop messages are constructed by the scheduler.',
    }));
  }

  async sendStatus(
    conversation: ConversationHandle,
    _update: StatusUpdate,
  ): Promise<Result<StatusHandle, ChannelError>> {
    return ok({
      channel: 'desktop',
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
      const message = await this.deps.prisma.$transaction(async tx => {
        const persisted = await tx.desktopMessage.create({
          data: {
            threadId: String(conversation.chatId),
            role: 'assistant',
            content: reply.text,
            metadata: {
              format: reply.format,
              source: 'scheduled_workflow',
              ...(reply.attachments?.length ? {
                attachments: reply.attachments.map(attachment => ({
                  url: attachment.url,
                  ...(attachment.label ? { label: attachment.label } : {}),
                })),
              } : {}),
            } satisfies Prisma.InputJsonObject,
          },
        });
        await tx.desktopThread.update({
          where: { id: String(conversation.chatId) },
          data: { lastMessageAt: new Date() },
        });
        return persisted;
      });
      return ok({ channel: 'desktop', messageId: asMessageId(message.id) });
    } catch (error) {
      this.deps.logger.error('scheduled_desktop.delivery_failed', {
        threadId: String(conversation.chatId),
        error: error instanceof Error ? error.message : String(error),
      });
      return err(new ChannelError({
        channel: 'desktop',
        stage: 'send_final',
        reason: 'upstream_5xx',
        cause: error,
        message: 'Could not persist the scheduled result in the desktop conversation.',
      }));
    }
  }
}
