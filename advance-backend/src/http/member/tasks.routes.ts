import { Router, type Response } from 'express';
import { z } from 'zod';
import type { Logger } from '../../shared/logger';
import { readOpenTasks, type OpenTasksDeps } from '../../application/work/open-tasks';

/**
 * The work still waiting on the signed-in member.
 *
 * Read-only, and it stays that way. Ticking a task off from a dashboard means
 * this surface holds a credential that can change somebody's Lark, which is a
 * different permission conversation from showing them a list — so the module
 * behind this asks for read access only and there is no route here that writes.
 *
 * Named for the resource under `/api/me` because it is scoped to the caller and
 * to nobody else: there is no id in the path and no way to ask about another
 * person, which is the same shape `/api/artifacts` has and for the same reason.
 * See that file for why new member routes live in `http/member/`.
 */

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(25).optional(),
});

export function createMemberTaskRoutes(deps: OpenTasksDeps & { logger: Logger }): Router {
  const router = Router();

  router.get('/', async (_req, res: Response, next) => {
    try {
      const query = querySchema.safeParse(_req.query);
      if (!query.success) {
        res.status(400).json({ error: 'invalid_query' });
        return;
      }

      const reading = await readOpenTasks(deps, {
        userId: String(res.locals['userId']),
        companyId: String(res.locals['companyId']),
        ...(query.data.limit !== undefined ? { limit: query.data.limit } : {}),
      });

      /*
        Every reading is a 200. "No Lark account is linked" is a true and
        complete answer to what this route was asked, not a failure of it — a
        4xx would put a red error in a panel whose honest state is that there is
        nothing to show. The caller distinguishes them by `status`, which is why
        the module returns one.
      */
      if (reading.status === 'ok') {
        res.json({ status: 'ok', tasks: reading.tasks });
        return;
      }
      res.json({ status: reading.status, tasks: [] });
    } catch (error) {
      /*
        Lark being unreachable is not this member's problem to read about in a
        dashboard panel. It is logged and reported as "cannot see your tasks",
        which is the same thing an unlinked account means to the reader and the
        same thing the panel does about it.
      */
      deps.logger.warn('member_tasks.read_failed', {
        userId: String(res.locals['userId']),
        error: error instanceof Error ? error.message : String(error),
      });
      res.json({ status: 'not_connected', tasks: [] });
      void next;
    }
  });

  return router;
}
