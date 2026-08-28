/**
 * The one public route WhatsApp needs.
 *
 * OpenWA pushes here on `message.received` and `message.sent`. Nothing else in
 * this feature is reachable from outside Divo.
 *
 * Two behaviours are ported deliberately from the follow-up agent, because both
 * are load-bearing:
 *
 *   1. The HMAC covers the exact bytes OpenWA sent, so verification runs against
 *      the captured raw body rather than the re-serialised object.
 *   2. The response goes out *before* the work happens. OpenWA retries a slow
 *      receiver, and a duplicate delivery costs us one idempotency lookup while
 *      a stalled webhook queue costs us the stream.
 */
import { Router, type Request, type Response } from 'express';
import type { Logger } from '../../shared/logger';
import { verifyWhatsappSignature } from '../../infrastructure/whatsapp/whatsapp-webhook.security';
import type { WhatsappIngestService } from '../../application/whatsapp/whatsapp-ingest.service';
import type { WhatsappWebhookEnvelope } from '../../application/whatsapp/whatsapp-message.normalize';
import { createAsyncRoute } from '../middleware/async-route';

const header = (req: Request, name: string): string | undefined => {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

export function createWhatsappWebhookRoutes(deps: {
  readonly ingest: WhatsappIngestService;
  readonly webhookSecret?: string;
  readonly logger: Logger;
}): Router {
  const router = Router();
  const log = deps.logger.child({ router: 'whatsapp-webhook' });
  const route = createAsyncRoute(log);

  router.post('/webhook', route(async (req: Request, res: Response) => {
    const rawBody = (req as unknown as Record<string, unknown>)['rawBody'];
    if (typeof rawBody !== 'string') {
      // The body never reached the JSON parser's verify hook, so there is
      // nothing to check a signature against. Refusing beats trusting.
      res.status(400).json({ error: 'invalid_whatsapp_webhook' });
      return;
    }

    if (!verifyWhatsappSignature(rawBody, header(req, 'x-openwa-signature'), deps.webhookSecret)) {
      res.status(401).json({ error: 'invalid_whatsapp_webhook' });
      return;
    }

    let envelope: WhatsappWebhookEnvelope;
    try {
      envelope = JSON.parse(rawBody) as WhatsappWebhookEnvelope;
    } catch {
      res.status(400).json({ error: 'invalid_whatsapp_webhook_payload' });
      return;
    }

    // The acknowledgement comes only after the receipt exists. OpenWA will
    // retry a 503, while a 200 closes its delivery path permanently.
    const admitted = await deps.ingest.admit(
      envelope,
      header(req, 'x-openwa-idempotency-key'),
    );
    if (admitted.status === 'failed') {
      log.error('whatsapp.admission_failed', { error: admitted.error });
      res.status(503).json({ error: 'whatsapp_ingress_unavailable' });
      return;
    }
    if (admitted.status === 'rejected') {
      if (admitted.reason === 'malformed') {
        log.warn('whatsapp.admission_rejected', { reason: admitted.reason });
      }
      res.json({ ok: true, ignored: true });
      return;
    }
    if (admitted.status === 'duplicate') {
      res.json({ ok: true, duplicate: true });
      return;
    }

    res.json({ ok: true });

    void deps.ingest
      .process(admitted.receiptId)
      .then(outcome => {
        if (outcome.status === 'failed') {
          log.error('whatsapp.ingest_failed', { error: outcome.error });
        } else if (outcome.status === 'unknown_session') {
          log.warn('whatsapp.ingest_unknown_session', { openwaSessionId: outcome.openwaSessionId });
        }
      })
      .catch((error: unknown) => {
        log.error('whatsapp.ingest_threw', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }));

  return router;
}
