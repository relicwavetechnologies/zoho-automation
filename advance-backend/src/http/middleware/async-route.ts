import type { Request, Response } from 'express';
import type { Logger } from '../../shared/logger';

/**
 * The last thing between a thrown route and a dead process.
 *
 * Express 4 does not await an `async` handler, so a rejection inside one is an
 * unhandled rejection, and Node exits on those. That is not theoretical: the
 * tunnel to the development database dropped, the Prisma pool timed out inside
 * a member route, and the backend was gone for eight hours while the process
 * list still showed everything else running.
 *
 * The admin routers each carry a private copy of this. This one is shared
 * because it acquired a second caller the day the member routers needed it —
 * the admin copies are older and are left alone rather than migrated in a
 * change about something else.
 *
 * This is a backstop, not error handling. A route that knows what a failure
 * means still answers it itself, with the status and sentence that failure
 * deserves; everything reaching here is unforeseen, and is reported as such
 * rather than dressed up as a refusal the caller could act on.
 */
export function createAsyncRoute(logger: Logger) {
  return (handler: (req: Request, res: Response) => Promise<void>) =>
    async (req: Request, res: Response): Promise<void> => {
      try {
        await handler(req, res);
      } catch (error) {
        logger.error('route.unhandled', {
          method: req.method,
          path: req.originalUrl,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
        // A handler may already have answered before throwing — writing a
        // second time would throw again, here, where nothing is left to catch.
        if (res.headersSent) return;
        res.status(500).json({
          ok: false,
          code: 'unexpected',
          message: 'Something went wrong at our end. Nothing was changed.',
        });
      }
    };
}
