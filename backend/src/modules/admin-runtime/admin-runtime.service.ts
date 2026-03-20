import config from '../../config';
import { HttpException } from '../../core/http-exception';
import { BaseService } from '../../core/service';
import type { NormalizedIncomingMessageDTO } from '../../company/contracts';
import { getOrchestrationQueue, orchestrationRuntime } from '../../company/queue/runtime';
import { redisConnection } from '../../company/queue/runtime/redis.connection';
import { qdrantAdapter } from '../../company/integrations/vector';
import { decideCheckpointRecovery } from '../../company/orchestration/checkpoint-recovery';
import { checkpointRepository } from '../../company/state/checkpoint';
import { hitlActionRepository } from '../../company/state/hitl/hitl-action.repository';
import { prisma } from '../../utils/prisma';
import { ControlTaskDto } from './dto/control-task.dto';

type AdminRuntimeSession = {
  userId: string;
  role: 'SUPER_ADMIN' | 'COMPANY_ADMIN';
  companyId?: string;
  sessionId?: string;
  expiresAt?: string;
};

type RuntimeTaskLike = {
  taskId: string;
  companyId?: string;
  scopeVisibility?: 'resolved' | 'unresolved';
  configuredEngine?: unknown;
  engineUsed?: unknown;
  rolledBackFrom?: unknown;
  rollbackReasonCode?: unknown;
  engine?: unknown;
  [key: string]: unknown;
};

type RuntimeDependencyHealth = {
  name: 'redis' | 'qdrant' | 'queue' | 'openai' | 'zoho';
  ok: boolean;
  latencyMs?: number;
  detail?: Record<string, unknown>;
  error?: string;
};

type RuntimeHealthResponse = {
  overall: 'ok' | 'degraded';
  generatedAt: string;
  dependencies: RuntimeDependencyHealth[];
};

type RuntimeDeps = {
  runtime: typeof orchestrationRuntime;
  checkpoints: typeof checkpointRepository;
  hitlActions: typeof hitlActionRepository;
  redis: typeof redisConnection;
  vector: typeof qdrantAdapter;
  queueFactory: typeof getOrchestrationQueue;
  db: typeof prisma;
  now: () => Date;
};

const isCompanyScopedSession = (session: AdminRuntimeSession): boolean =>
  session.role === 'COMPANY_ADMIN';

const normalizeCompanyId = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value : undefined;

const normalizeScopeVisibility = (value: unknown): 'resolved' | 'unresolved' =>
  value === 'resolved' ? 'resolved' : 'unresolved';

const isTaskVisibleForSession = (task: RuntimeTaskLike, session: AdminRuntimeSession): boolean => {
  if (!isCompanyScopedSession(session)) {
    return true;
  }

  if (!session.companyId) {
    return false;
  }

  const companyId = normalizeCompanyId(task.companyId);
  const scopeVisibility = normalizeScopeVisibility(task.scopeVisibility);
  if (scopeVisibility === 'unresolved') {
    return false;
  }

  return companyId === session.companyId;
};

const defaultRecoverSession: AdminRuntimeSession = {
  userId: 'system',
  role: 'SUPER_ADMIN',
};

const resolveRecoverArguments = (
  sessionOrTaskId: AdminRuntimeSession | string,
  maybeTaskId?: string,
): { session: AdminRuntimeSession; taskId: string } => {
  if (typeof sessionOrTaskId === 'string') {
    return {
      session: defaultRecoverSession,
      taskId: sessionOrTaskId,
    };
  }

  return {
    session: sessionOrTaskId,
    taskId: maybeTaskId ?? '',
  };
};

export class AdminRuntimeService extends BaseService {
  private readonly deps: RuntimeDeps;

  constructor(deps: Partial<RuntimeDeps> = {}) {
    super();
    this.deps = {
      runtime: deps.runtime ?? orchestrationRuntime,
      checkpoints: deps.checkpoints ?? checkpointRepository,
      hitlActions: deps.hitlActions ?? hitlActionRepository,
      redis: deps.redis ?? redisConnection,
      vector: deps.vector ?? qdrantAdapter,
      queueFactory: deps.queueFactory ?? getOrchestrationQueue,
      db: deps.db ?? prisma,
      now: deps.now ?? (() => new Date()),
    };
  }

