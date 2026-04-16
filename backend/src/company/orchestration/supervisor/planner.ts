import type { QueryEnrichment } from '../query-enrichment.service';
import type { SearchIntent } from '../search-intent-classifier';
import config from '../../../config';
import { logger } from '../../../utils/logger';
import { withProviderRetry } from '../../../utils/provider-retry';
import type {
  SupervisorAgentDescriptor,
  SupervisorAgentId,
  SupervisorPlan,
  SupervisorSourceSystem,
  SupervisorStep,
  SupervisorStepObjective,
} from './types';
import { supervisorPlanSchema } from './types';

const SUPERVISOR_PLANNER_TIMEOUT_MS = 4_500;

const extractFirstJsonObject = (text: string): string | null => {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return trimmed.slice(start, end + 1);
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;

const asStringArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value
    .map((entry) => asString(entry))
    .filter((entry): entry is string => Boolean(entry));
  return normalized;
};

const normalizeSupervisorStepPayload = (
  value: unknown,
  index: number,
): Record<string, unknown> | null => {
  const step = asRecord(value);
  if (!step) {
    return null;
  }
  const structured = asRecord(step.structuredObjective);
  const stepId = asString(step.stepId) ?? `step_${index + 1}`;
  const agentId =
    asString(step.agentId)
    ?? asString(step.agent)
    ?? asString(step.ownerAgent)
    ?? asString(step.owner);
  const action = asString(step.action) ?? asString(structured?.action);
  const sourceSystem =
    asString(step.sourceSystem)
    ?? asString(step.source)
    ?? asString(structured?.sourceSystem);
  const objective =
    asString(step.objective)
    ?? asString(step.naturalLanguage)
    ?? asString(step.summary)
    ?? asString(structured?.naturalLanguage);

  if (!agentId || !action || !sourceSystem || !objective) {
    return null;
  }

  return {
    ...step,
    stepId,
    agentId,
    action,
    sourceSystem,
    objective,
    dependsOn: asStringArray(step.dependsOn) ?? [],
    inputRefs: asStringArray(step.inputRefs) ?? [],
  };
};

const unwrapSupervisorPlanPayload = (value: unknown): unknown => {
  let current = value;
  for (;;) {
    const record = asRecord(current);
    if (!record) {
      return current;
    }
    if (asRecord(record.plan)) {
      current = record.plan;
      continue;
    }
    if (asRecord(record.result)) {
      current = record.result;
      continue;
    }
    if (asRecord(record.workflow)) {
      current = record.workflow;
      continue;
    }
    if (asRecord(record.output)) {
      current = record.output;
      continue;
    }
    return current;
  }
};

const normalizeSupervisorPlanPayload = (value: unknown): unknown => {
  const unwrapped = unwrapSupervisorPlanPayload(value);
  const record = asRecord(unwrapped);
  if (!record) {
    return value;
  }

  const rawSteps =
    (Array.isArray(record.steps) ? record.steps : undefined)
    ?? (Array.isArray(record.planSteps) ? record.planSteps : undefined)
    ?? (Array.isArray(record.workflowSteps) ? record.workflowSteps : undefined);
  const normalizedSteps = rawSteps
    ?.map((step, index) => normalizeSupervisorStepPayload(step, index))
    .filter((step): step is Record<string, unknown> => Boolean(step));
  const directAnswer =
    asString(record.directAnswer)
    ?? asString(record.answer)
    ?? asString(record.finalAnswer);
  const complexity =
    asString(record.complexity)
    ?? (directAnswer && !normalizedSteps ? 'direct' : undefined)
    ?? (normalizedSteps ? (normalizedSteps.length > 1 ? 'multi' : 'single') : undefined);

  return {
    ...record,
    ...(complexity ? { complexity } : {}),
    steps: normalizedSteps ?? (complexity === 'direct' ? [] : record.steps),
    ...(directAnswer ? { directAnswer } : {}),
  };
};

