import { Router, type Request, type Response } from 'express';
import type { Logger } from '../../shared/logger';
import type { GatewayDispatcher } from '../../application/gateway/gateway-dispatcher';
import type { GatewayMemberContext } from '../../application/gateway/gateway.types';
import { gatewayFailure, gatewayRequestSchema } from '../../application/gateway/gateway.types';
import { asChannelKey } from '../../domain/channel/runtime-channel';
import {
  measureRunLatency,
  piToolSpanId,
  type RunLatencyRecorder,
} from '../../application/observability/run-latency-recorder';

const PI_RUNTIME_BLOCKED_OPS = new Set([
  'teach.learning.apply',
  'tools.commit',
  'automation.plan.create',
  'knowledge.review.decide',
]);

export interface GatewayRoutesDeps {
  readonly dispatcher: GatewayDispatcher;
  readonly logger: Logger;
  readonly latencyRecorder?: RunLatencyRecorder;
}

export function createGatewayRoutes(deps: GatewayRoutesDeps): Router {
  const router = Router();
  const log = deps.logger.child({ service: 'gateway-routes' });

  router.post('/', async (req: Request, res: Response) => {
    const companyId = res.locals['companyId'] as string | undefined;
    const userId = res.locals['userId'] as string | undefined;
    const aiRole = res.locals['aiRole'] as string | undefined;
    const sessionId = res.locals['sessionId'] as string | undefined;
    const channel = asChannelKey(res.locals['channel']);

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
    if (
      res.locals['isPiRuntimeLease'] === true
      && parsed.data.op === 'knowledge.review.open'
      && !parsed.data.execution
    ) {
      res.status(400).json(
        gatewayFailure('bad_request', 'Knowledge review requires exact run execution provenance.'),
      );
      return;
    }
    if (res.locals['isPiRuntimeLease'] === true) {
      const runtimeThreadId = res.locals['runtimeThreadId'] as string | undefined;
      const runtimeRunId = res.locals['runtimeRunId'] as string | undefined;
      if (
        !runtimeThreadId
        || parsed.data.execution?.threadId !== runtimeThreadId
        || (runtimeRunId && parsed.data.execution?.runId !== runtimeRunId)
      ) {
        res.status(403).json(
          gatewayFailure(
            'permission_denied',
            'Pi runtime execution does not match its signed run and thread.',
          ),
        );
        return;
      }
    }
    const member: GatewayMemberContext = {
      companyId,
      userId,
      aiRole,
      channel,
      email: (res.locals['email'] as string | null | undefined) ?? null,
      larkOpenId: (res.locals['larkOpenId'] as string | null | undefined) ?? null,
      larkTenantKey: (res.locals['larkTenantKey'] as string | null | undefined) ?? null,
      ...(typeof res.locals['runtimeChatId'] === 'string'
        ? { runtimeChatId: res.locals['runtimeChatId'] as string }
        : {}),
      ...(typeof res.locals['runtimeRunId'] === 'string'
        ? { runtimeRunId: res.locals['runtimeRunId'] as string }
        : {}),
      ...(typeof res.locals['runtimeThreadId'] === 'string'
        ? { runtimeThreadId: res.locals['runtimeThreadId'] as string }
        : {}),
      sessionId,
      ...(res.locals['isPiRuntimeLease'] === true
        && parsed.data.op === 'tools.invoke'
        && req.get('x-divo-result-mode') === 'local-file'
        ? { resultAudience: 'local_file' as const }
        : {}),
      authProvider: (res.locals['authProvider'] as string | null | undefined) ?? null,
    };

    const execution = parsed.data.execution;
    const parentSpanId = execution?.actionId === 'native-inputs-eager'
      && res.locals['isPiRuntimeLease'] === true
      ? 'controller.model'
      : execution ? piToolSpanId(execution.actionId) : undefined;
    const latencyTrace = execution && deps.latencyRecorder
      ? deps.latencyRecorder.trace({
          runId: execution.runId,
          companyId,
          userId,
          source: 'gateway',
          ...(parentSpanId ? { parentSpanId } : {}),
        })
      : undefined;

    try {
      const result = await measureRunLatency(
        latencyTrace,
        {
          name: 'gateway.request',
          category: 'gateway',
          attributes: { op: parsed.data.op },
        },
        () => deps.dispatcher.dispatch(parsed.data, member, latencyTrace),
      );
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
    } finally {
      void latencyTrace?.flush();
    }
  });

  return router;
}
