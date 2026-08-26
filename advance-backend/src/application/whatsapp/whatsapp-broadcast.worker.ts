import type { Logger } from '../../shared/logger';
import {
  POLL_INTERVAL_MS,
  type WhatsappBroadcastService,
} from './whatsapp-broadcast.service';

/**
 * Someone has to keep asking.
 *
 * The gateway publishes twenty-three webhook events and not one of them is
 * about a batch, so a running broadcast reports nothing until it is asked. The
 * screen asks while somebody is watching it — but a person who starts an
 * eighty-recipient send and closes the tab would otherwise leave a row stuck at
 * `sending` forever, with recipients marked `pending` for messages that went out
 * ten minutes ago.
 *
 * That matters beyond tidiness. The gateway abandons in-flight batches across
 * its own restart, deliberately, because resuming risks double-sends. Nothing
 * tells us it did. A broadcast whose batch has been abandoned looks identical to
 * one that is still going, and only a poll that comes back 404 distinguishes
 * them — which is the difference between a history that says what happened and
 * one that quietly lies.
 *
 * The tick is cheap by construction: one query that returns only broadcasts in a
 * live state whose last reading has aged out, and nothing at all to do when
 * nobody is sending. It does not call a model and it does not touch WhatsApp.
 */

/** Broadcasts read per tick. More than a handful running at once is unusual. */
const POLL_BATCH = 10;

export interface WhatsappBroadcastWorkerDeps {
  readonly broadcasts: WhatsappBroadcastService;
  readonly logger: Logger;
  /**
   * How often to look for readings to refresh. Defaults to the same interval a
   * reading is considered fresh for, so a broadcast is re-read roughly every
   * `POLL_INTERVAL_MS` however the two are scheduled against each other.
   */
  readonly scanIntervalMs?: number;
}

export class WhatsappBroadcastWorker {
  private readonly log: Logger;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly deps: WhatsappBroadcastWorkerDeps) {
    this.log = deps.logger.child({ service: 'whatsapp-broadcast-worker' });
  }

  start(): void {
    const tick = () => {
      void this.runOnce().catch((error: unknown) => {
        this.log.error('whatsapp_broadcast.tick_failed', { error: errorText(error) });
      });
    };
    tick();
    this.timer = setInterval(tick, this.deps.scanIntervalMs ?? POLL_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(): Promise<void> {
    // A slow gateway must not let ticks pile up on top of each other; the next
    // one will pick up whatever this one did not reach.
    if (this.running) return;
    this.running = true;
    try {
      const pending = await this.deps.broadcasts.pollable(POLL_BATCH);
      if (!pending.ok) {
        this.log.error('whatsapp_broadcast.list_failed', { error: pending.error.message });
        return;
      }
      if (pending.value.length === 0) return;

      let polled = 0;
      for (const broadcast of pending.value) {
        const result = await this.deps.broadcasts.poll(broadcast);
        if (!result.ok) {
          // One unreadable batch must not abandon the rest. The row keeps its
          // old reading and its stale `lastPolledAt`, so the next tick tries it
          // again rather than treating the failure as an answer.
          this.log.warn('whatsapp_broadcast.poll_failed', {
            broadcastId: broadcast.id,
            error: result.error.message,
          });
          continue;
        }
        polled += 1;
      }
      this.log.info('whatsapp_broadcast.tick', { seen: pending.value.length, polled });
    } finally {
      this.running = false;
    }
  }
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
