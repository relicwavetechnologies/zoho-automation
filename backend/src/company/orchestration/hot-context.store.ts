export type HotContextIndexedEntity = {
  ordinal: number;
  recordId: string;
  label?: string;
  reference?: string;
};

export type HotContextSlot = {
  toolName: string;
  success: boolean;
  summary: string;
  authorityLevel?: 'confirmed' | 'candidate' | 'not_found';
  errorKind?: string;
  toolId?: string;
  actionGroup?: string;
  operation?: string;
  resolvedIds: Record<string, string>;
  entityIndexes?: Record<string, HotContextIndexedEntity[]>;
  fullPayload: unknown;
  completedAt: number;
};

export type HotContext = {
  taskId: string;
  slots: HotContextSlot[];
  createdAt: number;
};

class HotContextStore {
  private readonly store = new Map<string, HotContext>();

  init(taskId: string) {
    this.store.set(taskId, {
      taskId,
      slots: [],
      createdAt: Date.now(),
    });
  }

  push(taskId: string, slot: HotContextSlot) {
    const current = this.store.get(taskId);
    if (!current) {
      return;
    }
    current.slots.push(slot);
  }

  get(taskId: string): HotContext | undefined {
    return this.store.get(taskId);
  }

  clear(taskId: string) {
    this.store.delete(taskId);
  }

  getResolvedId(taskId: string, key: string): string | undefined {
    const context = this.store.get(taskId);
    if (!context) {
      return undefined;
    }
    for (const slot of [...context.slots].reverse()) {
      const value = slot.resolvedIds[key];
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }
    return undefined;
  }

  getLatestEntityIndex(taskId: string, entityType: string): HotContextIndexedEntity[] {
    const context = this.store.get(taskId);
    if (!context) {
      return [];
    }
    for (const slot of [...context.slots].reverse()) {
      const entries = slot.entityIndexes?.[entityType];
      if (Array.isArray(entries) && entries.length > 0) {
        return entries;
      }
    }
    return [];
  }

  toWarmSummary(taskId: string): {
    summary: string;
    resolvedIds: Record<string, string>;
  } {
    const context = this.store.get(taskId);
    if (!context || context.slots.length === 0) {
      return { summary: '', resolvedIds: {} };
    }
    const summary = context.slots.map((slot) => `${slot.toolName}: ${slot.summary}`).join('. ');
    const resolvedIds: Record<string, string> = {};
    for (const slot of [...context.slots].reverse()) {
      for (const [key, value] of Object.entries(slot.resolvedIds)) {
        if (value && resolvedIds[key] === undefined) {
          resolvedIds[key] = value;
        }
      }
    }
    return { summary, resolvedIds };
  }
}

export const hotContextStore = new HotContextStore();
