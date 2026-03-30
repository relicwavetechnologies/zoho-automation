export * from './types';
export * from './agent-registry';
export * from './handoff-context';
export * from './planner';
export * from './executor';
export * from './synthesis';

import type { QueryEnrichment } from '../query-enrichment.service';
import { resolveVercelLanguageModel } from '../vercel/model-factory';
import {
  buildSupervisorAgentCatalog,
  resolveSupervisorAgentToolIds,
  resolveSupervisorEligibleAgents,
  SUPERVISOR_AGENT_TOOL_IDS,
} from './agent-registry';
import { executeSupervisorPlan as runPlanExecutor } from './executor';
import { planSupervisorDelegation as basePlanSupervisorDelegation } from './planner';
import { chooseSupervisorPassThroughText, synthesizeSupervisorResult } from './synthesis';
import type {
  DelegatedAgentExecutionResult,
  DelegatedStepResult,
  SupervisorAgentId,
  SupervisorPlan,
  SupervisorStep,
} from './types';

export { SUPERVISOR_AGENT_TOOL_IDS };

export const deriveEligibleSupervisorAgents = (input: {
  allowedToolIds: string[];
  runExposedToolIds?: string[];
  plannerChosenOperationClass?: string | null;
  latestUserMessage?: string;
}): SupervisorAgentId[] =>
  resolveSupervisorEligibleAgents({
    runtime: {
      allowedToolIds: input.allowedToolIds,
      runExposedToolIds: input.runExposedToolIds,
      plannerChosenOperationClass: input.plannerChosenOperationClass ?? undefined,
      workspace: undefined,
    },
    latestUserMessage: input.latestUserMessage ?? '',
  }).eligibleAgents.map((agent) => agent.id);

export const inferEligibleSupervisorAgentIds = (allowedToolIds: string[]): SupervisorAgentId[] =>
  buildSupervisorAgentCatalog({ allowedToolIds }).map((agent) => agent.id);

export const runSupervisorPlan = async (input: {
  mode: 'fast' | 'high';
  latestUserMessage: string;
  systemPrompt: string;
  eligibleAgentIds: SupervisorAgentId[];
  plannerChosenOperationClass?: string | null;
  selectionReason?: string | null;
  contextSummary?: string[];
}): Promise<SupervisorPlan> => {
  const resolvedModel = await resolveVercelLanguageModel(input.mode);
  const eligibleAgents = buildSupervisorAgentCatalog({
    allowedToolIds: Object.values(SUPERVISOR_AGENT_TOOL_IDS).flat(),
  }).filter((agent) => input.eligibleAgentIds.includes(agent.id));
  return basePlanSupervisorDelegation({
    model: resolvedModel.model,
    providerOptions: {
      google: {
        thinkingConfig: {
          includeThoughts: false,
          thinkingLevel: resolvedModel.thinkingLevel,
        },
      },
    },
    systemPrompt: input.systemPrompt,
    latestUserMessage: input.latestUserMessage,
    eligibleAgents,
    preferredAgentIds: input.eligibleAgentIds,
    queryEnrichment: input.contextSummary?.length
      ? {
          cleanQuery: input.latestUserMessage,
          retrievalQuery: input.latestUserMessage,
          contextHints: input.contextSummary.slice(0, 6),
        }
      : undefined,
  });
};