const buildPlannerPrompt = (input: {
  latestUserMessage: string;
  eligibleAgents: SupervisorAgentDescriptor[];
  preferredAgentIds: string[];
  childRouteHints?: Record<string, unknown> | null;
  queryEnrichment?: QueryEnrichment;
  inferredDomain?: string | null;
  inferredOperationClass?: string | null;
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
      'You are the supervisor planner. You are the only workflow planner in the system.',
      'Return one valid orchestration plan object in JSON.',
      'Every non-direct step must include: stepId, agentId, action, sourceSystem, objective, dependsOn, inputRefs.',
      'Do not assume any later layer will reinterpret objective text. Your action and sourceSystem fields are final.',
      'ROUTING RULES — apply these in order, top to bottom:',
      '1. LARK requests (tasks, calendar, meetings, approvals, docs, messages, Lark Base): use lark-ops-agent with sourceSystem=lark.',
      '2. FINANCIAL requests (invoices, bills, payments, overdue, balance, Zoho Books): use zoho-ops-agent with sourceSystem=zoho_books.',
      '3. CRM requests (contacts, leads, accounts, deals, Zoho CRM): use zoho-ops-agent with sourceSystem=zoho_crm.',
      '4. EMAIL requests (send email, draft, reply, search inbox, Gmail): use google-workspace-agent with sourceSystem=gmail.',
      '5. DRIVE / GOOGLE CALENDAR requests: use google-workspace-agent with sourceSystem=google_drive or google_calendar.',
      '6. FILE / DOCUMENT / CODE / OCR requests where source is a local file or repo: use workspace-agent with sourceSystem=workspace.',
      '7. CROSS-SOURCE or UNCLEAR requests (history recall, "what did we discuss", internal knowledge, no clear system of record): use context-agent with action=cross_source_lookup and sourceSystem=context.',
      '8. If a clear system of record exists, do not use context-agent for the primary retrieval step.',
      '9. If a request reads from one system and then writes in another, always create multiple dependent steps.',
      '10. Do not collapse "read overdue invoices from Books and create Lark tasks" into one step.',
      '11. Preserve explicit people, assignees, recipients, and owners exactly as named by the user. Do not generalize a named person into a team or department.',
      'RETRIEVAL RULES:',
      'R1. If the user asks about any past conversation, decision, draft, file, person, invoice, company, or internal record — ALWAYS create a context-agent step FIRST before any action step. No exceptions.',
      'R2. If you are uncertain whether a fact exists in our systems — do not guess. Create a context-agent step.',
      'R3. When delegating to context-agent, write a detailed objective that includes: the specific entity or topic (name, ID, type), entities already resolved this session (IDs, emails, accountIds), what prior steps already found (avoid re-searching), implied date range if inferable from thread, language hint if user wrote Hindi or mixed Hindi/English, and exactly what the next step needs from this search result.',
      'R4. context-agent results include provenance tags (from:files, from:history, from:zoho etc). Pass these verbatim into the next step\'s inputRefs.',
      'R5. If context-agent returns empty — do not fill gaps with inference. Tell the user plainly.',
      'BAD objective example (never write this): "find invoice from Human AI LLC"',
      'GOOD objective example (always write this): "Find invoices from Human AI LLC in Zoho Books. Session context: user asking about overdue payments. Resolved entity: Human AI LLC (confirmed company). Implied date range: last 90 days. Language: mixed Hindi/English. Next step needs: invoice IDs, amounts, due dates for Lark task creation."',
      'Action choices:',
      '- read_records: domain-owned read/report/list inside a source-of-truth system',
      '- search_records: domain-owned lookup/fuzzy search inside a source-of-truth system',
      '- create_task: create a Lark task',
      '- send_email: send Gmail message',
      '- create_draft: create Gmail draft',
      '- post_message: send a Lark message/post',
      '- update_record: modify an existing domain record',
      '- cross_source_lookup: context-agent only',
      'Ownership constraints:',
      '- context-agent may only use action=cross_source_lookup and sourceSystem=context',
      '- zoho_books/zoho_crm must use zoho-ops-agent',
      '- lark must use lark-ops-agent',
      '- gmail/google_drive/google_calendar must use google-workspace-agent',
      'Examples:',
      '- "get overdue invoices from books and create lark tasks for Anish Suman" => step_1 zoho-ops-agent/read_records/zoho_books, step_2 lark-ops-agent/create_task/lark dependsOn step_1 and the second step objective must still name Anish Suman explicitly',
      '- "what did we discuss about overdue invoices last week" => one context-agent/cross_source_lookup/context step',
      'Choose direct only when no tool work is required.',
      'Choose single when one agent can fully complete the request.',
      'Choose multi when later steps depend on earlier step output.',
      input.supervisorProgress && input.supervisorProgress.completedSteps.length > 0
        ? `PRIOR EXECUTION: These steps already completed — do NOT re-delegate them:\n${input.supervisorProgress.completedSteps.map((s) => `- ${s.stepId} (${s.agentId}): ${s.objective} -> ${s.summary}`).join('\n')}\nResolved: ${Object.entries(input.supervisorProgress.resolvedIds).map(([k, v]) => `${k}=${v}`).join(', ')}`
        : null,
      input.threadSummary
        ? 'threadSummary contains what has already been resolved in this conversation.'
        : null,
    ].filter(Boolean),
    latestUserMessage: input.latestUserMessage,
    preferredAgentIds: input.preferredAgentIds,
    inferredDomain: input.inferredDomain ?? null,
    inferredOperationClass: input.inferredOperationClass ?? null,
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

const mapSourceSystemToTargetSource = (
  sourceSystem: SupervisorSourceSystem,
): SupervisorStepObjective['targetSource'] => {
  switch (sourceSystem) {
    case 'zoho_books':
      return 'books';
    case 'zoho_crm':
      return 'crm';
    case 'lark':
      return 'lark';
    case 'context':
      return 'files';
    default:
      return undefined;
  }
};

const buildStructuredObjectiveFromPlannedStep = (
  step: SupervisorStep,
  intent?: SearchIntent | null,
): SupervisorStepObjective => ({
  action: step.action,
  sourceSystem: step.sourceSystem,
  targetEntity: intent?.extractedEntity ?? undefined,
  targetEntityType:
    intent?.extractedEntityType === 'unknown' || intent?.extractedEntityType == null
      ? undefined
      : intent.extractedEntityType,
  targetSource: mapSourceSystemToTargetSource(step.sourceSystem),
  dateRange: intent?.dateRange ?? undefined,
  authorityRequired:
    step.sourceSystem === 'zoho_books'
    || step.sourceSystem === 'zoho_crm'
    || step.action === 'update_record',
  naturalLanguage: step.objective,
});

const buildStepWithCompatibilityObjective = (
  step: SupervisorStep,
  intent?: SearchIntent | null,
): SupervisorStep => ({
  ...step,
  structuredObjective: buildStructuredObjectiveFromPlannedStep(step, intent),
});

const defaultSourceSystemForAgent = (
  agentId: SupervisorAgentId,
  inferredDomain?: string | null,
): SupervisorSourceSystem => {
  if (agentId === 'zoho-ops-agent') {
    return inferredDomain === 'zoho_crm' ? 'zoho_crm' : 'zoho_books';
  }
  if (agentId === 'lark-ops-agent') return 'lark';
  if (agentId === 'google-workspace-agent') return 'gmail';
  if (agentId === 'workspace-agent') return 'workspace';
  return 'context';
};

const defaultActionForAgent = (
  agentId: SupervisorAgentId,
  inferredOperationClass?: string | null,
): SupervisorStepObjective['action'] => {
  if (agentId === 'context-agent') return 'cross_source_lookup';
  if (agentId === 'google-workspace-agent') {
    return inferredOperationClass === 'send' ? 'send_email' : 'create_draft';
  }
  if (agentId === 'lark-ops-agent') return 'create_task';
  if (agentId === 'zoho-ops-agent') {
    return inferredOperationClass === 'write' ? 'update_record' : 'read_records';
  }
  return 'search_records';
};

const buildFallbackPlan = (input: {
  latestUserMessage: string;
  preferredAgentIds: string[];
  eligibleAgents: SupervisorAgentDescriptor[];
  inferredDomain?: string | null;
  inferredOperationClass?: string | null;
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
        action: defaultActionForAgent(defaultAgent, input.inferredOperationClass),
        sourceSystem: defaultSourceSystemForAgent(defaultAgent, input.inferredDomain),
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
  inferredDomain?: string | null;
  inferredOperationClass?: string | null;
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
    inferredDomain: input.inferredDomain,
    inferredOperationClass: input.inferredOperationClass,
    recentTaskSummaries: input.recentTaskSummaries,
    supervisorProgress: input.supervisorProgress,
  });
};

