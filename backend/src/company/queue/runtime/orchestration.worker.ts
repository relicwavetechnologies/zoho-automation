import { Job, Worker } from 'bullmq';

import config from '../../../config';
import { logger } from '../../../utils/logger';
import { resolveChannelAdapter } from '../../channels';
import { classifyRuntimeError } from '../../observability';
import { orchestratorService } from '../../orchestration';
import { checkpointRepository } from '../../state/checkpoint';
import { hitlActionService } from '../../state/hitl';
import { runtimeTaskStore } from '../../orchestration/runtime-task.store';
import {
  ORCHESTRATION_JOB_NAME,
  ORCHESTRATION_QUEUE_NAME,
  type OrchestrationJobData,
} from './orchestration.queue';
import { runtimeControlSignalsRepository } from './control-signals.repository';
import { redisConnection } from './redis.connection';

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const userLocks = new Map<string, Promise<void>>();

const runPerUserDeterministically = async (userId: string, fn: () => Promise<void>): Promise<void> => {
  const previous = userLocks.get(userId) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(fn)
    .finally(() => {
      if (userLocks.get(userId) === next) {
        userLocks.delete(userId);
      }
    });
  userLocks.set(userId, next);
  return next;
};

const resolvePlanStartIndex = (plan: string[], latestNode?: string): number => {
  if (!latestNode) {
    return 0;
  }
  const index = plan.findIndex((step) => step === latestNode);
  if (index === -1) {
    return 0;
  }
  return Math.min(plan.length, index + 1);
};

const processTask = async (job: Job<OrchestrationJobData>): Promise<void> => {
  const { taskId, message } = job.data;
  const task = await orchestratorService.buildTask(taskId, message);
  logger.info('orchestration.task.route', {
    taskId,
    messageId: message.messageId,
    complexityLevel: task.complexityLevel,
    plan: task.plan,
  });
  runtimeTaskStore.update(taskId, {
    status: 'running',
    complexityLevel: task.complexityLevel,
    executionMode: task.executionMode,
    orchestratorModel: task.orchestratorModel,
    plan: task.plan,
  });

  const latestCheckpoint = await checkpointRepository.getLatest(taskId);
  if (latestCheckpoint?.node === 'synthesis.complete') {
    runtimeTaskStore.update(taskId, {
      status: 'done',
      currentStep: 'synthesis.complete',
      latestSynthesis:
        typeof latestCheckpoint.state.text === 'string'
          ? latestCheckpoint.state.text
          : 'Recovered from completed checkpoint',
    });
    return;
  }

  const planStartIndex = resolvePlanStartIndex(task.plan, latestCheckpoint?.node);
  if (planStartIndex > 0) {
    logger.warn('orchestration.task.resume', {
      taskId,
      messageId: message.messageId,
      fromCheckpointNode: latestCheckpoint?.node,
      resumePlanIndex: planStartIndex,
    });
  }

  for (const step of task.plan.slice(planStartIndex)) {
    await runtimeControlSignalsRepository.assertRunnableAtBoundary(taskId);
    runtimeTaskStore.update(taskId, { currentStep: step });
    await checkpointRepository.save(taskId, step, {
      step,
      channel: message.channel,
      messageId: message.messageId,
      chatId: message.chatId,
      chatType: message.chatType,
      timestamp: message.timestamp,
      userId: message.userId,
      text: message.text,
    });

    // Boundary-safe delay simulates an async external call without interruption mid-step.
    await sleep(100);
  }

  if (orchestratorService.requiresHumanConfirmation(message.text)) {
    const hitlAction = await hitlActionService.createPending({
      taskId,
      actionType: 'execute',
      summary: orchestratorService.buildHitlSummary(message.text),
      chatId: message.chatId,
    });

    runtimeTaskStore.update(taskId, {
      status: 'hitl',
      currentStep: 'hitl.pending',
      hitlActionId: hitlAction.actionId,
    });
    await checkpointRepository.save(taskId, 'hitl.requested', {
      actionId: hitlAction.actionId,
      actionType: hitlAction.actionType,
      expiresAt: hitlAction.expiresAt,
    });
    logger.warn('orchestration.task.hitl.requested', {
      taskId,
      messageId: message.messageId,
      actionId: hitlAction.actionId,
      expiresAt: hitlAction.expiresAt,
    });

    const channelAdapter = resolveChannelAdapter(message.channel);
    await channelAdapter.sendMessage({
      chatId: message.chatId,
      text:
        `Confirmation required for write-intent request.\n` +
        `Action ID: ${hitlAction.actionId}\n` +
        `Reply with: CONFIRM ${hitlAction.actionId} or CANCEL ${hitlAction.actionId}\n` +
        `Expires at: ${hitlAction.expiresAt}`,
      correlationId: taskId,
    });

    const resolved = await hitlActionService.waitForResolution(hitlAction.actionId);
    logger.info('orchestration.task.hitl.resolved', {
      taskId,
      messageId: message.messageId,
      actionId: resolved.action.actionId,
      status: resolved.action.status,
    });
    await checkpointRepository.save(taskId, `hitl.${resolved.action.status}`, {
      actionId: resolved.action.actionId,
      status: resolved.action.status,
    });

    if (resolved.action.status !== 'confirmed') {
      runtimeTaskStore.update(taskId, {
        status: 'cancelled',
        currentStep: `hitl.${resolved.action.status}`,
        latestSynthesis:
          resolved.action.status === 'expired'
            ? 'Request cancelled because confirmation timed out.'
            : 'Request cancelled by user confirmation flow.',
      });
      await channelAdapter.sendMessage({
        chatId: message.chatId,
        text:
          resolved.action.status === 'expired'
            ? 'Request auto-cancelled: confirmation window expired.'
            : 'Request cancelled. No write action executed.',
        correlationId: taskId,
      });
      return;
    }

    runtimeTaskStore.update(taskId, {
      status: 'running',
      currentStep: 'hitl.confirmed',
    });
    await channelAdapter.sendMessage({
      chatId: message.chatId,
      text: 'Confirmation received. Resuming execution.',
      correlationId: taskId,
    });
  }

  await runtimeControlSignalsRepository.assertRunnableAtBoundary(taskId);
  const agentResults = await orchestratorService.dispatchAgents(task, message);
  runtimeTaskStore.update(taskId, {
    agentResultsHistory: [
      ...(runtimeTaskStore.get(taskId)?.agentResultsHistory ?? []),
      ...agentResults,
    ],
  });
  await checkpointRepository.save(taskId, 'agent.dispatch.complete', {
    count: agentResults.length,
    failed: agentResults.some((result) => result.status === 'failed'),
    channel: message.channel,
    messageId: message.messageId,
    chatId: message.chatId,
    chatType: message.chatType,
    timestamp: message.timestamp,
    userId: message.userId,
    text: message.text,
  });

  const synthesis = orchestratorService.synthesize(task, message, agentResults);
  await checkpointRepository.save(taskId, 'synthesis.complete', {
    status: synthesis.taskStatus,
    text: synthesis.text,
    channel: message.channel,
    messageId: message.messageId,
    chatId: message.chatId,
    chatType: message.chatType,
    timestamp: message.timestamp,
    userId: message.userId,
  });

  const channelAdapter = resolveChannelAdapter(message.channel);
  await channelAdapter.sendMessage({
    chatId: message.chatId,
    text: synthesis.text,
    correlationId: taskId,
  });

  runtimeTaskStore.update(taskId, {
    status: synthesis.taskStatus,
    currentStep: task.plan[task.plan.length - 1],
    latestSynthesis: synthesis.text,
  });
  logger.info('orchestration.task.complete', {
    taskId,
    messageId: message.messageId,
    status: synthesis.taskStatus,
  });
};

