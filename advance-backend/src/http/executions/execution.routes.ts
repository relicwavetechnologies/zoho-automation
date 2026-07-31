/**
 * Execution trace routes — read-only observability for orchestration runs.
 *
 * All routes are company-scoped. Auth is enforced by the caller (middleware
 * that sets res.locals.companyId + res.locals.canViewRawExecutionData).
 *
 * Routes:
 *   GET /executions               — list recent runs (paginated)
 *   GET /executions/:id           — single run detail
 *   GET /executions/:id/events    — ordered event stream for a run
 *
 * Query params:
 *   ?limit=N    (max 200)
 *   ?offset=N
 *   ?status=running|completed|failed
 *   ?channel=lark|desktop
 *   ?phase=init|plan|execute|synthesis|complete|error  (events only)
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import type { ExecutionQueryService } from '../../application/observability/execution-query.service';
import type { Logger } from '../../shared/logger';

export interface ExecutionRoutesDeps {
  executionQueryService: ExecutionQueryService;
  logger:               Logger;
}

/**
 * Minimal auth context expected on res.locals by upstream middleware.
 * Production wiring must populate these from a verified JWT / session.
 */
interface AuthLocals {
  companyId:                string;
  canViewRawExecutionData: boolean;
  userId:                   string | null;
}

function getAuth(res: Response): AuthLocals {
  return {
    companyId:                res.locals['companyId'] as string,
    canViewRawExecutionData: (res.locals['canViewRawExecutionData'] as boolean | undefined) ?? false,
    userId:                   (res.locals['userId'] as string | undefined) ?? null,
  };
}

export function createExecutionRoutes(deps: ExecutionRoutesDeps): Router {
  const router = Router();
  const { executionQueryService, logger } = deps;

  // ── GET /executions ──────────────────────────────────────────────────────
  router.get('/', async (req: Request, res: Response): Promise<void> => {
    const { companyId } = getAuth(res);

    if (!companyId) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    try {
      const runs = await executionQueryService.listRuns({
        companyId,
        limit:   Number(req.query['limit'])  || 50,
        offset:  Number(req.query['offset']) || 0,
        ...(req.query['status']  ? { status:  String(req.query['status']) }  : {}),
        ...(req.query['channel'] ? { channel: String(req.query['channel']) } : {}),
        ...(req.query['userId']  ? { userId:  String(req.query['userId']) }  : {}),
      });

      res.json({ success: true, data: runs, total: runs.length });
    } catch (e) {
      logger.error('execution.routes.list.failed', { error: String(e), companyId });
      res.status(500).json({ success: false, message: 'internal_error' });
    }
  });

  // ── GET /executions/:id ──────────────────────────────────────────────────
  router.get('/:id', async (req: Request, res: Response): Promise<void> => {
    const { companyId } = getAuth(res);

    if (!companyId) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    try {
      const run = await executionQueryService.getRun({
        id: req.params['id']!,
        companyId,
      });

      if (!run) {
        res.status(404).json({ success: false, message: 'not_found' });
        return;
      }

      res.json({ success: true, data: run });
    } catch (e) {
      logger.error('execution.routes.get.failed', { error: String(e), id: req.params['id'] });
      res.status(500).json({ success: false, message: 'internal_error' });
    }
  });

  // ── GET /executions/:id/events ───────────────────────────────────────────
  router.get('/:id/events', async (req: Request, res: Response): Promise<void> => {
    const { companyId, canViewRawExecutionData } = getAuth(res);

    if (!companyId) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    try {
      const events = await executionQueryService.getEvents({
        executionId: req.params['id']!,
        companyId,
        canViewRawExecutionData,
        limit:       Number(req.query['limit']) || 500,
        ...(req.query['phase'] ? { phase: String(req.query['phase']) } : {}),
      });

      res.json({ success: true, data: events, total: events.length });
    } catch (e) {
      logger.error('execution.routes.events.failed', { error: String(e), id: req.params['id'] });
      res.status(500).json({ success: false, message: 'internal_error' });
    }
  });

  return router;
}
