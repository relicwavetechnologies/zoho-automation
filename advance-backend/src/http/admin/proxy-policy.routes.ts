/**
 * Admin proxy-policy routes — per-member guardrails for the model proxy.
 *
 * Mounted at /api/admin/proxy-policy.
 *
 *   GET  /            — all explicit policies for the company (keyed by userId)
 *   GET  /:userId     — one member's effective policy
 *   PUT  /:userId     — upsert a member's policy (block / budget / rate / models)
 *
 * These write the MemberProxyPolicy rows that LlmProxyService.gate() enforces.
 * When a member has no row, this endpoint surfaces the shared default grant
 * (isDefault=true).
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { PrismaClient } from '../../generated/prisma';
import type { Logger } from '../../shared/logger';
import { DEFAULT_ALLOWED_MODELS, PROXY_MODELS } from '../../application/observability/pricing';

export interface ProxyPolicyRoutesDeps {
  prisma: PrismaClient;
  logger: Logger;
}

type RouteError = Error & { status: number };
const routeError = (status: number, message: string): RouteError => {
  const e = new Error(message) as RouteError;
  e.status = status;
  return e;
};
const success = <T>(res: Response, data: T) => res.status(200).json({ success: true, data });
const fail = (res: Response, status: number, message: string) => res.status(status).json({ success: false, message });

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

function resolveCompanyId(res: Response, providedId?: string): string {
  const isSuperAdmin = Boolean(res.locals['isSuperAdmin']);
  const localId = (res.locals['companyId'] as string | undefined) ?? '';
  if (isSuperAdmin) {
    if (!providedId) throw routeError(400, 'companyId is required for super-admin requests');
    return providedId;
  }
  if (providedId && providedId !== localId) throw routeError(403, 'Access denied: company mismatch');
  return localId;
}
const qCompany = (req: Request, res: Response) =>
  resolveCompanyId(res, typeof req.query.companyId === 'string' ? req.query.companyId : undefined);

interface ProxyPolicyDto {
  userId: string;
  blocked: boolean;
  monthlyBudgetUsd: number | null;
  rateLimitRpm: number | null;
  allowedModels: string[];
  isDefault: boolean;
}

type PolicyRow = {
  userId: string;
  blocked: boolean;
  monthlyBudgetUsd: number | null;
  rateLimitRpm: number | null;
  allowedModels: string[];
};

const toDto = (userId: string, row: PolicyRow | null): ProxyPolicyDto => ({
  userId,
  blocked: row?.blocked ?? false,
  monthlyBudgetUsd: row?.monthlyBudgetUsd ?? null,
  rateLimitRpm: row?.rateLimitRpm ?? null,
  allowedModels: row && row.allowedModels.length > 0 ? row.allowedModels : [...DEFAULT_ALLOWED_MODELS],
  isDefault: !row,
});

const putSchema = z.object({
  blocked: z.boolean().optional(),
  monthlyBudgetUsd: z.number().positive().nullable().optional(),
  rateLimitRpm: z.number().int().positive().nullable().optional(),
  allowedModels: z.array(z.enum(PROXY_MODELS)).min(1, 'At least one model must be allowed').optional(),
});

/** Confirm the target user is a member of the resolved company (prevents cross-company writes). */
async function assertMember(prisma: PrismaClient, companyId: string, userId: string): Promise<void> {
  const membership = await prisma.adminMembership.findFirst({ where: { companyId, userId } });
  if (!membership) throw routeError(404, 'Member not found in this company');
}

export function createProxyPolicyRoutes(deps: ProxyPolicyRoutesDeps): Router {
  const router = Router();
  const { prisma } = deps;

  // ─── GET / — all explicit policies for the company ──────────────────
  router.get('/', asyncRoute(async (req, res) => {
    const companyId = qCompany(req, res);
    const rows = await prisma.memberProxyPolicy.findMany({ where: { companyId } });
    success(res, rows.map((r) => toDto(r.userId, r)));
  }));

  // ─── GET /:userId — one member's effective policy ───────────────────
  router.get('/:userId', asyncRoute(async (req, res) => {
    const companyId = qCompany(req, res);
    const userId = req.params.userId;
    if (!userId) throw routeError(400, 'userId is required');
    const row = await prisma.memberProxyPolicy.findUnique({ where: { userId } });
    if (row && row.companyId !== companyId) throw routeError(403, 'Access denied: company mismatch');
    success(res, toDto(userId, row));
  }));

  // ─── PUT /:userId — upsert a member's policy ────────────────────────
  router.put('/:userId', asyncRoute(async (req, res) => {
    const companyId = qCompany(req, res);
    const userId = req.params.userId;
    if (!userId) throw routeError(400, 'userId is required');
    await assertMember(prisma, companyId, userId);

    const body = putSchema.parse(req.body ?? {});
    const data = {
      blocked: body.blocked ?? false,
      monthlyBudgetUsd: body.monthlyBudgetUsd ?? null,
      rateLimitRpm: body.rateLimitRpm ?? null,
      allowedModels: body.allowedModels ?? [...DEFAULT_ALLOWED_MODELS],
    };

    const row = await prisma.memberProxyPolicy.upsert({
      where: { userId },
      create: { userId, companyId, ...data },
      update: { companyId, ...data },
    });
    deps.logger.info('proxy-policy.saved', { companyId, userId, blocked: data.blocked, models: data.allowedModels });
    success(res, toDto(userId, row));
  }));

  return router;
}
