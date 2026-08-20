import { Router, type Request, type Response } from 'express';
import type { GoogleConnectionAuthorizationService } from '../../application/connections/google-connection-authorization.service';
import type { ConnectionAskCourier } from '../../application/connections/connection-ask-courier';
import type { Logger } from '../../shared/logger';

export function createGoogleConnectionRoutes(deps: {
  authorization: GoogleConnectionAuthorizationService;
  /** Answers the run that is standing still waiting for this callback. */
  askCourier: Pick<ConnectionAskCourier, 'answer'>;
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
          /*
           * The run that asked never ended. It is blocked on this exact answer,
           * so the browser's last act is to unblock it, and the work carries on
           * inside the run the member was already watching.
           */
          const answered = await deps.askCourier.answer(completion.intentId, true);
          const where = completion.channel === 'web' ? 'the web thread' : 'Lark';
          res.status(200).send(resultHtml(
            true,
            'Google connected',
            answered === 'answered'
              ? `Connected as ${completion.accountName}. Divo is picking your request back up in ${where} now.`
              // Said plainly rather than dressed up. The account is genuinely
              // connected, and the only thing lost is the run that was waiting.
              : `Connected as ${completion.accountName}. The earlier request stopped waiting, so ask Divo again in ${where}.`,
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
