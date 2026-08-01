import { Router } from 'express';
import type { PrismaClient } from '../generated/prisma';
import type { KnowledgeOperationsService } from '../application/knowledge/knowledge-operations.service';

export const createHealthRoutes = (
  prisma: PrismaClient,
  options: {
    larkCardCallbackUrl?: string;
    knowledgeOperations?: Pick<KnowledgeOperationsService, 'health'>;
  } = {},
): Router => {
  const router = Router();

  router.get('/', async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    } catch {
      res.status(503).json({ status: 'degraded', db: 'unreachable' });
    }
  });

  router.get('/lark-card-callback', (_req, res) => {
    if (!options.larkCardCallbackUrl) {
      res.status(503).json({
        status: 'degraded',
        reason: 'callback_not_configured',
        callbackPath: '/webhooks/lark/events',
      });
      return;
    }
    res.json({
      status: 'ok',
      callbackPath: new URL(options.larkCardCallbackUrl).pathname,
    });
  });

  router.get('/knowledge', async (_req, res) => {
    if (!options.knowledgeOperations) {
      res.status(503).json({ status: 'degraded', reason: 'knowledge_health_not_configured' });
      return;
    }
    try {
      const health = await options.knowledgeOperations.health();
      res.status(health.status === 'ok' ? 200 : 503).json(health);
    } catch {
      res.status(503).json({ status: 'degraded', reason: 'knowledge_health_unavailable' });
    }
  });

  return router;
};
