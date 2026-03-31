import type { OrchestrationTaskStatus } from '../contracts/status';
import { prisma } from '../../utils/prisma';
import { runtimeTaskStore } from './runtime-task.store';

const mapTaskStatus = (status: 'pending' | 'running' | 'hitl' | 'done' | 'failed' | 'cancelled'): OrchestrationTaskStatus =>
  status;

export class TaskFsm {
  private getStatusPriority(status: OrchestrationTaskStatus): number {
    if (status === 'running') return 3;
    if (status === 'hitl') return 2;
    if (status === 'pending') return 1;
    return 0;
  }

  async create(input: {
    companyId: string;
    conversationKey: string;
    channel: string;
    inputMessage: unknown;
  }): Promise<string> {
    const row = await prisma.taskRun.create({
      data: {
        companyId: input.companyId,
        conversationKey: input.conversationKey,
        channel: input.channel,
        status: 'pending',
        inputMessage: input.inputMessage as any,
      },
    });
    return row.id;
  }

  async start(taskId: string): Promise<void> {
    await prisma.taskRun.update({
      where: { id: taskId },
      data: { status: 'running', lastHeartbeatAt: new Date(), failureReason: null, failedAt: null },
    });
    runtimeTaskStore.update(taskId, { status: 'running' });
  }

  async heartbeat(taskId: string): Promise<void> {
    await prisma.taskRun.update({
      where: { id: taskId },
      data: { lastHeartbeatAt: new Date() },
    });
  }

  async hitl(taskId: string, currentStep?: string): Promise<void> {
    await prisma.taskRun.update({
      where: { id: taskId },
      data: {
        status: 'hitl',
        currentStep: currentStep ?? null,
        lastHeartbeatAt: new Date(),
      },
    });
    runtimeTaskStore.update(taskId, { status: 'hitl', ...(currentStep ? { currentStep } : {}) });
  }

  async complete(taskId: string): Promise<void> {
    await prisma.taskRun.update({
      where: { id: taskId },
      data: { status: 'done', completedAt: new Date(), failureReason: null, failedAt: null },
    });
    runtimeTaskStore.update(taskId, { status: 'done' });
  }

  async fail(taskId: string, reason: string): Promise<void> {
    await prisma.taskRun.update({
      where: { id: taskId },
      data: { status: 'failed', failureReason: reason, failedAt: new Date() },
    });
    runtimeTaskStore.update(taskId, { status: 'failed' });
  }

  async cancel(taskId: string): Promise<void> {
    await prisma.taskRun.update({
      where: { id: taskId },
      data: { status: 'cancelled' },
    });
    runtimeTaskStore.update(taskId, { status: 'cancelled' });
  }

  async requeue(taskId: string): Promise<void> {
    await prisma.taskRun.update({
      where: { id: taskId },
      data: {
        status: 'pending',
        requeueCount: { increment: 1 },
        failureReason: null,
        failedAt: null,
      },
    });
    runtimeTaskStore.update(taskId, { status: 'pending' });
  }

  async getActiveForConversation(
    companyId: string | undefined,
    conversationKey: string,
  ): Promise<{ id: string; status: OrchestrationTaskStatus } | null> {
    const cached = runtimeTaskStore.findLatestActiveByConversation(conversationKey, companyId);
    if (cached) {
      return { id: cached.taskId, status: cached.status };
    }
    if (!companyId?.trim()) {
      return null;
    }

    const rows = await prisma.taskRun.findMany({
      where: {
        companyId,
        conversationKey,
        status: { in: ['pending', 'running', 'hitl'] },
      },
      orderBy: { updatedAt: 'desc' },
      take: 5,
      select: { id: true, status: true },
    });

    const row = rows
      .map((entry) => ({ id: entry.id, status: mapTaskStatus(entry.status) }))
      .sort((a, b) => this.getStatusPriority(b.status) - this.getStatusPriority(a.status))[0];

    return row ?? null;
  }

  async recoverStaleRunning(staleThresholdMs = 120_000): Promise<number> {
    const cutoff = new Date(Date.now() - staleThresholdMs);
    const result = await prisma.taskRun.updateMany({
      where: {
        status: 'running',
        lastHeartbeatAt: { lt: cutoff },
      },
      data: {
        status: 'failed',
        failureReason: 'stale_heartbeat',
        failedAt: new Date(),
      },
    });
    return result.count;
  }
}

export const taskFsm = new TaskFsm();