  private normalizeEngineMeta<T extends RuntimeTaskLike>(
    task: T,
  ): T & {
    configuredEngine: string;
    engineUsed: string;
    rolledBackFrom: string | null;
    rollbackReasonCode: string | null;
    engine: string;
  } {
    const configuredEngine =
      typeof task.configuredEngine === 'string'
        ? task.configuredEngine
        : typeof task.engine === 'string'
          ? task.engine
          : 'langgraph';
    const engineUsed =
      typeof task.engineUsed === 'string'
        ? task.engineUsed
        : typeof task.engine === 'string'
          ? task.engine
          : configuredEngine;
    const rolledBackFrom = typeof task.rolledBackFrom === 'string' ? task.rolledBackFrom : null;
    const rollbackReasonCode = typeof task.rollbackReasonCode === 'string' ? task.rollbackReasonCode : null;

    return {
      ...task,
      configuredEngine,
      engineUsed,
      rolledBackFrom,
      rollbackReasonCode,
      engine: engineUsed,
    };
  }

  private ensureTaskAccess<T extends RuntimeTaskLike>(task: T | null, session: AdminRuntimeSession): T {
    if (!task) {
      throw new HttpException(404, 'Task not found');
    }

    if (!isTaskVisibleForSession(task, session)) {
      throw new HttpException(404, 'Task not found');
    }

    return task;
  }

  async listTasks(session: AdminRuntimeSession, limit = 30) {
    const tasks = this.deps.runtime
      .listRecent(limit)
      .map((task) => this.normalizeEngineMeta(task))
      .filter((task) => isTaskVisibleForSession(task, session));
    return tasks;
  }

  async getTask(session: AdminRuntimeSession, taskId: string) {
    const task = await this.deps.runtime.getTask(taskId);
    const scopedTask = this.ensureTaskAccess(task, session);
    return this.normalizeEngineMeta(scopedTask);
  }

  async getTaskTrace(session: AdminRuntimeSession, taskId: string, limit = 100) {
    const task = await this.deps.runtime.getTask(taskId);
    const scopedTask = this.ensureTaskAccess(task, session);

    const history = await this.deps.checkpoints.getHistory(taskId, Math.max(1, Math.min(500, limit)));
    const normalizedTask = this.normalizeEngineMeta(scopedTask);

    return {
      taskId,
      companyId: normalizeCompanyId(normalizedTask.companyId) ?? null,
      scopeVisibility: normalizeScopeVisibility(normalizedTask.scopeVisibility),
      configuredEngine: normalizedTask.configuredEngine,
      engineUsed: normalizedTask.engineUsed,
      rolledBackFrom: normalizedTask.rolledBackFrom,
      rollbackReasonCode: normalizedTask.rollbackReasonCode,
      engine: normalizedTask.engine,
      graphThreadId: normalizedTask.graphThreadId ?? normalizedTask.taskId,
      latestNode: normalizedTask.graphNode ?? normalizedTask.currentStep ?? null,
      transitions: history.map((entry) => {
        const runtimeMeta =
          entry.state.runtimeMeta && typeof entry.state.runtimeMeta === 'object'
            ? (entry.state.runtimeMeta as Record<string, unknown>)
            : undefined;
        const route =
          entry.state.route && typeof entry.state.route === 'object'
            ? (entry.state.route as Record<string, unknown>)
            : undefined;
        const planValidationErrors = Array.isArray(entry.state.planValidationErrors)
          ? (entry.state.planValidationErrors as string[])
          : undefined;
        return {
          version: entry.version,
          node: entry.node,
          updatedAt: entry.updatedAt,
          companyId: normalizeCompanyId(normalizedTask.companyId) ?? null,
          scopeVisibility: normalizeScopeVisibility(normalizedTask.scopeVisibility),
          configuredEngine: normalizedTask.configuredEngine,
          engineUsed: typeof runtimeMeta?.engine === 'string' ? runtimeMeta.engine : normalizedTask.engineUsed,
          rolledBackFrom: normalizedTask.rolledBackFrom,
          rollbackReasonCode: normalizedTask.rollbackReasonCode,
          engine: typeof runtimeMeta?.engine === 'string' ? runtimeMeta.engine : normalizedTask.engineUsed,
          graphNode: typeof runtimeMeta?.node === 'string' ? runtimeMeta.node : undefined,
          graphThreadId: typeof runtimeMeta?.threadId === 'string' ? runtimeMeta.threadId : undefined,
          retryCount: typeof runtimeMeta?.retryCount === 'number' ? runtimeMeta.retryCount : undefined,
          routeIntent: typeof route?.intent === 'string' ? route.intent : undefined,
          routeSource: typeof route?.source === 'string' ? route.source : undefined,
          routeFallbackReasonCode:
            typeof route?.fallbackReasonCode === 'string' ? route.fallbackReasonCode : undefined,
          planSource: typeof entry.state.planSource === 'string' ? entry.state.planSource : undefined,
          planValidationErrors,
          synthesisSource: typeof entry.state.synthesisSource === 'string' ? entry.state.synthesisSource : undefined,
          responseDeliveryStatus:
            typeof entry.state.responseDeliveryStatus === 'string' ? entry.state.responseDeliveryStatus : undefined,
          recoveryMode: typeof entry.state.recoveryMode === 'string' ? entry.state.recoveryMode : undefined,
          resumeDecisionReason:
            typeof entry.state.resumeDecisionReason === 'string' ? entry.state.resumeDecisionReason : undefined,
        };
      }),
    };
  }

