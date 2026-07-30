import { Router, type Request, type Response } from 'express';
import type { Logger } from '../../shared/logger';
import type { GatewayDispatcher } from '../../application/gateway/gateway-dispatcher';
import type { GatewayMemberContext } from '../../application/gateway/gateway.types';
import { gatewayFailure, gatewayRequestSchema } from '../../application/gateway/gateway.types';

const PI_RUNTIME_BLOCKED_OPS = new Set([
  'teach.learning.apply',
  'tools.commit',
  'automation.plan.create',
]);

export interface GatewayRoutesDeps {
  readonly dispatcher: GatewayDispatcher;
  readonly logger: Logger;
}

export function createGatewayRoutes(deps: GatewayRoutesDeps): Router {
  const router = Router();
  const log = deps.logger.child({ service: 'gateway-routes' });

  router.post('/', async (req: Request, res: Response) => {
    const companyId = res.locals['companyId'] as string | undefined;
    const userId = res.locals['userId'] as string | undefined;
    const aiRole = res.locals['aiRole'] as string | undefined;
    const sessionId = res.locals['sessionId'] as string | undefined;
    const channel = res.locals['channel'] === 'lark' ? 'lark' : 'desktop';

    if (!companyId || !userId || !aiRole || !sessionId) {
      res.status(401).json(
        gatewayFailure('unauthorized', 'Missing member session context'),
      );
      return;
    }

    const parsed = gatewayRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      const issues = parsed.error.errors
        .map((e) => `${e.path.join('.') || '(root)'}: ${e.message}`)
        .join('; ');
      res.status(400).json(gatewayFailure('bad_request', issues));
      return;
    }
    if (res.locals['isPiRuntimeLease'] === true) {
      const runtimeThreadId = res.locals['runtimeThreadId'] as string | undefined;
      if (!runtimeThreadId || parsed.data.execution?.threadId !== runtimeThreadId) {
        res.status(403).json(
          gatewayFailure(
            'permission_denied',
            'Pi runtime execution does not match its signed thread.',
          ),
        );
        return;
      }
    }
    if (
      res.locals['isPiRuntimeLease'] === true
      && PI_RUNTIME_BLOCKED_OPS.has(parsed.data.op)
    ) {
      res.status(403).json(
        gatewayFailure(
          'permission_denied',
          'This company mutation requires an interactive approval flow that is not available to the Lark Pi runtime.',
        ),
      );
      return;
    }

    const member: GatewayMemberContext = {
      companyId,
      userId,
      aiRole,
      channel,
      email: (res.locals['email'] as string | null | undefined) ?? null,
      larkOpenId: (res.locals['larkOpenId'] as string | null | undefined) ?? null,
      larkTenantKey: (res.locals['larkTenantKey'] as string | null | undefined) ?? null,
      sessionId,
    };

    try {
      const result = await deps.dispatcher.dispatch(parsed.data, member);
      res.status(200).json(result);
    } catch (error) {
      log.error('gateway.dispatch.error', {
        error: error instanceof Error ? error.message : String(error),
        op: parsed.data.op,
        userId,
        companyId,
      });
      res.status(500).json(
        gatewayFailure('tool_error', 'Gateway request failed'),
      );
    }
  });

  return router;
}
