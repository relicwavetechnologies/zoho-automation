import type { Logger } from '../../../shared/logger';
import type { ChannelLedgerRow } from '../../../domain/channel/outbound';
import { buildStatusCard } from './lark-card.builder';
import type { StatusCardInput } from './lark-card.builder';

interface LarkClientPort {
  sendMessage(chatId: string, content: string, replyToMessageId?: string, replyInThread?: boolean): Promise<{ messageId: string }>;
  updateMessage(messageId: string, content: string): Promise<void>;
}

interface CoordinatorInput {
  client:              LarkClientPort;
  chatId:              string;
  correlationId?:      string;
  replyToMessageId?:   string;
  replyInThread?:      boolean;
  logger:              Logger;
  minUpdateIntervalMs?: number;
}

const DEFAULT_MIN_INTERVAL_MS  = 1500;
const DEFAULT_HEARTBEAT_MS     = 6000;
const FINALIZE_DRAIN_MS        = 10_000;
const FINALIZE_POLL_MS         = 25;

export class LarkStatusDrainTimeoutError extends Error {
  constructor() {
    super('A status update was still in flight when final delivery began');
    this.name = 'LarkStatusDrainTimeoutError';
  }
}

/**
 * Manages ephemeral Lark status cards during a run.
 * Rate-limits and deduplicates updates; adds a heartbeat to keep the card fresh
 * during long tool calls.
 */
export class LarkStatusCoordinator {
  private readonly client:            LarkClientPort;
  private readonly chatId:            string;
  private readonly replyToMessageId:  string | undefined;
  private readonly replyInThread:     boolean | undefined;
  private readonly logger:            Logger;
  private readonly minIntervalMs:     number;
  private readonly correlationId:     string | undefined;

  private statusMessageId:  string | undefined = undefined;
  private lastSentAt        = 0;
  private lastText:         string | undefined = undefined;
  private pending:          StatusCardInput | undefined = undefined;
  private lastRenderable:   StatusCardInput | undefined = undefined;
  private flushTimer:       NodeJS.Timeout | undefined = undefined;
  private heartbeatTimer:   NodeJS.Timeout | undefined = undefined;
  private inFlight          = false;
  private terminalLocked    = false;
  private closed            = false;
  private finalizing        = false;

  constructor(input: CoordinatorInput) {
    this.client             = input.client;
    this.chatId             = input.chatId;
    this.replyToMessageId   = input.replyToMessageId;
    this.replyInThread      = input.replyInThread;
    this.logger             = input.logger;
    this.minIntervalMs      = input.minUpdateIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.correlationId      = input.correlationId;
  }

  getStatusMessageId(): string | undefined { return this.statusMessageId; }

  async update(renderable: StatusCardInput, opts?: { force?: boolean; terminal?: boolean }): Promise<void> {
    if (this.closed || this.finalizing || (this.terminalLocked && !opts?.terminal)) return;

    const previewText = this.renderBodyPreview(renderable);
    if (!previewText && !opts?.force) return;
    if (this.lastText === previewText && !opts?.force) return;

    if (opts?.terminal) {
      this.terminalLocked = true;
      this.clearTimers();
    }

    this.pending = renderable;
    const elapsed = Date.now() - this.lastSentAt;

    if (elapsed >= this.minIntervalMs || opts?.terminal || opts?.force) {
      await this.flush();
    } else if (!this.flushTimer) {
      const delay = this.minIntervalMs - elapsed;
      this.flushTimer = setTimeout(() => { void this.flush(); }, delay);
    }
  }