  async controlTask(session: AdminRuntimeSession, taskId: string, payload: ControlTaskDto) {
    this.ensureTaskAccess(await this.deps.runtime.getTask(taskId), session);
    const signal = payload.action === 'pause' ? 'paused' : payload.action === 'resume' ? 'running' : 'cancelled';
    const task = await this.deps.runtime.control(taskId, signal);
    if (!task) {
      throw new HttpException(404, 'Task not found');
    }
    return {
      taskId,
      action: payload.action,
      appliedSignal: signal,
      appliedAt: this.deps.now().toISOString(),
      status: 'applied' as const,
    };
  }

  async recoverTask(session: AdminRuntimeSession, taskId: string): Promise<{
    taskId: string;
    recoveredFromVersion: number;
    recoveredFromNode: string;
    recoveryMode: 'resume_from_checkpoint' | 'requeue_from_start';
    resumeDecisionReason: string;
    status: 'already_completed' | 'requeued';
  }>;

  async recoverTask(taskId: string): Promise<{
    taskId: string;
    recoveredFromVersion: number;
    recoveredFromNode: string;
    recoveryMode: 'resume_from_checkpoint' | 'requeue_from_start';
    resumeDecisionReason: string;
    status: 'already_completed' | 'requeued';
  }>;

  async recoverTask(sessionOrTaskId: AdminRuntimeSession | string, maybeTaskId?: string) {
    const { session, taskId } = resolveRecoverArguments(sessionOrTaskId, maybeTaskId);
    if (!taskId) {
      throw new HttpException(400, 'taskId is required');
    }

    const runtimeTask = await this.deps.runtime.getTask(taskId);
    if (runtimeTask) {
      this.ensureTaskAccess(runtimeTask, session);
    } else if (isCompanyScopedSession(session)) {
      throw new HttpException(404, 'Task not found');
    }

    const latest = await this.deps.checkpoints.getLatest(taskId);
    if (!latest) {
      throw new HttpException(404, 'No checkpoint found for task');
    }

    const pendingHitlAction = latest.node === 'hitl.requested' ? await this.deps.hitlActions.getByTaskId(taskId) : null;
    const recoveryDecision = decideCheckpointRecovery({
      latestCheckpoint: latest,
      hasPendingHitlAction: Boolean(pendingHitlAction && pendingHitlAction.status === 'pending'),
    });

    const state = latest.state;
    const requiredKeys: Array<keyof NormalizedIncomingMessageDTO> = [
      'channel',
      'userId',
      'chatId',
      'chatType',
      'messageId',
      'timestamp',
      'text',
    ];

    for (const key of requiredKeys) {
      if (typeof state[key] !== 'string') {
        throw new HttpException(409, `Checkpoint missing ${key} for recovery`);
      }
    }

    const message: NormalizedIncomingMessageDTO = {
      channel: state.channel as NormalizedIncomingMessageDTO['channel'],
      userId: state.userId as string,
      chatId: state.chatId as string,
      chatType: state.chatType as NormalizedIncomingMessageDTO['chatType'],
      messageId: state.messageId as string,
      timestamp: state.timestamp as string,
      text: state.text as string,
      rawEvent: { recovered: true, fromCheckpointVersion: latest.version },
    };

    const checkpointTrace = state.trace;
    if (checkpointTrace && typeof checkpointTrace === 'object') {
      const trace = checkpointTrace as Record<string, unknown>;
      message.trace = {
        requestId: typeof trace.requestId === 'string' ? trace.requestId : undefined,
        eventId: typeof trace.eventId === 'string' ? trace.eventId : undefined,
        textHash: typeof trace.textHash === 'string' ? trace.textHash : undefined,
        receivedAt: typeof trace.receivedAt === 'string' ? trace.receivedAt : undefined,
      };
    }

    if (!recoveryDecision.shouldReturnCompleted) {
      await this.deps.runtime.requeue(taskId, message);
    }

    return {
      taskId,
      recoveredFromVersion: latest.version,
      recoveredFromNode: latest.node,
      recoveryMode: recoveryDecision.recoveryMode,
      resumeDecisionReason: recoveryDecision.resumeDecisionReason,
      status: recoveryDecision.shouldReturnCompleted ? 'already_completed' : 'requeued',
    };
  }

