import type { RequestHandler } from 'express';
import type { Logger } from '../../shared/logger';

/**
 * Backend-owned entitlement gate for browser chat.
 *
 * An unavailable lookup is not permission. The middleware returns a retryable
 * error instead of silently admitting the request, so a department whose chat
 * is disabled cannot cross the seam during a database outage.
 */
export function createRequireChatEnabled(deps: {
  readonly chatEnabledFor: (input: {
    companyId: string;
    userId: string;
  }) => Promise<boolean>;
  readonly logger: Logger;
}): RequestHandler {
  const log = deps.logger.child({ middleware: 'web-chat-access' });

  return (req, res, next) => {
    const companyId = String(res.locals['companyId'] ?? '');
    const userId = String(res.locals['userId'] ?? '');
    if (!companyId || !userId) {
      log.error('web_chat.gate.identity_missing', { path: req.path });
      res.status(503).json({
        success: false,
        code: 'chat_availability_unavailable',
        message: 'Divo could not check whether chat is enabled. Nothing was started.',
      });
      return;
    }

    void deps.chatEnabledFor({ companyId, userId })
      .then(enabled => {
        if (enabled) {
          next();
          return;
        }
        log.info('web_chat.refused', { companyId, userId, path: req.path });
        res.status(403).json({
          success: false,
          code: 'chat_not_enabled',
          message: 'Divo chat is not enabled for your team. Mail and Follow-ups are still yours.',
        });
      })
      .catch((error: unknown) => {
        log.error('web_chat.gate.error', {
          companyId,
          userId,
          path: req.path,
          error: error instanceof Error ? error.message : String(error),
        });
        res.status(503).json({
          success: false,
          code: 'chat_availability_unavailable',
          message: 'Divo could not check whether chat is enabled. Nothing was started.',
        });
      });
  };
}
