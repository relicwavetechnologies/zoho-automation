/**
 * The registered-tool catalogue the admin UI reads.
 *
 * This lived inside the agent-definition routes, which were deleted with the
 * in-backend agent — but it was never about agents. Skills Lab and the
 * department editor both use it to show which governed tools exist, so it
 * stands on its own rather than keeping a dead module alive around it.
 */

import { Router, type Request, type Response } from 'express';
import type { PrismaClient } from '../../generated/prisma';

export interface ToolRegistryRoutesDeps {
  readonly prisma: PrismaClient;
}

export function createToolRegistryRoutes(deps: ToolRegistryRoutesDeps): Router {
  const router = Router();

  router.get('/', async (_req: Request, res: Response): Promise<void> => {
    try {
      const tools = await deps.prisma.registeredTool.findMany({
        where: { deprecated: false },
        orderBy: [{ category: 'asc' }, { name: 'asc' }],
      });
      res.json({ success: true, data: tools, message: 'Registered tools loaded' });
    } catch {
      res.status(500).json({ success: false, message: 'Could not load registered tools' });
    }
  });

  return router;
}