  async getHealth(session: AdminRuntimeSession): Promise<RuntimeHealthResponse> {
    const dependencyHealth: RuntimeDependencyHealth[] = [];

    const redis = await this.deps.redis.health();
    dependencyHealth.push({
      name: 'redis',
      ok: redis.ok,
      latencyMs: redis.latencyMs,
      error: redis.error,
    });

    const qdrant = await this.deps.vector.health();
    dependencyHealth.push({
      name: 'qdrant',
      ok: qdrant.ok,
      latencyMs: qdrant.latencyMs,
      detail: {
        backend: qdrant.backend,
        collection: qdrant.collection,
      },
      error: qdrant.error,
    });

    try {
      const queue = this.deps.queueFactory();
      const queueCounts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
      dependencyHealth.push({
        name: 'queue',
        ok: true,
        detail: {
          counts: queueCounts,
        },
      });
    } catch (error) {
      dependencyHealth.push({
        name: 'queue',
        ok: false,
        error: error instanceof Error ? error.message : 'queue health check failed',
      });
    }

    const hasOpenAiKey = Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim().length > 0);
    dependencyHealth.push({
      name: 'openai',
      ok: true,
      detail: {
        mode: hasOpenAiKey ? 'model-enabled' : 'deterministic-fallback',
        orchestrationEngine: config.ORCHESTRATION_ENGINE,
      },
    });

    const where = isCompanyScopedSession(session) && session.companyId
      ? {
        companyId: session.companyId,
      }
      : {};
    const [connectedCount, tokenFailedCount] = await Promise.all([
      this.deps.db.zohoConnection.count({
        where: {
          ...where,
          status: 'CONNECTED',
        },
      }),
      this.deps.db.zohoConnection.count({
        where: {
          ...where,
          status: 'CONNECTED',
          tokenFailureCode: {
            not: null,
          },
        },
      }),
    ]);

    dependencyHealth.push({
      name: 'zoho',
      ok: tokenFailedCount === 0,
      detail: {
        connectedCount,
        tokenFailureCount: tokenFailedCount,
        scope: isCompanyScopedSession(session) ? session.companyId ?? null : 'global',
      },
      error: tokenFailedCount > 0 ? 'one_or_more_connected_tokens_in_failed_state' : undefined,
    });

    return {
      overall: dependencyHealth.every((entry) => entry.ok) ? 'ok' : 'degraded',
      generatedAt: this.deps.now().toISOString(),
      dependencies: dependencyHealth,
    };
  }
}

export const adminRuntimeService = new AdminRuntimeService();
