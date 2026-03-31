import type { OrchestrationTaskStatus } from '../contracts/status';
import type { AgentResultDTO } from '../contracts';
import type { OrchestrationEngineId } from './engine/types';

export type RuntimeTaskSnapshot = {
  taskId: string;
  queueJobId?: string;
  messageId: string;
  channel: string;
  conversationKey?: string;
  userId: string;
  chatId: string;
  companyId?: string;
  scopeVisibility?: 'resolved' | 'unresolved';
  status: OrchestrationTaskStatus;
  plan: string[];
  currentStep?: string;
  complexityLevel?: 1 | 2 | 3 | 4 | 5;
  executionMode?: 'sequential' | 'parallel' | 'mixed';
  orchestratorModel?: string;
  latestSynthesis?: string;
  agentResultsHistory?: AgentResultDTO[];
  hitlActionId?: string;
  engine?: OrchestrationEngineId;
  configuredEngine?: OrchestrationEngineId;
  engineUsed?: OrchestrationEngineId;
  rolledBackFrom?: OrchestrationEngineId;
  rollbackReasonCode?: string;
  graphThreadId?: string;
  graphNode?: string;
  graphStepHistory?: string[];
  routeIntent?: string;
  conversationRequeueCount?: number;
  updatedAt: string;
  createdAt: string;
  controlSignal: 'running' | 'paused' | 'cancelled';
};

class RuntimeTaskStore {
  private readonly tasks = new Map<string, RuntimeTaskSnapshot>();

  private getActivePriority(task: RuntimeTaskSnapshot): number {
    if (task.status === 'running') return 3;
    if (task.status === 'hitl') return 2;
    if (task.status === 'pending') return 1;
    return 0;
  }

  private isActive(task: RuntimeTaskSnapshot): boolean {
    return task.status === 'pending' || task.status === 'running';
  }

  create(input: Omit<RuntimeTaskSnapshot, 'updatedAt' | 'createdAt' | 'controlSignal'>): RuntimeTaskSnapshot {
    const now = new Date().toISOString();
    const snapshot: RuntimeTaskSnapshot = {
      ...input,
      createdAt: now,
      updatedAt: now,
      controlSignal: 'running',
      scopeVisibility: input.companyId ? 'resolved' : 'unresolved',
    };
    this.tasks.set(snapshot.taskId, snapshot);
    return snapshot;
  }

  upsert(input: Omit<RuntimeTaskSnapshot, 'updatedAt' | 'createdAt' | 'controlSignal'>): RuntimeTaskSnapshot {
    const existing = this.tasks.get(input.taskId);
    if (!existing) {
      return this.create(input);
    }

    const next: RuntimeTaskSnapshot = {
      ...existing,
      ...input,
      updatedAt: new Date().toISOString(),
    };
    this.tasks.set(next.taskId, next);
    return next;
  }

  update(taskId: string, patch: Partial<RuntimeTaskSnapshot>): RuntimeTaskSnapshot | null {
    const existing = this.tasks.get(taskId);
    if (!existing) {
      return null;
    }

    const next: RuntimeTaskSnapshot = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.tasks.set(taskId, next);
    return next;
  }

  get(taskId: string): RuntimeTaskSnapshot | null {
    return this.tasks.get(taskId) ?? null;
  }

  list(limit = 30): RuntimeTaskSnapshot[] {
    return [...this.tasks.values()]
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .slice(0, limit);
  }

  findLatestActiveByConversation(conversationKey: string, companyId?: string): RuntimeTaskSnapshot | null {
    const active = [...this.tasks.values()]
      .filter((task) =>
        task.conversationKey === conversationKey
        && (companyId ? task.companyId === companyId : true)
        && (task.status === 'pending' || task.status === 'running' || task.status === 'hitl'))
      .sort((a, b) => {
        const priorityDiff = this.getActivePriority(b) - this.getActivePriority(a);
        if (priorityDiff !== 0) {
          return priorityDiff;
        }
        return a.updatedAt < b.updatedAt ? 1 : -1;
      });
    return active[0] ?? null;
  }

  getConversationExecutionState(channel: string, chatId: string): {
    runningTask: RuntimeTaskSnapshot | null;
    pendingCount: number;
  } {
    const tasks = [...this.tasks.values()].filter((task) => task.channel === channel && task.chatId === chatId);
    const runningTask = tasks
      .filter((task) => task.status === 'running' || task.status === 'hitl')
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0] ?? null;
    const pendingCount = tasks.filter((task) => task.status === 'pending').length;
    return { runningTask, pendingCount };
  }

  getPendingTasksForChat(channel: string, chatId: string): RuntimeTaskSnapshot[] {
    return [...this.tasks.values()]
      .filter((task) => task.channel === channel && task.chatId === chatId && task.status === 'pending')
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }
}

export const runtimeTaskStore = new RuntimeTaskStore();
