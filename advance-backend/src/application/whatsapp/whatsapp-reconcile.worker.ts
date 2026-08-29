import type { Logger } from '../../shared/logger';
import type { IngressReceiptRepoPort } from '../../infrastructure/persistence/ingress-receipt.repository';
import type { WhatsappRepoPort } from '../../infrastructure/persistence/whatsapp.repository';
import type { OpenWaClient } from '../../infrastructure/whatsapp/openwa.client';
import {
  WHATSAPP_INGRESS_CHANNEL,
  type WhatsappIngestService,
} from './whatsapp-ingest.service';
import { SESSION_STALE_AFTER_MS } from './whatsapp-session.service';
import { classifyGatewaySessionStatus } from '../../domain/follow-ups/session-status';

/**
 * The safety net the imported agent does not have.
 *
 * Message arrival is genuinely pushed, and push is the right design — but the
 * agent has no answer for the push *stopping*. Its backfill runs once ever
 * (`if (config.backfill.onStart && !meta.get('backfilled_at'))`), there is no
 * gap detection, and nothing notices a webhook that was replaced or a session
 * that logged out. Messages just stop, and stopped messages look exactly like a
 * quiet week.
 *
 * Three jobs, all cheap, none of which call a model:
 *
 *   1. Finish receipts that were accepted and never completed — a process that
 *      died between answering the webhook and doing the work.
 *   2. Refresh chat display names, because a webhook payload never carries a
 *      group's subject and the digest would otherwise name rooms `…@g.us`.
 *   3. Raise the alarm on a handset that has gone quiet.
 *
 * Deliberately *not* here: re-reading history on a timer for every chat. That is
 * ten sessions times two hundred chats against a gateway throttled at 100
 * requests a minute, to find messages that almost always arrived fine. History
 * re-reads belong to a repair the alarm asks for, not to a routine sweep.
 */

const RECOVERY_BATCH = 25;
const CHAT_REFRESH_INTERVAL_MS = 30 * 60_000;
/** Hourly. An orphan is a slow leak, not an incident. */
const ORPHAN_SCAN_INTERVAL_MS = 60 * 60_000;

const PRUNE_INTERVAL_MS = 6 * 60 * 60_000;
const PRUNE_BATCH = 500;

export interface WhatsappReconcileDeps {
  readonly receipts: IngressReceiptRepoPort;
  readonly repo: WhatsappRepoPort;
  readonly ingest: WhatsappIngestService;
  readonly gateway: OpenWaClient;
  readonly logger: Logger;
  /** How often the sweep runs. */
  readonly scanIntervalMs?: number;
  /** How long transcript is kept. Defaults to 90 days. */
  readonly retentionMs?: number;
}

export class WhatsappReconcileWorker {
  private readonly log: Logger;
  private timer?: NodeJS.Timeout;
  private running = false;
  // Chat names refresh on the first tick on purpose: a fresh process may hold
  // groups still named `…@g.us`, and one chat-list call per session is cheap.
  // Retention is not — starting it at boot would run a six-hourly sweep several
  // times a day on a service that deploys often, which makes the stated cadence
  // fiction.
  private lastChatRefreshAt = 0;
  private lastPruneAt = Date.now();
  // Started full, like the prune clock above: an orphan is a slow leak, and
  // listing the gateway on every boot would cost a round trip on each restart
  // to answer a question that changes over hours.
  private lastOrphanScanAt = Date.now();

  constructor(private readonly deps: WhatsappReconcileDeps) {
    this.log = deps.logger.child({ service: 'whatsapp-reconcile' });
  }