  /**
   * Replaces the status bubble with the final card. Drains any in-flight or
   * scheduled status flush first so a delayed update cannot overwrite the answer.
   */
  async finalizeMessage(cardContent: string): Promise<string | undefined> {
    this.finalizing = true;
    this.terminalLocked = true;
    this.clearTimers();
    this.pending = undefined;

    await this.drainInFlight();

    this.closed = true;

    try {
      if (this.statusMessageId) {
        await this.client.updateMessage(this.statusMessageId, cardContent);
      } else {
        const { messageId } = await this.client.sendMessage(
          this.chatId, cardContent, this.replyToMessageId, this.replyInThread,
        );
        this.statusMessageId = messageId;
      }
      return this.statusMessageId;
    } catch (e) {
      this.logger.warn('lark.status.finalize.error', { error: String(e) });
      throw e;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.clearTimers();
    this.pending = undefined;
  }

  private async drainInFlight(): Promise<void> {
    const deadline = Date.now() + FINALIZE_DRAIN_MS;
    while (this.inFlight && Date.now() < deadline) {
      await new Promise<void>(resolve => setTimeout(resolve, FINALIZE_POLL_MS));
    }
    if (this.inFlight) {
      this.logger.warn('lark.status.finalize.drain_timeout');
      throw new LarkStatusDrainTimeoutError();
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer || this.closed || this.terminalLocked || this.finalizing) return;
    this.heartbeatTimer = setInterval(() => {
      if (this.closed || this.terminalLocked || this.finalizing) {
        this.clearTimers();
        return;
      }
      if (this.pending || !this.lastRenderable) return;
      void this.flush(true);
    }, DEFAULT_HEARTBEAT_MS);
    (this.heartbeatTimer as NodeJS.Timeout & { unref?: () => void }).unref?.();
  }

  private renderBodyPreview(input: StatusCardInput): string {
    const t = input.timeline;
    if (!t) return 'Working…';
    // Everything the card renders must appear here, or a real change can be
    // deduped away as "no update". Elapsed time is deliberately excluded — it
    // ticks every second and would defeat the rate limiter on its own.
    const parts = [
      t.phase,
      t.state,
      String(t.actionCount ?? ''),
      t.declared ? `${t.declared.done}/${t.declared.total}:${t.declared.current ?? ''}` : '',
      t.liveLabel,
      t.narrationActive,
      t.ledger?.map(r => this.ledgerPreview(r)).join('|'),
      t.declared?.items?.map(i => `${i.status}:${i.title}`).join('|'),
    ].filter(Boolean);
    return parts.join('\n');
  }

  private ledgerPreview(row: ChannelLedgerRow): string {
    return [
      row.status,
      row.label,
      row.count,
      row.outcome ?? '',
      row.children?.map(child => this.ledgerPreview(child)).join(',') ?? '',
    ].join(':');
  }

  private clearTimers(): void {
    if (this.flushTimer)    { clearTimeout(this.flushTimer);    this.flushTimer    = undefined; }
    if (this.heartbeatTimer){ clearInterval(this.heartbeatTimer); this.heartbeatTimer = undefined; }
  }

  private async flush(heartbeat = false): Promise<void> {
    if (this.inFlight || this.finalizing) return;
    const toSend = heartbeat ? this.lastRenderable : this.pending;
    if (!toSend) return;
    const startedAtMs = Date.now();
    const operation = this.statusMessageId ? 'update' : 'create';

    if (!heartbeat) {
      this.pending = undefined;
      if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = undefined; }
    }

    this.inFlight = true;
    try {
      if (this.finalizing) return;

      const cardContent = buildStatusCard(toSend);
      if (this.finalizing) return;

      if (this.statusMessageId) {
        await this.client.updateMessage(this.statusMessageId, cardContent);
      } else {
        const { messageId } = await this.client.sendMessage(
          this.chatId, cardContent, this.replyToMessageId, this.replyInThread,
        );
        this.statusMessageId = messageId;
        this.startHeartbeat();
      }
      if (!heartbeat && !this.finalizing) {
        this.lastText       = this.renderBodyPreview(toSend);
        this.lastRenderable = toSend;
        this.lastSentAt     = Date.now();
      }
      this.logger.info('lark.status.flush.completed', {
        correlationId: this.correlationId ?? null,
        operation,
        heartbeat,
        durationMs: Date.now() - startedAtMs,
        messageId: this.statusMessageId ?? null,
      });
    } catch (e) {
      this.logger.warn('lark.status.flush.error', {
        correlationId: this.correlationId ?? null,
        operation,
        heartbeat,
        durationMs: Date.now() - startedAtMs,
        error: String(e),
      });
    } finally {
      this.inFlight = false;
    }
  }
}
