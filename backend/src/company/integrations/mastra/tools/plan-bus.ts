import type { ExecutionPlan } from '../../../../modules/desktop-chat/desktop-plan';

type PlanCallback = (plan: ExecutionPlan) => void;

const registry = new Map<string, PlanCallback>();

export function registerPlanBus(requestId: string, cb: PlanCallback): void {
  registry.set(requestId, cb);
}

export function unregisterPlanBus(requestId: string): void {
  registry.delete(requestId);
}

export function emitPlanEvent(requestId: string, plan: ExecutionPlan): void {
  registry.get(requestId)?.(plan);
}
