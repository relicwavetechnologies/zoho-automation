/**
 * Admin controls routes.
 *
 * Mounted at /api/admin/controls.
 *
 *   GET  /                      — list admin control states (optionally scoped to a company)
 *   GET  /lark-untagged-policy  — effective untagged-group policy for a company
 *   PUT  /lark-untagged-policy  — set a company's untagged-group policy
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { PrismaClient } from '../../generated/prisma';
import type { Logger } from '../../shared/logger';
import type { TypedEnv } from '../../config/env';
import type { AuditService } from '../../application/observability/audit.service';
import { GROUP_CONTEXT_POLICY } from '../../domain/conversation/group-context-policy';
import {
  resolveCompanyUntaggedGroupPolicy,
  UNTAGGED_ATTACHMENTS_CONTROL,
  UNTAGGED_TEXT_RETENTION_CONTROL,
} from '../../infrastructure/channels/lark/lark-untagged-policy';

export interface ControlsRoutesDeps {
  prisma: PrismaClient;
  logger: Logger;
  env: TypedEnv;
  audit?: Pick<AuditService, 'record'>;
}

type RouteError = Error & { status: number };
const routeError = (status: number, message: string): RouteError => {
  const e = new Error(message) as RouteError;
  e.status = status;
  return e;
};

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

function resolveCompanyId(res: Response, providedId?: string): string | undefined {
  const isSuperAdmin = Boolean(res.locals['isSuperAdmin']);
  if (isSuperAdmin) return providedId;
  const localId = (res.locals['companyId'] as string | undefined) ?? '';
  if (providedId && providedId !== localId) throw routeError(403, 'Access denied: company mismatch');
  return localId || undefined;
}

export function createControlsRoutes(deps: ControlsRoutesDeps): Router {
  const router = Router();

  router.get('/', asyncRoute(async (req, res) => {
    const companyId = resolveCompanyId(res, typeof req.query.companyId === 'string' ? req.query.companyId : undefined);

    const rows = await deps.prisma.adminControlState.findMany({
      where:   companyId ? { companyId } : {},
      orderBy: { updatedAt: 'desc' },
      take:    200,
    });

    const controls = rows.map(r => ({
      id:         r.id,
      controlKey: r.controlKey,
      companyId:  r.companyId,
      value:      r.value,
      updatedBy:  r.updatedBy,
      updatedAt:  r.updatedAt.toISOString(),
    }));
    success(res, controls, 'Admin controls loaded');
  }));

  /**
   * The effective untagged-group policy for a company.
   *
   * Listing raw control rows is not the same as showing the policy: a company
   * that has set nothing has no rows, and an admin reading that list would see
   * an empty result rather than the default their people are actually governed
   * by. This reports the value in force, where it came from, and the bounds on
   * what retention keeps.
   */
  router.get('/lark-untagged-policy', asyncRoute(async (req, res) => {
    const companyId = resolveCompanyId(res, typeof req.query.companyId === 'string' ? req.query.companyId : undefined);
    if (!companyId) throw routeError(400, 'companyId is required');

    const controls = await deps.prisma.adminControlState.findMany({
      where: {
        companyId,
        controlKey: { in: [UNTAGGED_TEXT_RETENTION_CONTROL, UNTAGGED_ATTACHMENTS_CONTROL] },
      },
      select: { controlKey: true, value: true, updatedBy: true, updatedAt: true },
    });

    const policy = resolveCompanyUntaggedGroupPolicy({ env: deps.env, controls });
    const changedBy = (key: string) => controls.find(row => row.controlKey === key);

    success(res, {
      companyId,
      textRetention: {
        ...policy.textRetention,
        controlKey: UNTAGGED_TEXT_RETENTION_CONTROL,
        updatedBy: changedBy(UNTAGGED_TEXT_RETENTION_CONTROL)?.updatedBy ?? null,
        updatedAt: changedBy(UNTAGGED_TEXT_RETENTION_CONTROL)?.updatedAt.toISOString() ?? null,
      },
      attachments: {
        ...policy.attachments,
        controlKey: UNTAGGED_ATTACHMENTS_CONTROL,
        updatedBy: changedBy(UNTAGGED_ATTACHMENTS_CONTROL)?.updatedBy ?? null,
        updatedAt: changedBy(UNTAGGED_ATTACHMENTS_CONTROL)?.updatedAt.toISOString() ?? null,
      },
      retentionWindow: {
        // What "bounded" means in practice for a retained room transcript.
        maxMessages: GROUP_CONTEXT_POLICY.MAX_MESSAGES,
        minMessages: GROUP_CONTEXT_POLICY.MIN_MESSAGES,
        retainedTokenBudget: GROUP_CONTEXT_POLICY.RETAINED_MESSAGE_TOKEN_BUDGET,
        olderMessages: 'compacted into a rolling summary',
      },
      // Stated because the setting reads like a retention guarantee and is not
      // one: the raw event is persisted on the ingress receipt before any
      // policy applies, and nothing prunes those today.
      note: 'Text retention governs the room transcript only. Durable ingress receipts retain the raw event separately and are not pruned.',
    }, 'Untagged group policy loaded');
  }));

  const untaggedPolicyUpdate = z.object({
    textRetention: z.enum(['retain', 'off']).optional(),
    attachments:   z.enum(['ignore', 'process']).optional(),
  }).refine(
    body => body.textRetention !== undefined || body.attachments !== undefined,
    { message: 'Provide textRetention, attachments, or both' },
  );

  /**
   * Set a company's untagged-group policy.
   *
   * Without this the resolver and the read view describe an override nothing
   * could create outside hand-written SQL. Values are validated here as well as
   * in the resolver: the resolver's fallback keeps a bad row from being read as
   * consent, and this keeps the bad row from being written at all.
   */
  router.put('/lark-untagged-policy', asyncRoute(async (req, res) => {
    const companyId = resolveCompanyId(res, typeof req.query.companyId === 'string' ? req.query.companyId : undefined);
    if (!companyId) throw routeError(400, 'companyId is required');

    const update = untaggedPolicyUpdate.parse(req.body);
    const actorId = (res.locals['userId'] as string | undefined) ?? 'unknown';

    const writes: Array<{ controlKey: string; value: string }> = [
      ...(update.textRetention ? [{ controlKey: UNTAGGED_TEXT_RETENTION_CONTROL, value: update.textRetention }] : []),
      ...(update.attachments   ? [{ controlKey: UNTAGGED_ATTACHMENTS_CONTROL,    value: update.attachments }]   : []),
    ];

    for (const write of writes) {
      await deps.prisma.adminControlState.upsert({
        where:  { controlKey_companyId: { controlKey: write.controlKey, companyId } },
        create: { controlKey: write.controlKey, companyId, value: write.value, updatedBy: actorId },
        update: { value: write.value, updatedBy: actorId },
      });
    }

    // Turning attachment processing on starts moving a company's files out of
    // Lark. Who decided that, and when, belongs in the audit trail.
    deps.audit?.record({
      actorId,
      companyId,
      action: 'controls.lark_untagged_policy.set',
      outcome: 'success',
      metadata: Object.fromEntries(writes.map(w => [w.controlKey, w.value])),
    });

    success(res, {
      companyId,
      applied: Object.fromEntries(writes.map(w => [w.controlKey, w.value])),
    }, 'Untagged group policy updated');
  }));

  return router;
}
