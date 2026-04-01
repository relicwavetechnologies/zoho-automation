import { generateObject } from 'ai';

import type { QueryEnrichment } from '../query-enrichment.service';
import type { SearchIntent } from '../search-intent-classifier';
import type {
  SupervisorAgentDescriptor,
  SupervisorAgentId,
  SupervisorPlan,
  SupervisorStep,
  SupervisorStepObjective,
} from './types';
import { supervisorPlanSchema } from './types';

const buildPlannerPrompt = (input: {
  latestUserMessage: string;
  eligibleAgents: SupervisorAgentDescriptor[];
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
}): string => {
  const agentCatalog = input.eligibleAgents.map((agent) => ({
    agentId: agent.id,
    label: agent.label,
    description: agent.description,
    toolIds: agent.toolIds,
  }));
  return JSON.stringify({
    instructions: [
      'You are the supervisor planner. Your only job is to produce a valid orchestration plan.',
      'ROUTING RULES — apply these in order, top to bottom, stop at first match:',
      '1. LARK requests (tasks, calendar, meetings, approvals, docs, messages, Lark Base): use lark-ops-agent',
      '2. FINANCIAL requests (invoices, bills, payments, overdue, balance, Zoho Books): use zoho-ops-agent',
      '3. CRM requests (contacts, leads, accounts, deals, Zoho CRM): use zoho-ops-agent',
      '4. EMAIL requests (send email, draft, reply, search inbox, Gmail): use google-workspace-agent',
      '5. DRIVE / GOOGLE CALENDAR requests: use google-workspace-agent',
      '6. FILE / DOCUMENT / CODE / OCR requests where source is a local file or repo: use workspace-agent',
      '7. CROSS-SOURCE or UNCLEAR requests (history recall, "what did we discuss", internal knowledge, no clear system of record): use context-agent',
      '8. If none of the above match clearly: use context-agent as safe fallback',
      'For multi-step plans: only split into multiple steps when the second step genuinely depends on output from the first. Do not split a single-source lookup into two steps.',
      'Do not route to context-agent first and then domain agent second unless context-agent must resolve an entity ID that the domain agent cannot find on its own.',
      'Keep objectives concrete and executable. If recentTaskSummaries contains resolved IDs (invoiceId, email, name), embed them verbatim in the objective. Never write vague objectives like "send invoice to anish" when you have invoiceId=INV21271 and email=anish@example.com.',
      'Choose direct when no tool work is needed and you can answer from context alone.',
      'Choose single when one agent can complete the full task.',
      'Choose multi only when steps have genuine dependencies.',
      'Never assign tools directly. Only assign agentId.',
      input.supervisorProgress && input.supervisorProgress.completedSteps.length > 0
        ? `PRIOR EXECUTION: These steps already completed — do NOT re-delegate them:\n${input.supervisorProgress.completedSteps.map((s) => `- ${s.stepId} (${s.agentId}): ${s.objective} -> ${s.summary}`).join('\n')}\nResolved: ${Object.entries(input.supervisorProgress.resolvedIds).map(([k, v]) => `${k}=${v}`).join(', ')}\n${input.supervisorProgress.isPartial ? 'Run was interrupted — continue from here.' : 'Run completed — use resolved values above.'}`
        : null,
      input.threadSummary
        ? 'threadSummary contains what has already been resolved in this conversation. Read it before planning.'
        : null,
    ].filter(Boolean),
    latestUserMessage: input.latestUserMessage,
    preferredAgentIds: input.preferredAgentIds,
    eligibleAgents: agentCatalog,
    childRouteHints: input.childRouteHints ?? null,
    queryEnrichment: input.queryEnrichment ?? null,
    recentTaskSummaries: input.recentTaskSummaries?.length
      ? input.recentTaskSummaries.slice(0, 3).map((taskSummary) => ({
          summary: taskSummary.summary,
          completedAt: taskSummary.completedAt,
          resolvedIds: taskSummary.resolvedIds ?? {},
        }))
      : null,
    threadSummary: input.threadSummary ?? null,
    supervisorProgress: input.supervisorProgress
      ? {
        runId: input.supervisorProgress.runId,
        completedSteps: input.supervisorProgress.completedSteps.slice(0, 8).map((step) => ({
          stepId: step.stepId,
          agentId: step.agentId,
          objective: step.objective,
          summary: step.summary,
          resolvedIds: step.resolvedIds ?? {},
          completedAt: step.completedAt,
          success: step.success,
        })),
        resolvedIds: input.supervisorProgress.resolvedIds ?? {},
        isPartial: input.supervisorProgress.isPartial ?? false,
        interruptedAt: input.supervisorProgress.interruptedAt ?? null,
      }
      : null,
  });
};

const buildFallbackPlan = (input: {
  latestUserMessage: string;
  preferredAgentIds: string[];
  eligibleAgents: SupervisorAgentDescriptor[];
  recentTaskSummaries?: Array<{
    summary: string;
    resolvedIds?: Record<string, string>;
  }>;
  supervisorProgress?: {
    resolvedIds: Record<string, string>;
  } | null;
}): SupervisorPlan => {
  const defaultAgent = (input.preferredAgentIds[0] ?? input.eligibleAgents[0]?.id ?? 'context-agent') as SupervisorAgentId;
  const resolvedSource = input.supervisorProgress?.resolvedIds && Object.keys(input.supervisorProgress.resolvedIds).length > 0
    ? input.supervisorProgress.resolvedIds
    : input.recentTaskSummaries?.[0]?.resolvedIds;
  const resolvedContext = resolvedSource && Object.keys(resolvedSource).length > 0
    ? ` Context from prior step: ${Object.entries(resolvedSource)
      .map(([key, value]) => `${key}=${value}`)
      .join(', ')}.`
    : '';
  return {
    complexity: 'single',
    steps: [
      {
        stepId: 'step_1',
        agentId: defaultAgent,
        objective: input.latestUserMessage + resolvedContext,
        dependsOn: [],
        inputRefs: [],
      },
    ],
  };
};

