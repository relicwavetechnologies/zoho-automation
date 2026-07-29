import { Router, type Request, type Response } from 'express';
import type { GoogleConnectionAuthorizationService } from '../../application/connections/google-connection-authorization.service';
import type { GoogleConnectionContinuationQueue } from '../../application/connections/google-connection-continuation';
import type { Logger } from '../../shared/logger';

export function createGoogleConnectionRoutes(deps: {
  authorization: GoogleConnectionAuthorizationService;
  continuationQueue: Pick<GoogleConnectionContinuationQueue, 'enqueue'>;
  logger: Logger;
}): Router {
  const router = Router();
  const log = deps.logger.child({ router: 'google-connection' });

  router.get('/callback', async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const state = typeof req.query['state'] === 'string'
      ? req.query['state']
      : '';
    if (!state) {
      res.status(400).send(resultHtml(
        false,
        'Invalid connection link',
        'Return to Lark and ask Divo to connect Google again.',
      ));
      return;
    }

    try {
      const completion = await deps.authorization.complete({
        state,
        ...(typeof req.query['code'] === 'string'
          ? { code: req.query['code'] }
          : {}),
        ...(typeof req.query['error'] === 'string'
          ? { providerError: req.query['error'] }
          : {}),
      });

      switch (completion.outcome) {
        case 'connected': {
          try {
            await deps.continuationQueue.enqueue(completion.intentId);
          } catch (error) {
            // The durable intent remains pending. Worker reconciliation will
            // admit it without making the browser wait for an agent run.
            log.warn('google.connection.continuation_enqueue_failed', {
              intentId: completion.intentId,
              error: String(error),
            });
          }
          res.status(200).send(resultHtml(
            true,
            'Google connected',
            `Connected as ${completion.accountName}. Divo is continuing your request in Lark now.`,
          ));
          return;
        }
        case 'already_consumed':
          res.status(200).send(resultHtml(
            true,
            'Connection already handled',
            'You can close this tab and return to Lark.',
          ));
          return;
        case 'denied':
          res.status(400).send(resultHtml(
            false,
            'Google connection cancelled',
            'No agent continuation was started.',
          ));
          return;
        case 'expired':
          res.status(410).send(resultHtml(
            false,
            'Connection link expired',
            'Return to Lark and ask Divo to connect Google again.',
          ));
          return;
        case 'invalid':
          res.status(400).send(resultHtml(
            false,
            'Invalid connection link',
            'Return to Lark and ask Divo to connect Google again.',
          ));
          return;
      }
    } catch (error) {
      log.error('google.connection.callback_failed', { error: String(error) });
      res.status(500).send(resultHtml(
        false,
        'Google connection failed',
        'Return to Lark and try connecting again.',
      ));
    }
  });

  return router;
}

function resultHtml(ok: boolean, title: string, detail: string): string {
  const color = ok ? '#15803d' : '#dc2626';
  const background = ok ? '#f0fdf4' : '#fef2f2';
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Divo — ${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:${background}}
.card{background:#fff;border-radius:12px;padding:40px 48px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:520px}
.title{font-size:22px;font-weight:700;color:${color};margin:0 0 8px}.sub{color:#6b7280;font-size:15px;margin:0}</style></head>
<body><div class="card"><p class="title">${escapeHtml(title)}</p><p class="sub">${escapeHtml(detail)}</p></div></body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
