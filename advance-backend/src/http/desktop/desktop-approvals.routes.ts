import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { PrismaClient } from '../../generated/prisma';
import type { Logger } from '../../shared/logger';
import { createMemberAuthMiddleware } from '../middleware/member-auth.middleware';
import type { DecisionService } from '../../application/decision/decision.service';
import type { GatewayMemberContext } from '../../application/gateway/gateway.types';
import { confirmAnswer } from '../../domain/decision/decision';

export interface DesktopApprovalRoutesDeps {
  prisma: PrismaClient;
  memberJwtSecret: string;
  logger: Logger;
  decisions: DecisionService;
}

const decisionSchema = z.object({ decision: z.enum(['approved', 'rejected']) }).strict();

/**
 * Compatibility adapter for installed Desktop clients.
 *
 * This is deliberately Desktop-only. Web and Lark invoke governed tools
 * directly; installed Desktop clients retain their historical client-owned
 * confirmation path without leaking that interaction into browser runtime
 * code.
 *
 * It speaks yes/no because that is the shape installed clients send, and yes/no
 * is now the one-question case of a decision rather than a second mechanism.
 * The dispatch that used to live here — try the requester-owned path, fall
 * through to the governance one — has moved inside the decision module, where
 * it is a switch on the row rather than an ordering at the door.
 */
export function createDesktopApprovalRoutes(deps: DesktopApprovalRoutesDeps): Router {
  const router = Router();
  const memberAuth = createMemberAuthMiddleware({
    prisma: deps.prisma,
    jwtSecret: deps.memberJwtSecret,
    logger: deps.logger,
  });

  router.get('/approvals', memberAuth, async (_req: Request, res: Response) => {
    try {
      const open = await deps.decisions.open(actorFrom(res));
      /* Named `awaitingMe`/`requestedByMe` because that is what installed
         clients read. The values inside are decisions now, and every field the
         old inbox item carried is either on the decision or was the tool
         plumbing this surface never drew. */
      res.json(open);
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
      const outcome = await deps.decisions.settle(
        { ...actorFrom(res), member },
        req.params.approvalId!,
        confirmAnswer(parsed.data.decision),
      );
      if (outcome.ok) {
        res.json({
          ok: true,
          decision: outcome.verdict,
          ...(outcome.execution ? { execution: outcome.execution } : {}),
        });
        return;
      }
      res.status(statusFor(outcome.reason)).json({ error: outcome.reason, message: outcome.message });
    } catch (error) {
      deps.logger.error('desktop.approvals.decide_failed', { error: String(error) });
      res.status(500).json({ error: 'internal_error', message: 'Could not record that decision.' });
    }
  });

  return router;
}

/** One mapping from why an answer was refused to how it is refused. */
export function statusFor(reason: string): number {
  if (reason === 'forbidden') return 403;
  if (reason === 'not_found') return 404;
  if (reason === 'already_resolved' || reason === 'expired') return 409;
  if (reason === 'invalid_answer') return 422;
  return 500;
}

function actorFrom(res: Response): { userId: string; companyId: string; displayName?: string } {
  const email = res.locals['email'] as string | null;
  return {
    userId: res.locals['userId'] as string,
    companyId: res.locals['companyId'] as string,
    ...(email ? { displayName: email } : {}),
  };
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