const validateSupervisorPlan = (input: {
  plan: SupervisorPlan;
  eligibleAgents: SupervisorAgentDescriptor[];
}): string[] => {
  const eligibleAgentIds = new Set(input.eligibleAgents.map((agent) => agent.id));
  const issues: string[] = [];

  for (const step of input.plan.steps) {
    if (!eligibleAgentIds.has(step.agentId)) {
      issues.push(`step ${step.stepId}: ineligible agent ${step.agentId}`);
    }
    if (step.sourceSystem === 'context' && step.agentId !== 'context-agent') {
      issues.push(`step ${step.stepId}: sourceSystem=context must use context-agent`);
    }
    if (step.agentId === 'context-agent' && step.sourceSystem !== 'context') {
      issues.push(`step ${step.stepId}: context-agent may only own sourceSystem=context`);
    }
    if (step.agentId === 'context-agent' && step.action !== 'cross_source_lookup') {
      issues.push(`step ${step.stepId}: context-agent may only run cross_source_lookup`);
    }
    if ((step.sourceSystem === 'zoho_books' || step.sourceSystem === 'zoho_crm') && step.agentId !== 'zoho-ops-agent') {
      issues.push(`step ${step.stepId}: Zoho systems must use zoho-ops-agent`);
    }
    if (step.sourceSystem === 'lark' && step.agentId !== 'lark-ops-agent') {
      issues.push(`step ${step.stepId}: Lark steps must use lark-ops-agent`);
    }
    if (
      (step.sourceSystem === 'gmail' || step.sourceSystem === 'google_drive' || step.sourceSystem === 'google_calendar')
      && step.agentId !== 'google-workspace-agent'
    ) {
      issues.push(`step ${step.stepId}: Google workspace steps must use google-workspace-agent`);
    }
    if (step.inputRefs.length > 0 && step.dependsOn.length === 0) {
      issues.push(`step ${step.stepId}: inputRefs require dependsOn`);
    }
  }

  return issues;
};

