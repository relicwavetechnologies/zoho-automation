import { generateText, stepCountIs, type ModelMessage } from 'ai';

import config from '../../../config';
import type { ChannelAction } from '../../channels/base/channel-adapter';
import { resolveChannelAdapter } from '../../channels';
import { departmentService } from '../../departments/department.service';
import type {
  AgentResultDTO,
  NormalizedIncomingMessageDTO,
  OrchestrationTaskDTO,
} from '../../contracts';
import { conversationMemoryStore } from '../../state/conversation';
import { toolPermissionService } from '../../tools/tool-permission.service';
import { retrievalOrchestratorService } from '../../retrieval';
import { logger } from '../../../utils/logger';
import { resolveVercelChildRouterModel, resolveVercelLanguageModel } from '../vercel/model-factory';
import { createVercelDesktopTools } from '../vercel/tools';
import { buildWorkspaceAwarePromptSections } from '../vercel/workspace-aware-prompt';
import { CircuitBreakerOpenError, runWithCircuitBreaker } from '../../observability/circuit-breaker';
import type {
  PendingApprovalAction,
  VercelRuntimeRequestContext,
  VercelToolEnvelope,
} from '../vercel/types';
import type { OrchestrationEngine, OrchestrationExecutionInput, OrchestrationExecutionResult } from './types';
import { legacyOrchestrationEngine } from './legacy-orchestration.engine';
import { buildVisionContent, type AttachedFileRef } from '../../../modules/desktop-chat/file-vision.builder';
import { desktopThreadsService } from '../../../modules/desktop-threads/desktop-threads.service';
import { DESKTOP_THREAD_CONTEXT_MESSAGE_LIMIT } from '../../../modules/desktop-chat/desktop-thread-context.cache';
import {
  buildTaskStateContext,
  filterThreadMessagesForContext,
  buildThreadSummaryContext,
  createEmptyTaskState,
  parseDesktopTaskState,
  parseDesktopThreadSummary,
  refreshDesktopThreadSummary,
  upsertDesktopSourceArtifacts,
  updateTaskStateFromToolEnvelope,
  type DesktopTaskState,
  type DesktopThreadSummary,
} from '../../../modules/desktop-chat/desktop-thread-memory';
import { runDesktopChildRouter, type DesktopChildRoute } from '../../../modules/desktop-chat/vercel-desktop.engine';
import { LarkStatusCoordinator } from './lark-status.coordinator';
import { aiTokenUsageService } from '../../ai-usage/ai-token-usage.service';
import { estimateTokens } from '../../../utils/token-estimator';
import { AI_MODEL_CATALOG_MAP } from '../../ai-models';
import { desktopWsGateway } from '../../../modules/desktop-live/desktop-ws.gateway';
import { appendLatestAgentRunLog, resetLatestAgentRunLog } from '../../../utils/latest-agent-run-log';

const LOCAL_TIME_ZONE = 'Asia/Kolkata';
const LARK_BLOCKED_TOOL_IDS = new Set<string>();
const LARK_VERCEL_MODE: VercelRuntimeRequestContext['mode'] = 'high';
const LARK_THREAD_CONTEXT_MESSAGE_LIMIT = DESKTOP_THREAD_CONTEXT_MESSAGE_LIMIT;
const LARK_CONTEXT_TARGET_RATIO = 0.6;
const LARK_LIGHT_CONTEXT_TARGET_RATIO = 0.12;
const LARK_NORMAL_CONTEXT_TARGET_RATIO = 0.28;
const LARK_STATUS_HEARTBEAT_MESSAGES = [
  'Still working on this.',
  'Still gathering the right details.',
  'Still working through the next step.',
] as const;
const GEMINI_CIRCUIT_BREAKER = {
  failureThreshold: 5,
  windowMs: 60_000,
  openMs: 120_000,
};

const larkConversationHydrationVersions = new Map<string, string>();

const buildConversationKey = (message: NormalizedIncomingMessageDTO): string => `${message.channel}:${message.chatId}`;
const buildPersistentLarkConversationKey = (threadId: string): string => `lark-thread:${threadId}`;
const buildSourceArtifactEntriesFromAttachments = (
  attachments: AttachedFileRef[],
): Array<{
  fileAssetId: string;
  fileName: string;
  sourceType: 'uploaded_file';
}> =>
  attachments.map((file) => ({
    fileAssetId: file.fileAssetId,
    fileName: file.fileName,
    sourceType: 'uploaded_file' as const,
  }));

const summarizeText = (value: string | null | undefined, limit = 280): string | null => {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}...` : trimmed;
};

const isProviderInvalidArgumentError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return message.toLowerCase().includes('invalid argument');
};

const compactMessageText = (value: string, limit: number): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}...` : trimmed;
};

const sanitizeMessagesForProviderRetry = (messages: ModelMessage[], latestUserMessage: string): ModelMessage[] => {
  const compacted = messages
    .map((message) => {
      const flattened = flattenModelContent(message.content);
      const limit = message.role === 'user' ? 6_000 : 4_000;
      const content = compactMessageText(flattened, limit);
      if (!content) {
        return null;
      }
      return {
        role: message.role,
        content,
      } as ModelMessage;
    })
    .filter((message): message is ModelMessage => Boolean(message));

  const trimmedHistory = compacted.slice(-12);
  const latestUser = compactMessageText(latestUserMessage, 6_000);
  if (!latestUser) {
    return trimmedHistory.length > 0 ? trimmedHistory : [{ role: 'user', content: 'Continue from the latest verified context.' }];
  }

  if (trimmedHistory.length === 0) {
    return [{ role: 'user', content: latestUser }];
  }

  const last = trimmedHistory[trimmedHistory.length - 1];
  if (last.role === 'user') {
    trimmedHistory[trimmedHistory.length - 1] = { role: 'user', content: latestUser };
    return trimmedHistory;
  }

  return [...trimmedHistory, { role: 'user', content: latestUser }];
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
    return await runWithCircuitBreaker('gemini', operation, GEMINI_CIRCUIT_BREAKER, async () => Promise.resolve(run()));
  } catch (error) {
    if (error instanceof CircuitBreakerOpenError) {
      throw new Error('Gemini is temporarily unavailable. Please try again shortly.');
    }
    throw error;
  }
};

const flattenModelContent = (content: ModelMessage['content'] | string | undefined): string => {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content.map((part) => {
    if (!part || typeof part !== 'object') {
      return '';
    }
    const record = part as Record<string, unknown>;
    return typeof record.text === 'string' ? record.text : '';
  }).filter(Boolean).join('\n');
};

const estimateMessageTokens = (messages: ModelMessage[]): number =>
  messages.reduce((sum, message) => sum + estimateTokens(flattenModelContent(message.content)), 0);

type LarkContextClass = 'lightweight_chat' | 'normal_work' | 'long_running_task' | 'document_grounded_followup';

const isReferentialFollowup = (value: string | null | undefined): boolean =>
  /\b(next task|pick the next|move on|move to next|continue|next one|same file|same one|next estimate|what next)\b/i.test(value ?? '');

const isLightweightChatTurn = (value: string | null | undefined): boolean =>
  /^(hi|hello|hey|thanks|thank you|ok|okay|cool|great|nice|yes|no)[.! ]*$/i.test((value ?? '').trim());

