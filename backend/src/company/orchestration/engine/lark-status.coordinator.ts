import type {
  ChannelAction,
  ChannelAdapter,
  ChannelOutboundResult,
} from '../../channels/base/channel-adapter';
import { logger } from '../../../utils/logger';

type LarkStatusRenderable = {
  text: string;
  actions?: ChannelAction[];
};

type PendingUpdate = {
  renderable: LarkStatusRenderable;
  terminal: boolean;
};

type LarkStatusCoordinatorInput = {
  adapter: Pick<ChannelAdapter, 'sendMessage' | 'updateMessage'>;
  chatId: string;
  correlationId?: string;
  initialStatusMessageId?: string;
  replyToMessageId?: string;
  replyInThread?: boolean;
  minUpdateIntervalMs?: number;
  heartbeatIntervalMs?: number;
};

const DEFAULT_MIN_UPDATE_INTERVAL_MS = 1500;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 6000;

const normalizeActions = (actions?: ChannelAction[]): ChannelAction[] =>
  Array.isArray(actions) ? actions : [];

const actionsKey = (actions?: ChannelAction[]): string => JSON.stringify(normalizeActions(actions));

export class LarkStatusCoordinator {
  private readonly adapter: Pick<ChannelAdapter, 'sendMessage' | 'updateMessage'>;
  private readonly chatId: string;
  private readonly correlationId?: string;
  private readonly replyToMessageId?: string;
  private readonly replyInThread?: boolean;
  private readonly minUpdateIntervalMs: number;
  private readonly heartbeatIntervalMs: number;

  private statusMessageId?: string;
  private liveTextMessageId?: string;
  private lastSentAt = 0;
  private lastText?: string;
  private lastActionsKey = actionsKey();
  private pending?: PendingUpdate;
  private flushTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private inFlight = false;
  private terminalLocked = false;
  private closed = false;

  public constructor(input: LarkStatusCoordinatorInput) {
    this.adapter = input.adapter;
    this.chatId = input.chatId;
    this.correlationId = input.correlationId;
    this.statusMessageId = input.initialStatusMessageId;
    this.replyToMessageId = input.replyToMessageId;
    this.replyInThread = input.replyInThread;
    this.minUpdateIntervalMs = input.minUpdateIntervalMs ?? DEFAULT_MIN_UPDATE_INTERVAL_MS;
    this.heartbeatIntervalMs = input.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  }

  public getStatusMessageId(): string | undefined {
    return this.statusMessageId;
  }

  public getLiveTextMessageId(): string | undefined {
    return this.liveTextMessageId;
  }

  public async update(renderable: LarkStatusRenderable, options?: { force?: boolean; terminal?: boolean }): Promise<void> {
    if (this.closed) return;
    if (this.terminalLocked && !options?.terminal) return;
    const next = {
      text: renderable.text.trim(),
      actions: normalizeActions(renderable.actions),
    };
    if (!next.text) return;

    const nextActionsKey = actionsKey(next.actions);
    const isVisibleDuplicate = this.lastText === next.text && this.lastActionsKey === nextActionsKey;
    if (isVisibleDuplicate && !options?.force) {
      return;
    }

    this.pending = {
      renderable: next,
      terminal: Boolean(options?.terminal),
    };

    const now = Date.now();
    const elapsed = now - this.lastSentAt;
    if (!options?.force && this.lastSentAt > 0 && elapsed < this.minUpdateIntervalMs) {
      this.scheduleFlush(this.minUpdateIntervalMs - elapsed);
      return;
    }

    await this.pump();
  }

