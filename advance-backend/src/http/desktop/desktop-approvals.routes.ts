import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { PrismaClient } from '../../generated/prisma';
import type { Logger } from '../../shared/logger';
import { createMemberAuthMiddleware } from '../middleware/member-auth.middleware';
import type { ApprovalInboxService } from '../../application/approval/approval-inbox.service';
import type { BusinessActionService } from '../../application/approval/business-action.service';
import type { GatewayMemberContext } from '../../application/gateway/gateway.types';

export interface DesktopApprovalRoutesDeps {
  prisma: PrismaClient;
  memberJwtSecret: string;
  logger: Logger;
  inbox: ApprovalInboxService;
  businessActions: BusinessActionService;
}

const decisionSchema = z.object({ decision: z.enum(['approved', 'rejected']) }).strict();

/**
 * Compatibility adapter for installed Desktop clients.
 *
 * This is deliberately Desktop-only. Web and Lark invoke governed tools
 * directly; installed Desktop clients retain their historical client-owned
 * confirmation path without leaking that interaction into browser runtime
 * code.
 */
export function createDesktopApprovalRoutes(deps: DesktopApprovalRoutesDeps): Router {
  const router = Router();
  const memberAuth = createMemberAuthMiddleware({
    prisma: deps.prisma,
    jwtSecret: deps.memberJwtSecret,
    logger: deps.logger,
  });

  const actor = (res: Response) => {
    const email = res.locals['email'] as string | null;
    return {
      userId: res.locals['userId'] as string,
      companyId: res.locals['companyId'] as string,
      ...(email ? { displayName: email } : {}),
    };
  };

  router.get('/approvals', memberAuth, async (_req: Request, res: Response) => {
    try {
      res.json(await deps.inbox.list(actor(res)));
    } catch (error) {
      deps.logger.error('desktop.approvals.list_failed', { error: String(error) });
      res.status(500).json({ error: 'internal_error', message: 'Could not load your approvals.' });
    }
  });

  router.post('/approvals/:approvalId/decision', memberAuth, async (req: Request, res: Response) => {
    const parsed = decisionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', message: 'decision must be "approved" or "rejected"' });
      return;
    }
    try {
      const member = memberFrom(res);
      if (!member) {
        res.status(401).json({ error: 'unauthenticated', message: 'Sign in again.' });
        return;
      }
      const businessAction = await deps.businessActions.decide({
        member,
        actionId: req.params.approvalId!,
        decision: parsed.data.decision,
      });
      if (businessAction.handled) {
        const forbidden = businessAction.response.status === 'permission_denied';
        res.status(forbidden ? 403 : 200).json({
          ok: !forbidden,
          decision: parsed.data.decision,
          execution: businessAction.response,
        });
        return;
      }
      const outcome = await deps.inbox.decide(actor(res), req.params.approvalId!, parsed.data.decision);
      if (outcome.ok) {
        res.json(outcome);
        return;
      }
      const status = outcome.reason === 'forbidden' ? 403
        : outcome.reason === 'not_found' ? 404
        : outcome.reason === 'already_resolved' || outcome.reason === 'expired' ? 409
        : 500;
      res.status(status).json({ error: outcome.reason, message: outcome.message });
    } catch (error) {
      deps.logger.error('desktop.approvals.decide_failed', { error: String(error) });
      res.status(500).json({ error: 'internal_error', message: 'Could not record that decision.' });
    }
  });

  return router;
}

function memberFrom(res: Response): GatewayMemberContext | null {
  const companyId = res.locals['companyId'] as string | undefined;
  const userId = res.locals['userId'] as string | undefined;
  const aiRole = res.locals['aiRole'] as string | undefined;
  const sessionId = res.locals['sessionId'] as string | undefined;
  if (!companyId || !userId || !aiRole || !sessionId) return null;
  return {
    companyId,
    userId,
    aiRole,
    sessionId,
    channel: 'desktop',
    email: (res.locals['email'] as string | null | undefined) ?? null,
    larkOpenId: null,
  };
}
