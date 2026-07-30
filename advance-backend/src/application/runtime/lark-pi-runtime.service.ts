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
  readonly onProgress?: (event: LarkPiProgressEvent) => Promise<void> | void;
}

export type LarkPiProgressEvent =
  | {
      readonly type: 'starting';
      readonly stage: 'workspace' | 'container';
      readonly label: string;
    }
  | { readonly type: 'ready' | 'thinking' | 'writing' }
  | {
      readonly type: 'tool_start';
      readonly callId: string;
      readonly toolName: string;
      readonly toolId?: string;
    }
  | {
      readonly type: 'tool_end';
      readonly callId: string;
      readonly toolName: string;
      readonly isError: boolean;
    };

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

  private findActiveSession(runContext: LarkPiRuntimeInput['runContext']) {
    if (!runContext.tenantId || !runContext.userExternalId) {
      return null;
    }
    const minimumSessionExpiry = new Date(Date.now() + 5 * 60_000);
    return this.deps.prisma.memberSession.findFirst({
      where: {
        userId: String(runContext.userId),
        companyId: String(runContext.companyId),
        channel: 'lark',
        larkTenantKey: String(runContext.tenantId),
        larkOpenId: String(runContext.userExternalId),
        revokedAt: null,
        expiresAt: { gt: minimumSessionExpiry },
      },
      orderBy: { createdAt: 'desc' },
      select: { sessionId: true, expiresAt: true },
    });
  }

  async hasActiveSession(
    runContext: LarkPiRuntimeInput['runContext'],
  ): Promise<boolean> {
    return Boolean(await this.findActiveSession(runContext));
  }

  async run(input: LarkPiRuntimeInput): Promise<{ text: string }> {
    const session = await this.findActiveSession(input.runContext);
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
          headers: {
            'content-type': 'application/json',
            accept: 'application/x-ndjson, application/json',
          },
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

    if (response.headers.get('content-type')?.includes('application/x-ndjson')) {
      return this.readStream(response, input);
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

  private async readStream(
    response: Response,
    input: LarkPiRuntimeInput,
  ): Promise<{ text: string }> {
    if (!response.body) {
      throw new LarkPiRuntimeError(
        'empty_controller_stream',
        'Pi completed without a usable answer (empty_controller_stream). No fallback agent was run.',
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let streamError: { code: string; message?: string } | undefined;

    const consume = async (line: string): Promise<void> => {
      if (!line.trim()) return;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        throw new LarkPiRuntimeError(
          'invalid_controller_stream',
          'Pi could not complete this request (invalid_controller_stream). No fallback agent was run.',
        );
      }
      if (!event || typeof event !== 'object') return;
      const record = event as Record<string, unknown>;
      if (record['type'] === 'progress') {
        const progress = parseProgressEvent(record['progress']);
        if (progress && input.onProgress) {
          try {
            await input.onProgress(progress);
          } catch (error) {
            this.log.warn('pi.progress.delivery_failed', {
              error: String(error),
              correlationId: input.incoming.traceId,
              progressType: progress.type,
            });
          }
        }
        return;
      }
      if (record['type'] === 'result' && typeof record['text'] === 'string') {
        text = record['text'].trim();
        return;
      }
      const error = record['error'];
      if (record['type'] === 'error' && error && typeof error === 'object') {
        const value = error as Record<string, unknown>;
        streamError = {
          code: typeof value['code'] === 'string' ? value['code'] : 'run_failed',
          ...(typeof value['message'] === 'string' ? { message: value['message'] } : {}),
        };
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) await consume(line);
      if (done) break;
    }
    await consume(buffer);

    if (streamError) {
      const userMessage = streamError.code === 'capacity_full' || streamError.code === 'user_busy'
        ? streamError.message ?? 'Your Pi agent is busy. Please try again shortly.'
        : `Pi could not complete this request (${streamError.code}). No fallback agent was run.`;
      throw new LarkPiRuntimeError(streamError.code, userMessage, streamError.message);
    }
    if (!text) {
      throw new LarkPiRuntimeError(
        'empty_runtime_response',
        'Pi completed without a usable answer (empty_runtime_response). No fallback agent was run.',
      );
    }
    return { text };
  }
}

function safeProgressString(value: unknown, maxLength = 120): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

function parseProgressEvent(value: unknown): LarkPiProgressEvent | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const event = value as Record<string, unknown>;
  const type = event['type'];
  if (type === 'ready' || type === 'thinking' || type === 'writing') return { type };
  if (type === 'starting') {
    const stage = event['stage'];
    const label = safeProgressString(event['label']);
    if ((stage === 'workspace' || stage === 'container') && label) {
      return { type, stage, label };
    }
    return undefined;
  }
  if (type === 'tool_start') {
    const callId = safeProgressString(event['callId'], 100);
    const toolName = safeProgressString(event['toolName'], 80);
    const toolId = safeProgressString(event['toolId'], 80);
    if (!callId || !toolName) return undefined;
    return { type, callId, toolName, ...(toolId ? { toolId } : {}) };
  }
  if (type === 'tool_end') {
    const callId = safeProgressString(event['callId'], 100);
    const toolName = safeProgressString(event['toolName'], 80);
    if (!callId || !toolName) return undefined;
    return { type, callId, toolName, isError: event['isError'] === true };
  }
  return undefined;
}
