import { generateObject } from 'ai';

import type { QueryEnrichment } from '../query-enrichment.service';
import type { SupervisorAgentDescriptor, SupervisorAgentId, SupervisorPlan } from './types';
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
}): string => {
  const agentCatalog = input.eligibleAgents.map((agent) => ({
    agentId: agent.id,
    label: agent.label,
    description: agent.description,
    toolIds: agent.toolIds,
  }));
  return JSON.stringify({
    instructions: [
      'You are the supervisor planner.',
      'Choose direct when no delegated tool work is needed.',
      'Choose single when one agent can complete the task alone.',
      'Choose multi when the task must be decomposed across agents or dependency steps.',
      'Never choose tools directly. You may only choose agents.',
      'For dependent work, use dependsOn and inputRefs.',
      'Keep objectives concrete and executable.',
      'If recentTaskSummaries is present, read it before writing objectives. It contains resolved entities from prior steps in this session — invoice IDs, emails, names, amounts. Embed these values explicitly and verbatim into your delegation objectives. Never write a vague objective like "send invoice to anish" when you have invoiceId=INV21271 and email=anishsuman2305@gmail.com available. Write "Send invoice INV21271 to anishsuman2305@gmail.com" instead. The sub-agent only receives what you write in the objective — it cannot guess what you left out.',
      'If threadSummary is present, use it to understand what has already been resolved in this conversation before deciding how to delegate.',
    ],
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
}): SupervisorPlan => {
  const defaultAgent = (input.preferredAgentIds[0] ?? input.eligibleAgents[0]?.id ?? 'context-agent') as SupervisorAgentId;
  const latestSummary = input.recentTaskSummaries?.[0];
  const resolvedContext = latestSummary?.resolvedIds
    && Object.keys(latestSummary.resolvedIds).length > 0
    ? ` Context from prior step: ${Object.entries(latestSummary.resolvedIds)
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
}): Promise<SupervisorPlan> => {
  try {
    const result = await generateObject({
      model: input.model,
      schema: supervisorPlanSchema,
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
      });
    }
    return result.object;
  } catch {
    return buildFallbackPlan({
      latestUserMessage: input.latestUserMessage,
      preferredAgentIds: input.preferredAgentIds,
      eligibleAgents: input.eligibleAgents,
      recentTaskSummaries: input.recentTaskSummaries,
    });
  }
};
