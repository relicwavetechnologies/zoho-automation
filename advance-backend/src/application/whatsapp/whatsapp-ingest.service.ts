import type { Logger } from '../../shared/logger';
import type { IngressReceiptRepoPort } from '../../infrastructure/persistence/ingress-receipt.repository';
import type { WhatsappRepoPort } from '../../infrastructure/persistence/whatsapp.repository';
import {
  normalizeWhatsappEnvelope,
  type WhatsappIngestRejection,
  type WhatsappWebhookEnvelope,
} from './whatsapp-message.normalize';

/**
 * One WhatsApp message, from webhook to stored row.
 *
 * The message really is pushed — OpenWA POSTs on `message.received` and
 * `message.sent`, and the follow-up agent registers for both at startup. Only
 * the analysis half is polled, and it polls our own database rather than
 * WhatsApp. Worth stating plainly because the two halves are easy to conflate.
 *
 * What changes in the port: the imported agent kept its own `seen_deliveries`
 * table and wrote to SQLite synchronously inside the request. Divo reuses
 * `IngressIdempotencyKey` — already unique on `(channel, tenantKey, messageId)`
 * — with `channel='whatsapp'`, so WhatsApp gets the same durability, recovery
 * sweep and dead-lettering as every other ingress without a second mechanism to
 * reason about.
 *
 * Deliberately not queued. The work is a normalise and two writes; a queue would
 * buy throughput this will never need and cost a hop that can fail. Durability
 * comes from the receipt: anything accepted and not completed is found again by
 * the reconcile sweep.
 */

export const WHATSAPP_INGRESS_CHANNEL = 'whatsapp';

export type WhatsappIngestOutcome =
  | { readonly status: 'stored'; readonly chatId: string }
  | { readonly status: 'duplicate' }
  | { readonly status: 'rejected'; readonly reason: WhatsappIngestRejection }
  | { readonly status: 'unknown_session'; readonly openwaSessionId: string }
  | { readonly status: 'failed'; readonly error: string };

/**
 * The durable half of webhook handling.
 *
 * `accepted` means the exact provider payload is in Postgres and may safely be
 * acknowledged. Processing is deliberately a second step: a process can die
 * after the acknowledgement and the recovery sweep still has the receipt.
 */
export type WhatsappIngressAdmission =
  | { readonly status: 'accepted'; readonly receiptId: string }
  | { readonly status: 'duplicate' }
  | { readonly status: 'rejected'; readonly reason: WhatsappIngestRejection }
  | { readonly status: 'failed'; readonly error: string };

export class WhatsappIngestService {
  private readonly log: Logger;

  constructor(
    private readonly deps: {
      readonly receipts: IngressReceiptRepoPort;
      readonly repo: WhatsappRepoPort;
      readonly logger: Logger;
    },
  ) {
    this.log = deps.logger.child({ service: 'whatsapp-ingest' });
  }

  /**
   * Admit an envelope and store it.
   *
   * `idempotencyKey` is OpenWA's `X-OpenWA-Idempotency-Key` when it sends one.
   * Falling back to the message id is safe because the receipt's unique key
   * already includes the session, so two handsets that both saw a message
   * cannot collide with each other.
   */
  async ingest(
    envelope: WhatsappWebhookEnvelope,
    idempotencyKey: string | undefined,
  ): Promise<WhatsappIngestOutcome> {
    const admitted = await this.admit(envelope, idempotencyKey);
    if (admitted.status === 'accepted') return this.process(admitted.receiptId);
    return admitted;
  }

  /**
   * Persist a provider delivery before the HTTP route acknowledges it.
   *
   * Admission does not require a Divo session row. Session registration and
   * webhook delivery can race by milliseconds after a number is created; the
   * receipt keeps that event recoverable until the session row appears.
   */
  async admit(
    envelope: WhatsappWebhookEnvelope,
    idempotencyKey: string | undefined,
  ): Promise<WhatsappIngressAdmission> {
    const normalized = normalizeWhatsappEnvelope(envelope);
    if (!normalized.ok) {
      // Not a failure worth a receipt. Status posts and unsubscribed event types
      // arrive constantly, and recording each one would bury real faults.
      return { status: 'rejected', reason: normalized.reason };
    }

    const { sessionId: openwaSessionId, message } = normalized;

    const accepted = await this.deps.receipts.accept({
      channel: WHATSAPP_INGRESS_CHANNEL,
      tenantKey: openwaSessionId,
      messageId: message.waMessageId,
      payload: envelope as unknown as Record<string, unknown>,
      ...(idempotencyKey ? { eventId: idempotencyKey } : {}),
    });
    if (!accepted.ok) return { status: 'failed', error: accepted.error.message };
    if (!accepted.value.isNew) return { status: 'duplicate' };
    return { status: 'accepted', receiptId: accepted.value.receiptId };
  }

