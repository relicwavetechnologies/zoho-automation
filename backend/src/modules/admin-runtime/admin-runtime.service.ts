import { HttpException } from '../../core/http-exception';
import { BaseService } from '../../core/service';
import type { NormalizedIncomingMessageDTO } from '../../company/contracts';
import { orchestrationRuntime } from '../../company/queue/runtime';
import { checkpointRepository } from '../../company/state/checkpoint';
import { ControlTaskDto } from './dto/control-task.dto';

export class AdminRuntimeService extends BaseService {
  async listTasks(limit = 30) {
    return orchestrationRuntime.listRecent(limit);
  }

  async getTask(taskId: string) {
    const task = await orchestrationRuntime.getTask(taskId);
    if (!task) {
      throw new HttpException(404, 'Task not found');
    }
    return task;
  }

  async getTaskTrace(taskId: string, limit = 100) {
    const task = await orchestrationRuntime.getTask(taskId);
    if (!task) {
      throw new HttpException(404, 'Task not found');
    }

    const history = await checkpointRepository.getHistory(taskId, Math.max(1, Math.min(500, limit)));
    return {
      taskId,
      engine: task.engine ?? 'legacy',
      graphThreadId: task.graphThreadId ?? task.taskId,
      latestNode: task.graphNode ?? task.currentStep ?? null,
      transitions: history.map((entry) => {
        const runtimeMeta =
          entry.state.runtimeMeta && typeof entry.state.runtimeMeta === 'object'
            ? (entry.state.runtimeMeta as Record<string, unknown>)
            : undefined;
        return {
          version: entry.version,
          node: entry.node,
          updatedAt: entry.updatedAt,
          engine: typeof runtimeMeta?.engine === 'string' ? runtimeMeta.engine : task.engine ?? 'legacy',
          graphNode: typeof runtimeMeta?.node === 'string' ? runtimeMeta.node : undefined,
          graphThreadId: typeof runtimeMeta?.threadId === 'string' ? runtimeMeta.threadId : undefined,
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

    await orchestrationRuntime.requeue(taskId, message);
    return {
      taskId,
      recoveredFromVersion: latest.version,
      recoveredFromNode: latest.node,
      status: 'requeued',
    };
  }
}

export const adminRuntimeService = new AdminRuntimeService();