  public async updateLiveText(text: string): Promise<void> {
    const nextText = text.trim();
    if (this.closed || !nextText) return;
    try {
      if (this.liveTextMessageId) {
        logger.info('supervisor_v2.live_text.update_attempt', {
          branch: 'update',
          chatId: this.chatId,
          correlationId: this.correlationId,
          liveTextMessageId: this.liveTextMessageId,
          textLength: nextText.length,
          preview: nextText.slice(0, 160),
        });
        const result = await this.adapter.updateMessage({
          messageId: this.liveTextMessageId,
          text: nextText,
          format: 'text',
          correlationId: this.correlationId,
        });
        logger.info('supervisor_v2.live_text.update_ok', {
          liveTextMessageId: this.liveTextMessageId,
          resultStatus: result.status,
          resultMessageId: result.messageId ?? null,
          hasProviderResponse: Boolean(result.providerResponse),
        });
      } else {
        logger.info('supervisor_v2.live_text.send_attempt', {
          branch: 'send',
          chatId: this.chatId,
          correlationId: this.correlationId,
          replyToMessageId: this.replyToMessageId ?? null,
          replyInThread: this.replyInThread ?? null,
          textLength: nextText.length,
          preview: nextText.slice(0, 160),
        });
        const result = await this.adapter.sendMessage({
          chatId: this.chatId,
          text: nextText,
          format: 'text',
          correlationId: this.correlationId,
          replyToMessageId: this.replyToMessageId,
          replyInThread: this.replyInThread,
        });
        this.liveTextMessageId = result?.messageId;
        logger.info('supervisor_v2.live_text.send_ok', {
          chatId: this.chatId,
          liveTextMessageId: this.liveTextMessageId,
          hasMessageId: Boolean(this.liveTextMessageId),
          resultStatus: result.status,
          resultMessageId: result.messageId ?? null,
          hasProviderResponse: Boolean(result.providerResponse),
        });
      }
    } catch (err) {
      logger.warn('supervisor_v2.live_text.failed', {
        chatId: this.chatId,
        correlationId: this.correlationId,
        replyToMessageId: this.replyToMessageId ?? null,
        replyInThread: this.replyInThread ?? null,
        liveTextMessageId: this.liveTextMessageId,
        textLength: nextText.length,
        preview: nextText.slice(0, 160),
        error: err instanceof Error ? err.message : 'unknown',
      });
    }
  }

  public async finalizeLiveText(text: string): Promise<void> {
    if (this.closed || !this.liveTextMessageId) return;
    try {
      logger.info('supervisor_v2.live_text.finalize_attempt', {
        chatId: this.chatId,
        correlationId: this.correlationId,
        liveTextMessageId: this.liveTextMessageId,
        textLength: text.length,
        preview: text.slice(0, 160),
      });
      const result = await this.adapter.updateMessage({
        messageId: this.liveTextMessageId,
        text,
        format: 'text',
        correlationId: this.correlationId,
      });
      logger.info('supervisor_v2.live_text.finalize_ok', {
        liveTextMessageId: this.liveTextMessageId,
        resultStatus: result.status,
        resultMessageId: result.messageId ?? null,
        hasProviderResponse: Boolean(result.providerResponse),
      });
    } catch (err) {
      logger.warn('supervisor_v2.live_text.finalize_failed', {
        chatId: this.chatId,
        correlationId: this.correlationId,
        liveTextMessageId: this.liveTextMessageId,
        textLength: text.length,
        preview: text.slice(0, 160),
        error: err instanceof Error ? err.message : 'unknown',
      });
    }
  }

  public startHeartbeat(getRenderable: () => LarkStatusRenderable): void {
    if (this.closed || this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      if (this.closed) return;
      if (this.pending) {
        void this.flushPending();
        return;
      }
      const renderable = getRenderable();
      void this.updateLiveText(renderable.text);
    }, this.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  public async replace(text: string, actions?: ChannelAction[]): Promise<void> {
    await this.update({ text, actions }, { force: true, terminal: true });
  }

  public async close(): Promise<void> {
    this.closed = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private scheduleFlush(delayMs: number): void {
    if (this.flushTimer || this.closed) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flushPending();
    }, Math.max(delayMs, 0));
    this.flushTimer.unref?.();
  }

  private async flushPending(): Promise<void> {
    if (this.closed) return;
    await this.pump();
  }

  private async pump(): Promise<void> {
    if (this.closed || this.inFlight || !this.pending) return;
    this.inFlight = true;
    try {
      while (!this.closed && this.pending) {
        const next = this.pending;
        this.pending = undefined;
        await this.flush(next);
      }
    } finally {
      this.inFlight = false;
    }
  }

  private async flush(input: PendingUpdate): Promise<void> {
    if (this.closed) return;
    const { renderable, terminal } = input;
    const outbound = this.statusMessageId
      ? await this.adapter.updateMessage({
        messageId: this.statusMessageId,
        text: renderable.text,
        actions: renderable.actions,
        correlationId: this.correlationId,
      })
      : await this.adapter.sendMessage({
        chatId: this.chatId,
        text: renderable.text,
        actions: renderable.actions,
        correlationId: this.correlationId,
        replyToMessageId: this.replyToMessageId,
        replyInThread: this.replyInThread,
      });

    this.captureOutboundState(renderable, outbound, terminal);
  }

  private captureOutboundState(renderable: LarkStatusRenderable, outbound: ChannelOutboundResult, terminal: boolean): void {
    if (outbound.status === 'failed') {
      return;
    }
    this.statusMessageId = outbound.messageId ?? this.statusMessageId;
    this.lastSentAt = Date.now();
    this.lastText = renderable.text;
    this.lastActionsKey = actionsKey(renderable.actions);
    if (terminal) {
      this.terminalLocked = true;
      this.pending = undefined;
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = undefined;
      }
    }
  }
}
