/**
 * AI model control plane routes.
 *
 * Mounted at /api/admin/ai-models.
 *
 *   GET /   — list AI model target configurations
 *   PUT /:targetKey  — update a target config
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { PrismaClient } from '../../generated/prisma';
import type { Logger } from '../../shared/logger';

export interface AiModelsRoutesDeps {
  prisma: PrismaClient;
  logger: Logger;
}

type RouteError = Error & { status: number };

const success = <T>(res: Response, data: T, message?: string, status = 200) =>
  res.status(status).json({ success: true, data, ...(message ? { message } : {}) });

const fail = (res: Response, status: number, message: string) =>
  res.status(status).json({ success: false, message });

const asyncRoute = (handler: (req: Request, res: Response) => Promise<void>) =>
  async (req: Request, res: Response): Promise<void> => {
    try {
      await handler(req, res);
    } catch (error) {
      if (error instanceof z.ZodError) { fail(res, 400, error.issues[0]?.message ?? 'Invalid request'); return; }
      if (error instanceof Error && 'status' in error && typeof (error as RouteError).status === 'number') {
        fail(res, (error as RouteError).status, error.message); return;
      }
      throw error;
    }
  };

const updateTargetSchema = z.object({
  provider:            z.string().min(1).max(50),
  modelId:             z.string().min(1).max(100),
  thinkingLevel:       z.string().max(50).nullable().optional(),
  fastProvider:        z.string().max(50).nullable().optional(),
  fastModelId:         z.string().max(100).nullable().optional(),
  fastThinkingLevel:   z.string().max(50).nullable().optional(),
  xtremeProvider:      z.string().max(50).nullable().optional(),
  xtremeModelId:       z.string().max(100).nullable().optional(),
  xtremeThinkingLevel: z.string().max(50).nullable().optional(),
});

export function createAiModelsRoutes(deps: AiModelsRoutesDeps): Router {
  const router = Router();
  const { prisma } = deps;

  function assertAdminSession(res: Response): void {
    if (!Boolean(res.locals['isSuperAdmin']) && !res.locals['companyId']) {
      const e = new Error('Admin session company context required') as RouteError;
      e.status = 403;
      throw e;
    }
  }

  router.get('/', asyncRoute(async (_req, res) => {
    assertAdminSession(res);
    const rows = await prisma.aiModelTargetConfig.findMany({ orderBy: { targetKey: 'asc' } });
    const targets = rows.map(r => ({
      id:                  r.id,
      targetKey:           r.targetKey,
      provider:            r.provider,
      modelId:             r.modelId,
      thinkingLevel:       r.thinkingLevel,
      fastProvider:        r.fastProvider,
      fastModelId:         r.fastModelId,
      fastThinkingLevel:   r.fastThinkingLevel,
      xtremeProvider:      r.xtremeProvider,
      xtremeModelId:       r.xtremeModelId,
      xtremeThinkingLevel: r.xtremeThinkingLevel,
      updatedBy:           r.updatedBy,
      updatedAt:           r.updatedAt.toISOString(),
    }));
    success(res, targets, 'AI model controls loaded');
  }));

  router.put('/:targetKey', asyncRoute(async (req, res) => {
    assertAdminSession(res);
    const payload   = updateTargetSchema.parse(req.body);
    const { targetKey } = req.params as { targetKey: string };
    const updatedBy = (res.locals['userId'] as string | undefined) ?? 'unknown';

    const nullableFields = {
      ...(payload.thinkingLevel       !== undefined ? { thinkingLevel:       payload.thinkingLevel }       : {}),
      ...(payload.fastProvider        !== undefined ? { fastProvider:        payload.fastProvider }        : {}),
      ...(payload.fastModelId         !== undefined ? { fastModelId:         payload.fastModelId }         : {}),
      ...(payload.fastThinkingLevel   !== undefined ? { fastThinkingLevel:   payload.fastThinkingLevel }   : {}),
      ...(payload.xtremeProvider      !== undefined ? { xtremeProvider:      payload.xtremeProvider }      : {}),
      ...(payload.xtremeModelId       !== undefined ? { xtremeModelId:       payload.xtremeModelId }       : {}),
      ...(payload.xtremeThinkingLevel !== undefined ? { xtremeThinkingLevel: payload.xtremeThinkingLevel } : {}),
    };

    const updated = await prisma.aiModelTargetConfig.upsert({
      where:  { targetKey },
      update: { provider: payload.provider, modelId: payload.modelId, ...nullableFields, updatedBy },
      create: { targetKey, provider: payload.provider, modelId: payload.modelId, ...nullableFields, updatedBy },
    });
    success(res, {
      id:                  updated.id,
      targetKey:           updated.targetKey,
      provider:            updated.provider,
      modelId:             updated.modelId,
      thinkingLevel:       updated.thinkingLevel,
      fastProvider:        updated.fastProvider,
      fastModelId:         updated.fastModelId,
      fastThinkingLevel:   updated.fastThinkingLevel,
      xtremeProvider:      updated.xtremeProvider,
      xtremeModelId:       updated.xtremeModelId,
      xtremeThinkingLevel: updated.xtremeThinkingLevel,
      updatedAt:           updated.updatedAt.toISOString(),
    }, 'AI model target updated');
  }));

  return router;
}
