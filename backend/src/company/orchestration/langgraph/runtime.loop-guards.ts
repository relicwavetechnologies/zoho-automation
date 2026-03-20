import type { RuntimeDiagnostics } from './runtime.types';

export const stableSerialize = (value: unknown): string => {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableSerialize(entryValue)}`);
  return `{${entries.join(',')}}`;
};

export const createEmptyRuntimeDiagnostics = (): RuntimeDiagnostics => ({
  repeatedToolCallCount: {},
  repeatedValidationFailureCount: {},
  repeatedPlanHashCount: {},
  repeatedDeliveryKeyCount: {},
  nodeTransitionCount: {},
  retrievalRouteCount: {},
});

const incrementCounter = (bucket: Record<string, number>, key: string): number => {
  const next = (bucket[key] ?? 0) + 1;
  bucket[key] = next;
  return next;
};

export class RuntimeLoopGuards {
  constructor(
    private readonly thresholds: {
      repeatedToolCall: number;
      repeatedValidationFailure: number;
      repeatedPlanHash: number;
      repeatedDeliveryKey: number;
    } = {
      repeatedToolCall: 3,
      repeatedValidationFailure: 3,
      repeatedPlanHash: 3,
      repeatedDeliveryKey: 2,
    },
  ) {}

  registerToolCall(diagnostics: RuntimeDiagnostics, toolId: string, input: unknown) {
    const key = `tool:${toolId}:${stableSerialize(input)}`;
    const count = incrementCounter(diagnostics.repeatedToolCallCount, key);
    return {
      key,
      count,
      blocked: count > this.thresholds.repeatedToolCall,
      reason: count > this.thresholds.repeatedToolCall ? 'repeat_tool_call_limit' : undefined,
    };
  }

  registerValidationFailure(diagnostics: RuntimeDiagnostics, toolId: string, error: unknown) {
    const key = `validation:${toolId}:${stableSerialize(error)}`;
    const count = incrementCounter(diagnostics.repeatedValidationFailureCount, key);
    return {
      key,
      count,
      blocked: count > this.thresholds.repeatedValidationFailure,
      reason: count > this.thresholds.repeatedValidationFailure ? 'repeat_validation_failure_limit' : undefined,
    };
  }

  registerPlan(diagnostics: RuntimeDiagnostics, plan: string[]) {
    const key = `plan:${stableSerialize(plan)}`;
    const count = incrementCounter(diagnostics.repeatedPlanHashCount, key);
    return {
      key,
      count,
      blocked: count > this.thresholds.repeatedPlanHash,
      reason: count > this.thresholds.repeatedPlanHash ? 'repeat_plan_limit' : undefined,
    };
  }

  registerDelivery(diagnostics: RuntimeDiagnostics, channel: string, dedupeKey: string) {
    const key = `delivery:${channel}:${dedupeKey}`;
    const count = incrementCounter(diagnostics.repeatedDeliveryKeyCount, key);
    return {
      key,
      count,
      blocked: count > this.thresholds.repeatedDeliveryKey,
      reason: count > this.thresholds.repeatedDeliveryKey ? 'repeat_delivery_limit' : undefined,
    };
  }
}

export const runtimeLoopGuards = new RuntimeLoopGuards();
