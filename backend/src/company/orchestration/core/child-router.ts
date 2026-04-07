import { generateText, type ModelMessage } from 'ai';
import { z } from 'zod';

import { resolveVercelChildRouterModel } from '../vercel/model-factory';
import {
  CircuitBreakerOpenError,
  runWithCircuitBreaker,
} from '../../observability/circuit-breaker';
import { memoryService } from '../../memory';
import { ALIAS_TO_CANONICAL_ID, DOMAIN_ALIASES, TOOL_REGISTRY_MAP } from '../../tools/tool-registry';
import {
  classifyIntent,
  isBareContinuationMessage,
  toNarrowOperationClass,
} from '../intent/canonical-intent';
import { appendLatestAgentRunLog } from '../../../utils/latest-agent-run-log';
import { logger } from '../../../utils/logger';
import { buildVisionContent, type AttachedFileRef } from '../../../modules/desktop-chat/file-vision.builder';
import {
  filterThreadMessagesForContext,
  type DesktopTaskState,
  type DesktopThreadSummary,
} from '../../../modules/desktop-chat/desktop-thread-memory';
import type { QueryEnrichment } from '../query-enrichment.service';
import type { ToolActionGroup } from '../../tools/tool-action-groups';

const GEMINI_CIRCUIT_BREAKER = {
  failureThreshold: 5,
  windowMs: 60_000,
  cooldownMs: 60_000,
};

const CHILD_ROUTER_FAST_REPLY_MAX_LENGTH = 4000;
const CHILD_ROUTER_INTENT_CLASS_VALUES = [
  'direct_calendar',
  'reusable_workflow',
  'saved_workflow_reuse',
  'other',
] as const;
const LOCAL_TIME_ZONE = 'Asia/Kolkata';

type ChildRouterIntentClass = (typeof CHILD_ROUTER_INTENT_CLASS_VALUES)[number];

type ParsedDesktopChildRoute = z.infer<typeof desktopChildRouteSchema>;
export type DesktopChildRoute = ParsedDesktopChildRoute & {
  intentClass: ChildRouterIntentClass;
  confidence: number;
};

const desktopChildRouteSchema = z.object({
  route: z.enum(['fast_reply', 'direct_execute', 'handoff']),
  reply: z.string().min(1).max(CHILD_ROUTER_FAST_REPLY_MAX_LENGTH).optional(),
  acknowledgement: z.string().min(1).max(400).optional(),
  reason: z.string().min(1).max(200).optional(),
  domain: z.string().min(1).max(80).optional(),
  operationType: z.enum(['read', 'write', 'send', 'inspect', 'schedule', 'search']).optional(),
  normalizedIntent: z.string().min(1).max(400).optional(),
  intentClass: z.enum(CHILD_ROUTER_INTENT_CLASS_VALUES).optional(),
  confidence: z.number().min(0).max(1).optional(),
  alternativeIntent: z.string().min(1).max(120).optional(),
  preferredReplyMode: z.enum(['thread', 'reply', 'plain', 'dm']).optional(),
  suggestedToolIds: z.array(z.string().min(1).max(80)).max(12).optional(),
  suggestedSkillQuery: z.string().min(1).max(300).optional(),
  suggestedActions: z.array(z.string().min(1).max(200)).max(10).optional(),
});