const callGroqPlanner = async (input: {
  systemPrompt: string;
  prompt: string;
}): Promise<SupervisorPlan> => {
  if (!config.GROQ_API_KEY.trim()) {
    throw new Error('groq_planner_missing_api_key');
  }

  const response = await withProviderRetry('groq', async () => {
    const nextResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.GROQ_ROUTER_MODEL,
        temperature: 0,
        max_tokens: 1200,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: input.systemPrompt },
          { role: 'user', content: input.prompt },
        ],
      }),
      signal: AbortSignal.timeout(SUPERVISOR_PLANNER_TIMEOUT_MS),
    });

    if (!nextResponse.ok) {
      const error: Error & { status?: number; headers?: Record<string, string> } = new Error(`supervisor_planner_http_${nextResponse.status}`);
      error.status = nextResponse.status;
      error.headers = Object.fromEntries(nextResponse.headers.entries());
      throw error;
    }

    return nextResponse;
  });

  const payload = await response.json() as {
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  const content = payload.choices?.[0]?.message?.content?.trim() ?? '';
  const json = extractFirstJsonObject(content);
  if (!json) {
    throw new Error('supervisor_planner_no_json');
  }
  const normalizedPayload = normalizeSupervisorPlanPayload(JSON.parse(json));
  try {
    return supervisorPlanSchema.parse(normalizedPayload);
  } catch (error) {
    logger.warn('supervisor.planner.payload_invalid', {
      rawContent: content.slice(0, 1200),
      normalizedPayload: JSON.stringify(normalizedPayload).slice(0, 1200),
      error: error instanceof Error ? error.message : 'unknown',
    });
    throw error;
  }
};

