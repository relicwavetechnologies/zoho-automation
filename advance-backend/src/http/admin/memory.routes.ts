/**
 * Memory browser routes — admin read/delete access to Mem0 memories.
 *
 * Mounted at /api/admin/memories behind admin auth.
 *
 *   GET    /          — list memories (filters: userId, departmentId, scope, limit)
 *   GET    /stats     — memory counts by scope for the company
 *   DELETE /:id       — delete a single memory
 *   DELETE /user/:userId — delete all memories for a user
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import type { Mem0Service } from '../../application/memory/mem0.service';
import type { Logger } from '../../shared/logger';

export interface MemoryRoutesDeps {
  mem0: Mem0Service | null;
  logger: Logger;
}

const success = <T>(res: Response, data: T, message?: string, status = 200) =>
  res.status(status).json({ success: true, data, ...(message ? { message } : {}) });

const fail = (res: Response, status: number, message: string) =>
  res.status(status).json({ success: false, message });

function resolveCompanyId(res: Response): string | null {
  const isSuperAdmin = Boolean(res.locals['isSuperAdmin']);
  const localId = res.locals['companyId'] as string | undefined ?? '';
  return isSuperAdmin ? (localId || null) : (localId || null);
}

export function createMemoryRoutes(deps: MemoryRoutesDeps): Router {
  const router = Router();
  const { mem0, logger } = deps;

  if (!mem0) {
    router.use((_req, res) => {
      fail(res, 503, 'Memory system is not enabled');
    });
    return router;
  }

  router.get('/stats', async (_req: Request, res: Response): Promise<void> => {
    const companyId = resolveCompanyId(res);
    if (!companyId) { fail(res, 401, 'unauthorized'); return; }

    try {
      const stats = await mem0.getMemoryStats({ companyId });
      success(res, stats, 'Memory stats loaded');
    } catch (e) {
      logger.error('memory.routes.stats.failed', { error: String(e), companyId });
      fail(res, 500, 'Failed to load memory stats');
    }
  });

  router.get('/', async (req: Request, res: Response): Promise<void> => {
    const companyId = resolveCompanyId(res);
    if (!companyId) { fail(res, 401, 'unauthorized'); return; }

    try {
      const memories = await mem0.listMemories({
        companyId,
        ...(req.query['userId'] ? { userId: String(req.query['userId']) } : {}),
        ...(req.query['departmentId'] ? { departmentId: String(req.query['departmentId']) } : {}),
        ...(req.query['scope'] ? { scope: String(req.query['scope']) as 'user' | 'department' | 'company' } : {}),
        ...(req.query['limit'] ? { limit: Number(req.query['limit']) } : {}),
      });
      success(res, memories, 'Memories loaded');
    } catch (e) {
      logger.error('memory.routes.list.failed', { error: String(e), companyId });
      fail(res, 500, 'Failed to load memories');
    }
  });

  router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
    const companyId = resolveCompanyId(res);
    if (!companyId) { fail(res, 401, 'unauthorized'); return; }

    try {
      await mem0.deleteMemory(req.params['id']!);
      success(res, { deleted: true }, 'Memory deleted');
    } catch (e) {
      logger.error('memory.routes.delete.failed', { error: String(e), id: req.params['id'] });
      fail(res, 500, 'Failed to delete memory');
    }
  });

  router.delete('/user/:userId', async (req: Request, res: Response): Promise<void> => {
    const companyId = resolveCompanyId(res);
    if (!companyId) { fail(res, 401, 'unauthorized'); return; }

    try {
      await mem0.deleteAllForUser(req.params['userId']!);
      success(res, { deleted: true }, 'All memories for user deleted');
    } catch (e) {
      logger.error('memory.routes.deleteAll.failed', { error: String(e), userId: req.params['userId'] });
      fail(res, 500, 'Failed to delete memories');
    }
  });

  return router;
}
