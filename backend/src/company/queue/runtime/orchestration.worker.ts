import { randomUUID } from 'crypto';
import { Job, Worker } from 'bullmq';

import config from '../../../config';
import { logger } from '../../../utils/logger';
import { orangeDebug } from '../../../utils/orange-debug';
import { LarkChannelAdapter } from '../../channels/lark/lark.adapter';
import {
  buildExecutionDecisionPayload,
  buildExecutionFailurePayload,
  buildExecutionOutcomePayload,
  buildExecutionRequestPayload,
  buildExecutionToolResultPayload,
  classifyRuntimeError,
  emitRuntimeTrace,
  executionService,
} from '../../observability';
import {
  buildTaskWithConfiguredEngine,
  executeTaskWithConfiguredEngine,
  getConfiguredOrchestrationEngineId,
} from '../../orchestration/engine';
import { runtimeTaskStore } from '../../orchestration/runtime-task.store';
import { taskFsm } from '../../orchestration/task-fsm';
import { checkpointRepository } from '../../state/checkpoint';
import {
  ORCHESTRATION_JOB_NAME,
  ORCHESTRATION_QUEUE_NAME,
  getOrchestrationQueue,
  requeueOrchestrationTask,
  type OrchestrationJobData,
} from './orchestration.queue';
import { pushDeadLetterRecord } from './dead-letter.queue';
import { QueueTaskTimeoutError, withTaskTimeout } from './queue-safety';
import { redisConnection, stateRedisConnection } from './redis.connection';

const conversationLocks = new Map<string, Promise<void>>();
const taskAbortControllers = new Map<string, AbortController>();
const CONVERSATION_LOCK_TTL_MS = config.ORCHESTRATION_QUEUE_JOB_TIMEOUT_MS + 15_000;
const CONVERSATION_LOCK_REQUEUE_DELAY_MS = 2_000;
const CONVERSATION_LOCK_REQUEUE_MAX_DELAY_MS = 30_000;

const runPerConversationDeterministically = async (
  conversationKey: string,
  fn: () => Promise<void>,
): Promise<void> => {
  const previous = conversationLocks.get(conversationKey) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(fn)
    .finally(() => {
      if (conversationLocks.get(conversationKey) === next) {
        conversationLocks.delete(conversationKey);
      }
    });
  conversationLocks.set(conversationKey, next);
  return next;
};

const extractCompanyIdFromAgentResults = (results: Array<Record<string, unknown>> | undefined): string | undefined => {
  if (!Array.isArray(results)) {
    return undefined;
  }

  for (const result of results) {
    if (!result || typeof result !== 'object') {
      continue;
    }
    if (result.agentKey !== 'zoho-read' || result.status !== 'success') {
      continue;
    }
    const payload = result.result;
    if (!payload || typeof payload !== 'object') {
      continue;
    }
    const companyId = (payload as Record<string, unknown>).companyId;
    if (typeof companyId === 'string' && companyId.trim().length > 0) {
      return companyId;
    }
  }

  return undefined;
};

