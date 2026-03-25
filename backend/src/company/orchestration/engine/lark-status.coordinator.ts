import type {
  ChannelAction,
  ChannelAdapter,
  ChannelOutboundResult,
} from '../../channels/base/channel-adapter';

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

  public startHeartbeat(getRenderable: () => LarkStatusRenderable | null): void {
    if (this.closed || this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      if (this.closed) return;
      if (this.pending) {
        void this.flushPending();
        return;
      }
      if (Date.now() - this.lastSentAt < this.heartbeatIntervalMs) {
        return;
      }
      const renderable = getRenderable();
      if (!renderable) return;
      void this.update(renderable, { force: true });
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
