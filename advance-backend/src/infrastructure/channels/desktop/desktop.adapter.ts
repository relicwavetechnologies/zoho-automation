import type { WebSocket } from 'ws';
import { Prisma, type PrismaClient } from '../../../generated/prisma';
import type { ChannelAdapter, ConversationHandle, ReplyHandle, StatusHandle } from '../../../application/channels/channel.adapter';
import type { IncomingMessage } from '../../../domain/channel/incoming-message';
import type { ChannelPlanStep, FinalReply, StatusUpdate } from '../../../domain/channel/outbound';
import { err, ok, type Result } from '../../../shared/result';
import { ChannelError } from '../../../shared/errors';
import { asChatId, asCorrelationId, asMessageId } from '../../../shared/ids';
import type { Logger } from '../../../shared/logger';
import type {
  TerminalBridge,
  TerminalExecRequest,
  ExecResult,
} from './terminal-bridge';

export interface DesktopChatStartPayload {
  readonly type: 'chat.start';
  readonly requestId: string;
  readonly threadId: string;
  readonly message: string;
  readonly mode?: 'fast' | 'high';
  readonly workspace?: { readonly name: string; readonly path: string } | null;
  readonly workflowInvocation?: {
    readonly workflowId: string;
    readonly workflowName?: string;
    readonly overrideText?: string;
  };
}

interface DesktopIncomingRaw extends DesktopChatStartPayload {
  readonly userExternalId: string;
  readonly timestamp: string;
}

interface DesktopPlanStep {
  readonly status: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly toolFamily?: string;
}

type DesktopStreamEvent =
  | { readonly type: 'text'; readonly data: string }
  | { readonly type: 'done'; readonly data: { readonly message: DesktopMessageDto } }
  | { readonly type: 'error'; readonly data: string }
  | { readonly type: 'plan'; readonly steps: ReadonlyArray<DesktopPlanStep> }
  | { readonly type: 'thinking'; readonly text: string }
  | {
      readonly type: 'tool.start';
      readonly callId: string;
      readonly name: string;
      readonly family: string;
      readonly args: unknown;
      readonly verb?: string;
    }
  | {
      readonly type: 'tool.end';
      readonly callId: string;
      readonly name: string;
      readonly ok: boolean;
      readonly output: string;
      readonly durationMs: number;
      readonly past?: string;
    }
  | {
      readonly type: 'terminal.exec.request';
      readonly callId: string;
      readonly command: string;
      readonly cwd: string;
      readonly net: boolean;
      readonly timeoutMs?: number;
    };

interface DesktopMessageDto {
  readonly id: string;
  readonly threadId: string;
  readonly role: string;
  readonly content: string;
  readonly metadata?: unknown;
  readonly createdAt: string;
}

/** How long to wait for the client to run + report a command before giving up. */
const EXEC_TIMEOUT_MS = 12 * 60 * 1000;

export class DesktopChannelAdapter implements ChannelAdapter, TerminalBridge {
  readonly key = 'desktop' as const;

  private lastPlanSignature: string | null = null;
  private lastThinkingText: string | null = null;
  private readonly pendingExecs = new Map<
    string,
    { resolve: (r: ExecResult) => void; timer: ReturnType<typeof setTimeout> }
  >();

  constructor(
    private readonly deps: {
      prisma: PrismaClient;
      ws: WebSocket;
      requestId: string;
      logger: Logger;
    },
  ) {}

