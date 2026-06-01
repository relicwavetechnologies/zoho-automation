import type { Response } from 'express';
import { Prisma, type PrismaClient } from '../../../generated/prisma';
import type { ChannelAdapter, ConversationHandle, ReplyHandle, StatusHandle } from '../../../application/channels/channel.adapter';
import type { IncomingMessage } from '../../../domain/channel/incoming-message';
import type { ChannelPlanStep, FinalReply, StatusUpdate } from '../../../domain/channel/outbound';
import { err, ok, type Result } from '../../../shared/result';
import { ChannelError } from '../../../shared/errors';
import { asChatId, asCorrelationId, asMessageId } from '../../../shared/ids';
import type { Logger } from '../../../shared/logger';

export interface AirnoteIncomingPayload {
  readonly requestId: string;
  readonly threadId: string;
  readonly message: string;
  readonly mode?: 'fast' | 'high';
  readonly userExternalId: string;
  readonly timestamp: string;
}

interface AirnotePlanStep {
  readonly status: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly toolFamily?: string;
}

interface AirnoteMessageDto {
  readonly id: string;
  readonly threadId: string;
  readonly role: string;
  readonly content: string;
  readonly createdAt: string;
}

export class AirnoteChannelAdapter implements ChannelAdapter {
  readonly key = 'airnote' as const;

  private lastPlanSignature: string | null = null;
  private lastThinkingText: string | null = null;

  constructor(
    private readonly deps: {
      prisma: PrismaClient;
      res: Response;
      requestId: string;
      logger: Logger;
    },
  ) {}

  parseIncoming(raw: unknown): Result<IncomingMessage, ChannelError> {
    const payload = raw as Partial<AirnoteIncomingPayload>;
    if (
      !payload.requestId
      || !payload.threadId
      || typeof payload.message !== 'string'
      || !payload.userExternalId
      || !payload.timestamp
    ) {
      return err(new ChannelError({
        channel: 'airnote',
        stage: 'parse_incoming',
        reason: 'malformed',
        message: 'Malformed airnote chat payload',
      }));
    }

    return ok({
      channel: 'airnote',
      messageId: asMessageId(payload.requestId),
      chatId: asChatId(payload.threadId),
      chatType: 'p2p',
      userExternalId: payload.userExternalId,
      text: payload.message.trim(),
      attachments: [],
      timestamp: payload.timestamp,
      traceId: asCorrelationId(payload.requestId),
      mentions: [],
      mentionsSelf: true,
      raw,
    });
  }

  async sendStatus(
    conversation: ConversationHandle,
    update: StatusUpdate,
  ): Promise<Result<StatusHandle, ChannelError>> {
    this.emitTimelineEvents(update);
    return ok({
      channel: 'airnote',
      messageId: asMessageId(`airnote-status-${String(conversation.correlationId)}`),
      correlationId: conversation.correlationId,
    });
  }

  async editStatus(
    handle: StatusHandle,
    update: StatusUpdate,
  ): Promise<Result<StatusHandle, ChannelError>> {
    this.emitTimelineEvents(update);
    return ok(handle);
  }

  emitToolStart(event: { callId: string; name: string; family: string; args: unknown; verb?: string }): void {
    this.emit('tool.start', {
      callId: event.callId,
      name: event.name,
      family: event.family,
      args: event.args,
      ...(event.verb ? { verb: event.verb } : {}),
    });
  }

  emitToolEnd(event: {
    callId: string;
    name: string;
    ok: boolean;
    output: string;
    durationMs: number;
    past?: string;
  }): void {
    this.emit('tool.end', {
      callId: event.callId,
      name: event.name,
      ok: event.ok,
      durationMs: event.durationMs,
      ...(event.past ? { past: event.past } : {}),
    });
  }

  emitTextDelta(delta: string): void {
    if (!delta) return;
    this.emit('text', { delta });
  }

  async sendFinalReply(
    conversation: ConversationHandle,
    reply: FinalReply,
  ): Promise<Result<ReplyHandle, ChannelError>> {
    try {
      const metadata = buildReplyMetadata(reply);
      const message = await this.deps.prisma.desktopMessage.create({
        data: {
          threadId: String(conversation.chatId),
          role: 'assistant',
          content: reply.text,
          ...(metadata ? { metadata } : {}),
        },
      });

      await this.deps.prisma.desktopThread.update({
        where: { id: String(conversation.chatId) },
        data: { lastMessageAt: new Date() },
      });

      const dto: AirnoteMessageDto = {
        id: message.id,
        threadId: message.threadId,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt.toISOString(),
      };
      this.emit('done', { message: dto, format: 'markdown' });

      return ok({ channel: 'airnote', messageId: asMessageId(message.id) });
    } catch (e) {
      this.deps.logger.warn('airnote.adapter.final_reply_failed', {
        error: e instanceof Error ? e.message : String(e),
        requestId: this.deps.requestId,
      });
      return err(new ChannelError({
        channel: 'airnote',
        stage: 'send_final',
        reason: 'upstream_5xx',
        cause: e,
        message: `Failed to deliver airnote final reply: ${e instanceof Error ? e.message : String(e)}`,
      }));
    }
  }

  emitError(message: string): void {
    this.emit('error', { message });
  }

  private emitTimelineEvents(update: StatusUpdate): void {
    const tl = update.timeline;
    if (!tl) return;

    const statusData: Record<string, unknown> = {};
    if (tl.phase) statusData['phase'] = tl.phase;
    if (tl.liveLabel) statusData['liveLabel'] = tl.liveLabel;
    if (typeof tl.progressPct === 'number') statusData['progressPct'] = tl.progressPct;

    if (tl.plan && tl.plan.length > 0) {
      const steps: AirnotePlanStep[] = tl.plan.map((step: ChannelPlanStep) => ({
        status: step.status,
        title: step.title,
        ...(step.subtitle ? { subtitle: step.subtitle } : {}),
        ...(step.toolFamily ? { toolFamily: step.toolFamily } : {}),
      }));
      const signature = JSON.stringify(steps);
      if (signature !== this.lastPlanSignature) {
        this.lastPlanSignature = signature;
        statusData['plan'] = steps;
      }
    }

    if (Object.keys(statusData).length > 0) {
      this.emit('status', statusData);
    }

    const narration = [
      ...(tl.narration ?? []),
      ...(tl.narrationActive ? [tl.narrationActive] : []),
    ].join(' ').trim();
    if (narration && narration !== this.lastThinkingText) {
      this.lastThinkingText = narration;
      this.emit('thinking', { text: narration });
    }
  }

  private emit(eventName: string, data: unknown): void {
    if (this.deps.res.writableEnded) return;
    this.deps.res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}

function buildReplyMetadata(reply: FinalReply): Prisma.InputJsonObject {
  return {
    format: reply.format,
    channel: 'airnote',
    ...(reply.attachments && reply.attachments.length > 0 ? {
      attachments: reply.attachments.map(a => ({
        url: a.url,
        ...(a.label ? { label: a.label } : {}),
      })),
    } : {}),
    ...(reply.executionTrace ? { executionTrace: reply.executionTrace } : {}),
  };
}