const chooseLarkContextClass = (input: {
  latestUserMessage?: string;
  taskState: DesktopTaskState;
  threadSummary: DesktopThreadSummary;
  historyMessageCount: number;
}): LarkContextClass => {
  const latestUserMessage = input.latestUserMessage?.trim() ?? '';
  if (isLightweightChatTurn(latestUserMessage)) {
    return 'lightweight_chat';
  }
  if (
    input.taskState.activeSourceArtifacts.length > 0
    && isReferentialFollowup(latestUserMessage)
  ) {
    return 'document_grounded_followup';
  }
  if (
    input.taskState.activeSourceArtifacts.length > 0
    || input.taskState.completedMutations.length > 0
    || Boolean(input.taskState.pendingApproval)
    || input.threadSummary.sourceMessageCount >= 10
    || input.historyMessageCount >= 16
  ) {
    return 'long_running_task';
  }
  return 'normal_work';
};

const resolveModelCatalogEntry = (resolvedModel: {
  effectiveProvider: string;
  effectiveModelId: string;
}) =>
  AI_MODEL_CATALOG_MAP.get(`${resolvedModel.effectiveProvider}:${resolvedModel.effectiveModelId}`)
  ?? (resolvedModel.effectiveProvider === 'google'
    ? AI_MODEL_CATALOG_MAP.get('google:gemini-3.1-flash-lite-preview')
      ?? AI_MODEL_CATALOG_MAP.get('google:gemini-2.5-flash')
      ?? null
    : null);

const resolveLarkContextBudget = (input: {
  resolvedModel: { effectiveProvider: string; effectiveModelId: string };
  contextClass: LarkContextClass;
}): { usableContextBudget: number; targetContextBudget: number; modelId: string } => {
  const catalogEntry = resolveModelCatalogEntry(input.resolvedModel);
  const usableContextBudget = catalogEntry
    ? Math.max(4_000, catalogEntry.maxContextTokens - catalogEntry.outputReserveTokens)
    : input.resolvedModel.effectiveProvider === 'google'
      ? 1_048_576 - 32_768
      : 128_000 - 16_384;
  const ratio = input.contextClass === 'lightweight_chat'
    ? LARK_LIGHT_CONTEXT_TARGET_RATIO
    : input.contextClass === 'normal_work'
      ? LARK_NORMAL_CONTEXT_TARGET_RATIO
      : LARK_CONTEXT_TARGET_RATIO;
  return {
    usableContextBudget,
    targetContextBudget: Math.max(12_000, Math.floor(usableContextBudget * ratio)),
    modelId: input.resolvedModel.effectiveModelId,
  };
};

const buildAdaptiveLarkHistoryMessages = (input: {
  messages: Array<ModelMessage & { id?: string }>;
  targetBudgetTokens: number;
  reservedTokens: number;
  contextClass: LarkContextClass;
}): {
  messages: Array<ModelMessage & { id?: string }>;
  includedRawMessageCount: number;
  compactionTier: number;
} => {
  const maxMessages = input.contextClass === 'lightweight_chat'
    ? 8
    : input.contextClass === 'normal_work'
      ? 16
      : 32;
  const lowValueFilter = input.contextClass !== 'lightweight_chat';
  const selected: Array<ModelMessage & { id?: string }> = [];
  let used = 0;
  let compactionTier = 1;
  const recent = input.messages
    .slice(-60)
    .filter((message) => {
      const flattened = flattenModelContent(message.content);
      if (lowValueFilter && isLightweightChatTurn(flattened)) {
        return false;
      }
      return filterThreadMessagesForContext([{ role: message.role, content: flattened }]).length > 0;
    });

  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const message = recent[index]!;
    const estimated = estimateTokens(flattenModelContent(message.content));
    if (
      selected.length >= maxMessages
      || used + estimated + input.reservedTokens > input.targetBudgetTokens
    ) {
      compactionTier = Math.max(compactionTier, 4);
      continue;
    }
    used += estimated;
    selected.unshift(message);
  }

  return {
    messages: selected,
    includedRawMessageCount: selected.length,
    compactionTier,
  };
};

const loadLarkThreadMemory = async (threadId: string, userId: string): Promise<{
  summary: DesktopThreadSummary;
  taskState: DesktopTaskState;
}> => {
  const thread = await desktopThreadsService.getThreadMeta(threadId, userId);
  return {
    summary: parseDesktopThreadSummary((thread as Record<string, unknown>).summaryJson),
    taskState: parseDesktopTaskState((thread as Record<string, unknown>).taskStateJson),
  };
};

const persistLarkThreadMemory = async (input: {
  threadId: string;
  userId: string;
  summary?: DesktopThreadSummary | null;
  taskState?: DesktopTaskState | null;
}) => {
  await desktopThreadsService.updateOwnedThreadMemory(input.threadId, input.userId, {
    ...(input.summary !== undefined ? { summaryJson: input.summary ? input.summary as unknown as Record<string, unknown> : null } : {}),
    ...(input.taskState !== undefined ? { taskStateJson: input.taskState ? input.taskState as unknown as Record<string, unknown> : null } : {}),
  });
};

const getLocalDateString = (offsetDays = 0): string => {
  const base = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: LOCAL_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(base);
  const read = (type: string) => parts.find((part) => part.type === type)?.value ?? '00';
  return `${read('year')}-${read('month')}-${read('day')}`;
};

const inferDateScope = (message?: string): string | undefined => {
  const input = message?.trim();
  if (!input) return undefined;
  const explicit = input.match(/\b\d{4}-\d{2}-\d{2}\b/);
  if (explicit) return explicit[0];
  const lowered = input.toLowerCase();
  if (lowered.includes('tomorrow')) return getLocalDateString(1);
  if (lowered.includes('yesterday')) return getLocalDateString(-1);
  if (lowered.includes('today')) return getLocalDateString(0);
  return undefined;
};

const isWorkflowLikeRequest = (value: string | null | undefined): boolean =>
  /\b(workflow|prompt|schedule|scheduled|every day|every week|every month|recurring|save (?:this|it) for later|make (?:this|it) reusable)\b/i.test(value ?? '');

const hasSpecificWorkflowReference = (value: string | null | undefined): boolean => {
  const text = value?.trim() ?? '';
  if (!text) return false;
  return /\b(this workflow|that workflow|current workflow)\b/i.test(text)
    || /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(text)
    || /\b(?:workflow named|workflow called|named workflow|called workflow)\b/i.test(text)
    || /"[^"]{2,120}"/.test(text)
    || /'[^']{2,120}'/.test(text);
};

const buildConversationRefsContext = (conversationKey: string): string | null => {
  const latestDoc = conversationMemoryStore.getLatestLarkDoc(conversationKey);
  const latestEvent = conversationMemoryStore.getLatestLarkCalendarEvent(conversationKey);
  const latestTask = conversationMemoryStore.getLatestLarkTask(conversationKey);
  const lines: string[] = [];

  if (latestTask) {
    lines.push(
      `Latest Lark task: ${latestTask.summary ?? latestTask.taskId} [taskId=${latestTask.taskId}${latestTask.taskGuid ? `, taskGuid=${latestTask.taskGuid}` : ''}${latestTask.status ? `, status=${latestTask.status}` : ''}]`,
    );
  }
  if (latestDoc) {
    lines.push(`Latest Lark doc: ${latestDoc.title} [documentId=${latestDoc.documentId}]`);
  }
  if (latestEvent) {
    lines.push(`Latest Lark event: ${latestEvent.summary ?? latestEvent.eventId} [eventId=${latestEvent.eventId}]`);
  }

  return lines.length > 0 ? ['Conversation refs:', ...lines].join('\n') : null;
};

type PersistedConversationRefs = {
  latestLarkDoc?: Record<string, unknown>;
  latestLarkCalendarEvent?: Record<string, unknown>;
  latestLarkTask?: Record<string, unknown>;
};

