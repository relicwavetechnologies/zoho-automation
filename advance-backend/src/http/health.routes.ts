import { Router } from 'express';
import type { PrismaClient } from '../generated/prisma';
import type { KnowledgeOperationsService } from '../application/knowledge/knowledge-operations.service';

export const createHealthRoutes = (
  prisma: PrismaClient,
  options: {
    larkCardCallbackUrl?: string;
    larkCardCallbackProbe?: (url: string) => Promise<boolean>;
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

  router.get('/lark-card-callback', async (_req, res) => {
    if (!options.larkCardCallbackUrl) {
      res.status(503).json({
        status: 'degraded',
        reason: 'callback_not_configured',
        callbackPath: '/webhooks/lark/events',
      });
      return;
    }
    const callbackPath = new URL(options.larkCardCallbackUrl).pathname;
    const reachable = await (
      options.larkCardCallbackProbe ?? probeConfiguredCallbackUrl
    )(options.larkCardCallbackUrl).catch(() => false);
    if (!reachable) {
      res.status(503).json({
        status: 'degraded',
        reason: 'callback_url_unreachable',
        callbackPath,
        providerConfiguration: 'unverified',
      });
      return;
    }
    res.json({
      status: 'reachable',
      callbackPath,
      providerConfiguration: 'unverified',
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

async function probeConfiguredCallbackUrl(url: string): Promise<boolean> {
  const response = await fetch(url, {
    method: 'GET',
    redirect: 'manual',
    signal: AbortSignal.timeout(3_000),
  });
  // Any HTTP response proves that the configured public route is reachable.
  // It cannot prove what URL is stored in the Lark developer console.
  return response.status > 0;
}