  /**
   * Do the stored work for an accepted receipt.
   *
   * Takes only the receipt id. The envelope is already on the receipt, so asking
   * a caller to carry it alongside would let the two disagree — and, worse,
   * tempt the caller to claim the receipt first in order to read it. That is
   * exactly the bug this shape prevents: `claim` is a lease, so a caller that
   * claims and then calls in here makes the lease *live*, and this method's own
   * claim is refused as `leased`. The receipt would then be skipped on every
   * sweep, forever, while looking like ordinary contention.
   *
   * One claim, taken here, is the invariant. The recovery sweep must not take
   * its own.
   */
  async process(receiptId: string): Promise<WhatsappIngestOutcome> {
    const claim = await this.deps.receipts.claim(receiptId);
    if (!claim.ok) return { status: 'failed', error: claim.error.message };
    // `leased` means another worker owns it and `terminal` means it is done.
    // Both are "not mine", and neither is an error.
    if (claim.value.outcome !== 'claimed') return { status: 'duplicate' };

    const envelope = claim.value.receipt.payload as unknown as WhatsappWebhookEnvelope;
    const normalized = normalizeWhatsappEnvelope(envelope);
    if (!normalized.ok) {
      await this.deps.receipts.markFailed(receiptId, `malformed: ${normalized.reason}`, { terminal: true });
      return { status: 'rejected', reason: normalized.reason };
    }

    const session = await this.deps.repo.findSessionByOpenwaId(normalized.sessionId);
    if (!session.ok) {
      await this.deps.receipts.markFailed(receiptId, session.error);
      return { status: 'failed', error: session.error.message };
    }
    if (!session.value) {
      // Registration and webhook delivery can race after a number is created.
      // Keep the receipt retryable: once the session row appears the same stored
      // payload acquires its company and department through this lookup.
      await this.deps.receipts.markFailed(receiptId, 'unknown session');
      return { status: 'unknown_session', openwaSessionId: normalized.sessionId };
    }

    const stored = await this.deps.repo.storeMessage({
      session: session.value,
      message: normalized.message,
    });
    if (!stored.ok) {
      await this.deps.receipts.markFailed(receiptId, stored.error);
      return { status: 'failed', error: stored.error.message };
    }

    // Proof of life for the staleness alarm. Written on every message rather
    // than on a timer, so "when did we last hear from this handset" is answered
    // by traffic rather than by a heartbeat that can outlive the stream.
    //
    // The result is checked, not dropped. `lastSeenAt` is the alarm's only
    // input, so a silently failing write makes a live handset look dark — or,
    // failing the other way, leaves a dark one looking healthy. Either way the
    // alarm starts lying, which is worse than not having one.
    const touched = await this.deps.repo.touchSession(session.value.id, new Date());
    if (!touched.ok) {
      this.log.error('whatsapp.touch_session_failed', {
        sessionId: session.value.id,
        error: touched.error.message,
      });
    }

    // Checked for a different reason: an unnoticed failure here leaves finished
    // work sitting in `processing`, which the sweep then keeps re-claiming as a
    // phantom stuck receipt.
    const completed = await this.deps.receipts.markCompleted(receiptId);
    if (!completed.ok) {
      this.log.error('whatsapp.mark_completed_failed', {
        receiptId,
        error: completed.error.message,
      });
      return { status: 'failed', error: completed.error.message };
    }

    if (stored.value.chatIsNew) {
      this.log.info('whatsapp.chat_opened', {
        chatId: stored.value.chatId,
        isGroup: normalized.message.isGroup,
        sessionId: session.value.id,
      });
    }

    return { status: 'stored', chatId: stored.value.chatId };
  }
}