const buildPersistedConversationRefs = (conversationKey: string): PersistedConversationRefs | null => {
  const latestDoc = conversationMemoryStore.getLatestLarkDoc(conversationKey);
  const latestEvent = conversationMemoryStore.getLatestLarkCalendarEvent(conversationKey);
  const latestTask = conversationMemoryStore.getLatestLarkTask(conversationKey);

  const refs: PersistedConversationRefs = {
    ...(latestDoc ? {
      latestLarkDoc: {
        title: latestDoc.title,
        documentId: latestDoc.documentId,
        ...(latestDoc.url ? { url: latestDoc.url } : {}),
      },
    } : {}),
    ...(latestEvent ? {
      latestLarkCalendarEvent: {
        eventId: latestEvent.eventId,
        ...(latestEvent.calendarId ? { calendarId: latestEvent.calendarId } : {}),
        ...(latestEvent.summary ? { summary: latestEvent.summary } : {}),
        ...(latestEvent.startTime ? { startTime: latestEvent.startTime } : {}),
        ...(latestEvent.endTime ? { endTime: latestEvent.endTime } : {}),
        ...(latestEvent.url ? { url: latestEvent.url } : {}),
      },
    } : {}),
    ...(latestTask ? {
      latestLarkTask: {
        taskId: latestTask.taskId,
        ...(latestTask.taskGuid ? { taskGuid: latestTask.taskGuid } : {}),
        ...(latestTask.summary ? { summary: latestTask.summary } : {}),
        ...(latestTask.status ? { status: latestTask.status } : {}),
        ...(latestTask.url ? { url: latestTask.url } : {}),
      },
    } : {}),
  };

  return Object.keys(refs).length > 0 ? refs : null;
};

const hydrateConversationRefsFromMetadata = (conversationKey: string, metadata: Record<string, unknown>): void => {
  const refs = metadata.conversationRefs;
  if (!refs || typeof refs !== 'object' || Array.isArray(refs)) return;
  const record = refs as PersistedConversationRefs;

  const latestDoc = record.latestLarkDoc;
  if (latestDoc && typeof latestDoc === 'object' && !Array.isArray(latestDoc)) {
    const documentId = typeof latestDoc.documentId === 'string' ? latestDoc.documentId.trim() : '';
    if (documentId) {
      conversationMemoryStore.addLarkDoc(conversationKey, {
        title: typeof latestDoc.title === 'string' ? latestDoc.title : 'Lark Doc',
        documentId,
        url: typeof latestDoc.url === 'string' ? latestDoc.url : undefined,
      });
    }
  }

  const latestEvent = record.latestLarkCalendarEvent;
  if (latestEvent && typeof latestEvent === 'object' && !Array.isArray(latestEvent)) {
    const eventId = typeof latestEvent.eventId === 'string' ? latestEvent.eventId.trim() : '';
    if (eventId) {
      conversationMemoryStore.addLarkCalendarEvent(conversationKey, {
        eventId,
        calendarId: typeof latestEvent.calendarId === 'string' ? latestEvent.calendarId : undefined,
        summary: typeof latestEvent.summary === 'string' ? latestEvent.summary : undefined,
        startTime: typeof latestEvent.startTime === 'string' ? latestEvent.startTime : undefined,
        endTime: typeof latestEvent.endTime === 'string' ? latestEvent.endTime : undefined,
        url: typeof latestEvent.url === 'string' ? latestEvent.url : undefined,
      });
    }
  }

  const latestTask = record.latestLarkTask;
  if (latestTask && typeof latestTask === 'object' && !Array.isArray(latestTask)) {
    const taskId = typeof latestTask.taskId === 'string' ? latestTask.taskId.trim() : '';
    if (taskId) {
      conversationMemoryStore.addLarkTask(conversationKey, {
        taskId,
        taskGuid: typeof latestTask.taskGuid === 'string' ? latestTask.taskGuid : undefined,
        summary: typeof latestTask.summary === 'string' ? latestTask.summary : undefined,
        status: typeof latestTask.status === 'string' ? latestTask.status : undefined,
        url: typeof latestTask.url === 'string' ? latestTask.url : undefined,
      });
    }
  }
};

const buildSystemPrompt = (input: {
  conversationKey: string;
  runtime: VercelRuntimeRequestContext;
  routerAcknowledgement?: string;
  childRouteHints?: DesktopChildRoute;
  latestUserMessage?: string;
  hasAttachedFiles?: boolean;
  threadSummary?: DesktopThreadSummary;
  taskState?: DesktopTaskState;
}) => {
  const retrievalGuidance = input.latestUserMessage?.trim()
    ? retrievalOrchestratorService.buildPromptGuidance({
      messageText: input.latestUserMessage,
      hasAttachments: input.hasAttachedFiles,
    })
    : [];
  const parts = [
    'You are the Vercel AI SDK runtime for a tool-using assistant.',
    'Use the available comprehensive tools directly.',
    'Do not refer to Mastra, LangGraph, workflows, or internal orchestration.',
    'If the user describes a repeatable process, wants to save it for later, wants to make it reusable, asks to schedule it, asks to list saved prompts/workflows, or asks to run a saved workflow, prefer the dedicated workflow authoring tools over ad hoc execution.',
    'If a workflow authoring tool returns missing_input, ask the user exactly for that missing detail instead of guessing.',
    'Do not assume an existing saved workflow satisfies a new scheduling or reusable-workflow request unless the user explicitly names that workflow, gives its id, or clearly says to edit/update the current one.',
    'If the user asks to schedule "a workflow" or describes a recurring process without naming an existing saved workflow, treat it as planning/creation work: gather missing details, plan it, or ask a clarification question instead of claiming an old workflow already covers it.',
    'Use workflow listing and existing-workflow reuse only when the user is explicitly asking about saved workflows or references a specific saved workflow by name/id.',
    ...buildWorkspaceAwarePromptSections({
      workspace: input.runtime.workspace,
      approvalPolicySummary: input.runtime.desktopApprovalPolicySummary,
      latestActionResult: input.runtime.latestActionResult,
      availability: input.runtime.desktopExecutionAvailability ?? (input.runtime.workspace ? 'available' : 'unknown'),
    }),
    'For specialized or complex workflows, first search relevant skills with the skillSearch tool, read the chosen skill, and then proceed with the task.',
    'If a request might be about reusable workflow creation, recurring scheduling, save-for-later behavior, or the right scheduling/calendar route is unclear, search skills before guessing.',
  ];

  if (input.runtime.departmentName) {
    parts.push(`Active department: ${input.runtime.departmentName}.`);
  }
  if (input.runtime.departmentRoleSlug) {
    parts.push(`Requester department role: ${input.runtime.departmentRoleSlug}.`);
  }
  if (input.runtime.departmentSystemPrompt?.trim()) {
    parts.push('Department instructions:', input.runtime.departmentSystemPrompt.trim());
  }
  if (input.runtime.departmentSkillsMarkdown?.trim()) {
    parts.push(
      'Legacy department skills fallback context (use skillSearch for the structured skill flow first):',
      input.runtime.departmentSkillsMarkdown.trim(),
    );
  }
  if (input.runtime.dateScope) {
    parts.push(`Inferred date scope: ${input.runtime.dateScope}.`);
  }
  if (input.latestUserMessage?.trim()) {
    parts.push(
      `Latest live user request: ${input.latestUserMessage.trim()}`,
      'If older history, thread summary, or prior assistant conclusions conflict with the latest live user request, the latest live user request wins.',
    );
  }
  if (isWorkflowLikeRequest(input.latestUserMessage) && !hasSpecificWorkflowReference(input.latestUserMessage)) {
    parts.push(
      'Current turn note: this is a fresh workflow planning/scheduling request, not a confirmed reference to a specific saved workflow.',
      'Do not satisfy this turn by reusing or describing an older saved workflow unless a tool lookup confirms the exact match and the user clearly agrees that it is the same workflow.',
      'If required schedule, destination, or workflow-definition details are missing, ask for them or use workflow planning tools to gather them.',
    );
  }
  const threadSummaryContext = input.threadSummary ? buildThreadSummaryContext(input.threadSummary) : null;
  if (threadSummaryContext) {
    parts.push(threadSummaryContext);
  }
  const taskStateContext = input.taskState ? buildTaskStateContext(input.taskState) : null;
  if (taskStateContext) {
    parts.push(taskStateContext);
  }
  const refsContext = buildConversationRefsContext(input.conversationKey);
  if (refsContext) {
    parts.push(refsContext);
  }
  if (input.routerAcknowledgement?.trim()) {
    parts.push(
      `The user has already seen this short intake acknowledgement: "${input.routerAcknowledgement.trim()}"`,
      'Do not repeat that acknowledgement verbatim. Continue from it and focus on execution.',
    );
  }
  if (input.childRouteHints) {
    parts.push(
      'Child router guidance for this turn:',
      JSON.stringify({
        route: input.childRouteHints.route,
        reason: input.childRouteHints.reason ?? null,
        normalizedIntent: input.childRouteHints.normalizedIntent ?? null,
        suggestedToolIds: input.childRouteHints.suggestedToolIds ?? [],
        suggestedSkillQuery: input.childRouteHints.suggestedSkillQuery ?? null,
        suggestedActions: input.childRouteHints.suggestedActions ?? [],
      }),
      'Use these hints to choose the correct next tools when they fit the request and available permissions.',
    );
  }
  if (retrievalGuidance.length > 0) {
    parts.push('Retrieval portfolio guidance for this request:', ...retrievalGuidance);
  }
  parts.push(`Conversation key: ${input.conversationKey}.`);
  return parts.join('\n');
};

