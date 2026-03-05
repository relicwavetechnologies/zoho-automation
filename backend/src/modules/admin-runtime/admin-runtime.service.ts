import { HttpException } from '../../core/http-exception';
import { BaseService } from '../../core/service';
import type { NormalizedIncomingMessageDTO } from '../../company/contracts';
import { decideCheckpointRecovery } from '../../company/orchestration/langgraph/checkpoint-recovery';
import { orchestrationRuntime } from '../../company/queue/runtime';
import { checkpointRepository } from '../../company/state/checkpoint';
import { hitlActionRepository } from '../../company/state/hitl/hitl-action.repository';
import { ControlTaskDto } from './dto/control-task.dto';

export class AdminRuntimeService extends BaseService {
  private normalizeEngineMeta<T extends Record<string, unknown>>(task: T): T & {
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
          : 'legacy';
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

  async listTasks(limit = 30) {
    return orchestrationRuntime.listRecent(limit).map((task) => this.normalizeEngineMeta(task));
  }

  async getTask(taskId: string) {
    const task = await orchestrationRuntime.getTask(taskId);
    if (!task) {
      throw new HttpException(404, 'Task not found');
    }
    return this.normalizeEngineMeta(task);
  }

  async getTaskTrace(taskId: string, limit = 100) {
    const task = await orchestrationRuntime.getTask(taskId);
    if (!task) {
      throw new HttpException(404, 'Task not found');
    }

    const history = await checkpointRepository.getHistory(taskId, Math.max(1, Math.min(500, limit)));
    const normalizedTask = this.normalizeEngineMeta(task);

    return {
      taskId,
      configuredEngine: normalizedTask.configuredEngine,
      engineUsed: normalizedTask.engineUsed,
      rolledBackFrom: normalizedTask.rolledBackFrom,
      rollbackReasonCode: normalizedTask.rollbackReasonCode,
      engine: normalizedTask.engine,
      graphThreadId: task.graphThreadId ?? task.taskId,
      latestNode: task.graphNode ?? task.currentStep ?? null,
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

  async controlTask(taskId: string, payload: ControlTaskDto) {
    const signal = payload.action === 'pause' ? 'paused' : payload.action === 'resume' ? 'running' : 'cancelled';
    const task = await orchestrationRuntime.control(taskId, signal);
    if (!task) {
      throw new HttpException(404, 'Task not found');
    }
    return {
      taskId,
      action: payload.action,
      appliedSignal: signal,
      appliedAt: new Date().toISOString(),
      status: 'applied' as const,
    };
  }

  async recoverTask(taskId: string) {
    const latest = await checkpointRepository.getLatest(taskId);
    if (!latest) {
      throw new HttpException(404, 'No checkpoint found for task');
    }

    const pendingHitlAction = latest.node === 'hitl.requested' ? await hitlActionRepository.getByTaskId(taskId) : null;
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
      await orchestrationRuntime.requeue(taskId, message);
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
}

export const adminRuntimeService = new AdminRuntimeService();