const constrainPlanToEligibleAgents = (input: {
  plan: SupervisorPlan;
  eligibleAgents: SupervisorAgentDescriptor[];
  preferredAgentIds: string[];
  latestUserMessage: string;
  recentTaskSummaries?: Array<{
    summary: string;
    resolvedIds?: Record<string, string>;
  }>;
  supervisorProgress?: {
    resolvedIds: Record<string, string>;
  } | null;
}): SupervisorPlan => {
  const eligibleAgentIds = new Set(input.eligibleAgents.map((agent) => agent.id));
  if (input.plan.complexity === 'direct') {
    return input.plan;
  }
  const hasInvalidStep = input.plan.steps.some((step) => !eligibleAgentIds.has(step.agentId));
  if (!hasInvalidStep) {
    return input.plan;
  }
  return buildFallbackPlan({
    latestUserMessage: input.latestUserMessage,
    preferredAgentIds: input.preferredAgentIds,
    eligibleAgents: input.eligibleAgents,
    recentTaskSummaries: input.recentTaskSummaries,
    supervisorProgress: input.supervisorProgress,
  });
};

const inferActionFromObjective = (objective: string): SupervisorStepObjective['action'] => {
  const lower = objective.toLowerCase();
  if (/search|find|look|retrieve|get/.test(lower)) return 'search';
  if (/send|email|message|notify/.test(lower)) return 'send';
  if (/write|create|update|add/.test(lower)) return 'write';
  if (/summarize|synthesize|compile/.test(lower)) return 'synthesize';
  return 'read';
};

const enrichStepObjective = (
  step: SupervisorStep,
  intent?: SearchIntent | null,
): SupervisorStep => {
  if (!intent) {
    return {
      ...step,
      structuredObjective: {
        action: inferActionFromObjective(step.objective),
        naturalLanguage: step.objective,
      },
    };
  }

  return {
    ...step,
    structuredObjective: {
      action: inferActionFromObjective(step.objective),
      targetEntity: intent.extractedEntity ?? undefined,
      targetEntityType:
        intent.extractedEntityType === 'unknown' || intent.extractedEntityType == null
          ? undefined
          : intent.extractedEntityType,
      targetSource:
        intent.sourceHint === 'books'
        || intent.sourceHint === 'crm'
        || intent.sourceHint === 'files'
        || intent.sourceHint === 'lark'
        || intent.sourceHint === 'web'
          ? intent.sourceHint
          : undefined,
      dateRange: intent.dateRange ?? undefined,
      authorityRequired: intent.queryType === 'company_entity' || intent.queryType === 'financial_record',
      naturalLanguage: step.objective,
    },
  };
};

export const planSupervisorDelegation = async (input: {
  model: any;
  providerOptions?: Record<string, unknown>;
  systemPrompt: string;
  latestUserMessage: string;
  eligibleAgents: SupervisorAgentDescriptor[];
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
  searchIntent?: SearchIntent;
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
}): Promise<SupervisorPlan> => {
  try {
    const result = await generateObject({
      model: input.model,
      schema: supervisorPlanSchema,
      maxOutputTokens: 1024,
      system: [
        input.systemPrompt,
        'You are the top-level multi-agent supervisor planner.',
        'Return only a valid orchestration plan object.',
      ].join('\n\n'),
      prompt: buildPlannerPrompt({
        latestUserMessage: input.latestUserMessage,
        eligibleAgents: input.eligibleAgents,
        preferredAgentIds: input.preferredAgentIds,
        childRouteHints: input.childRouteHints,
        queryEnrichment: input.queryEnrichment,
        recentTaskSummaries: input.recentTaskSummaries,
        threadSummary: input.threadSummary,
        supervisorProgress: input.supervisorProgress,
      }),
      temperature: 0,
      providerOptions: input.providerOptions,
    });

    if (result.object.complexity === 'direct') {
      return {
        complexity: 'direct',
        directAnswer: result.object.directAnswer?.trim() || 'Done.',
        steps: [],
      };
    }
    if (result.object.steps.length === 0) {
      return buildFallbackPlan({
        latestUserMessage: input.latestUserMessage,
        preferredAgentIds: input.preferredAgentIds,
        eligibleAgents: input.eligibleAgents,
        recentTaskSummaries: input.recentTaskSummaries,
        supervisorProgress: input.supervisorProgress,
      });
    }
    const constrainedPlan = constrainPlanToEligibleAgents({
      plan: result.object,
      eligibleAgents: input.eligibleAgents,
      preferredAgentIds: input.preferredAgentIds,
      latestUserMessage: input.latestUserMessage,
      recentTaskSummaries: input.recentTaskSummaries,
      supervisorProgress: input.supervisorProgress,
    });
    return {
      ...constrainedPlan,
      steps: constrainedPlan.steps.map((step) => enrichStepObjective(step, input.searchIntent)),
    };
  } catch {
    const fallback = buildFallbackPlan({
      latestUserMessage: input.latestUserMessage,
      preferredAgentIds: input.preferredAgentIds,
      eligibleAgents: input.eligibleAgents,
      recentTaskSummaries: input.recentTaskSummaries,
      supervisorProgress: input.supervisorProgress,
    });
    return {
      ...fallback,
      steps: fallback.steps.map((step) => enrichStepObjective(step, input.searchIntent)),
    };
  }
};

export { enrichStepObjective, inferActionFromObjective };