const findPendingApproval = (
  steps: Array<{ toolResults?: Array<{ output: unknown }> }>,
): PendingApprovalAction | null => {
  for (const step of steps) {
    for (const result of step.toolResults ?? []) {
      const output = result.output as VercelToolEnvelope | undefined;
      if (output?.pendingApprovalAction) {
        return output.pendingApprovalAction;
      }
    }
  }
  return null;
};

const stopOnPendingApproval = ({
  steps,
}: {
  steps: Array<{ toolResults?: Array<{ output: unknown }> }>;
}): boolean => Boolean(findPendingApproval(steps));

const findBlockingUserInput = (
  steps: Array<{ toolResults?: Array<{ output: unknown }> }>,
): VercelToolEnvelope | null => {
  for (const step of steps) {
    for (const result of step.toolResults ?? []) {
      const output = result.output as VercelToolEnvelope | undefined;
      if (output?.errorKind === 'missing_input') {
        return output;
      }
    }
  }
  return null;
};

const stopOnBlockingUserInput = ({
  steps,
}: {
  steps: Array<{ toolResults?: Array<{ output: unknown }> }>;
}): boolean => Boolean(findBlockingUserInput(steps));

const toClarificationQuestion = (value: string | null | undefined): string | null => {
  const raw = summarizeText(value, 500)?.trim();
  if (!raw) {
    return null;
  }
  const normalized = raw.replace(/\s+/g, ' ').trim();
  const lower = normalized.toLowerCase();

  if (lower.includes('requires title and markdown')) {
    return 'Please send the document title and the markdown content you want in the Lark doc.';
  }
  if (lower.includes('need both a dayofweek and time') || lower.includes('need both a weekday and time')) {
    return 'Which weekday and time should this run?';
  }
  if (lower.startsWith('ask the user ')) {
    const rewritten = normalized.replace(/^Ask the user\s+/i, '').replace(/\.$/, '');
    if (/^(which|what|when|where|who|how)\b/i.test(rewritten)) {
      return `${rewritten}?`.replace(/\?\?$/, '?');
    }
    return `Please ${rewritten}.`;
  }
  if (lower.startsWith('please provide ')) {
    const rewritten = normalized.replace(/^Please provide\s+/i, '').replace(/\.$/, '');
    return `Please provide ${rewritten}.`;
  }
  if (lower.includes('requires ')) {
    const requirement = normalized.replace(/^.*?requires?\s+/i, '').replace(/\.$/, '');
    return `Please provide ${requirement}.`;
  }
  return null;
};

const buildMissingInputResponseText = (output: VercelToolEnvelope | null | undefined): string | null => {
  if (!output) {
    return null;
  }
  const question = toClarificationQuestion(output.userAction) ?? toClarificationQuestion(output.summary);
  if (question) {
    return [
      'I need a bit more information before I can finish this.',
      '',
      question,
    ].join('\n');
  }
  const action = summarizeText(output.userAction, 400);
  const summary = summarizeText(output.summary, 500);
  if (action) {
    return [
      'I need a bit more information before I can finish this.',
      '',
      action,
    ].join('\n');
  }
  if (summary) {
    return [
      'I need a bit more information before I can finish this.',
      '',
      summary,
    ].join('\n');
  }
  return null;
};

const buildLarkStatusText = (input: {
  task: OrchestrationTaskDTO;
  message: NormalizedIncomingMessageDTO;
  phase: 'received' | 'preparing' | 'planning' | 'tool_running' | 'tool_done' | 'analyzing' | 'approval' | 'failed';
  detail?: string;
  history: string[];
  heartbeatNote?: string;
}) => {
  void input.task;
  void input.message;
  void input.history;

  const detail = input.detail?.trim();
  const withDetail = (prefix: string): string => (detail ? `${prefix}: ${detail}` : prefix);

  if (input.phase === 'received') {
    return 'Working on it.';
  }
  if (input.phase === 'preparing') {
    return 'Getting things ready.';
  }
  if (input.phase === 'planning') {
    return withDetail('Working on it');
  }
  if (input.phase === 'tool_running') {
    return withDetail('Fetching results');
  }
  if (input.phase === 'tool_done') {
    return 'Still working on it.';
  }
  if (input.phase === 'analyzing') {
    return 'Putting the answer together.';
  }
  if (input.phase === 'approval') {
    return detail ? `Approval needed: ${detail}` : 'Approval needed.';
  }
  return input.heartbeatNote?.trim() || detail || 'Something went wrong.';
};

const buildLarkApprovalActions = (pendingApproval: PendingApprovalAction): ChannelAction[] => {
  if (pendingApproval.kind !== 'tool_action') {
    return [];
  }
  return [
    {
      id: 'hitl_approve',
      label: 'Approve',
      style: 'primary',
      value: {
        kind: 'hitl_tool_action',
        actionId: pendingApproval.approvalId,
        decision: 'confirmed',
      },
    },
    {
      id: 'hitl_reject',
      label: 'Reject',
      style: 'danger',
      value: {
        kind: 'hitl_tool_action',
        actionId: pendingApproval.approvalId,
        decision: 'cancelled',
      },
    },
  ];
};