export const planSupervisorDelegation = async (
  input:
    | {
        model: any;
        providerOptions?: Record<string, unknown>;
        systemPrompt: string;
        latestUserMessage: string;
        eligibleAgents: ReturnType<typeof buildSupervisorAgentCatalog>;
        preferredAgentIds: string[];
        childRouteHints?: Record<string, unknown> | null;
        queryEnrichment?: QueryEnrichment;
        recentTaskSummaries?: Array<{
          taskId: string;
          summary: string;
          completedAt: string;
          resolvedIds?: Record<string, string>;
        }>;
        threadSummary?: string;
        supervisorProgress?: {
          runId: string;
          completedSteps: Array<{
            stepId: string;
            agentId: string;
            objective: string;
            summary: string;
            resolvedIds: Record<string, string>;
            completedAt: string;
            success: boolean;
          }>;
          resolvedIds: Record<string, string>;
          isPartial?: boolean;
          interruptedAt?: string;
        } | null;
      }
    | {
        mode: 'fast' | 'high';
        latestUserMessage: string;
        eligibleAgentIds: SupervisorAgentId[];
        childRouteHints?: Record<string, unknown> | null;
        toolSelectionReason?: string | null;
        inferredDomain?: string | null;
        inferredOperationClass?: string | null;
        abortSignal?: AbortSignal;
        recentTaskSummaries?: Array<{
          taskId: string;
          summary: string;
          completedAt: string;
          resolvedIds?: Record<string, string>;
        }>;
        threadSummary?: string;
        supervisorProgress?: {
          runId: string;
          completedSteps: Array<{
            stepId: string;
            agentId: string;
            objective: string;
            summary: string;
            resolvedIds: Record<string, string>;
            completedAt: string;
            success: boolean;
          }>;
          resolvedIds: Record<string, string>;
          isPartial?: boolean;
          interruptedAt?: string;
        } | null;
      },
): Promise<SupervisorPlan> => {
  if ('model' in input) {
    return basePlanSupervisorDelegation(input);
  }
  const resolvedModel = await resolveVercelLanguageModel(input.mode);
  const eligibleAgents = buildSupervisorAgentCatalog({
    allowedToolIds: Object.values(SUPERVISOR_AGENT_TOOL_IDS).flat(),
  }).filter((agent) => input.eligibleAgentIds.includes(agent.id));
  return basePlanSupervisorDelegation({
    model: resolvedModel.model,
    providerOptions: {
      google: {
        thinkingConfig: {
          includeThoughts: false,
          thinkingLevel: resolvedModel.thinkingLevel,
        },
      },
    },
    systemPrompt: [
      'You are acting as the supervisor planner.',
      input.toolSelectionReason ? `Tool-selection reason: ${input.toolSelectionReason}` : '',
      input.inferredDomain ? `Inferred domain: ${input.inferredDomain}` : '',
      input.inferredOperationClass ? `Inferred operation class: ${input.inferredOperationClass}` : '',
    ].filter(Boolean).join('\n'),
    latestUserMessage: input.latestUserMessage,
    eligibleAgents,
    preferredAgentIds: input.eligibleAgentIds,
    childRouteHints: input.childRouteHints ?? undefined,
    recentTaskSummaries: input.recentTaskSummaries,
    threadSummary: input.threadSummary,
    supervisorProgress: input.supervisorProgress,
  });
};

export const executeSupervisorPlan = async <TTaskState>(input: {
  plan: SupervisorPlan;
  originalUserMessage: string;
  initialTaskState: TTaskState;
  buildScopedContext: (step: SupervisorStep) => string[];
  executeStep: (input: {
    step: SupervisorStep;
    taskState: TTaskState;
    scopedContext: string[];
    dependencyInputs: Array<{
      stepId: string;
      agentId: string;
      summary: string;
      data?: Record<string, unknown>;
    }>;
  }) => Promise<DelegatedAgentExecutionResult<TTaskState>>;
  mergeTaskState: (
    currentState: TTaskState,
    result: DelegatedAgentExecutionResult<TTaskState>,
  ) => TTaskState;
  onWaveStart?: (wave: { index: number; readyStepIds: string[] }) => Promise<void> | void;
  onStepStart?: (step: SupervisorStep) => Promise<void> | void;
  onStepComplete?: (result: DelegatedAgentExecutionResult<TTaskState>) => Promise<void> | void;
}): Promise<{
  results: DelegatedAgentExecutionResult<TTaskState>[];
  finalTaskState: TTaskState;
  waveCount: number;
}> => {
  let currentTaskState = input.initialTaskState;
  const byStepId = new Map<string, DelegatedAgentExecutionResult<TTaskState>>();
  const execution = await runPlanExecutor({
    steps: input.plan.steps,
    onWaveStart: async (wave, index) => {
      await input.onWaveStart?.({
        index,
        readyStepIds: wave.map((step) => step.stepId),
      });
    },
    onWaveComplete: async (results) => {
      for (const result of results) {
        const delegated = byStepId.get(result.stepId);
        if (delegated) {
          currentTaskState = input.mergeTaskState(currentTaskState, delegated);
        }
      }
    },
    executeStep: async (step): Promise<DelegatedStepResult> => {
      await input.onStepStart?.(step);
      const dependencyInputs = step.inputRefs
        .map((ref) => byStepId.get(ref))
        .filter((value): value is DelegatedAgentExecutionResult<TTaskState> => Boolean(value))
        .map((result) => ({
          stepId: result.stepId,
          agentId: result.agentId,
          summary: result.summary,
          data: result.data,
        }));
      const delegated = await input.executeStep({
        step,
        taskState: currentTaskState,
        scopedContext: input.buildScopedContext(step),
        dependencyInputs,
      });
      byStepId.set(step.stepId, delegated);
      await input.onStepComplete?.(delegated);
      return {
        stepId: delegated.stepId,
        agentId: delegated.agentId,
        status:
          delegated.pendingApproval ? 'approval_required'
          : delegated.blockingUserInput ? 'blocked'
          : delegated.status === 'failed' ? 'failed' : 'success',
        summary: delegated.summary,
        finalText: delegated.assistantText,
        toolEnvelopes: [],
        pendingApprovalAction: delegated.pendingApproval ?? undefined,
        blockingReason:
          (delegated.blockingUserInput as { summary?: string; userAction?: string } | undefined)?.summary
          ?? (delegated.blockingUserInput as { userAction?: string } | undefined)?.userAction
          ?? null,
        sourceRefs: delegated.sourceRefs,
      };
    },
  });

  return {
    results: execution.stepResults
      .map((entry) => byStepId.get(entry.stepId))
      .filter((value): value is DelegatedAgentExecutionResult<TTaskState> => Boolean(value)),
    finalTaskState: currentTaskState,
    waveCount: execution.waveCount,
  };
};

