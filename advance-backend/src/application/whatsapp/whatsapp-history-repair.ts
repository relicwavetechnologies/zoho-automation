import type { Logger } from '../../shared/logger';
import type { InfraError } from '../../shared/errors';
import { ok, type Result } from '../../shared/result';
import type { OpenWaClient } from '../../infrastructure/whatsapp/openwa.client';
import type {
  WhatsappRepoPort,
  WhatsappSessionRow,
} from '../../infrastructure/persistence/whatsapp.repository';
import { normalizeWhatsappPayload } from './whatsapp-message.normalize';

/**
 * Fill a hole, once, because somebody asked.
 *
 * The gap this repairs is the one nothing else can see. The analysis sweep polls
 * our own Postgres — `lastMessageAt` against `lastAnalyzedMessageAt`, both our
 * columns — so it asks "did anything I stored change", never "does WhatsApp have
 * something I do not". A message that was never delivered leaves no trace at
 * all, and an undelivered message is indistinguishable from a quiet afternoon.
 *
 * Two designs were possible. Re-reading every chat on a timer would find these
 * holes, but it is ten sessions times two hundred chats against a gateway
 * throttled at a hundred requests a minute — twenty minutes of solid traffic
 * every pass, to find nothing on almost every pass.
 *
 * This is the other one: a repair with a person behind it. The liveness sweep
 * already knows when a handset went dark and records it on `darkSince`; the web
 * app shows that; somebody presses a button. No timer, no automatic behaviour to
 * reason about, and the gateway is only touched when there is a known reason to.
 *
 * It deliberately does not decide *when* to run. Knowing a gap exists is worth
 * more than closing it silently, and a repair that runs on its own would make
 * the outage invisible again — which is the failure this whole path exists to
 * prevent.
 */

export interface HistoryRepairReport {
  readonly chatsRead: number;
  readonly messagesRecovered: number;
  readonly failures: readonly { readonly chat: string; readonly error: string }[];
}

export interface HistoryRepairOptions {
  /** How many chats to walk, most recent first. */
  readonly chatLimit?: number;
  /** How far back to read within each chat. */
  readonly perChat?: number;
  /**
   * Gap between history reads. Each one is a live query against WhatsApp, which
   * is the thing actually worth being gentle with — the gateway's own 100/min
   * ceiling is only the part that complains.
   */
  readonly pacingMs?: number;
}

const DEFAULTS = { chatLimit: 30, perChat: 50, pacingMs: 1500 } as const;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export class WhatsappHistoryRepair {
  private readonly log: Logger;

  constructor(
    private readonly deps: {
      readonly repo: WhatsappRepoPort;
      readonly gateway: OpenWaClient;
      readonly logger: Logger;
    },
  ) {
    this.log = deps.logger.child({ service: 'whatsapp-history-repair' });
  }

  /**
   * Re-read one handset's recent history and store anything missing.
   *
   * Safe to run when nothing is wrong: every message goes through the same
   * `storeMessage` the webhook path uses, and its unique key on
   * `(companyId, waMessageId)` means a message already held is a no-op rather
   * than a duplicate. The cost of pressing the button twice is time, not data.
   */
  async repair(
    session: WhatsappSessionRow,
    options: HistoryRepairOptions = {},
  ): Promise<Result<HistoryRepairReport, InfraError>> {
    const chatLimit = options.chatLimit ?? DEFAULTS.chatLimit;
    const perChat = options.perChat ?? DEFAULTS.perChat;
    const pacingMs = options.pacingMs ?? DEFAULTS.pacingMs;

    const chats = await this.deps.gateway.chats(session.openwaSessionId, Math.max(chatLimit, 50));
    if (!chats.ok) return chats;

    const targets = chats.value.filter(chat => Boolean(chat.id)).slice(0, chatLimit);

    let messagesRecovered = 0;
    const failures: { chat: string; error: string }[] = [];

    for (const [index, chat] of targets.entries()) {
      if (index > 0) await sleep(pacingMs);

      // The live chat list knows a group's real subject; message payloads never
      // do. Writing it here is why a repaired chat is not left named `…@g.us`.
      if (chat.name) {
        await this.deps.repo.renameChat({
          companyId: session.companyId,
          waChatId: chat.id,
          name: chat.name,
          isGroup: Boolean(chat.isGroup),
        });
      }

      const history = await this.deps.gateway.chatHistory(session.openwaSessionId, chat.id, perChat);
      if (!history.ok) {
        // One unreadable chat must not abandon the other twenty-nine. Collected
        // and reported rather than thrown: a partial repair is a real result,
        // and the caller is told exactly which parts are still missing.
        failures.push({ chat: chat.name ?? chat.id, error: history.error.message });
        continue;
      }

      for (const raw of history.value) {
        const normalized = normalizeWhatsappPayload(
          raw as never,
          session.openwaSessionId,
        );
        if (!normalized.ok) continue;

        const stored = await this.deps.repo.storeMessage({
          session,
          message: normalized.message,
        });
        if (!stored.ok) {
          failures.push({ chat: chat.name ?? chat.id, error: stored.error.message });
          break;
        }
        if (stored.value.stored) messagesRecovered += 1;
      }
    }

    // Only a completed pass clears the mark. A repair that gave up half way
    // still leaves a hole, and saying otherwise would retire the one signal
    // anybody has that messages are missing.
    if (failures.length === 0) {
      const cleared = await this.deps.repo.clearDark(session.id);
      if (!cleared.ok) return cleared;
    }

    this.log.info('whatsapp.history_repaired', {
      sessionId: session.id,
      chatsRead: targets.length,
      messagesRecovered,
      failures: failures.length,
      gapCleared: failures.length === 0,
    });

    return ok({ chatsRead: targets.length, messagesRecovered, failures });
  }
}