const summarizeText = (value: string | null | undefined, limit = 280): string | null => {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}...` : trimmed;
};

const isBareMentionMessage = (value: string | null | undefined): boolean => {
  const trimmed = value?.trim();
  if (!trimmed) return true;
  return trimmed.replace(/@\S+/g, '').trim().length === 0;
};

const runWithModelCircuitBreaker = async <T>(
  provider: string,
  operation: string,
  run: () => Promise<T> | T,
): Promise<T> => {
  if (provider !== 'google') {
    return Promise.resolve(run());
  }
  try {
    return await runWithCircuitBreaker('gemini', operation, GEMINI_CIRCUIT_BREAKER, async () =>
      Promise.resolve(run()),
    );
  } catch (error) {
    if (error instanceof CircuitBreakerOpenError) {
      throw new Error('Gemini is temporarily unavailable. Please try again shortly.');
    }
    throw error;
  }
};

const extractFirstJsonObject = (text: string): string | null => {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  return trimmed.slice(start, end + 1);
};

const normalizeChildRouteResponse = (value: unknown): unknown => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  if (record.route === 'fast_reply|direct_execute|handoff') {
    if (typeof record.reply === 'string' && record.reply.trim()) {
      return { ...record, route: 'fast_reply' };
    }
    if (typeof record.acknowledgement === 'string' && record.acknowledgement.trim()) {
      return { ...record, route: 'handoff' };
    }
    return { ...record, route: 'direct_execute' };
  }
  if (typeof record.route === 'string') {
    return record;
  }
  for (const key of ['result', 'decision', 'output', 'response', 'childRoute']) {
    const nested = record[key];
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      const nestedRecord = nested as Record<string, unknown>;
      if (typeof nestedRecord.route === 'string') {
        return nestedRecord;
      }
    }
  }
  return record;
};

const truncateString = (value: unknown, maxLength: number): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
};

const uniq = <T>(values: Array<T | null | undefined>): T[] =>
  Array.from(new Set(values.filter((value): value is T => value !== null && value !== undefined)));

const sanitizeChildRouteCandidate = (value: unknown): unknown => {
  const normalized = normalizeChildRouteResponse(value);
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) {
    return normalized;
  }
  const record = normalized as Record<string, unknown>;
  const route = typeof record.route === 'string' ? record.route.trim() : undefined;
  return {
    ...(route ? { route } : {}),
    ...(truncateString(record.reply, CHILD_ROUTER_FAST_REPLY_MAX_LENGTH)
      ? { reply: truncateString(record.reply, CHILD_ROUTER_FAST_REPLY_MAX_LENGTH) }
      : {}),
    ...(truncateString(record.acknowledgement, 400)
      ? { acknowledgement: truncateString(record.acknowledgement, 400) }
      : {}),
    ...(truncateString(record.reason, 200) ? { reason: truncateString(record.reason, 200) } : {}),
    ...(truncateString(record.domain, 80) ? { domain: truncateString(record.domain, 80) } : {}),
    ...(typeof record.operationType === 'string' ? { operationType: record.operationType.trim() } : {}),
    ...(truncateString(record.normalizedIntent, 400)
      ? { normalizedIntent: truncateString(record.normalizedIntent, 400) }
      : {}),
    ...(truncateString(record.suggestedSkillQuery, 300)
      ? { suggestedSkillQuery: truncateString(record.suggestedSkillQuery, 300) }
      : {}),
    ...(typeof record.intentClass === 'string' ? { intentClass: record.intentClass.trim() } : {}),
    ...(typeof record.alternativeIntent === 'string'
      ? { alternativeIntent: truncateString(record.alternativeIntent, 120) }
      : {}),
    ...(typeof record.confidence === 'number' && Number.isFinite(record.confidence)
      ? { confidence: Math.min(1, Math.max(0, record.confidence)) }
      : {}),
    ...(Array.isArray(record.suggestedToolIds)
      ? {
          suggestedToolIds: record.suggestedToolIds
            .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
            .map((entry) => entry.trim().slice(0, 80))
            .slice(0, 12),
        }
      : {}),
    ...(Array.isArray(record.suggestedActions)
      ? {
          suggestedActions: record.suggestedActions
            .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
            .map((entry) => entry.trim().slice(0, 200))
            .slice(0, 10),
        }
      : {}),
  };
};

const inferChildRouteDomain = (input: {
  message: string;
  normalizedIntent?: string;
  explicitDomain?: string;
  suggestedToolIds?: string[];
}): string | undefined => {
  const explicitDomain = input.explicitDomain?.trim();
  if (explicitDomain) {
    return DOMAIN_ALIASES[explicitDomain] ?? DOMAIN_ALIASES[explicitDomain.toLowerCase()] ?? explicitDomain;
  }

  const suggestedDomains = uniq(
    (input.suggestedToolIds ?? []).map((toolId) => {
      const canonicalToolId = ALIAS_TO_CANONICAL_ID[toolId]
        ?? ALIAS_TO_CANONICAL_ID[toolId.toLowerCase()]
        ?? ALIAS_TO_CANONICAL_ID[toolId.replace(/([a-z0-9])([A-Z])/g, '$1-$2')]
        ?? ALIAS_TO_CANONICAL_ID[toolId.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()];
      return canonicalToolId ? TOOL_REGISTRY_MAP.get(canonicalToolId)?.domain : null;
    }),
  );
  if (suggestedDomains.length > 0) {
    return suggestedDomains[0];
  }

  const intent = classifyIntent(input.message, {
    normalizedIntent: input.normalizedIntent,
  });
  switch (intent.domain) {
    case 'zoho_books':
      return 'zoho_books';
    case 'zoho_crm':
      return 'zoho_crm';
    case 'gmail':
      return 'gmail';
    case 'lark_doc':
      return 'lark_doc';
    case 'calendar':
      return 'lark_calendar';
    case 'lark':
      return 'lark_task';
    case 'outreach':
      return 'outreach';
    case 'web_search':
      return 'web_search';
    default:
      return undefined;
  }
};

const inferChildRouteOperationType = (input: {
  message: string;
  normalizedIntent?: string;
  explicitOperationType?: unknown;
  inferredDomain?: string;
  priorToolResults?: DesktopTaskState['latestToolResults'];
}): 'read' | 'write' | 'send' | 'inspect' | 'schedule' | 'search' => {
  if (isBareContinuationMessage(input.message) && (input.priorToolResults?.length ?? 0) > 0) {
    return toNarrowOperationClass(classifyIntent(input.message, {
      normalizedIntent: input.normalizedIntent,
      childRouterDomain: input.inferredDomain,
      priorToolResults: input.priorToolResults,
    }));
  }
  if (typeof input.explicitOperationType === 'string') {
    const explicit = input.explicitOperationType.trim();
    if (['read', 'write', 'send', 'inspect', 'schedule', 'search'].includes(explicit)) {
      return explicit as 'read' | 'write' | 'send' | 'inspect' | 'schedule' | 'search';
    }
  }

  return toNarrowOperationClass(classifyIntent(input.message, {
    normalizedIntent: input.normalizedIntent,
    childRouterDomain: input.inferredDomain,
  }));
};

const inferChildRouteIntentClass = (input: {
  message: string;
  normalizedIntent?: string;
  suggestedToolIds?: string[];
  explicitIntentClass?: unknown;
}): ChildRouterIntentClass => {
  if (typeof input.explicitIntentClass === 'string') {
    const trimmed = input.explicitIntentClass.trim() as ChildRouterIntentClass;
    if (CHILD_ROUTER_INTENT_CLASS_VALUES.includes(trimmed)) {
      return trimmed;
    }
  }
  const haystack = `${input.message}\n${input.normalizedIntent ?? ''}`.toLowerCase();
  const suggestedToolIds = new Set((input.suggestedToolIds ?? []).map((entry) => entry.trim()));
  const savedWorkflowSignals =
    /\b(saved workflow|run workflow|workflow named|workflow called|open workflow|list workflows|show workflows)\b/i.test(haystack)
    || suggestedToolIds.has('workflowList')
    || suggestedToolIds.has('workflowRun');
  if (savedWorkflowSignals) {
    return 'saved_workflow_reuse';
  }
  const workflowSignals =
    /\b(workflow|recurring|repeat every|save this|save for later|reusable|automation)\b/i.test(haystack)
    || suggestedToolIds.has('workflowDraft')
    || suggestedToolIds.has('workflowPlan')
    || suggestedToolIds.has('workflowBuild')
    || suggestedToolIds.has('workflowValidate')
    || suggestedToolIds.has('workflowSave')
    || suggestedToolIds.has('workflowSchedule');
  const calendarSignals =
    /\b(meeting|calendar|event|availability|reschedul|invite|slot|book)\b/i.test(haystack)
    || suggestedToolIds.has('larkCalendar')
    || suggestedToolIds.has('googleCalendar');
  if (workflowSignals && !calendarSignals) {
    return 'reusable_workflow';
  }
  if (calendarSignals && !workflowSignals) {
    return 'direct_calendar';
  }
  return 'other';
};

const inferChildRouteConfidence = (input: {
  message: string;
  intentClass: ChildRouterIntentClass;
  explicitConfidence?: unknown;
}): number => {
  if (typeof input.explicitConfidence === 'number' && Number.isFinite(input.explicitConfidence)) {
    return Math.min(1, Math.max(0, input.explicitConfidence));
  }
  if (input.intentClass === 'other') {
    return 0.9;
  }
  const message = input.message.toLowerCase();
  const workflowSignals = /\b(workflow|recurring|repeat every|save this|save for later|reusable|automation)\b/.test(message);
  const calendarSignals = /\b(meeting|calendar|event|availability|reschedul|invite|slot|book)\b/.test(message);
  if (workflowSignals && calendarSignals) {
    return 0.55;
  }
  if (input.intentClass === 'saved_workflow_reuse') {
    return 0.85;
  }
  if (workflowSignals || calendarSignals) {
    return 0.82;
  }
  return 0.7;
};

const inferAlternativeIntent = (input: {
  message: string;
  intentClass: ChildRouterIntentClass;
  explicitAlternativeIntent?: unknown;
}): string | undefined => {
  if (typeof input.explicitAlternativeIntent === 'string' && input.explicitAlternativeIntent.trim()) {
    return input.explicitAlternativeIntent.trim().slice(0, 120);
  }
  const message = input.message.toLowerCase();
  const workflowSignals = /\b(workflow|recurring|repeat every|save this|save for later|reusable|automation)\b/.test(message);
  const calendarSignals = /\b(meeting|calendar|event|availability|reschedul|invite|slot|book)\b/.test(message);
  if (!(workflowSignals && calendarSignals)) {
    return undefined;
  }
  if (input.intentClass === 'direct_calendar') {
    return 'reusable_workflow';
  }
  if (input.intentClass === 'reusable_workflow' || input.intentClass === 'saved_workflow_reuse') {
    return 'direct_calendar';
  }
  return 'reusable_workflow';
};

const enrichChildRouteMetadata = (
  route: ParsedDesktopChildRoute,
  message: string,
  taskState?: DesktopTaskState,
): DesktopChildRoute => {
  const intentClass = inferChildRouteIntentClass({
    message,
    normalizedIntent: route.normalizedIntent,
    suggestedToolIds: route.suggestedToolIds,
    explicitIntentClass: route.intentClass,
  });
  const confidence = inferChildRouteConfidence({
    message,
    intentClass,
    explicitConfidence: route.confidence,
  });
  const domain = inferChildRouteDomain({
    message,
    normalizedIntent: route.normalizedIntent,
    explicitDomain: route.domain,
    suggestedToolIds: route.suggestedToolIds,
  });
  const operationType = inferChildRouteOperationType({
    message,
    normalizedIntent: route.normalizedIntent,
    explicitOperationType: route.operationType,
    inferredDomain: domain,
    priorToolResults: taskState?.latestToolResults,
  });
  const alternativeIntent = inferAlternativeIntent({
    message,
    intentClass,
    explicitAlternativeIntent: route.alternativeIntent,
  });
  return {
    ...route,
    intentClass,
    confidence,
    ...(domain ? { domain } : {}),
    operationType,
    ...(alternativeIntent ? { alternativeIntent } : {}),
  };
};

export const buildSchedulingIntentClarification = (
  route: Pick<DesktopChildRoute, 'intentClass' | 'confidence' | 'alternativeIntent'>,
): string | null => {
  if (
    !['direct_calendar', 'reusable_workflow', 'saved_workflow_reuse'].includes(route.intentClass)
    || route.confidence >= 0.75
  ) {
    return null;
  }
  if (route.intentClass === 'saved_workflow_reuse') {
    return 'Did you want to run an existing saved workflow, or create a new recurring workflow?';
  }
  if (route.intentClass === 'direct_calendar') {
    return 'Did you want to schedule a one-time meeting, or save this as a reusable recurring workflow?';
  }
  if (route.intentClass === 'reusable_workflow') {
    return 'Did you want to save this as a reusable recurring workflow, or just schedule a one-time meeting/event?';
  }
  return 'Did you want to schedule a one-time meeting, or save this as a recurring workflow you can reuse?';
};

const isWorkflowCapabilityQuestion = (message: string): boolean => {
  const normalized = message.trim().toLowerCase();
  if (!normalized.includes('workflow')) {
    return false;
  }
  return ['output', 'destination', 'where', 'deliver', 'send', 'go'].some((token) =>
    normalized.includes(token),
  );
};

const buildTaskAwareRouterAcknowledgement = (message: string): string => {
  const normalized = message.trim().replace(/\s+/g, ' ');
  if (!normalized) {
    return 'On it.';
  }
  if (/\b(schedule|meeting|calendar|reschedul|availability|book|slot)\b/i.test(normalized)) {
    return 'Let me sort out the scheduling details.';
  }
  if (/\b(check|review|inspect|look at|what do you see|analy[sz]e|summari[sz]e|compare)\b/i.test(normalized)) {
    return 'Let me take a closer look.';
  }
  if (/\b(find|search|look up|research|latest|current|status|where|which|who)\b/i.test(normalized)) {
    return 'Let me check that.';
  }
  if (/\b(create|set up|draft|write|prepare|make|update|change|edit|delete|remove|send)\b/i.test(normalized)) {
    return 'I can take care of that.';
  }
  return 'On it.';
};

const ensureChildRouteAcknowledgement = (
  route: DesktopChildRoute,
  message: string,
): DesktopChildRoute => {
  if (route.route === 'fast_reply') {
    return route;
  }
  return {
    ...route,
    acknowledgement: route.acknowledgement?.trim() || buildTaskAwareRouterAcknowledgement(message),
  };
};

const shouldPlanDesktopTask = (message?: string): boolean => {
  const input = message?.trim();
  if (!input) return false;
  if (isBareContinuationMessage(input)) return false;
  if (input.length >= 120) return true;
  if (/\b(and|then|after that|also|compare|audit|investigate|analyze|review|summarize|implement|debug|refactor|prepare)\b/i.test(input)) {
    return true;
  }
  if (
    /\b(create|make|mkdir|delete|remove|move|rename|organize|cleanup|clean up|run|execute)\b/i.test(input)
    && /\b(workspace|repo|folder|directory|file|files|terminal|command|script)\b/i.test(input)
  ) {
    return true;
  }
  if (
    /\b(create|update|send|draft|write|read|search)\b/i.test(input)
    && /\b(zoho|lark|google|repo|workspace|file|document|calendar|task|invoice|payment)\b/i.test(input)
  ) {
    return true;
  }
  return false;
};

const buildAllowedToolCatalog = (input: {
  allowedToolIds?: string[];
  allowedActionsByTool?: Record<string, ToolActionGroup[]>;
}): string => {
  const allowed = Array.from(new Set(input.allowedToolIds ?? []));
  if (allowed.length === 0) {
    return 'No explicit allowed tool catalog was provided.';
  }
  return allowed
    .map((toolId) => {
      const def = TOOL_REGISTRY_MAP.get(toolId);
      const actions = input.allowedActionsByTool?.[toolId];
      const actionText = actions && actions.length > 0 ? ` actions=${actions.join(',')}` : '';
      if (!def) {
        return `- ${toolId}${actionText}`;
      }
      return `- ${toolId}: ${def.description}${actionText}`;
    })
    .join('\n');
};

const summarizeChildRouterTaskState = (taskState?: DesktopTaskState): string => {
  if (!taskState) {
    return 'No task state available.';
  }
  const lines = [
    taskState.activeObjective ? `activeObjective=${taskState.activeObjective}` : '',
    taskState.pendingApproval
      ? `pendingApproval=${JSON.stringify(taskState.pendingApproval).slice(0, 600)}`
      : '',
    taskState.activeSourceArtifacts.length > 0
      ? `activeSourceArtifacts=${taskState.activeSourceArtifacts.map((artifact) => artifact.fileName).join(', ')}`
      : '',
    taskState.completedMutations.length > 0
      ? `completedMutations=${taskState.completedMutations
          .slice(-4)
          .map((mutation) => `${mutation.module ?? 'unknown'}:${mutation.recordId ?? 'n/a'}:${mutation.summary}`)
          .join(' | ')}`
      : '',
  ].filter(Boolean);
  return lines.length > 0 ? lines.join('\n') : 'No meaningful task state available.';
};

const summarizeChildRouterThreadSummary = (threadSummary?: DesktopThreadSummary): string => {
  if (!threadSummary || threadSummary.sourceMessageCount === 0) {
    return 'No thread summary available.';
  }
  return JSON.stringify({
    sourceMessageCount: threadSummary.sourceMessageCount,
    summary: threadSummary.summary ?? null,
    latestObjective: threadSummary.latestObjective ?? null,
    latestUserGoal: threadSummary.latestUserGoal ?? null,
    activeEntities: threadSummary.activeEntities,
    userGoals: threadSummary.userGoals,
    completedActions: threadSummary.completedActions,
    completedWrites: threadSummary.completedWrites,
    resolvedReferences: threadSummary.resolvedReferences,
    pendingApprovals: threadSummary.pendingApprovals,
    constraints: threadSummary.constraints,
  });
};

const getLocalDateTimeContext = (): string => {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: LOCAL_TIME_ZONE,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  });
  return formatter.format(new Date());
};

const buildRequesterIdentityContext = (input: {
  requesterName?: string;
  requesterEmail?: string;
}): string | null => {
  const lines: string[] = [];
  if (input.requesterName?.trim()) {
    lines.push(`- name: ${input.requesterName.trim()}`);
  }
  if (input.requesterEmail?.trim()) {
    lines.push(`- email: ${input.requesterEmail.trim()}`);
  }
  if (lines.length === 0) return null;
  return [
    'Requester identity context:',
    ...lines,
    '- Use this only when it helps with personalization or disambiguation.',
  ].join('\n');
};

const buildConversationKey = (threadId: string): string => `desktop:${threadId}`;

export const buildChildRouterPrompt = (input: {
  message: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  queryEnrichment?: QueryEnrichment;
  attachedFiles?: AttachedFileRef[];
  workspace?: { name: string; path: string };
  approvalPolicySummary?: string;
  requesterName?: string;
  requesterEmail?: string;
  requesterAiRole?: string;
  retrievedMemorySnippets?: string[];
  behaviorProfileContext?: string | null;
  durableMemoryContext?: string | null;
  relevantMemoryFactsContext?: string | null;
  allowedToolIds?: string[];
  allowedActionsByTool?: Record<string, ToolActionGroup[]>;
  departmentSystemPrompt?: string;
  departmentSkillsMarkdown?: string;
  taskState?: DesktopTaskState;
  threadSummary?: DesktopThreadSummary;
}): string => {
  const filteredHistory = filterThreadMessagesForContext(input.history);
  const historyBlock =
    filteredHistory.length > 0
      ? filteredHistory
          .slice(-6)
          .map((entry, index) => `${index + 1}. ${entry.role.toUpperCase()}: ${entry.content}`)
          .join('\n')
      : 'No useful prior conversation history.';

  const workspaceBlock = input.workspace
    ? `Workspace is open at ${input.workspace.path} (${input.workspace.name}). Approval policy: ${input.approvalPolicySummary ?? 'unknown'}.`
    : 'No workspace context is active.';
  const requesterContext = buildRequesterIdentityContext({
    requesterName: input.requesterName,
    requesterEmail: input.requesterEmail,
  });
  const behaviorProfileBlock = input.behaviorProfileContext?.trim() || 'No resolved behavior profile.';
  const durableMemoryBlock = input.durableMemoryContext?.trim() || 'No durable task memory.';
  const retrievedMemoryBlock =
    input.retrievedMemorySnippets && input.retrievedMemorySnippets.length > 0
      ? input.retrievedMemorySnippets.map((snippet, index) => `${index + 1}. ${snippet}`).join('\n')
      : 'No retrieved conversation memory.';
  const relevantMemoryFactsBlock = input.relevantMemoryFactsContext?.trim() || 'No relevant durable memory facts.';
  const toolCatalogBlock = buildAllowedToolCatalog({
    allowedToolIds: input.allowedToolIds,
    allowedActionsByTool: input.allowedActionsByTool,
  });
  const attachmentBlock =
    input.attachedFiles && input.attachedFiles.length > 0
      ? input.attachedFiles
          .map((file, index) => `${index + 1}. ${file.fileName} (${file.mimeType})`)
          .join('\n')
      : 'No current grounded files.';
  const threadSummaryBlock = summarizeChildRouterThreadSummary(input.threadSummary);
  const taskStateBlock = summarizeChildRouterTaskState(input.taskState);
  const enrichmentBlock = input.queryEnrichment
    ? [
        `Clean query: ${input.queryEnrichment.cleanQuery}`,
        input.queryEnrichment.exactTerms.length > 0 ? `Exact terms: ${input.queryEnrichment.exactTerms.join(', ')}` : '',
        input.queryEnrichment.contextHints.length > 0 ? `Context hints: ${input.queryEnrichment.contextHints.join(' | ')}` : '',
        input.queryEnrichment.retrievalQueries.length > 1
          ? `Retrieval query variants:\n${input.queryEnrichment.retrievalQueries.map((value, index) => `${index + 1}. ${value}`).join('\n')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n')
    : 'No L1 query enrichment.';
  const currentRequestBlock = [
    '## CURRENT REQUEST — this is the ONLY message that determines tool selection',
    `Message: ${input.message || '(empty)'}`,
    'The above is the message you are classifying right now.',
    'History above is context only. It must never override the intent of the current request.',
  ].join('\n');

  return [
    'Classify and enrich this chat turn for a two-tier assistant runtime.',
    'The CURRENT REQUEST section later in this prompt is the highest-priority signal for tool selection.',
    'Return exactly one JSON object only.',
    'Do not wrap it in markdown, prose, arrays, or an outer envelope.',
    'Required JSON keys:',
    'route, reply, acknowledgement, reason, domain, operationType, normalizedIntent, intentClass, confidence, alternativeIntent, preferredReplyMode, suggestedToolIds, suggestedSkillQuery, suggestedActions',
    'Allowed route values: fast_reply, direct_execute, handoff',
    'Allowed preferredReplyMode values: thread, reply, plain, dm',
    'Valid examples:',
    '{"route":"fast_reply","reply":"Hi, how can I help?","reason":"simple greeting","domain":"general","operationType":"read","normalizedIntent":"greeting","intentClass":"other","confidence":0.98,"preferredReplyMode":"reply","suggestedToolIds":[],"suggestedActions":[]}',
    '{"route":"direct_execute","acknowledgement":"Let me check that.","reason":"simple tool-backed request","domain":"workflow","operationType":"read","normalizedIntent":"list saved workflows","intentClass":"saved_workflow_reuse","confidence":0.9,"preferredReplyMode":"thread","suggestedToolIds":["workflowList"],"suggestedActions":["call workflowList"]}',
    '{"route":"handoff","acknowledgement":"I can set that up.","reason":"multi-step request","domain":"workflow","operationType":"schedule","normalizedIntent":"schedule a reusable workflow","intentClass":"reusable_workflow","confidence":0.88,"alternativeIntent":"direct_calendar","preferredReplyMode":"thread","suggestedToolIds":["contextSearch","workflowPlan","workflowSchedule"],"suggestedSkillQuery":"workflow scheduling reusable prompt","suggestedActions":["search relevant skill","plan workflow","ask for missing schedule details"]}',
    'Routes:',
    '- fast_reply: greetings, thanks, chit-chat, identity/capability questions, short conversational replies that need no tools, or grounded multimodal turns that can be answered directly from the current attached image/media context without external tools.',
    '- direct_execute: straightforward work that should go directly to the main executor. Always include a short natural acknowledgement the user should see immediately.',
    '- handoff: multi-step or heavier work likely to require more than 2-3 tool calls, iteration, or planning. Always include a short natural acknowledgement the user should see immediately.',
    'Rules:',
    '- Do not use tools.',
    '- `domain` should use the routing-domain taxonomy when possible: zoho_crm, zoho_books, lark_task, lark_message, lark_calendar, lark_meeting, lark_approval, lark_doc, lark_base, gmail, google_drive, google_calendar, workflow, skill, web_search, context_search, workspace, document_inspection, general.',
    '- `operationType` must be one of: read, write, send, inspect, schedule, search.',
    '- If retrieved conversation memory clearly answers a personal-memory question, prefer fast_reply and answer from that memory.',
    '- When a workspace is active, ambiguous file and folder requests refer to the LOCAL workspace by default, not Google Drive or any other cloud integration, unless the user explicitly names a cloud service.',
    '- Use the allowed tool catalog to suggest the best next tool ids or skill query. Prefer concrete allowed tools over vague guesses.',
    '- If the right tool path is unclear, suggest contextSearch first and provide a concise suggestedSkillQuery for skill lookup or broader context retrieval.',
    '- If older history or thread summary conflicts with the latest user message, the latest user message wins.',
    '- Treat the current local date/time in this prompt as authoritative for ambiguous year-sensitive requests.',
    '- preferredReplyMode is your delivery proposal for this turn. Use reply for short direct answers in chat, thread for longer group-chat execution/results, plain for proactive standalone channel updates, and dm only when the user explicitly asks for private delivery or the content is clearly sensitive.',
    '- For fast_reply, fill reply and keep it short.',
    '- For direct_execute, always fill acknowledgement and keep it short, natural, and action-oriented.',
    '- For handoff, always fill acknowledgement and keep it short, natural, and action-oriented.',
    workspaceBlock,
    `Current local date/time: ${getLocalDateTimeContext()} (${LOCAL_TIME_ZONE}).`,
    requesterContext ?? '',
    input.departmentSystemPrompt?.trim() ? `Department instructions:\n${input.departmentSystemPrompt.trim()}` : '',
    input.departmentSkillsMarkdown?.trim() ? `Department skill context:\n${input.departmentSkillsMarkdown.trim()}` : '',
    'Allowed tool catalog:',
    toolCatalogBlock,
    'Resolved behavior profile:',
    behaviorProfileBlock,
    'Durable task memory:',
    durableMemoryBlock,
    'Relevant durable memory facts:',
    relevantMemoryFactsBlock,
    'Current grounded files:',
    attachmentBlock,
    'L1 query enrichment:',
    enrichmentBlock,
    'Thread summary:',
    threadSummaryBlock,
    'Task state:',
    taskStateBlock,
    'Retrieved conversation memory:',
    retrievedMemoryBlock,
    '## Conversation history (background context only)',
    historyBlock,
    currentRequestBlock,
  ]
    .filter(Boolean)
    .join('\n\n');
};

