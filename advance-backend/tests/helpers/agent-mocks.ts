/**
 * Shared mock factories for multi-agent delegation tests.
 *
 * These helpers let you test each specialist in complete isolation:
 *   - mockPlanner(plan)  → Planner that returns the given plan
 *   - mockExecutor(opts) → Executor that returns controlled step/outcome data
 *   - makeTool(id)       → minimal Tool<T,U> with no real I/O
 *
 * Usage:
 *   const planner  = mockPlanner(validPlan);
 *   const executor = mockExecutor({ stepStatus: 'success' });
 *   const specialist = createLarkSpecialist({ planner, executor, logger: noopLogger });
 *   const result = await specialist.run(makeSpecialistInput(['larkTask', 'larkMessaging']));
 */

import { z } from 'zod';
import { ok, err } from '../../src/shared/result.ts';
import { OrchestrationError } from '../../src/shared/errors.ts';
import { asToolId } from '../../src/shared/ids.ts';
import type { Planner } from '../../src/application/orchestration/engine/planner.ts';
import type { Executor, ExecutorOutput } from '../../src/application/orchestration/engine/executor.ts';
import type { Tool } from '../../src/application/orchestration/tools/tool.contract.ts';
import type { SpecialistInput } from '../../src/application/orchestration/agents/agent.types.ts';
import type { PermissionResult } from '../../src/application/permissions/permission.types.ts';
import type { Logger } from '../../src/shared/logger.ts';
import type { Plan } from '../../src/domain/orchestration/plan.ts';
import type { StepResult } from '../../src/domain/orchestration/step-result.ts';
import type { ToolOutcome } from '../../src/domain/tools/tool-call.ts';

// ─── Logger ───────────────────────────────────────────────────────────────────

export const noopLogger: Logger = {
  info:  () => {},
  warn:  () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
};

// ─── StatusChannel ────────────────────────────────────────────────────────────

export const noopStatus: SpecialistInput['statusChannel'] = {
  sendStatus: async () => null,
  editStatus: async () => null,
};

// ─── Permissions ──────────────────────────────────────────────────────────────

export function makePermissionResult(toolIds: string[]): PermissionResult {
  return {
    allowedToolIds:       new Set(toolIds.map(asToolId)) as any,
    allowedActionsByTool: new Map() as any,
    decisions:            [],
  };
}

// ─── Tools ────────────────────────────────────────────────────────────────────

/**
 * Build a minimal Tool stub that always succeeds.
 * The tool's `id` is the key for filtering tests.
 */
export function makeTool(id: string): Tool<{ input: string }, string> {
  return {
    id:           asToolId(id),
    family:       'larkTask' as any,
    actionGroups: new Set(['read']) as any,
    argsSchema:   z.object({ input: z.string() }),
    resultSchema: z.string(),
    description:  `Mock tool: ${id}`,

    permissionCheck(): any { return ok('read' as any); },
    execute: async () => ok('done'),
  };
}

// ─── Plans ────────────────────────────────────────────────────────────────────

export function makePlan(toolIds: string[], stepId = 'step-001'): Plan {
  return {
    planId: 'plan-mock',
    intent: 'Mock intent',
    steps: [
      {
        stepId,
        agentId:   'mock-agent',
        objective: 'Mock objective',
        toolIds,
        dependsOn: [],
        wave:      0,
      },
    ],
  };
}

// ─── Planner mock ─────────────────────────────────────────────────────────────

/**
 * Returns a Planner-shaped object whose plan() always returns the given Plan.
 * Cast to Planner with `as unknown as Planner`.
 *
 * Also records which tools were passed to it (for filter-assertion tests).
 */
export function mockPlanner(plan: Plan, onCalled?: (toolIds: string[]) => void): Planner {
  return {
    plan: async (input) => {
      onCalled?.(input.availableTools.map(t => t.id as string));
      return ok(plan);
    },
  } as unknown as Planner;
}

export function failingPlanner(reason = 'llm_invalid_output'): Planner {
  return {
    plan: async () =>
      err(new OrchestrationError({ stage: 'plan', reason: reason as any, message: 'Planner mock failure' })),
  } as unknown as Planner;
}

// ─── Executor mock ────────────────────────────────────────────────────────────

export interface MockExecutorOpts {
  stepStatus:  StepResult['status'];
  toolStatus?: ToolOutcome['status'];
  toolId?:     string;
}

export function mockExecutor(opts: MockExecutorOpts): Executor {
  const { stepStatus, toolStatus = 'success', toolId = 'larkTask' } = opts;

  const outcome: ToolOutcome = {
    toolId:     asToolId(toolId),
    action:     'read' as any,
    status:     toolStatus,
    data:       { result: 'ok' },
    durationMs: 10,
  };

  const step: StepResult = {
    stepId:       'step-001',
    agentId:      'mock-agent',
    status:       stepStatus,
    toolOutcomes: [outcome],
    durationMs:   15,
  };

  const output: ExecutorOutput = {
    stepResults:     [step],
    allToolOutcomes: [outcome],
    pendingApproval: null,
  };

  return {
    run: async () => ok(output),
  } as unknown as Executor;
}

export function failingExecutor(): Executor {
  return {
    run: async () =>
      err(new OrchestrationError({ stage: 'execute', reason: 'step_failed', message: 'Executor mock failure' })),
  } as unknown as Executor;
}

// ─── SpecialistInput ──────────────────────────────────────────────────────────

/**
 * Build a minimal SpecialistInput with the given set of permitted tools.
 */
export function makeSpecialistInput(toolIds: string[]): SpecialistInput {
  return {
    userMessage:    'Test message',
    history:        { turns: [], truncated: false, tokenEstimate: 0 },
    agentDef:       null,
    permittedTools: toolIds.map(makeTool),
    perm:           makePermissionResult(toolIds),
    runContext: {
      companyId:   'co1' as any,
      userId:      'usr1' as any,
      companyRole: 'MEMBER' as any,
      channel:     'lark',
    },
    statusChannel: noopStatus,
  };
}