const summarizeText = (value: string | null | undefined, limit = 280): string | null => {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}...` : trimmed;
};

const buildExecutionId = (taskId: string, requestId?: string): string => requestId?.trim() || taskId;
const buildConversationRuntimeKey = (channel: string, chatId: string): string =>
  `${channel}:${chatId}`;
const buildConversationLockKey = (job: Job<OrchestrationJobData>): string =>
  `orchestration:conversation-lock:${buildConversationRuntimeKey(job.data.message.channel, job.data.message.chatId)}`;

const computeConversationRequeueDelayMs = (requeueCount: number): number =>
  Math.min(
    CONVERSATION_LOCK_REQUEUE_DELAY_MS * (2 ** Math.max(0, requeueCount)),
    CONVERSATION_LOCK_REQUEUE_MAX_DELAY_MS,
  );

const buildQueueJobId = (job: Job<OrchestrationJobData>): string | undefined =>
  typeof job.id === 'string'
    ? job.id
    : job.id != null
      ? String(job.id)
      : undefined;

const isAbortSignalError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const candidate = error as {
    name?: string;
    message?: string;
  };
  return candidate.name === 'AbortError'
    || (typeof candidate.message === 'string' && candidate.message.includes('Task cancelled via abort signal'));
};

const isTaskCancellationError = (error: unknown): boolean =>
  error instanceof QueueTaskTimeoutError
  || isAbortSignalError(error)
  || (error instanceof Error && error.message.includes('Task cancelled via control signal'));

const registerTaskAbortController = (taskId: string, controller: AbortController): void => {
  taskAbortControllers.set(taskId, controller);
};

const unregisterTaskAbortController = (taskId: string, controller: AbortController): void => {
  if (taskAbortControllers.get(taskId) === controller) {
    taskAbortControllers.delete(taskId);
  }
};

export const abortRunningTaskInProcess = (taskId: string): boolean => {
  const controller = taskAbortControllers.get(taskId);
  if (!controller) {
    return false;
  }
  controller.abort();
  return true;
};

const acquireConversationLock = async (job: Job<OrchestrationJobData>): Promise<(() => Promise<void>) | null> => {
  const client = stateRedisConnection.getClient();
  const key = buildConversationLockKey(job);
  const token = randomUUID();
  const acquired = await client.set(key, token, 'PX', CONVERSATION_LOCK_TTL_MS, 'NX');
  if (acquired === 'OK') {
    return async () => {
      try {
        const current = await client.get(key);
        if (current === token) {
          await client.del(key);
        }
      } catch (error) {
        logger.warn('queue.conversation_lock.release_failed', {
          taskId: job.data.taskId,
          messageId: job.data.message.messageId,
          chatId: job.data.message.chatId,
          jobId: job.id,
          error: error instanceof Error ? error.message : 'unknown_error',
        });
      }
    };
  }

  const existingTask = runtimeTaskStore.get(job.data.taskId);
  const requeueCount = existingTask?.conversationRequeueCount ?? 0;
  logger.warn('queue.conversation_lock.busy', {
    taskId: job.data.taskId,
    messageId: job.data.message.messageId,
    chatId: job.data.message.chatId,
    jobId: job.id,
    requeueDelayMs: computeConversationRequeueDelayMs(requeueCount),
    requeueCount,
  });
  return null;
};

const startLarkExecutionRun = async (input: {
  executionId: string;
  taskId: string;
  companyId?: string;
  userId?: string;
  message: OrchestrationJobData['message'];
}): Promise<boolean> => {
  if (!input.companyId) {
    logger.warn('lark.execution.company_unresolved', {
      taskId: input.taskId,
      messageId: input.message.messageId,
      requestId: input.message.trace?.requestId,
    });
    return false;
  }

  await executionService.startRun({
    id: input.executionId,
    companyId: input.companyId,
    userId: input.userId ?? null,
    channel: 'lark',
    entrypoint: 'lark_inbound',
    requestId: input.executionId,
    taskId: input.taskId,
    chatId: input.message.chatId,
    messageId: input.message.messageId,
    agentTarget: 'lark-runtime',
    latestSummary: summarizeText(input.message.text),
  });

  await executionService.appendEvent({
    executionId: input.executionId,
    phase: 'request',
    eventType: 'execution.started',
    actorType: 'system',
    actorKey: input.message.channel,
    title: 'Lark execution started',
    summary: summarizeText(input.message.text),
    status: 'running',
    payload: {
      ...buildExecutionRequestPayload({
        originalPrompt: input.message.text,
        channel: 'lark',
        chatId: input.message.chatId,
        messageId: input.message.messageId,
        taskId: input.taskId,
        linkedUserId: input.userId ?? null,
      }),
      channel: input.message.channel,
      userId: input.message.userId,
    },
  });

  return true;
};

const appendExecutionEventSafe = async (
  executionId: string,
  input: Parameters<typeof executionService.appendEvent>[0],
): Promise<void> => {
  try {
    await executionService.appendEvent({
      ...input,
      executionId,
    });
  } catch (error) {
    logger.warn('lark.execution.event_append_failed', {
      executionId,
      eventType: input.eventType,
      error: error instanceof Error ? error.message : 'unknown_execution_event_error',
    });
  }
};

const notifyChannelTimeout = async (input: {
  taskId: string;
  message: OrchestrationJobData['message'];
  timeoutMs: number;
}): Promise<void> => {
  if (input.message.channel !== 'lark') {
    return;
  }

  const snapshot = runtimeTaskStore.get(input.taskId);
  const latestProgress =
    summarizeText(snapshot?.latestSynthesis, 220)
    ?? summarizeText(snapshot?.currentStep, 220)
    ?? 'The job was still in progress.';
  const timeoutText = [
    `I timed out after ${Math.round(input.timeoutMs / 60000)} minute${input.timeoutMs >= 120000 ? 's' : ''} while working on this.`,
    '',
    `Latest progress: ${latestProgress}`,
    '',
    'Reply with "continue" to resume from the saved progress.',
  ].join('\n');

  try {
    const adapter = new LarkChannelAdapter();
    const statusMessageId = input.message.trace?.statusMessageId?.trim();
    if (statusMessageId) {
      await adapter.updateMessage({
        messageId: statusMessageId,
        text: timeoutText,
        correlationId: input.taskId,
        actions: [],
      });
      return;
    }

    await adapter.sendMessage({
      chatId: input.message.chatId,
      text: timeoutText,
      correlationId: input.taskId,
      replyToMessageId: input.message.trace?.replyToMessageId ?? input.message.messageId,
      replyInThread: input.message.chatType === 'group',
      actions: [],
    });
  } catch (error) {
    logger.warn('queue.worker.timeout_notify_failed', {
      taskId: input.taskId,
      messageId: input.message.messageId,
      error: error instanceof Error ? error.message : 'unknown_error',
    });
  }
};

const cancelTrackedExecutionRun = async (input: {
  taskId: string;
  message: OrchestrationJobData['message'];
  summary: string;
  reasonCode: string;
}): Promise<void> => {
  const companyId = input.message.trace?.companyId;
  if (!companyId) {
    return;
  }
  const executionId = buildExecutionId(input.taskId, input.message.trace?.requestId);
  await appendExecutionEventSafe(executionId, {
    executionId,
    phase: 'control',
    eventType: 'execution.cancelled',
    actorType: 'system',
    actorKey: input.message.channel,
    title: 'Lark execution cancelled',
    summary: summarizeText(input.summary, 400),
    status: 'cancelled',
    payload: buildExecutionFailurePayload({
      stage: 'lark_runtime',
      errorCode: input.reasonCode,
      errorMessage: input.summary,
      retriable: input.reasonCode === 'queue_task_timeout',
    }),
  });
  await executionService.cancelRun({
    executionId,
    latestSummary: summarizeText(input.summary, 400),
  });
};

const upsertRuntimeSnapshotFromJob = (
  job: Job<OrchestrationJobData>,
  status: 'pending' | 'running',
) => {
  const existing = runtimeTaskStore.get(job.data.taskId);
  return runtimeTaskStore.upsert({
    taskId: job.data.taskId,
    queueJobId: buildQueueJobId(job),
    messageId: job.data.message.messageId,
    channel: job.data.message.channel,
    conversationKey: job.data.message.chatId,
    userId: job.data.message.userId,
    chatId: job.data.message.chatId,
    companyId: existing?.companyId ?? job.data.message.trace?.companyId,
    scopeVisibility: (existing?.companyId ?? job.data.message.trace?.companyId) ? 'resolved' : 'unresolved',
    status,
    plan: existing?.plan ?? [],
    currentStep: existing?.currentStep,
    complexityLevel: existing?.complexityLevel,
    executionMode: existing?.executionMode,
    orchestratorModel: existing?.orchestratorModel,
    latestSynthesis: existing?.latestSynthesis,
    agentResultsHistory: existing?.agentResultsHistory,
    hitlActionId: existing?.hitlActionId,
    engine: existing?.engine,
    configuredEngine: existing?.configuredEngine,
    engineUsed: existing?.engineUsed,
    rolledBackFrom: existing?.rolledBackFrom,
    rollbackReasonCode: existing?.rollbackReasonCode,
    graphThreadId: existing?.graphThreadId,
    graphNode: existing?.graphNode,
    graphStepHistory: existing?.graphStepHistory,
    routeIntent: existing?.routeIntent,
  });
};

const reconcileTaskStateOnStartup = async (): Promise<void> => {
  const queue = getOrchestrationQueue();
  const [activeJobs, waitingJobs, delayedJobs] = await Promise.all([
    queue.getActive(),
    queue.getWaiting(),
    queue.getDelayed(),
  ]);

  for (const job of activeJobs) {
    upsertRuntimeSnapshotFromJob(job, 'running');
  }
  for (const job of [...waitingJobs, ...delayedJobs]) {
    upsertRuntimeSnapshotFromJob(job, 'pending');
  }

  logger.info('orchestration.worker.startup.reconciled', {
    activeCount: activeJobs.length,
    waitingCount: waitingJobs.length,
    delayedCount: delayedJobs.length,
  });
};

const processTask = async (
  job: Job<OrchestrationJobData>,
  abortSignal?: AbortSignal,
): Promise<void> => {
  const { taskId, message } = job.data;
  const executionId = buildExecutionId(taskId, message.trace?.requestId);
  const runStartedAt = Date.now();
  const linkedUserId = typeof message.trace?.linkedUserId === 'string' ? message.trace.linkedUserId : undefined;
  let trackedCompanyId = message.trace?.companyId;
  let executionTrackingEnabled = false;
  const configuredEngine = getConfiguredOrchestrationEngineId();
  logger.info('lark.runtime.job.started', {
    requestId: message.trace?.requestId,
    channel: message.channel,
    eventId: message.trace?.eventId,
    messageId: message.messageId,
    chatId: message.chatId,
    userId: message.userId,
    taskId,
    jobId: job.id,
    textHash: message.trace?.textHash,
  });
  orangeDebug('queue.job.started', {
    taskId,
    jobId: job.id,
    messageId: message.messageId,
    chatId: message.chatId,
    userId: message.userId,
  });
  emitRuntimeTrace({
    event: 'lark.runtime.job.started',
    level: 'info',
    requestId: message.trace?.requestId,
    taskId,
    messageId: message.messageId,
    metadata: {
      channel: message.channel,
      eventId: message.trace?.eventId,
      chatId: message.chatId,
      userId: message.userId,
      textHash: message.trace?.textHash,
    },
  });
  executionTrackingEnabled = await startLarkExecutionRun({
    executionId,
    taskId,
    companyId: trackedCompanyId,
    userId: linkedUserId,
    message,
  });
  const task = await buildTaskWithConfiguredEngine(taskId, message);
  if (executionTrackingEnabled) {
    await appendExecutionEventSafe(executionId, {
      executionId,
      phase: 'planning',
      eventType: 'plan.created',
      actorType: 'planner',
      actorKey: configuredEngine,
      title: 'Built orchestration plan',
      summary: summarizeText(task.plan.join(' | '), 600),
      status: 'running',
      payload: {
        configuredEngine,
        complexityLevel: task.complexityLevel,
        executionMode: task.executionMode,
        plan: task.plan.map((step, index) => ({
          index: index + 1,
          title: step,
        })),
      },
    });
  }

  await taskFsm.start(taskId);
  runtimeTaskStore.update(taskId, {
    queueJobId: buildQueueJobId(job),
    complexityLevel: task.complexityLevel,
    executionMode: task.executionMode,
    orchestratorModel: task.orchestratorModel,
    plan: task.plan,
    configuredEngine,
    engine: configuredEngine,
    engineUsed: undefined,
    rolledBackFrom: undefined,
    rollbackReasonCode: undefined,
    routeIntent: undefined,
  });

  logger.debug('orchestration.task.route', {
    taskId,
    messageId: message.messageId,
    configuredEngine,
    complexityLevel: task.complexityLevel,
    plan: task.plan,
  });

  const latestCheckpoint = await checkpointRepository.getLatest(taskId);
  const heartbeatInterval = setInterval(() => {
    void taskFsm.heartbeat(taskId).catch((error) => {
      logger.warn('task_fsm.heartbeat_failed', {
        taskId,
        error: error instanceof Error ? error.message : 'unknown_error',
      });
    });
  }, 30_000);
  let result: Awaited<ReturnType<typeof executeTaskWithConfiguredEngine>>['result'];
  let selectedEngine: Awaited<ReturnType<typeof executeTaskWithConfiguredEngine>>['configuredEngine'];
  let engineUsed: Awaited<ReturnType<typeof executeTaskWithConfiguredEngine>>['engineUsed'];
  try {
    ({ result, configuredEngine: selectedEngine, engineUsed } = await executeTaskWithConfiguredEngine({
      task,
      message,
      latestCheckpoint,
      abortSignal,
    }));
  } finally {
    clearInterval(heartbeatInterval);
  }
  const rolledBackFrom = null;
  const rollbackReasonCode = null;
  const resolvedCompanyId = extractCompanyIdFromAgentResults(result.agentResults as Array<Record<string, unknown>>);
  if (!trackedCompanyId && resolvedCompanyId) {
    trackedCompanyId = resolvedCompanyId;
    executionTrackingEnabled = await startLarkExecutionRun({
      executionId,
      taskId,
      companyId: trackedCompanyId,
      userId: linkedUserId,
      message,
    });
    if (executionTrackingEnabled) {
      await appendExecutionEventSafe(executionId, {
        executionId,
        phase: 'planning',
        eventType: 'plan.created',
        actorType: 'planner',
        actorKey: selectedEngine,
        title: 'Built orchestration plan',
        summary: summarizeText(task.plan.join(' | '), 600),
        status: 'running',
        payload: {
          configuredEngine: selectedEngine,
          complexityLevel: task.complexityLevel,
          executionMode: task.executionMode,
          plan: task.plan.map((step, index) => ({
            index: index + 1,
            title: step,
          })),
        },
      });
    }
  }

  const applyExecutionResultToTask = (input: {
    taskId: string;
    result: typeof result;
    selectedEngine: typeof selectedEngine;
    engineUsed: typeof engineUsed;
  }) =>
    runtimeTaskStore.update(input.taskId, {
      status: input.result.status,
      complexityLevel: input.result.task.complexityLevel,
      executionMode: input.result.task.executionMode,
      orchestratorModel: input.result.task.orchestratorModel,
      plan: input.result.task.plan,
      currentStep: input.result.currentStep,
      latestSynthesis: input.result.latestSynthesis,
      hitlActionId: input.result.hitlAction?.actionId,
      configuredEngine: input.selectedEngine,
      engine: input.engineUsed,
      engineUsed: input.engineUsed,
      rolledBackFrom: undefined,
      rollbackReasonCode: undefined,
      graphThreadId: input.result.runtimeMeta?.threadId,
      graphNode: input.result.runtimeMeta?.node,
      graphStepHistory: input.result.runtimeMeta?.stepHistory,
      routeIntent: input.result.runtimeMeta?.routeIntent,
      companyId: resolvedCompanyId ?? runtimeTaskStore.get(input.taskId)?.companyId,
      scopeVisibility: (resolvedCompanyId ?? runtimeTaskStore.get(input.taskId)?.companyId)
        ? 'resolved'
        : 'unresolved',
      agentResultsHistory: [
        ...(runtimeTaskStore.get(input.taskId)?.agentResultsHistory ?? []),
        ...(input.result.agentResults ?? []),
      ],
    });

  applyExecutionResultToTask({
    taskId,
    result,
    selectedEngine,
    engineUsed,
  });

  if (result.status === 'done') {
    await taskFsm.complete(taskId);
  } else if (result.status === 'failed') {
    await taskFsm.fail(taskId, result.currentStep ?? result.latestSynthesis ?? 'runtime_failed');
  } else if (result.status === 'cancelled') {
    await taskFsm.cancel(taskId);
  } else if (result.status === 'hitl') {
    await taskFsm.hitl(taskId, result.currentStep);
  }

  if (executionTrackingEnabled) {
    for (const agentResult of result.agentResults ?? []) {
      const status = typeof agentResult.status === 'string' ? agentResult.status : undefined;
      const isFailure = status === 'failed' || status === 'timed_out_partial';
      await appendExecutionEventSafe(executionId, {
        executionId,
        phase: isFailure ? 'error' : 'tool',
        eventType: isFailure ? 'tool.failed' : 'tool.completed',
        actorType: 'agent',
        actorKey: typeof agentResult.agentKey === 'string' ? agentResult.agentKey : 'agent',
        title: `${isFailure ? 'Agent failed' : 'Agent completed'}: ${
          typeof agentResult.agentKey === 'string' ? agentResult.agentKey : 'agent'
        }`,
        summary: summarizeText(typeof agentResult.message === 'string' ? agentResult.message : null, 800),
        status: status ?? null,
        payload: {
          ...buildExecutionToolResultPayload({
            toolName: typeof agentResult.agentKey === 'string' ? agentResult.agentKey : 'agent',
            title: `${isFailure ? 'Agent failed' : 'Agent completed'}: ${
              typeof agentResult.agentKey === 'string' ? agentResult.agentKey : 'agent'
            }`,
            success: !isFailure,
            status: status ?? null,
            summary: typeof agentResult.message === 'string' ? agentResult.message : null,
            output: typeof agentResult.result === 'object' ? agentResult.result : null,
            error: typeof agentResult.error === 'object' ? agentResult.error : null,
            latencyMs: typeof agentResult.metrics?.latencyMs === 'number' ? agentResult.metrics.latencyMs : null,
          }),
          metrics: typeof agentResult.metrics === 'object' ? agentResult.metrics : null,
        },
      });
    }

    if (result.latestSynthesis) {
      await appendExecutionEventSafe(executionId, {
        executionId,
        phase: 'synthesis',
        eventType: 'synthesis.completed',
        actorType: 'agent',
        actorKey: engineUsed,
        title: 'Generated final synthesis',
        summary: summarizeText(result.latestSynthesis, 800),
        status: 'done',
        payload: buildExecutionOutcomePayload({
          finalText: result.latestSynthesis,
          deliveryTarget: message.channel,
          details: {
            configuredEngine: selectedEngine,
            engineUsed,
            durationMs: Date.now() - runStartedAt,
          },
        }),
      });
    }

    await appendExecutionEventSafe(executionId, {
      executionId,
      phase: 'delivery',
      eventType: 'delivery.completed',
      actorType: 'delivery',
      actorKey: message.channel,
      title: 'Runtime delivery completed',
      summary: summarizeText(result.latestSynthesis ?? result.currentStep ?? message.text, 400),
      status: result.status,
      payload: {
        ...buildExecutionDecisionPayload({
          summary: result.status === 'failed'
            ? 'Execution delivery completed in a failed state.'
            : 'Execution delivery completed successfully.',
          details: {
            configuredEngine: selectedEngine,
            engineUsed,
            rolledBackFrom: rolledBackFrom ?? null,
            rollbackReasonCode: rollbackReasonCode ?? null,
            currentStep: result.currentStep ?? null,
            graphThreadId: result.runtimeMeta?.threadId ?? null,
            graphNode: result.runtimeMeta?.node ?? null,
            durationMs: Date.now() - runStartedAt,
          },
        }),
        durationMs: Date.now() - runStartedAt,
        configuredEngine: selectedEngine,
        engineUsed,
        rolledBackFrom: rolledBackFrom ?? null,
        rollbackReasonCode: rollbackReasonCode ?? null,
        currentStep: result.currentStep ?? null,
        graphThreadId: result.runtimeMeta?.threadId ?? null,
        graphNode: result.runtimeMeta?.node ?? null,
      },
    });

    if (result.status === 'failed') {
      await executionService.failRun({
        executionId,
        latestSummary: summarizeText(result.latestSynthesis ?? result.currentStep ?? message.text, 400),
        errorCode: rollbackReasonCode ?? 'lark_runtime_failed',
        errorMessage: summarizeText(result.currentStep ?? result.latestSynthesis ?? 'Runtime failed', 400),
      });
    } else if (result.status === 'cancelled') {
      await executionService.cancelRun({
        executionId,
        latestSummary: summarizeText(result.currentStep ?? message.text, 400),
      });
    } else {
      await executionService.completeRun({
        executionId,
        latestSummary: summarizeText(result.latestSynthesis ?? result.currentStep ?? message.text, 400),
      });
    }
  }

  if (rolledBackFrom) {
    logger.warn('orchestration.task.engine.rollback', {
      taskId,
      messageId: message.messageId,
      configuredEngine: selectedEngine,
      engineUsed,
      rolledBackFrom,
      rollbackReasonCode,
    });
  }

  logger.success('orchestration.task.complete', {
    taskId,
    messageId: message.messageId,
    configuredEngine: selectedEngine,
    engineUsed,
    rolledBackFrom,
    rollbackReasonCode,
    status: result.status,
  });
  logger.info('lark.runtime.job.completed', {
    requestId: message.trace?.requestId,
    channel: message.channel,
    eventId: message.trace?.eventId,
    messageId: message.messageId,
    chatId: message.chatId,
    userId: message.userId,
    taskId,
    jobId: job.id,
    status: result.status,
    textHash: message.trace?.textHash,
  });
  orangeDebug('queue.job.completed', {
    taskId,
    jobId: job.id,
    messageId: message.messageId,
    chatId: message.chatId,
    status: result.status,
  });
  emitRuntimeTrace({
    event: 'lark.runtime.job.completed',
    level: 'info',
    requestId: message.trace?.requestId,
    taskId,
    messageId: message.messageId,
    companyId: resolvedCompanyId,
    metadata: {
      status: result.status,
      channel: message.channel,
      eventId: message.trace?.eventId,
      chatId: message.chatId,
      userId: message.userId,
      textHash: message.trace?.textHash,
      configuredEngine: selectedEngine,
      engineUsed,
    },
  });
};

export const runOrchestrationJobWithSafety = async (
  job: Job<OrchestrationJobData>,
  abortController: AbortController,
  processor: (job: Job<OrchestrationJobData>, abortSignal?: AbortSignal) => Promise<void> = processTask,
): Promise<void> =>
  withTaskTimeout(
    (abortSignal) => processor(job, abortSignal),
    config.ORCHESTRATION_QUEUE_JOB_TIMEOUT_MS,
    {
      taskId: job.data.taskId,
      messageId: job.data.message.messageId,
      channel: job.data.message.channel,
      requestId: job.data.message.trace?.requestId,
      jobId: job.id,
    },
    abortController,
  );

const buildWorkerOptions = (connection = redisConnection.getClient()) => ({
  connection,
  concurrency: Math.max(1, config.ORCHESTRATION_WORKER_CONCURRENCY),
  lockDuration: config.ORCHESTRATION_QUEUE_LOCK_DURATION_MS,
  stalledInterval: config.ORCHESTRATION_QUEUE_STALLED_INTERVAL_MS,
  maxStalledCount: config.ORCHESTRATION_QUEUE_MAX_STALLED_COUNT,
  autorun: false,
});

let worker: Worker<OrchestrationJobData, void, typeof ORCHESTRATION_JOB_NAME> | null = null;

export const startOrchestrationWorker = async (): Promise<Worker<OrchestrationJobData, void, typeof ORCHESTRATION_JOB_NAME>> => {
  if (worker) {
    return worker;
  }

  worker = new Worker<OrchestrationJobData, void, typeof ORCHESTRATION_JOB_NAME>(
    ORCHESTRATION_QUEUE_NAME,
    async (job) => {
      if (job.name !== ORCHESTRATION_JOB_NAME) {
        return;
      }

      const releaseConversationLock = await acquireConversationLock(job);
      if (!releaseConversationLock) {
        const currentSnapshot = runtimeTaskStore.get(job.data.taskId);
        const requeueCount = currentSnapshot?.conversationRequeueCount ?? 0;
        const requeueDelayMs = computeConversationRequeueDelayMs(requeueCount);
        const executionId = buildExecutionId(job.data.taskId, job.data.message.trace?.requestId);
        await appendExecutionEventSafe(executionId, {
          executionId,
          phase: 'queued',
          eventType: 'queue.conversation_lock.waiting',
          actorType: 'worker',
          actorKey: 'orchestration-worker',
          title: 'Waiting for active conversation to finish',
          summary: `Requeued (attempt ${requeueCount + 1}), retrying in ${Math.round(requeueDelayMs / 1000)}s`,
          status: 'running',
          payload: {
            requeueCount: requeueCount + 1,
            requeueDelayMs,
            chatId: job.data.message.chatId,
            channel: job.data.message.channel,
          },
        });
        const requeued = await requeueOrchestrationTask(
          job.data.taskId,
          job.data.message,
          requeueDelayMs,
        );
        runtimeTaskStore.update(job.data.taskId, {
          conversationKey: job.data.message.chatId,
        });
        runtimeTaskStore.update(job.data.taskId, {
          queueJobId: requeued.queueJobId,
          conversationRequeueCount: requeueCount + 1,
          currentStep: `Waiting for another task in this chat to finish (retry in ${Math.round(requeueDelayMs / 1000)}s).`,
        });
        return;
      }
      runtimeTaskStore.update(job.data.taskId, {
        conversationRequeueCount: 0,
      });

      const abortController = new AbortController();
      registerTaskAbortController(job.data.taskId, abortController);
      try {
        await runPerConversationDeterministically(
          buildConversationRuntimeKey(job.data.message.channel, job.data.message.chatId),
          async () => {
          try {
            await runOrchestrationJobWithSafety(job, abortController);
          } catch (error) {
            if (isTaskCancellationError(error)) {
              await taskFsm.cancel(job.data.taskId);
              await cancelTrackedExecutionRun({
                taskId: job.data.taskId,
                message: job.data.message,
                summary: error instanceof QueueTaskTimeoutError
                  ? `Execution timed out after ${error.timeoutMs}ms and was cancelled.`
                  : 'Execution was cancelled before completion.',
                reasonCode: error instanceof QueueTaskTimeoutError
                  ? 'queue_task_timeout'
                  : 'lark_runtime_cancelled',
              });
              if (error instanceof QueueTaskTimeoutError) {
                await notifyChannelTimeout({
                  taskId: job.data.taskId,
                  message: job.data.message,
                  timeoutMs: error.timeoutMs,
                });
              }
              if (error instanceof QueueTaskTimeoutError) {
                logger.error('queue.worker.timeout', {
                  taskId: job.data.taskId,
                  messageId: job.data.message.messageId,
                  channel: job.data.message.channel,
                  requestId: job.data.message.trace?.requestId,
                  jobId: job.id,
                  timeoutMs: error.timeoutMs,
                });
              }
              return;
            }

            await taskFsm.fail(
              job.data.taskId,
              error instanceof Error ? error.message : 'runtime_worker_failure',
            );
            logger.error('orchestration.task.error', {
              taskId: job.data.taskId,
              messageId: job.data.message.messageId,
              classifiedError: classifyRuntimeError(error),
            });
            throw error;
          }
          },
        );
      } finally {
        unregisterTaskAbortController(job.data.taskId, abortController);
        await releaseConversationLock();
      }
    },
    buildWorkerOptions(),
  );

  worker.on('completed', (job) => {
    logger.success('orchestration.worker.job.completed', { taskId: job.data.taskId, jobId: job.id });
  });
  worker.on('failed', (job, error) => {
    const classifiedError = classifyRuntimeError(error);
    void pushDeadLetterRecord({
      queue: 'orchestration',
      failedAt: new Date().toISOString(),
      taskId: job?.data.taskId,
      jobId: typeof job?.id === 'string' ? job.id : job?.id != null ? String(job.id) : undefined,
      requestId: job?.data.message.trace?.requestId,
      companyId: job?.data.message.trace?.companyId,
      channel: job?.data.message.channel,
      messageId: job?.data.message.messageId,
      chatId: job?.data.message.chatId,
      userId: job?.data.message.userId,
      error: {
        message: classifiedError.rawMessage ?? classifiedError.classifiedReason ?? 'unknown_runtime_failure',
      },
    });
    orangeDebug('queue.job.failed', {
      taskId: job?.data.taskId,
      jobId: job?.id,
      messageId: job?.data.message.messageId,
      chatId: job?.data.message.chatId,
      error: classifiedError.rawMessage ?? classifiedError.classifiedReason ?? 'unknown_error',
    });
    logger.error('Orchestration task failed', {
      taskId: job?.data.taskId,
      jobId: job?.id,
      error: classifiedError,
    });
    logger.error('lark.runtime.job.failed', {
      requestId: job?.data.message.trace?.requestId,
      channel: job?.data.message.channel,
      eventId: job?.data.message.trace?.eventId,
      messageId: job?.data.message.messageId,
      chatId: job?.data.message.chatId,
      userId: job?.data.message.userId,
      taskId: job?.data.taskId,
      jobId: job?.id,
      textHash: job?.data.message.trace?.textHash,
      error: classifiedError,
    });
    emitRuntimeTrace({
      event: 'lark.runtime.job.failed',
      level: 'error',
      requestId: job?.data.message.trace?.requestId,
      taskId: job?.data.taskId,
      messageId: job?.data.message.messageId,
      metadata: {
        channel: job?.data.message.channel,
        eventId: job?.data.message.trace?.eventId,
        chatId: job?.data.message.chatId,
        userId: job?.data.message.userId,
        textHash: job?.data.message.trace?.textHash,
        error: classifiedError,
      },
    });
    const companyId = job?.data.message.trace?.companyId;
    if (job?.data.taskId && companyId) {
      const executionId = buildExecutionId(job.data.taskId, job.data.message.trace?.requestId);
      void appendExecutionEventSafe(executionId, {
        executionId,
        phase: 'error',
        eventType: 'execution.failed',
        actorType: 'system',
        actorKey: job.data.message.channel,
        title: 'Lark execution failed',
        summary: summarizeText(classifiedError.rawMessage ?? classifiedError.classifiedReason ?? 'Runtime worker failure', 400),
        status: 'failed',
        payload: {
          ...buildExecutionFailurePayload({
            stage: 'lark_runtime',
            errorCode: classifiedError.classifiedReason ?? 'lark_runtime_failed',
            errorMessage: classifiedError.rawMessage ?? classifiedError.classifiedReason ?? 'Runtime worker failure',
          }),
          taskId: job.data.taskId,
          messageId: job.data.message.messageId,
          classifiedError,
        },
      }).then(async () => {
        await executionService.failRun({
          executionId,
          latestSummary: summarizeText(classifiedError.rawMessage ?? classifiedError.classifiedReason ?? 'Runtime worker failure', 400),
          errorCode: classifiedError.classifiedReason ?? 'lark_runtime_failed',
          errorMessage: summarizeText(classifiedError.rawMessage ?? classifiedError.classifiedReason ?? 'Runtime worker failure', 400),
        });
      }).catch(() => undefined);
    }
  });
  worker.on('error', (error) => {
    logger.error('queue.worker.error', { error });
  });

  const recovered = await taskFsm.recoverStaleRunning(120_000);
  if (recovered > 0) {
    logger.warn('task_fsm_stale_recovery', { count: recovered });
  }
  await reconcileTaskStateOnStartup();
  void worker.run();
  return worker;
};

export const stopOrchestrationWorker = async (): Promise<void> => {
  if (!worker) {
    return;
  }
  await worker.close();
  worker = null;
};

export const __test__ = {
  buildWorkerOptions,
  applyExecutionResultToTask: (input: {
    taskId: string;
    result: {
      status: 'pending' | 'running' | 'hitl' | 'done' | 'failed' | 'cancelled';
      task: {
        complexityLevel?: 1 | 2 | 3 | 4 | 5;
        executionMode?: 'sequential' | 'parallel' | 'mixed';
        orchestratorModel?: string;
        plan: string[];
      };
      currentStep?: string;
      latestSynthesis?: string;
      hitlAction?: { actionId: string };
      runtimeMeta?: { threadId?: string; node?: string; stepHistory?: string[]; routeIntent?: string };
      agentResults?: Array<Record<string, unknown>>;
    };
    selectedEngine: 'legacy' | 'vercel' | 'langgraph';
    engineUsed: 'legacy' | 'vercel' | 'langgraph';
    rolledBackFrom?: 'legacy' | 'vercel' | 'langgraph';
    rollbackReasonCode?: string;
  }) =>
    runtimeTaskStore.update(input.taskId, {
      status: input.result.status,
      complexityLevel: input.result.task.complexityLevel,
      executionMode: input.result.task.executionMode,
      orchestratorModel: input.result.task.orchestratorModel,
      plan: input.result.task.plan,
      currentStep: input.result.currentStep,
      latestSynthesis: input.result.latestSynthesis,
      hitlActionId: input.result.hitlAction?.actionId,
      configuredEngine: input.selectedEngine,
      engine: input.engineUsed,
      engineUsed: input.engineUsed,
      rolledBackFrom: input.rolledBackFrom,
      rollbackReasonCode: input.rollbackReasonCode,
      graphThreadId: input.result.runtimeMeta?.threadId,
      graphNode: input.result.runtimeMeta?.node,
      graphStepHistory: input.result.runtimeMeta?.stepHistory,
      routeIntent: input.result.runtimeMeta?.routeIntent,
      agentResultsHistory: [
        ...(runtimeTaskStore.get(input.taskId)?.agentResultsHistory ?? []),
        ...((input.result.agentResults as any[]) ?? []),
      ],
    }),
};