  parseIncoming(raw: unknown): Result<IncomingMessage, ChannelError> {
    const payload = raw as Partial<DesktopIncomingRaw>;
    if (
      payload.type !== 'chat.start'
      || !payload.requestId
      || !payload.threadId
      || typeof payload.message !== 'string'
      || !payload.userExternalId
      || !payload.timestamp
    ) {
      return err(new ChannelError({
        channel: 'desktop',
        stage: 'parse_incoming',
        reason: 'malformed',
        message: 'Malformed desktop chat.start payload',
      }));
    }

    const text = payload.message.trim();

    return ok({
      channel: 'desktop',
      messageId: asMessageId(payload.requestId),
      chatId: asChatId(payload.threadId),
      chatType: 'p2p',
      userExternalId: payload.userExternalId,
      text,
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
      channel: 'desktop',
      messageId: asMessageId(`desktop-status-${String(conversation.correlationId)}`),
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
    this.emit({
      type: 'tool.start',
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
    this.emit({
      type: 'tool.end',
      callId: event.callId,
      name: event.name,
      ok: event.ok,
      output: event.output,
      durationMs: event.durationMs,
      ...(event.past ? { past: event.past } : {}),
    });
  }

  emitTextDelta(delta: string): void {
    if (!delta) return;
    this.emit({ type: 'text', data: delta });
  }

  // ── TerminalBridge (execution happens on the client's machine) ─────────────
  execute(req: TerminalExecRequest): Promise<ExecResult> {
    this.emit({
      type: 'terminal.exec.request',
      callId: req.callId,
      command: req.command,
      cwd: req.cwd,
      net: req.net,
      ...(req.timeoutMs ? { timeoutMs: req.timeoutMs } : {}),
    });
    return new Promise<ExecResult>(resolve => {
      const timer = setTimeout(() => {
        this.pendingExecs.delete(req.callId);
        resolve({ status: 'declined', message: 'No response from the desktop app (timed out waiting for the user).' });
      }, EXEC_TIMEOUT_MS);
      this.pendingExecs.set(req.callId, { resolve, timer });
    });
  }

  resolveResult(callId: string, result: ExecResult): void {
    const pending = this.pendingExecs.get(callId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingExecs.delete(callId);
    pending.resolve(result);
  }

  private emitTimelineEvents(update: StatusUpdate): void {
    const tl = update.timeline;
    if (!tl) return;

    if (tl.plan && tl.plan.length > 0) {
      const steps: DesktopPlanStep[] = tl.plan.map((step: ChannelPlanStep) => ({
        status: step.status,
        title: step.title,
        ...(step.subtitle ? { subtitle: step.subtitle } : {}),
        ...(step.toolFamily ? { toolFamily: step.toolFamily } : {}),
      }));
      const signature = JSON.stringify(steps);
      if (signature !== this.lastPlanSignature) {
        this.lastPlanSignature = signature;
        this.emit({ type: 'plan', steps });
      }
    }

    const narration = [
      ...(tl.narration ?? []),
      ...(tl.narrationActive ? [tl.narrationActive] : []),
    ].join(' ').trim();
    if (narration && narration !== this.lastThinkingText) {
      this.lastThinkingText = narration;
      this.emit({ type: 'thinking', text: narration });
    }
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

      const dto = toDesktopMessageDto(message);
      this.emit({ type: 'done', data: { message: dto } });

      return ok({ channel: 'desktop', messageId: asMessageId(message.id) });
    } catch (e) {
      this.deps.logger.warn('desktop.adapter.final_reply_failed', {
        error: e instanceof Error ? e.message : String(e),
        requestId: this.deps.requestId,
      });
      return err(new ChannelError({
        channel: 'desktop',
        stage: 'send_final',
        reason: 'upstream_5xx',
        cause: e,
        message: `Failed to deliver desktop final reply: ${e instanceof Error ? e.message : String(e)}`,
      }));
    }
  }

  emitError(message: string): void {
    this.emit({ type: 'error', data: message });
  }

  private emit(event: DesktopStreamEvent): void {
    if (this.deps.ws.readyState !== 1) return;
    this.deps.ws.send(JSON.stringify({
      type: 'chat.event',
      requestId: this.deps.requestId,
      event,
    }));
  }
}

function buildReplyMetadata(reply: FinalReply): Prisma.InputJsonObject {
  return {
    format: reply.format,
    ...(reply.attachments && reply.attachments.length > 0 ? {
      attachments: reply.attachments.map(attachment => ({
        url: attachment.url,
        ...(attachment.label ? { label: attachment.label } : {}),
      })),
    } : {}),
    ...(reply.executionTrace ? { executionTrace: reply.executionTrace } : {}),
  };
}

function toDesktopMessageDto(message: {
  id: string;
  threadId: string;
  role: string;
  content: string;
  metadata: Prisma.JsonValue | null;
  createdAt: Date;
}): DesktopMessageDto {
  return {
    id: message.id,
    threadId: message.threadId,
    role: message.role,
    content: message.content,
    ...(message.metadata !== null ? { metadata: message.metadata } : {}),
    createdAt: message.createdAt.toISOString(),
  };
}