export const planSupervisorDelegation = async (input: {
  model?: any;
  providerOptions?: Record<string, unknown>;
  systemPrompt: string;
  latestUserMessage: string;
  eligibleAgents: SupervisorAgentDescriptor[];
  preferredAgentIds: string[];
  childRouteHints?: Record<string, unknown> | null;
  queryEnrichment?: QueryEnrichment;
  inferredDomain?: string | null;
  inferredOperationClass?: string | null;
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
  let result: SupervisorPlan | undefined;
  let lastValidationIssues: string[] = [];
  const plannerSystemPrompt = [
    input.systemPrompt,
    'You are the top-level multi-agent supervisor planner.',
    'Return only a valid orchestration plan object.',
  ].join('\n\n');
  const invalidShapeRetryPrompt = [
    plannerSystemPrompt,
    'Previous output was invalid.',
    'Retry now and return ONLY one JSON object with top-level keys: complexity and steps.',
    'Do not wrap the plan under plan, result, workflow, or output.',
    'For non-direct plans, steps must be an array of objects with: stepId, agentId, action, sourceSystem, objective, dependsOn, inputRefs.',
  ].join('\n\n');
  const plannerPrompt = buildPlannerPrompt({
    latestUserMessage: input.latestUserMessage,
    eligibleAgents: input.eligibleAgents,
    preferredAgentIds: input.preferredAgentIds,
    childRouteHints: input.childRouteHints,
    queryEnrichment: input.queryEnrichment,
    inferredDomain: input.inferredDomain,
    inferredOperationClass: input.inferredOperationClass,
    recentTaskSummaries: input.recentTaskSummaries,
    threadSummary: input.threadSummary,
    supervisorProgress: input.supervisorProgress,
  });

  try {
    try {
      result = await callGroqPlanner({
        systemPrompt: plannerSystemPrompt,
        prompt: plannerPrompt,
      });
    } catch (firstPlannerError) {
      logger.warn('supervisor.planner.retrying_invalid_shape', {
        error: firstPlannerError instanceof Error ? firstPlannerError.message : 'unknown',
      });
      result = await callGroqPlanner({
        systemPrompt: invalidShapeRetryPrompt,
        prompt: plannerPrompt,
      });
    }
    lastValidationIssues = validateSupervisorPlan({
      plan: result,
      eligibleAgents: input.eligibleAgents,
    });
    if (lastValidationIssues.length > 0) {
      result = await callGroqPlanner({
        systemPrompt: [
          plannerSystemPrompt,
          `Previous plan was invalid. Correct these issues exactly:\n${lastValidationIssues.map((issue) => `- ${issue}`).join('\n')}`,
        ].join('\n\n'),
        prompt: plannerPrompt,
      });
      lastValidationIssues = validateSupervisorPlan({
        plan: result,
        eligibleAgents: input.eligibleAgents,
      });
      if (lastValidationIssues.length > 0) {
        throw new Error(`supervisor_planner_invalid_plan:${lastValidationIssues.join('; ')}`);
      }
    }

    if (result.complexity === 'direct') {
      return {
        complexity: 'direct',
        directAnswer: result.directAnswer?.trim() || 'Done.',
        steps: [],
      };
    }
    if (!result.steps?.length) {
      return buildFallbackPlan({
        latestUserMessage: input.latestUserMessage,
        preferredAgentIds: input.preferredAgentIds,
        eligibleAgents: input.eligibleAgents,
        inferredDomain: input.inferredDomain,
        inferredOperationClass: input.inferredOperationClass,
        recentTaskSummaries: input.recentTaskSummaries,
        supervisorProgress: input.supervisorProgress,
      });
    }

    const constrainedPlan = constrainPlanToEligibleAgents({
      plan: result,
      eligibleAgents: input.eligibleAgents,
      preferredAgentIds: input.preferredAgentIds,
      latestUserMessage: input.latestUserMessage,
      inferredDomain: input.inferredDomain,
      inferredOperationClass: input.inferredOperationClass,
      recentTaskSummaries: input.recentTaskSummaries,
      supervisorProgress: input.supervisorProgress,
    });
    return {
      ...constrainedPlan,
      steps: constrainedPlan.steps.map((step) => buildStepWithCompatibilityObjective(step, input.searchIntent)),
    };
  } catch (error) {
    logger.warn('supervisor.planner.failed', {
      hasSteps: Array.isArray(result?.steps),
      stepsLength: result?.steps?.length,
      validationIssues: lastValidationIssues,
      error: error instanceof Error ? error.message : 'unknown',
    });
    const fallback = buildFallbackPlan({
      latestUserMessage: input.latestUserMessage,
      preferredAgentIds: input.preferredAgentIds,
      eligibleAgents: input.eligibleAgents,
      inferredDomain: input.inferredDomain,
      inferredOperationClass: input.inferredOperationClass,
      recentTaskSummaries: input.recentTaskSummaries,
      supervisorProgress: input.supervisorProgress,
    });
    return {
      ...fallback,
      steps: fallback.steps.map((step) => buildStepWithCompatibilityObjective(step, input.searchIntent)),
    };
  }
};

export { buildStepWithCompatibilityObjective };