let worker: Worker<OrchestrationJobData, void, typeof ORCHESTRATION_JOB_NAME> | null = null;

export const startOrchestrationWorker = (): Worker<OrchestrationJobData, void, typeof ORCHESTRATION_JOB_NAME> => {
  if (worker) {
    return worker;
  }

  worker = new Worker<OrchestrationJobData, void, typeof ORCHESTRATION_JOB_NAME>(
    ORCHESTRATION_QUEUE_NAME,
    async (job) => {
      if (job.name !== ORCHESTRATION_JOB_NAME) {
        return;
      }

      await runPerUserDeterministically(job.data.message.userId, async () => {
        try {
          await processTask(job);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown orchestration worker failure';
          if (message.includes('Task cancelled via control signal')) {
            runtimeTaskStore.update(job.data.taskId, { status: 'cancelled' });
            return;
          }

          runtimeTaskStore.update(job.data.taskId, { status: 'failed' });
          logger.error('orchestration.task.error', {
            taskId: job.data.taskId,
            messageId: job.data.message.messageId,
            classifiedError: classifyRuntimeError(error),
          });
          throw error;
        }
      });
    },
    {
      connection: redisConnection.getClient(),
      concurrency: Math.max(1, config.ORCHESTRATION_WORKER_CONCURRENCY),
    },
  );

  worker.on('completed', (job) => {
    logger.info('Orchestration task completed', { taskId: job.data.taskId, jobId: job.id });
  });
  worker.on('failed', (job, error) => {
    const classifiedError = classifyRuntimeError(error);
    logger.error('Orchestration task failed', {
      taskId: job?.data.taskId,
      jobId: job?.id,
      error: classifiedError,
    });
  });

  return worker;
};

export const stopOrchestrationWorker = async (): Promise<void> => {
  if (!worker) {
    return;
  }
  await worker.close();
  worker = null;
};
