import type { OrchestrationTaskStatus } from '../contracts/status';
import type { AgentResultDTO } from '../contracts';
import type { OrchestrationEngineId } from './engine/types';

export type RuntimeTaskSnapshot = {
  taskId: string;
  messageId: string;
  channel: string;
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
  updatedAt: string;
  createdAt: string;
  controlSignal: 'running' | 'paused' | 'cancelled';
};

class RuntimeTaskStore {
  private readonly tasks = new Map<string, RuntimeTaskSnapshot>();

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
}

export const runtimeTaskStore = new RuntimeTaskStore();