const mapToolStepsToAgentResults = (
  steps: Array<{ toolResults?: Array<{ toolName?: string; output?: unknown }> }>,
): AgentResultDTO[] =>
  steps.flatMap((step) =>
    (step.toolResults ?? []).map((toolResult, index) => {
      const output = toolResult.output as VercelToolEnvelope | undefined;
      const toolName = toolResult.toolName ?? `tool-${index + 1}`;
      return {
        taskId: '',
        agentKey: toolName,
        status: output?.success ? 'success' : 'failed',
        message: output?.summary ?? `${toolName} completed.`,
        result: output?.fullPayload ?? output?.keyData,
        error: output?.success
          ? undefined
          : {
            type: 'TOOL_ERROR',
            classifiedReason: output?.errorKind ?? 'tool_failed',
            rawMessage: output?.summary,
            retriable: output?.retryable ?? false,
          },
        metrics: { apiCalls: 1 },
      } satisfies AgentResultDTO;
    }),
  );

const adaptPlanForVercel = (task: OrchestrationTaskDTO): OrchestrationTaskDTO => ({
  ...task,
  plan: task.plan.map((step) => (step === 'agent.invoke.lark-response' ? 'delivery.lark-status' : step)),
});

const resolveRuntimeContext = async (
  task: OrchestrationTaskDTO,
  message: NormalizedIncomingMessageDTO,
  persistentThreadId?: string,
  taskState?: DesktopTaskState,
): Promise<VercelRuntimeRequestContext> => {
  const companyId = message.trace?.companyId;
  if (!companyId) {
    throw new Error('Missing companyId for Vercel runtime.');
  }

  const requesterAiRole = message.trace?.userRole ?? 'MEMBER';
  const fallbackAllowedToolIds = await toolPermissionService.getAllowedTools(companyId, requesterAiRole);
  const linkedUserId = message.trace?.linkedUserId ?? message.userId;
  let departmentId: string | undefined;
  let departmentName: string | undefined;
  let departmentRoleSlug: string | undefined;
  let departmentSystemPrompt: string | undefined;
  let departmentSkillsMarkdown: string | undefined;
  let allowedToolIds = fallbackAllowedToolIds;
  let allowedActionsByTool: Record<string, string[]> | undefined;
  const desktopAvailability = linkedUserId
    ? desktopWsGateway.getRemoteExecutionAvailability(linkedUserId, companyId)
    : { status: 'none' as const };
  const activeWorkspace = desktopAvailability.status === 'available'
    ? desktopAvailability.session?.activeWorkspace
    : undefined;

  if (linkedUserId) {
    const departments = await departmentService.listUserDepartments(linkedUserId, companyId);
    const autoDepartment = departments.length === 1 ? departments[0] : null;
    const resolved = await departmentService.resolveRuntimeContext({
      userId: linkedUserId,
      companyId,
      departmentId: autoDepartment?.id,
      fallbackAllowedToolIds,
    });
    departmentId = resolved.departmentId;
    departmentName = resolved.departmentName;
    departmentRoleSlug = resolved.departmentRoleSlug;
    departmentSystemPrompt = resolved.systemPrompt;
    departmentSkillsMarkdown = resolved.skillsMarkdown;
    allowedToolIds = resolved.allowedToolIds;
    allowedActionsByTool = resolved.allowedActionsByTool;
  }

  return {
    channel: 'lark',
    threadId: persistentThreadId ?? buildConversationKey(message),
    chatId: message.chatId,
    attachedFiles: message.attachedFiles,
    executionId: task.taskId,
    companyId,
    userId: linkedUserId,
    requesterAiRole,
    requesterEmail: message.trace?.requesterEmail,
    departmentId,
    departmentName,
    departmentRoleSlug,
    larkTenantKey: message.trace?.larkTenantKey,
    larkOpenId: message.trace?.larkOpenId,
    larkUserId: message.trace?.larkUserId,
    authProvider: 'lark',
    mode: LARK_VERCEL_MODE,
    taskState,
    workspace: activeWorkspace
      ? {
          name: activeWorkspace.name,
          path: activeWorkspace.path,
        }
      : undefined,
    desktopExecutionAvailability: desktopAvailability.status,
    desktopApprovalPolicySummary: desktopWsGateway.getPolicySummary(linkedUserId, companyId),
    dateScope: inferDateScope(message.text),
    allowedToolIds: allowedToolIds.filter((toolId) => !LARK_BLOCKED_TOOL_IDS.has(toolId)),
    allowedActionsByTool: allowedActionsByTool
      ? Object.fromEntries(
        Object.entries(allowedActionsByTool).filter(([toolId]) => !LARK_BLOCKED_TOOL_IDS.has(toolId)),
      )
      : undefined,
    departmentSystemPrompt,
    departmentSkillsMarkdown,
  };
};