export const runDesktopChildRouter = async (input: {
  executionId: string;
  threadId: string;
  message: string;
  queryEnrichment?: QueryEnrichment;
  attachedFiles?: AttachedFileRef[];
  workspace?: { name: string; path: string };
  approvalPolicySummary?: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  requesterName?: string;
  requesterEmail?: string;
  requesterAiRole?: string;
  companyId?: string;
  userId?: string;
  allowedToolIds?: string[];
  allowedActionsByTool?: Record<string, ToolActionGroup[]>;
  departmentSystemPrompt?: string;
  departmentSkillsMarkdown?: string;
  taskState?: DesktopTaskState;
  threadSummary?: DesktopThreadSummary;
}): Promise<DesktopChildRoute> => {
  logger.info('vercel.child_router.start', {
    executionId: input.executionId,
    threadId: input.threadId,
    messagePreview: summarizeText(input.message, 200),
    historyCount: input.history.length,
    hasWorkspace: Boolean(input.workspace),
    attachedFileCount: input.attachedFiles?.length ?? 0,
  });
  if (isBareMentionMessage(input.message)) {
    return {
      route: 'fast_reply',
      reply: 'You mentioned me — what would you like me to do?',
      reason: 'bare mention without actionable text',
      normalizedIntent: 'unknown',
      domain: 'general',
      operationType: 'read',
      intentClass: 'other',
      confidence: 1,
      preferredReplyMode: 'reply',
      suggestedToolIds: [],
      suggestedActions: [],
    };
  }

  try {
    const memoryPromptContext =
      input.companyId && input.userId
        ? await memoryService.getPromptContext({
            companyId: input.companyId,
            userId: input.userId,
            threadId: input.threadId,
            conversationKey: buildConversationKey(input.threadId),
            queryText: input.queryEnrichment?.retrievalQuery ?? input.message,
            contextClass: 'normal_work',
          })
        : {
            behaviorProfile: null,
            behaviorProfileContext: null,
            durableTaskContext: [],
            durableTaskContextText: null,
            relevantMemoryFacts: [],
            relevantMemoryFactsText: null,
            preferredReplyMode: null,
          };
    if (input.taskState && !input.taskState.preferredReplyMode && memoryPromptContext.preferredReplyMode) {
      input.taskState.preferredReplyMode = memoryPromptContext.preferredReplyMode;
      input.taskState.updatedAt = new Date().toISOString();
    }
    const retrievedMemorySnippets = memoryPromptContext.relevantMemoryFacts;
    const model = await resolveVercelChildRouterModel();
    const routerPrompt = buildChildRouterPrompt({
      ...input,
      retrievedMemorySnippets,
      behaviorProfileContext: memoryPromptContext.behaviorProfileContext,
      durableMemoryContext: memoryPromptContext.durableTaskContextText,
      relevantMemoryFactsContext: memoryPromptContext.relevantMemoryFactsText,
    });
    await appendLatestAgentRunLog(input.executionId, 'child_router.start', {
      message: input.message,
      currentAttachedFiles: (input.attachedFiles ?? []).map((file) => ({
        fileAssetId: file.fileAssetId,
        fileName: file.fileName,
        mimeType: file.mimeType,
      })),
      workspace: input.workspace ?? null,
      approvalPolicySummary: input.approvalPolicySummary ?? null,
      history: input.history,
      retrievedMemorySnippets,
      allowedToolIds: input.allowedToolIds ?? [],
      allowedActionsByTool: input.allowedActionsByTool ?? {},
      departmentSystemPrompt: input.departmentSystemPrompt ?? null,
      hasDepartmentSkillsMarkdown: Boolean(input.departmentSkillsMarkdown?.trim()),
      taskState: input.taskState ?? null,
      threadSummary: input.threadSummary ?? null,
      model: {
        provider: model.effectiveProvider,
        modelId: model.effectiveModelId,
        thinkingLevel: model.thinkingLevel,
      },
      prompt: routerPrompt,
    });

    const currentImageAttachments = (input.attachedFiles ?? []).filter((file) =>
      file.mimeType?.startsWith('image/'),
    );
    const routerMessages =
      input.companyId && currentImageAttachments.length > 0
        ? [
            {
              role: 'user' as const,
              content: (await buildVisionContent({
                userMessage: input.message,
                attachedFiles: currentImageAttachments,
                companyId: input.companyId,
                requesterUserId: input.userId,
                requesterAiRole: input.requesterAiRole,
              })) as ModelMessage['content'],
            },
          ]
        : undefined;
    const result = await runWithModelCircuitBreaker(model.effectiveProvider, 'child_router', () =>
      generateText({
        model: model.model,
        ...(routerMessages
          ? {
              system: `${routerPrompt}\n\nReturn one valid JSON object only. No markdown, no prose, no code fences.`,
              messages: routerMessages,
            }
          : {
              system: 'Return one valid JSON object only. No markdown, no prose, no code fences.',
              prompt: routerPrompt,
            }),
        temperature: 0,
        providerOptions: {
          google: {
            thinkingConfig: {
              includeThoughts: true,
              thinkingLevel: model.thinkingLevel,
            },
          },
        },
      }),
    );
    const rawJson = extractFirstJsonObject(result.text) ?? result.text.trim();
    const parsedRoute = enrichChildRouteMetadata(
      desktopChildRouteSchema.parse(
        sanitizeChildRouteCandidate(JSON.parse(rawJson)),
      ),
      input.message,
      input.taskState,
    );
    await appendLatestAgentRunLog(input.executionId, 'child_router.completed', {
      rawText: result.text,
      parsedRoute,
    });
    logger.info('vercel.child_router.completed', {
      executionId: input.executionId,
      threadId: input.threadId,
      route: parsedRoute.route,
      reason: parsedRoute.reason ?? null,
      retrievedMemorySnippetCount: retrievedMemorySnippets.length,
    });
    if (parsedRoute.route === 'fast_reply' && /\b(do you know|do you remember|remember|recall|what(?:'s| is) my|my (?:fav|favorite|favourite|preferred)|favorite|favourite|preferred|preference|about me|my name|my email)\b/i.test(input.message)) {
      if (retrievedMemorySnippets.length === 0) {
        logger.info('vercel.child_router.override', {
          executionId: input.executionId,
          threadId: input.threadId,
          fromRoute: 'fast_reply',
          toRoute: 'direct_execute',
          reason: 'personal_memory_question_requires_context_retrieval',
        });
        return {
          route: 'direct_execute',
          reason: 'personal memory question should use thread context and conversation retrieval',
          domain: 'context_search',
          operationType: 'search',
          intentClass: 'other',
          confidence: 0.95,
        };
      }
    }
    if (parsedRoute.route === 'direct_execute' && shouldPlanDesktopTask(input.message)) {
      return ensureChildRouteAcknowledgement(parsedRoute, input.message);
    }
    if (parsedRoute.route === 'fast_reply' && isWorkflowCapabilityQuestion(input.message)) {
      return ensureChildRouteAcknowledgement(
        {
          route: 'direct_execute',
          acknowledgement: 'I’ll check the workflow output configuration for you.',
          reason: 'workflow_output_question_requires_current_workflow_config',
          normalizedIntent: 'workflow output capability question',
          domain: 'workflow',
          operationType: 'read',
          intentClass: 'saved_workflow_reuse',
          confidence: 0.9,
          suggestedToolIds: ['workflowList', 'workflowDraft'],
          suggestedActions: ['inspect current workflow output destinations'],
        },
        input.message,
      );
    }
    return ensureChildRouteAcknowledgement(parsedRoute, input.message);
  } catch (error) {
    const fallbackRoute = shouldPlanDesktopTask(input.message)
      ? {
          route: 'handoff' as const,
          acknowledgement: buildTaskAwareRouterAcknowledgement(input.message),
          reason: 'router_fallback_complex',
          intentClass: 'other' as const,
          confidence: 0.65,
        }
      : {
          route: 'direct_execute' as const,
          acknowledgement: buildTaskAwareRouterAcknowledgement(input.message),
          reason: 'router_fallback_direct',
          intentClass: 'other' as const,
          confidence: 0.75,
        };
    logger.warn('vercel.child_router.failed', {
      executionId: input.executionId,
      threadId: input.threadId,
      error: error instanceof Error ? error.message : 'unknown_error',
      fallbackRoute: fallbackRoute.route,
    });
    await appendLatestAgentRunLog(input.executionId, 'child_router.failed', {
      error: error instanceof Error ? error.message : 'unknown_error',
      fallbackRoute,
    });
    return fallbackRoute;
  }
};
