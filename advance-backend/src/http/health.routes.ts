import { Router } from 'express';
import type { PrismaClient } from '../generated/prisma';

export const createHealthRoutes = (prisma: PrismaClient): Router => {
  const router = Router();

  router.get('/', async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    } catch {
      res.status(503).json({ status: 'degraded', db: 'unreachable' });
    }
  });

  return router;
};