export const executeSupervisorDag = async (input: {
  steps: SupervisorStep[];
  runStep: (
    step: SupervisorStep,
    upstreamResults: DelegatedAgentExecutionResult[],
  ) => Promise<DelegatedAgentExecutionResult>;
}): Promise<{
  orderedResults: DelegatedAgentExecutionResult[];
  waveCount: number;
}> => {
  const orderedResults: DelegatedAgentExecutionResult[] = [];
  const execution = await runPlanExecutor({
    steps: input.steps,
    executeStep: async (step): Promise<DelegatedStepResult> => {
      const upstreamResults = step.inputRefs
        .map((ref) => orderedResults.find((result) => result.stepId === ref))
        .filter((value): value is DelegatedAgentExecutionResult => Boolean(value));
      const delegated = await input.runStep(step, upstreamResults);
      orderedResults.push(delegated);
      return {
        stepId: delegated.stepId,
        agentId: delegated.agentId,
        status:
          delegated.pendingApproval ? 'approval_required'
          : delegated.blockingUserInput ? 'blocked'
          : delegated.status === 'failed' ? 'failed' : 'success',
        summary: delegated.summary,
        finalText: delegated.assistantText ?? delegated.text ?? '',
        toolEnvelopes: [],
      };
    },
  });
  return {
    orderedResults,
    waveCount: execution.waveCount,
  };
};

export const runSupervisorSynthesis = async (input: {
  mode: 'fast' | 'high';
  systemPrompt: string;
  latestUserMessage: string;
  agentResults: DelegatedAgentExecutionResult[];
}): Promise<string> => {
  const resolvedModel = await resolveVercelLanguageModel(input.mode);
  return synthesizeSupervisorResult({
    model: resolvedModel.model,
    providerOptions: {
      google: {
        thinkingConfig: {
          includeThoughts: false,
          thinkingLevel: resolvedModel.thinkingLevel,
        },
      },
    },
    systemPrompt: input.systemPrompt,
    latestUserMessage: input.latestUserMessage,
    plan: {
      complexity: input.agentResults.length <= 1 ? 'single' : 'multi',
      steps: input.agentResults.map((result) => ({
        stepId: result.stepId,
        agentId: result.agentId,
        objective: result.objective,
        dependsOn: [],
        inputRefs: [],
      })),
    },
    stepResults: input.agentResults.map((result) => ({
      stepId: result.stepId,
      agentId: result.agentId,
      status:
        result.pendingApproval ? 'approval_required'
        : result.blockingUserInput ? 'blocked'
        : result.status === 'failed' ? 'failed' : 'success',
      summary: result.summary,
      finalText: result.assistantText ?? result.text ?? '',
      toolEnvelopes: [],
      sourceRefs: result.sourceRefs,
    })),
  });
};

export const synthesizeSupervisorOutcome = async (input: {
  mode: 'fast' | 'high';
  systemPrompt: string;
  latestUserMessage: string;
  results: DelegatedAgentExecutionResult[];
  abortSignal?: AbortSignal;
}): Promise<string> =>
  runSupervisorSynthesis({
    mode: input.mode,
    systemPrompt: input.systemPrompt,
    latestUserMessage: input.latestUserMessage,
    agentResults: input.results,
  });

export const getSupervisorAgentToolIds = (
  agentId: SupervisorAgentId,
  allowedToolIds: string[],
): string[] => resolveSupervisorAgentToolIds({ agentId, allowedToolIds });

export { chooseSupervisorPassThroughText };