const executeLarkVercelTask = async (
  task: OrchestrationTaskDTO,
  message: NormalizedIncomingMessageDTO,
): Promise<OrchestrationExecutionResult> => {
  const adapter = resolveChannelAdapter('lark');
  const companyId = message.trace?.companyId;
  const linkedUserId = message.trace?.linkedUserId;
  const persistentThread = companyId && linkedUserId
    ? await desktopThreadsService.findOrCreateLarkLifetimeThread(linkedUserId, companyId)
    : null;
  const conversationKey = persistentThread
    ? buildPersistentLarkConversationKey(persistentThread.id)
    : buildConversationKey(message);
  const statusHistory: string[] = [];
  let currentStatusPhase: 'received' | 'preparing' | 'planning' | 'tool_running' | 'tool_done' | 'analyzing' | 'approval' | 'failed' = 'received';
  let currentStatusDetail: string | undefined;
  let currentStatusActions: ChannelAction[] | undefined;
  let heartbeatIndex = 0;
  const statusCoordinator = new LarkStatusCoordinator({
    adapter,
    chatId: message.chatId,
    correlationId: task.taskId,
    initialStatusMessageId: message.trace?.statusMessageId,
  });
  const renderCurrentStatus = (heartbeat = false): { text: string; actions?: ChannelAction[] } => ({
    text: buildLarkStatusText({
      task,
      message,
      phase: currentStatusPhase,
      detail: currentStatusDetail,
      history: statusHistory,
      heartbeatNote: heartbeat
        ? LARK_STATUS_HEARTBEAT_MESSAGES[heartbeatIndex++ % LARK_STATUS_HEARTBEAT_MESSAGES.length]
        : undefined,
    }),
    actions: currentStatusActions,
  });
  const updateStatus = async (
    phase: typeof currentStatusPhase,
    detail?: string,
    actions?: ChannelAction[],
    options?: { force?: boolean },
  ) => {
    currentStatusPhase = phase;
    currentStatusDetail = detail;
    currentStatusActions = actions;
    await statusCoordinator.update(renderCurrentStatus(false), options);
  };

  await updateStatus('preparing');
  statusCoordinator.startHeartbeat(() => renderCurrentStatus(true));

  const currentAttachments = (message.attachedFiles ?? []) as AttachedFileRef[];
  let persistedUserMessageId: string | undefined;
  let activeThreadSummary = parseDesktopThreadSummary(null);
  let activeTaskState = createEmptyTaskState();
  if (persistentThread) {
    const threadMemory = await loadLarkThreadMemory(persistentThread.id, linkedUserId);
    activeThreadSummary = threadMemory.summary;
    activeTaskState = threadMemory.taskState;
    if (currentAttachments.length > 0) {
      activeTaskState = upsertDesktopSourceArtifacts({
        taskState: activeTaskState,
        artifacts: buildSourceArtifactEntriesFromAttachments(currentAttachments),
      });
    }
    const userMessage = await desktopThreadsService.addOwnedThreadMessage(
      persistentThread.id,
      linkedUserId,
      'user',
      message.text,
      {
        channel: 'lark',
        lark: {
          chatId: message.chatId,
          chatType: message.chatType,
          inboundMessageId: message.messageId,
          larkTenantKey: message.trace?.larkTenantKey ?? null,
          larkOpenId: message.trace?.larkOpenId ?? null,
          larkUserId: message.trace?.larkUserId ?? null,
          channelIdentityId: message.trace?.channelIdentityId ?? null,
          requesterEmail: message.trace?.requesterEmail ?? null,
        },
        ...(message.attachedFiles?.length ? { attachedFiles: message.attachedFiles } : {}),
      },
      {
        requiredChannel: 'lark',
        contextLimit: LARK_THREAD_CONTEXT_MESSAGE_LIMIT,
      },
    );
    persistedUserMessageId = userMessage.id;
  } else {
    conversationMemoryStore.addUserMessage(conversationKey, message.messageId, message.text);
  }

  const runtime = await resolveRuntimeContext(task, message, persistentThread?.id, activeTaskState);
  await resetLatestAgentRunLog(task.taskId, {
    channel: 'lark',
    entrypoint: 'lark_message',
    taskId: task.taskId,
    threadId: persistentThread?.id ?? message.chatId,
    companyId: runtime.companyId,
    userId: linkedUserId ?? null,
    message: message.text,
    workspace: runtime.workspace ?? null,
  });
  statusHistory.push('Context ready.');
  const contextMessages = persistentThread
    ? await (async () => {
      const cachedContext = await desktopThreadsService.getCachedOwnedThreadContext(
        persistentThread.id,
        linkedUserId!,
        LARK_THREAD_CONTEXT_MESSAGE_LIMIT,
      );
      const hydrationVersion = `${cachedContext.cachedAt}:${cachedContext.messages[cachedContext.messages.length - 1]?.id ?? 'empty'}`;
      if (larkConversationHydrationVersions.get(conversationKey) !== hydrationVersion) {
        for (const entry of cachedContext.messages) {
          if (entry.role === 'user') {
            conversationMemoryStore.addUserMessage(conversationKey, entry.id, entry.content);
          } else {
            conversationMemoryStore.addAssistantMessage(conversationKey, entry.id, entry.content);
            if (entry.metadata && typeof entry.metadata === 'object' && !Array.isArray(entry.metadata)) {
              hydrateConversationRefsFromMetadata(conversationKey, entry.metadata as Record<string, unknown>);
            }
          }
        }
        larkConversationHydrationVersions.set(conversationKey, hydrationVersion);
      }
      return cachedContext.messages.map((entry) => ({
        id: entry.id,
        role: entry.role === 'assistant' ? 'assistant' : 'user',
        content: entry.content,
      })) as Array<ModelMessage & { id?: string }>;
    })()
    : conversationMemoryStore.getContextMessages(conversationKey).map((entry) => ({
      role: entry.role,
      content: entry.content,
    })) as Array<ModelMessage & { id?: string }>;

  const childRoute = await runDesktopChildRouter({
    executionId: task.taskId,
    threadId: persistentThread?.id ?? message.chatId,
    message: message.text,
    workspace: runtime.workspace,
    approvalPolicySummary: runtime.desktopApprovalPolicySummary,
    companyId: runtime.companyId,
    userId: linkedUserId ?? undefined,
    allowedToolIds: runtime.allowedToolIds,
    allowedActionsByTool: runtime.allowedActionsByTool,
    departmentSystemPrompt: runtime.departmentSystemPrompt,
    departmentSkillsMarkdown: runtime.departmentSkillsMarkdown,
    taskState: activeTaskState,
    threadSummary: activeThreadSummary,
    history: filterThreadMessagesForContext(contextMessages.map((entry) => ({
      role: entry.role === 'assistant' ? 'assistant' : 'user',
      content: typeof entry.content === 'string' ? entry.content : flattenModelContent(entry.content),
    }))).slice(-6),
    requesterEmail: message.trace?.requesterEmail,
  });

  if (childRoute.route === 'fast_reply' && childRoute.reply?.trim()) {
    const reply = childRoute.reply.trim();
    statusHistory.push('Handled directly by child router.');
    await statusCoordinator.replace(reply, []);
    const statusMessageId = statusCoordinator.getStatusMessageId();
    conversationMemoryStore.addAssistantMessage(conversationKey, task.taskId, reply);
    if (persistentThread) {
      await desktopThreadsService.addOwnedThreadMessage(
        persistentThread.id,
        linkedUserId,
        'assistant',
        reply,
        {
          channel: 'lark',
          lark: {
            chatId: message.chatId,
            outboundMessageId: statusMessageId ?? null,
            statusMessageId: statusMessageId ?? null,
            correlationId: task.taskId,
          },
        },
        {
          requiredChannel: 'lark',
          contextLimit: LARK_THREAD_CONTEXT_MESSAGE_LIMIT,
        },
      );
      const refreshedSummary = await refreshDesktopThreadSummary({
        messages: [
          ...contextMessages.map((entry) => ({
            role: entry.role === 'assistant' ? 'assistant' : 'user',
            content: flattenModelContent(entry.content),
          })),
          {
            role: 'assistant',
            content: reply,
          },
        ],
        taskState: activeTaskState,
        currentSummary: activeThreadSummary,
      });
      await persistLarkThreadMemory({
        threadId: persistentThread.id,
        userId: linkedUserId,
        summary: refreshedSummary,
        taskState: activeTaskState,
      });
    }
    if (linkedUserId) {
      const childRouterPrompt = [
        'Lark child router handled this turn directly.',
        `Latest user message: ${message.text}`,
      ].join('\n');
      const childRouterModel = await resolveVercelChildRouterModel();
      const estimatedInputTokens = estimateTokens(childRouterPrompt);
      const estimatedOutputTokens = estimateTokens(reply);
      await aiTokenUsageService.record({
        userId: linkedUserId,
        companyId: runtime.companyId,
        agentTarget: 'lark.child_router',
        modelId: childRouterModel.effectiveModelId,
        provider: childRouterModel.effectiveProvider,
        channel: 'lark',
        threadId: persistentThread?.id,
        estimatedInputTokens,
        estimatedOutputTokens,
        actualInputTokens: estimatedInputTokens,
        actualOutputTokens: estimatedOutputTokens,
        wasCompacted: false,
        mode: 'fast',
      });
    }
    await appendLatestAgentRunLog(task.taskId, 'run.completed', {
      channel: 'lark',
      route: 'fast_reply',
      threadId: persistentThread?.id ?? message.chatId,
      finalText: reply,
    });

    return {
      task,
      status: 'done',
      currentStep: 'child_router.fast_reply',
      latestSynthesis: reply,
      agentResults: [],
      runtimeMeta: {
        engine: 'vercel',
        threadId: persistentThread?.id,
        node: 'child_router.fast_reply',
        stepHistory: task.plan,
      },
    };
  }

  const routerAcknowledgement = childRoute.route === 'fast_reply'
    ? undefined
    : childRoute.acknowledgement?.trim() || 'I’ll handle that now and keep it moving for you.';
  statusHistory.push('Context ready.');
  await updateStatus(
    'planning',
    routerAcknowledgement ?? 'Choosing the right tools and approach for this request.',
  );

  const tools = createVercelDesktopTools(runtime, {
    onToolStart: async (_toolName, _activityId, title) => {
      await appendLatestAgentRunLog(task.taskId, 'tool.start', {
        toolName: _toolName,
        activityId: _activityId,
        title,
        channel: 'lark',
        threadId: persistentThread?.id ?? message.chatId,
      });
      statusHistory.push(`Started ${title}`);
      await updateStatus('tool_running', `Using ${title}.`);
    },
    onToolFinish: async (toolName, _activityId, title, output) => {
      await appendLatestAgentRunLog(task.taskId, 'tool.finish', {
        toolName,
        activityId: _activityId,
        title,
        output,
        channel: 'lark',
        threadId: persistentThread?.id ?? message.chatId,
      });
      const summary = summarizeText(output.summary, 180) ?? output.summary;
      statusHistory.push(`${output.success ? 'Completed' : 'Failed'} ${title}: ${summary}`);
      await updateStatus('tool_done', `${title}: ${summary}`);
    },
  });
  const resolvedModel = await resolveVercelLanguageModel(runtime.mode);
  const contextClass = chooseLarkContextClass({
    latestUserMessage: message.text,
    taskState: activeTaskState,
    threadSummary: activeThreadSummary,
    historyMessageCount: contextMessages.length,
  });
  const systemPrompt = buildSystemPrompt({
    conversationKey,
    runtime,
    routerAcknowledgement,
    childRouteHints: childRoute,
    latestUserMessage: message.text,
    hasAttachedFiles: currentAttachments.length > 0,
    threadSummary: activeThreadSummary,
    taskState: activeTaskState,
  });
  const budget = resolveLarkContextBudget({
    resolvedModel,
    contextClass,
  });
  const reservedTokens =
    estimateTokens(systemPrompt)
    + estimateTokens(message.text)
    + (currentAttachments.length > 0 ? 8_000 : 1_500);
  const historySelection = buildAdaptiveLarkHistoryMessages({
    messages: contextMessages,
    targetBudgetTokens: budget.targetContextBudget,
    reservedTokens,
    contextClass,
  });
  logger.info('lark.context.summary', {
    taskId: task.taskId,
    threadId: persistentThread?.id ?? message.chatId,
    contextClass,
    modelId: budget.modelId,
    usableContextBudget: budget.usableContextBudget,
    targetContextBudget: budget.targetContextBudget,
    includedRawMessageCount: historySelection.includedRawMessageCount,
    includedThreadSummary: activeThreadSummary.sourceMessageCount > 0,
    includedTaskState:
      activeTaskState.completedMutations.length > 0
      || activeTaskState.activeSourceArtifacts.length > 0
      || Boolean(activeTaskState.pendingApproval)
      || Boolean(activeTaskState.activeObjective),
    compactionTier: historySelection.compactionTier,
  });
  await appendLatestAgentRunLog(task.taskId, 'lark.context.summary', {
    threadId: persistentThread?.id ?? message.chatId,
    contextClass,
    modelId: budget.modelId,
    usableContextBudget: budget.usableContextBudget,
    targetContextBudget: budget.targetContextBudget,
    includedRawMessageCount: historySelection.includedRawMessageCount,
    includedThreadSummary: activeThreadSummary.sourceMessageCount > 0,
    includedTaskState:
      activeTaskState.completedMutations.length > 0
      || activeTaskState.activeSourceArtifacts.length > 0
      || Boolean(activeTaskState.pendingApproval)
      || Boolean(activeTaskState.activeObjective),
    compactionTier: historySelection.compactionTier,
  });
  let inputMessages = historySelection.messages.map(({ role, content, id }) => ({ role, content, id })) as Array<ModelMessage & { id?: string }>;
  if (currentAttachments.length > 0) {
    const visionParts = await buildVisionContent({
      userMessage: message.text,
      attachedFiles: currentAttachments,
      companyId: runtime.companyId,
      requesterUserId: runtime.userId,
      requesterAiRole: runtime.requesterAiRole,
    });
    if (persistentThread && persistedUserMessageId) {
      let replacedCurrentMessage = false;
      inputMessages = historySelection.messages.map((entry, index) => {
        const shouldReplace = index === historySelection.messages.length - 1 && entry.id === persistedUserMessageId;
        if (shouldReplace) {
          replacedCurrentMessage = true;
        }
        return shouldReplace
          ? { role: 'user', content: visionParts as ModelMessage['content'] }
          : { role: entry.role, content: entry.content };
      }) as ModelMessage[];
      if (!replacedCurrentMessage) {
        inputMessages = [
          ...historySelection.messages.map(({ role, content }) => ({ role, content })),
          { role: 'user', content: visionParts as ModelMessage['content'] },
        ];
      }
    } else {
      inputMessages = [
        ...historySelection.messages.map(({ role, content }) => ({ role, content })),
        { role: 'user', content: visionParts as ModelMessage['content'] },
      ];
    }
  } else if (message.text.trim()) {
    const hasCurrentUserTurn = persistentThread
      ? inputMessages.some((entry) => entry.id === persistedUserMessageId)
      : false;
    if (!persistentThread || !hasCurrentUserTurn) {
      inputMessages = [
        ...inputMessages.map(({ role, content }) => ({ role, content })),
        { role: 'user', content: message.text },
      ];
    }
  }

  try {
    const primaryMessages = inputMessages.length > 0
      ? inputMessages
      : [{ role: 'user', content: message.text }];
    await appendLatestAgentRunLog(task.taskId, 'llm.context', {
      phase: 'lark_generate',
      threadId: persistentThread?.id ?? message.chatId,
      systemPrompt,
      messages: primaryMessages.map((entry, index) => ({
        index,
        role: entry.role,
        content: typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content),
      })),
      runtime: {
        allowedToolIds: runtime.allowedToolIds,
        allowedActionsByTool: runtime.allowedActionsByTool ?? {},
        departmentName: runtime.departmentName ?? null,
        departmentRoleSlug: runtime.departmentRoleSlug ?? null,
        routerAcknowledgement: routerAcknowledgement ?? null,
        threadSummary: activeThreadSummary,
        taskState: activeTaskState,
        contextClass,
      },
    });
    let result;
    try {
      result = await runWithModelCircuitBreaker(resolvedModel.effectiveProvider, 'lark_generate', () => generateText({
        model: resolvedModel.model,
        system: systemPrompt,
        messages: primaryMessages,
        tools,
        temperature: config.OPENAI_TEMPERATURE,
        providerOptions: {
          google: {
            thinkingConfig: {
              includeThoughts: true,
              thinkingLevel: resolvedModel.thinkingLevel,
            },
          },
        },
        stopWhen: [stopOnPendingApproval, stopOnBlockingUserInput, stepCountIs(20)],
      }));
    } catch (error) {
      if (!isProviderInvalidArgumentError(error)) {
        throw error;
      }

      const sanitizedMessages = sanitizeMessagesForProviderRetry(primaryMessages, message.text);
      logger.warn('lark.generate.retry_with_sanitized_messages', {
        taskId: task.taskId,
        messageId: message.messageId,
        originalMessageCount: primaryMessages.length,
        sanitizedMessageCount: sanitizedMessages.length,
        originalLatestUserLength: message.text.length,
        sanitizedLatestUserLength: typeof sanitizedMessages[sanitizedMessages.length - 1]?.content === 'string'
          ? sanitizedMessages[sanitizedMessages.length - 1]!.content.length
          : 0,
        error: error instanceof Error ? error.message : 'invalid_argument',
      });
      result = await runWithModelCircuitBreaker(resolvedModel.effectiveProvider, 'lark_generate_sanitized_retry', () => generateText({
        model: resolvedModel.model,
        system: systemPrompt,
        messages: sanitizedMessages,
        tools,
        temperature: config.OPENAI_TEMPERATURE,
        providerOptions: {
          google: {
            thinkingConfig: {
              includeThoughts: true,
              thinkingLevel: resolvedModel.thinkingLevel,
            },
          },
        },
        stopWhen: [stopOnPendingApproval, stopOnBlockingUserInput, stepCountIs(20)],
      }));
    }
    logger.info('vercel.tool_loop.summary', {
      mode: runtime.mode,
      modelId: resolvedModel.effectiveModelId,
      stepCount: Array.isArray(result.steps) ? result.steps.length : 0,
      stepLimit: 20,
      hitStepLimit: Array.isArray(result.steps) ? result.steps.length >= 20 : false,
      channel: 'lark',
    });

    const steps = result.steps as Array<{ toolResults?: Array<{ toolName?: string; output?: unknown }> }>;
    const pendingApproval = findPendingApproval(steps as Array<{ toolResults?: Array<{ output: unknown }> }>);
    const blockingUserInput = findBlockingUserInput(steps as Array<{ toolResults?: Array<{ output: unknown }> }>);
    const finalText = blockingUserInput
      ? ((buildMissingInputResponseText(blockingUserInput) ?? result.text.trim()) || 'I need one more detail from you before I can continue.')
      : pendingApproval
      ? `Approval required before continuing: ${pendingApproval.kind === 'run_command' ? pendingApproval.command : pendingApproval.kind}.`
      : result.text.trim() || 'Done.';

    statusHistory.push('Execution complete. Preparing the final response.');
    await updateStatus('analyzing', 'Finalizing the response for you.');

    if (pendingApproval) {
      statusHistory.push(`Approval required: ${pendingApproval.kind}`);
      await updateStatus(
        'approval',
        pendingApproval.kind === 'tool_action'
          ? summarizeText(pendingApproval.summary, 220) ?? finalText
          : finalText,
        buildLarkApprovalActions(pendingApproval),
        { force: true, terminal: true },
      );
    } else {
      await statusCoordinator.replace(finalText, []);
    }

    const statusMessageId = statusCoordinator.getStatusMessageId();
    if (!pendingApproval) {
      conversationMemoryStore.addAssistantMessage(conversationKey, task.taskId, finalText);
    }
    if (linkedUserId) {
      const effectiveMessages = inputMessages.length > 0
        ? inputMessages
        : [{ role: 'user', content: message.text }];
      const estimatedInputTokens = estimateTokens(systemPrompt) + estimateMessageTokens(effectiveMessages);
      const estimatedOutputTokens = estimateTokens(finalText);
      await aiTokenUsageService.record({
        userId: linkedUserId,
        companyId: runtime.companyId,
        agentTarget: 'lark.vercel',
        modelId: resolvedModel.effectiveModelId,
        provider: resolvedModel.effectiveProvider,
        channel: 'lark',
        threadId: persistentThread?.id,
        estimatedInputTokens,
        estimatedOutputTokens,
        actualInputTokens: estimatedInputTokens,
        actualOutputTokens: estimatedOutputTokens,
        wasCompacted: historySelection.compactionTier > 1,
        mode: runtime.mode,
      });
    }

    if (persistentThread) {
      const conversationRefs = buildPersistedConversationRefs(conversationKey);
      await desktopThreadsService.addOwnedThreadMessage(
        persistentThread.id,
        linkedUserId,
        'assistant',
        finalText,
        {
          channel: 'lark',
          lark: {
            chatId: message.chatId,
            outboundMessageId: statusMessageId ?? null,
            statusMessageId: statusMessageId ?? null,
            correlationId: task.taskId,
          },
          ...(pendingApproval ? { pendingApproval: { kind: pendingApproval.kind, approvalId: pendingApproval.kind === 'tool_action' ? pendingApproval.approvalId : null } } : {}),
          ...(conversationRefs ? { conversationRefs } : {}),
        },
        {
          requiredChannel: 'lark',
          contextLimit: LARK_THREAD_CONTEXT_MESSAGE_LIMIT,
        },
      );
    }

    const agentResults = mapToolStepsToAgentResults(steps).map((entry) => ({
      ...entry,
      taskId: task.taskId,
    }));
    for (const step of steps) {
      for (const toolResult of step.toolResults ?? []) {
        const output = toolResult.output as VercelToolEnvelope | undefined;
        if (!output) continue;
        activeTaskState = updateTaskStateFromToolEnvelope({
          taskState: activeTaskState,
          toolName: toolResult.toolName ?? 'unknown-tool',
          output,
          latestObjective: message.text,
        });
      }
    }
    if (persistentThread) {
      const refreshedSummary = await refreshDesktopThreadSummary({
        messages: [
          ...contextMessages.map((entry) => ({
            role: entry.role === 'assistant' ? 'assistant' : 'user',
            content: flattenModelContent(entry.content),
          })),
          {
            role: 'assistant',
            content: finalText,
          },
        ],
        taskState: activeTaskState,
        currentSummary: activeThreadSummary,
      });
      await persistLarkThreadMemory({
        threadId: persistentThread.id,
        userId: linkedUserId,
        summary: refreshedSummary,
        taskState: activeTaskState,
      });
      activeThreadSummary = refreshedSummary;
    }
    await appendLatestAgentRunLog(task.taskId, pendingApproval ? 'run.waiting_for_approval' : 'run.completed', {
      channel: 'lark',
      route: childRoute.route,
      threadId: persistentThread?.id ?? message.chatId,
      finalText,
      pendingApproval: pendingApproval
        ? {
          kind: pendingApproval.kind,
          approvalId: pendingApproval.kind === 'tool_action' ? pendingApproval.approvalId : null,
        }
        : null,
      stepCount: Array.isArray(result.steps) ? result.steps.length : 0,
    });

    return {
      task,
      status: 'done',
      currentStep: pendingApproval ? 'control.requested' : 'synthesis.complete',
      latestSynthesis: finalText,
      agentResults,
      runtimeMeta: {
        engine: 'vercel',
        threadId: persistentThread?.id,
        node: pendingApproval ? 'control.requested' : 'synthesis.complete',
        stepHistory: task.plan,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Vercel Lark runtime failed.';
    await appendLatestAgentRunLog(task.taskId, 'run.failed', {
      channel: 'lark',
      threadId: persistentThread?.id ?? message.chatId,
      error: errorMessage,
    });
    statusHistory.push(`Failed: ${errorMessage}`);
    await statusCoordinator.replace(
      [
        'I ran into a problem while working on this.',
        '',
        summarizeText(errorMessage, 280) ?? errorMessage,
        '',
        'Please try again or rephrase the request.',
      ].join('\n'),
      [],
    );
    throw error;
  } finally {
    await statusCoordinator.close();
  }
};

const executeByChannel = async (
  task: OrchestrationTaskDTO,
  message: NormalizedIncomingMessageDTO,
): Promise<OrchestrationExecutionResult> => {
  switch (message.channel) {
    case 'lark':
      return executeLarkVercelTask(task, message);
    default:
      logger.warn('vercel.engine.channel_fallback', {
        taskId: task.taskId,
        messageId: message.messageId,
        channel: message.channel,
      });
      return legacyOrchestrationEngine.executeTask({ task, message });
  }
};

export const vercelOrchestrationEngine: OrchestrationEngine = {
  id: 'vercel',
  async buildTask(taskId, message) {
    const task = await legacyOrchestrationEngine.buildTask(taskId, message);
    return adaptPlanForVercel(task);
  },
  async executeTask(input) {
    return executeByChannel(input.task, input.message);
  },
};
