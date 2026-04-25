import type { Logger } from '../../../shared/logger';

interface LarkStatusRenderable {
  text: string;
  actions?: Array<{ label: string; value: string }>;
}

interface LarkClientPort {
  sendMessage(chatId: string, content: string, replyToMessageId?: string, replyInThread?: boolean): Promise<{ messageId: string }>;
  updateMessage(messageId: string, content: string): Promise<void>;
}

interface CoordinatorInput {
  client: LarkClientPort;
  chatId: string;
  correlationId?: string;
  replyToMessageId?: string;
  replyInThread?: boolean;
  logger: Logger;
  minUpdateIntervalMs?: number;
}

const DEFAULT_MIN_INTERVAL_MS = 1500;
const DEFAULT_HEARTBEAT_MS = 6000;

/** Manages ephemeral Lark status cards, rate-limiting and deduplicating updates. */
export class LarkStatusCoordinator {
  private readonly client: LarkClientPort;
  private readonly chatId: string;
  private readonly replyToMessageId: string | undefined;
  private readonly replyInThread: boolean | undefined;
  private readonly logger: Logger;
  private readonly minIntervalMs: number;

  private statusMessageId: string | undefined = undefined;
  private lastSentAt = 0;
  private lastText: string | undefined = undefined;
  private pending: LarkStatusRenderable | undefined = undefined;
  private flushTimer: NodeJS.Timeout | undefined = undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined = undefined;
  private inFlight = false;
  private terminalLocked = false;
  private closed = false;

  constructor(input: CoordinatorInput) {
    this.client = input.client;
    this.chatId = input.chatId;
    this.replyToMessageId = input.replyToMessageId;
    this.replyInThread = input.replyInThread;
    this.logger = input.logger;
    this.minIntervalMs = input.minUpdateIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  }

  getStatusMessageId(): string | undefined { return this.statusMessageId; }

  async update(renderable: LarkStatusRenderable, opts?: { force?: boolean; terminal?: boolean }): Promise<void> {
    if (this.closed || (this.terminalLocked && !opts?.terminal)) return;

    const text = renderable.text.trim();
    if (!text) return;
    if (this.lastText === text && !opts?.force) return;

    if (opts?.terminal) {
      this.terminalLocked = true;
      this.clearTimers();
    }

    this.pending = renderable;
    const now = Date.now();
    const elapsed = now - this.lastSentAt;

    if (elapsed >= this.minIntervalMs || opts?.terminal || opts?.force) {
      await this.flush();
    } else if (!this.flushTimer) {
      const delay = this.minIntervalMs - elapsed;
      this.flushTimer = setTimeout(() => { void this.flush(); }, delay);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.clearTimers();
  }

  private clearTimers(): void {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = undefined; }
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = undefined; }
  }

  private renderCard(renderable: LarkStatusRenderable): string {
    const elements: unknown[] = [{
      tag: 'div',
      text: { tag: 'lark_md', content: renderable.text },
    }];
    if (renderable.actions?.length) {
      elements.push({
        tag: 'action',
        actions: renderable.actions.map(a => ({
          tag: 'button',
          text: { tag: 'plain_text', content: a.label },
          value: { action: a.value },
          type: 'default',
        })),
      });
    }
    // Return wrapper format — sendMessage and updateMessage both unwrap it correctly.
    return JSON.stringify({
      msg_type: 'interactive',
      card: JSON.stringify({
        elements,
        header: { title: { tag: 'plain_text', content: '🤖 Working...' } },
      }),
    });
  }

  private async flush(): Promise<void> {
    if (this.inFlight || !this.pending || this.closed) return;
    const toSend = this.pending;
    this.pending = undefined;
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = undefined; }

    this.inFlight = true;
    try {
      const cardContent = this.renderCard(toSend);
      if (this.statusMessageId) {
        await this.client.updateMessage(this.statusMessageId, cardContent);
      } else {
        const { messageId } = await this.client.sendMessage(
          this.chatId, cardContent, this.replyToMessageId, this.replyInThread,
        );
        this.statusMessageId = messageId;
      }
      this.lastText = toSend.text;
      this.lastSentAt = Date.now();
    } catch (e) {
      this.logger.warn('lark.status.flush.error', { error: String(e) });
    } finally {
      this.inFlight = false;
    }
  }
}