  start(): void {
    const tick = () => {
      void this.runOnce().catch((error: unknown) => {
        this.log.error('whatsapp_reconcile.tick_failed', { error: errorText(error) });
      });
    };
    tick();
    this.timer = setInterval(tick, this.deps.scanIntervalMs ?? 5 * 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const recovered = await this.recoverStuckReceipts();
      const alarms = await this.checkSessionLiveness();

      const now = Date.now();
      let renamed = 0;
      if (now - this.lastChatRefreshAt >= CHAT_REFRESH_INTERVAL_MS) {
        this.lastChatRefreshAt = now;
        renamed = await this.refreshChatNames();
      }

      let pruned = 0;
      if (now - this.lastPruneAt >= PRUNE_INTERVAL_MS) {
        this.lastPruneAt = now;
        pruned = await this.pruneTranscript();
      }

      let orphans = 0;
      if (now - this.lastOrphanScanAt >= ORPHAN_SCAN_INTERVAL_MS) {
        this.lastOrphanScanAt = now;
        orphans = await this.reportGatewayOrphans();
      }

      if (recovered || alarms || renamed || pruned || orphans) {
        this.log.info('whatsapp_reconcile.tick', { recovered, alarms, renamed, pruned, orphans });
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * Re-run receipts that were admitted and never finished.
   *
   * The payload is on the receipt, so recovery replays the original envelope
   * rather than asking WhatsApp again — which means it works even when the
   * gateway is the thing that was down.
   */
  private async recoverStuckReceipts(): Promise<number> {
    const stuck = await this.deps.receipts.listRecoverable(RECOVERY_BATCH, {
      channel: WHATSAPP_INGRESS_CHANNEL,
    });
    if (!stuck.ok) {
      this.log.error('whatsapp_reconcile.list_recoverable_failed', { error: stuck.error.message });
      return 0;
    }

    let recovered = 0;
    for (const receiptId of stuck.value) {
      // Deliberately no claim here. `process` takes the only claim, and reads the
      // envelope off the receipt itself. Claiming first would make the lease live
      // and cause `process` to refuse its own work as `leased` — a receipt that
      // then never recovers on any sweep.
      const outcome = await this.deps.ingest.process(receiptId);
      if (outcome.status === 'stored') recovered += 1;
    }

    // Receipts past their retry window are moved to `dead` so they stop holding
    // recovery slots that live work needs.
    const exhausted = await this.deps.receipts.listExhausted(RECOVERY_BATCH, {
      channel: WHATSAPP_INGRESS_CHANNEL,
    });
    if (exhausted.ok) {
      for (const receiptId of exhausted.value) {
        await this.deps.receipts.markFailed(receiptId, 'retry window closed', { terminal: true });
      }
      if (exhausted.value.length > 0) {
        this.log.warn('whatsapp_reconcile.receipts_retired', { count: exhausted.value.length });
      }
    }

    return recovered;
  }

  /**
   * Call out handsets that have gone quiet.
   *
   * A warning rather than a repair, and that is the honest shape of it: nobody
   * here can re-link a phone. What this buys is that the silence is *visible* —
   * the `/followups` tab shows the number as dark and the digest carries a
   * health card, so a broken stream is noticed in hours rather than whenever
   * somebody wonders why a client stopped appearing.
   */
  private async checkSessionLiveness(): Promise<number> {
    const quietSince = new Date(Date.now() - SESSION_STALE_AFTER_MS);
    const stale = await this.deps.repo.listStaleSessions(quietSince);
    if (!stale.ok) {
      this.log.error('whatsapp_reconcile.liveness_failed', { error: stale.error.message });
      return 0;
    }

    let alarms = 0;
    for (const session of stale.value) {
      // Ask the gateway before shouting: a handset can be legitimately quiet,
      // and the gateway is the only thing that knows whether it is still linked.
      const remote = await this.deps.gateway.session(session.openwaSessionId);
      if (!remote.ok) {
        this.log.warn('whatsapp_reconcile.session_check_failed', {
          sessionId: session.id,
          error: remote.error.message,
        });
        continue;
      }

      const status = classifyGatewaySessionStatus(remote.value.status);
      if (status === 'unknown' || status === 'pending') {
        this.log.warn('whatsapp_reconcile.session_status_unrecognized', {
          sessionId: session.id,
          gatewayStatus: remote.value.status ?? null,
        });
        continue;
      }

      if (status === 'linked') {
        if (session.status === 'disconnected') {
          const restored = await this.deps.repo.updateSessionStatus({
            sessionId: session.id,
            status: 'linked',
          });
          if (!restored.ok) {
            this.log.error('whatsapp_reconcile.session_restore_failed', {
              sessionId: session.id,
              error: restored.error.message,
            });
            continue;
          }
          this.log.info('whatsapp_reconcile.session_recovered', { sessionId: session.id });
        } else {
          this.log.warn('whatsapp_reconcile.session_stale', {
            sessionId: session.id,
            label: session.label,
            lastSeenAt: session.lastSeenAt?.toISOString() ?? null,
            gatewaySaysConnected: true,
          });
        }
        continue;
      }

      if (session.status !== 'disconnected') {
        const disconnected = await this.deps.repo.updateSessionStatus({
          sessionId: session.id,
          status: 'disconnected',
        });
        if (!disconnected.ok) {
          this.log.error('whatsapp_reconcile.session_disconnect_write_failed', {
            sessionId: session.id,
            error: disconnected.error.message,
          });
          continue;
        }
      }
      const dark = await this.deps.repo.markDark(
        session.id,
        session.lastSeenAt ?? new Date(),
      );
      if (!dark.ok) {
        this.log.error('whatsapp_reconcile.session_dark_write_failed', {
          sessionId: session.id,
          error: dark.error.message,
        });
        continue;
      }
      alarms += 1;
      this.log.warn('whatsapp_reconcile.session_stale', {
        sessionId: session.id,
        label: session.label,
        lastSeenAt: session.lastSeenAt?.toISOString() ?? null,
        gatewaySaysConnected: false,
      });
    }

    return alarms;
  }

  /**
   * Gateway sessions Divo has no row for.
   *
   * Invisible in every other view: the follow-ups page lists Divo's rows, so a
   * session the gateway holds and Divo does not appears nowhere at all, while
   * it keeps a connection retrying forever. Three accumulated from one
   * afternoon of a team retrying a link, and the only reason anybody found out
   * was a shell on the server.
   *
   * Reported, never deleted. A session with no row may be mid-link in another
   * process, and removing somebody's half-scanned handset to tidy a log is a
   * far worse outcome than a warning nobody reads for a day.
   */
  private async reportGatewayOrphans(): Promise<number> {
    const remote = await this.deps.gateway.listSessions();
    if (!remote.ok) {
      this.log.warn('whatsapp_reconcile.orphan_scan_failed', { error: remote.error.message });
      return 0;
    }
    const known = await this.deps.repo.listLinkedSessions();
    if (!known.ok) {
      this.log.warn('whatsapp_reconcile.orphan_scan_failed', { error: known.error.message });
      return 0;
    }

    const mine = new Set(known.value.map(session => session.openwaSessionId));
    const orphans = remote.value.filter(session => session.id && !mine.has(session.id));
    if (orphans.length > 0) {
      this.log.warn('whatsapp_reconcile.gateway_orphans', {
        count: orphans.length,
        sessions: orphans.slice(0, 10).map(session => ({ id: session.id, name: session.name })),
      });
    }
    return orphans.length;
  }

  /** Fill in group subjects, which webhook payloads never carry. */
  private async refreshChatNames(): Promise<number> {
    const sessions = await this.deps.repo.listLinkedSessions();
    if (!sessions.ok) return 0;

    let renamed = 0;
    for (const session of sessions.value) {
      const chats = await this.deps.gateway.chats(session.openwaSessionId);
      if (!chats.ok) {
        this.log.warn('whatsapp_reconcile.chat_list_failed', {
          sessionId: session.id,
          error: chats.error.message,
        });
        continue;
      }
      for (const chat of chats.value) {
        if (!chat.id || !chat.name) continue;
        const written = await this.deps.repo.renameChat({
          companyId: session.companyId,
          waChatId: chat.id,
          name: chat.name,
          isGroup: Boolean(chat.isGroup),
        });
        if (written.ok) renamed += 1;
      }
    }
    return renamed;
  }

  /** Drop transcript past the retention window, a batch at a time. */
  private async pruneTranscript(): Promise<number> {
    const retentionMs = this.deps.retentionMs ?? 90 * 24 * 60 * 60_000;
    const cutoff = new Date(Date.now() - retentionMs);
    const removed = await this.deps.repo.pruneMessagesBefore(cutoff, PRUNE_BATCH);
    if (!removed.ok) {
      this.log.error('whatsapp_reconcile.prune_failed', { error: removed.error.message });
      return 0;
    }
    return removed.value;
  }
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
