import type { PrismaClient } from '../../generated/prisma';
import type { Logger } from '../../shared/logger';
import type { ConversationHandle } from '../channels/channel.adapter';
import type { IncomingMessage } from '../../domain/channel/incoming-message';
import type { RunContext } from '../../domain/orchestration/run-context';
import { issuePiRuntimeLease } from './pi-runtime-lease';

export interface LarkPiRuntimeInput {
  readonly incoming: IncomingMessage;
  readonly runContext: RunContext;
  readonly conversation: ConversationHandle;
  readonly threadId: string;
  readonly abortSignal?: AbortSignal;
}

export class LarkPiRuntimeError extends Error {
  constructor(
    readonly code: string,
    readonly userMessage: string,
    message = userMessage,
  ) {
    super(message);
    this.name = 'LarkPiRuntimeError';
  }
}

export interface LarkPiRuntimeServiceDeps {
  readonly prisma: PrismaClient;
  readonly logger: Logger;
  readonly memberJwtSecret: string;
  readonly backendUrl: string;
  readonly controllerUrl: string;
  readonly instanceId: string;
  readonly leaseTtlSeconds: number;
  readonly runTimeoutMs: number;
  readonly fetch?: typeof globalThis.fetch;
}

export class LarkPiRuntimeService {
  private readonly log: Logger;

  constructor(private readonly deps: LarkPiRuntimeServiceDeps) {
    this.log = deps.logger.child({ service: 'lark-pi-runtime' });
  }

  async run(input: LarkPiRuntimeInput): Promise<{ text: string }> {
    const minimumSessionExpiry = new Date(Date.now() + 5 * 60_000);
    const session = await this.deps.prisma.memberSession.findFirst({
      where: {
        userId: String(input.runContext.userId),
        companyId: String(input.runContext.companyId),
        revokedAt: null,
        expiresAt: { gt: minimumSessionExpiry },
      },
      orderBy: { createdAt: 'desc' },
      select: { sessionId: true, expiresAt: true },
    });
    if (!session) {
      throw new LarkPiRuntimeError(
        'runtime_session_missing',
        'Your Divo cloud session is not active. Please sign in to Divo again, then retry.',
      );
    }

    const remainingSeconds = Math.floor((session.expiresAt.getTime() - Date.now()) / 1_000);
    const runtimeLease = issuePiRuntimeLease({
      sessionId: session.sessionId,
      userId: String(input.runContext.userId),
      companyId: String(input.runContext.companyId),
      role: String(input.runContext.companyRole),
      instanceId: this.deps.instanceId,
      threadId: input.threadId,
      ttlSeconds: Math.min(this.deps.leaseTtlSeconds, remainingSeconds),
    }, this.deps.memberJwtSecret);

    const timeoutSignal = AbortSignal.timeout(this.deps.runTimeoutMs);
    const signal = input.abortSignal
      ? AbortSignal.any([input.abortSignal, timeoutSignal])
      : timeoutSignal;
    let response: Response;
    try {
      response = await (this.deps.fetch ?? globalThis.fetch)(
        `${this.deps.controllerUrl.replace(/\/+$/, '')}/v1/lark-runs`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            backendUrl: this.deps.backendUrl,
            runtimeLease,
            message: input.incoming.text,
          }),
          signal,
        },
      );
    } catch (error) {
      if (input.abortSignal?.aborted) {
        throw new DOMException('The Pi run was interrupted.', 'AbortError');
      }
      this.log.error('pi.controller.unreachable', {
        error: String(error),
        correlationId: input.incoming.traceId,
      });
      throw new LarkPiRuntimeError(
        'controller_unreachable',
        'Pi could not start this request (controller_unreachable). No fallback agent was run.',
        String(error),
      );
    }

    const body = await response.json().catch(() => null) as {
      text?: unknown;
      error?: { code?: unknown; message?: unknown };
    } | null;
    if (!response.ok) {
      const code = typeof body?.error?.code === 'string'
        ? body.error.code
        : `controller_http_${response.status}`;
      const controllerMessage = typeof body?.error?.message === 'string'
        ? body.error.message
        : undefined;
      const userMessage = code === 'capacity_full' || code === 'user_busy'
        ? controllerMessage ?? 'Your Pi agent is busy. Please try again shortly.'
        : `Pi could not complete this request (${code}). No fallback agent was run.`;
      throw new LarkPiRuntimeError(code, userMessage, controllerMessage);
    }
    if (typeof body?.text !== 'string' || !body.text.trim()) {
      throw new LarkPiRuntimeError(
        'empty_runtime_response',
        'Pi completed without a usable answer (empty_runtime_response). No fallback agent was run.',
      );
    }
    return { text: body.text.trim() };
  }
}
