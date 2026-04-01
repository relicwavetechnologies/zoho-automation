import { generateText, stepCountIs, type ModelMessage } from 'ai';

import config from '../../../config';
import type { ChannelAction } from '../../channels/base/channel-adapter';
import { resolveChannelAdapter } from '../../channels';
import { larkChatContextService } from '../../channels/lark/lark-chat-context.service';
import { departmentService } from '../../departments/department.service';
import { departmentPreferenceService } from '../../departments/department-preference.service';
import type {
  AgentResultDTO,
  NormalizedIncomingMessageDTO,
  OrchestrationTaskDTO,
} from '../../contracts';
import { conversationMemoryStore } from '../../state/conversation';
import { toolPermissionService } from '../../tools/tool-permission.service';
import { retrievalOrchestratorService } from '../../retrieval';
import { logger } from '../../../utils/logger';
import {
  buildExecutionModelInputPayload,
  buildCapabilityGapFromSelection,
  buildCapabilityGapFromToolFailure,
  buildExecutionToolDemandPayload,
  EXECUTION_CAPABILITY_GAP_EVENT,
  EXECUTION_TOOL_DEMAND_EVENT,
  executionService,
  type ExecutionToolDemandPayload,
} from '../../observability';
import { resolveVercelChildRouterModel, resolveVercelLanguageModel } from '../vercel/model-factory';
import { buildSharedAgentSystemPrompt } from '../prompting/shared-agent-prompt';
import { checkToolSelectionInvariant, resolveRunScopedToolSelection } from '../tool-selection/run-scoped-tool-selection.service';
import { createVercelDesktopTools } from '../vercel/tools';
import {
  CircuitBreakerOpenError,
  runWithCircuitBreaker,
} from '../../observability/circuit-breaker';
import type {
  PendingApprovalAction,
  VercelRuntimeRequestContext,
  VercelToolEnvelope,
  VercelToolResultStatus,
} from '../vercel/types';
import type {
  OrchestrationEngine,
  OrchestrationExecutionInput,
  OrchestrationExecutionResult,
} from './types';
import { legacyOrchestrationEngine } from './legacy-orchestration.engine';
import {
  buildVisionContentWithGrounding,
  type AttachedFileRef,
  type GroundedFilePromptInfo,
} from '../../../modules/desktop-chat/file-vision.builder';
import { desktopThreadsService } from '../../../modules/desktop-threads/desktop-threads.service';
import { DESKTOP_THREAD_CONTEXT_MESSAGE_LIMIT } from '../../../modules/desktop-chat/desktop-thread-context.cache';
import {
  buildTaskStateContext,
  filterThreadMessagesForContext,
  buildThreadSummaryContext,
  createEmptyTaskState,
  isAttentionOnlyText,
  markDesktopSourceArtifactsUsed,
  parseDesktopTaskState,
  parseDesktopThreadSummary,
  refreshDesktopThreadSummary,
  selectDesktopSourceArtifacts,
  upsertDesktopSourceArtifacts,
  updateTaskStateFromToolEnvelope,
  type DesktopTaskState,
  type DesktopThreadSummary,
} from '../../../modules/desktop-chat/desktop-thread-memory';
import {
  buildSchedulingIntentClarification,
  runDesktopChildRouter,
  type DesktopChildRoute,
} from '../../../modules/desktop-chat/vercel-desktop.engine';
import { LarkStatusCoordinator } from './lark-status.coordinator';
import { aiTokenUsageService } from '../../ai-usage/ai-token-usage.service';
import { estimateMessageTokens, estimateTokens } from '../../../utils/token-estimator';
import { AI_MODEL_CATALOG_MAP } from '../../ai-models';
import { personalVectorMemoryService, type PersonalMemoryMatch } from '../../integrations/vector';
import { memoryExtractionService, memoryService } from '../../memory';
import { enrichQuery, type QueryEnrichment } from '../query-enrichment.service';
import { classifyIntent } from '../intent/canonical-intent';
import { hotContextStore, type HotContextIndexedEntity, type HotContextSlot } from '../hot-context.store';
import {
  type DelegatedAgentExecutionResult,
  type StepResultEnvelope,
  type SupervisorStep,
  buildSupervisorResolvedContext,
  executeSupervisorDag,
  formatSupervisorResolvedContext,
  getSupervisorAgentToolIds,
  planSupervisorDelegation,
  synthesizeSupervisorOutcome,
} from '../supervisor';
import { resolveSupervisorEligibleAgents } from '../supervisor/agent-registry';
import { resolveOrdinalReferences } from '../utils/resolve-ordinal-references';
import { runtimeControlSignalsRepository } from '../../queue/runtime/control-signals.repository';
import { desktopWsGateway } from '../../../modules/desktop-live/desktop-ws.gateway';
import {
  appendLatestAgentRunLog,
  resetLatestAgentRunLog,
} from '../../../utils/latest-agent-run-log';
import { prisma } from '../../../utils/prisma';
import {
  estimateFinalPromptTokens,
  FULL_PROMPT_COMPACTION_USABLE_BUDGET,
  PROTECTED_RECENT_MESSAGE_COUNT,
  runLayeredCompaction,
  type ConversationRetrievalItem,
  type RetrievalSnippet,
} from './context-compaction';

const LOCAL_TIME_ZONE = 'Asia/Kolkata';
const LARK_BLOCKED_TOOL_IDS = new Set<string>();
const LARK_VERCEL_MODE: VercelRuntimeRequestContext['mode'] = 'high';
const LARK_THREAD_CONTEXT_MESSAGE_LIMIT = DESKTOP_THREAD_CONTEXT_MESSAGE_LIMIT;
const LARK_CONTEXT_TARGET_RATIO = 0.6;
const LARK_LIGHT_CONTEXT_TARGET_RATIO = 0.12;
const LARK_NORMAL_CONTEXT_TARGET_RATIO = 0.28;
const SUPERVISOR_PROMPT_MAX_CHARS = 8_000;
const LARK_CHILD_ROUTER_HISTORY_TOKEN_BUDGET = 8_000;
const LARK_CHILD_ROUTER_HISTORY_MAX_MESSAGES = 16;
const LARK_LIGHTWEIGHT_RAW_HISTORY_TOKEN_BUDGET = 6_000;
const LARK_NORMAL_RAW_HISTORY_TOKEN_BUDGET = 40_000;
const LARK_LONG_RUNNING_RAW_HISTORY_TOKEN_BUDGET = 80_000;
const LARK_LIGHTWEIGHT_RAW_HISTORY_MAX_MESSAGES = 12;
const LARK_NORMAL_RAW_HISTORY_MAX_MESSAGES = 60;
const LARK_LONG_RUNNING_RAW_HISTORY_MAX_MESSAGES = 120;
const LARK_STATUS_HEARTBEAT_MESSAGES = [
  'Digging through the current scope.',
  'Tracing the next useful step.',
  'Checking the latest progress before moving ahead.',
  'Matching the current findings.',
] as const;
const GEMINI_CIRCUIT_BREAKER = {
  failureThreshold: 5,
  windowMs: 60_000,
  openMs: 120_000,
};
const larkConversationHydrationVersions = new Map<string, string>();

class DepartmentSelectionRequiredError extends Error {
  constructor() {
    super(
      [
        'You are a member of multiple departments. Please select one before continuing:',
        '/dept --list to see your departments',
        '/dept --switch <name> to activate one',
      ].join('\n'),
    );
    this.name = 'DepartmentSelectionRequiredError';
  }
}

const buildConversationKey = (message: NormalizedIncomingMessageDTO): string =>
  `${message.channel}:${message.chatId}`;
const buildPersistentLarkConversationKey = (threadId: string): string => `lark-thread:${threadId}`;
const buildSharedLarkConversationKey = (chatId: string): string => `lark-chat:${chatId}`;
type ReplyModeHint = 'thread' | 'reply' | 'plain' | 'dm';

export interface ReplyModeConfig {
  replyToMessageId?: string;
  replyInThread?: boolean;
  chatType?: 'p2p';
}

const buildReplyModeHint = (config: ReplyModeConfig): ReplyModeHint =>
  config.replyInThread
    ? 'thread'
    : config.replyToMessageId
      ? 'reply'
      : config.chatType === 'p2p'
        ? 'dm'
        : 'plain';

const replyModeHintsMatch = (
  left?: ReplyModeHint,
  right?: ReplyModeHint,
): boolean => Boolean(left && right && left === right);

const countSentences = (text: string): number =>
  text
    .split(/[.!?]+/u)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .length;

const resolveExplicitReplyModeFromText = (
  text: string | null | undefined,
): ReplyModeHint | undefined => {
  const normalized = text?.trim().toLowerCase() ?? '';
  if (!normalized) return undefined;
  if (
    /\b(?:dm me|send (?:it|this|that|them)?(?: to)? my dm|send (?:it|this|that|them)? privately|private\b|just me\b|send to me privately)\b/u.test(normalized)
  ) {
    return 'dm';
  }
  if (/\b(?:reply in thread|thread reply|use thread|in this thread)\b/u.test(normalized)) {
    return 'thread';
  }
  if (
    /\b(?:reply to (?:this|that) message|reply here|reply to this|tell me here|answer here|say it here|here itself|in (?:this )?chat|reply in (?:the )?chat|chat only|here only|not in (?:a )?thread|don't reply in (?:a )?thread|do not reply in (?:a )?thread)\b/u.test(normalized)
  ) {
    return 'reply';
  }
  if (/\b(?:plain send|standalone update|send to the channel|post it to the channel|no thread)\b/u.test(normalized)) {
    return 'plain';
  }
  return undefined;
};

const resolveStoredReplyMode = (
  taskState: DesktopTaskState | null | undefined,
): 'thread' | 'reply' | 'plain' | 'dm' | undefined =>
  taskState?.preferredReplyMode;

export const resolveReplyMode = (params: {
  chatType: 'group' | 'p2p';
  incomingMessageId: string;
  isProactiveDelivery: boolean;
  isSensitiveContent: boolean;
  isShortAcknowledgement: boolean;
  proposedReplyMode?: ReplyModeHint;
  userExplicitMode?: 'dm' | 'thread' | 'reply' | 'plain';
}): ReplyModeConfig => {
  const {
    chatType,
    incomingMessageId,
    isProactiveDelivery,
    isSensitiveContent,
    isShortAcknowledgement,
    proposedReplyMode,
    userExplicitMode,
  } = params;
  void isSensitiveContent;

  if (userExplicitMode === 'dm') return { chatType: 'p2p' };
  if (userExplicitMode === 'thread') return { replyInThread: true, replyToMessageId: incomingMessageId };
  if (userExplicitMode === 'reply') return { replyToMessageId: incomingMessageId };
  if (userExplicitMode === 'plain') return {};

  if (isProactiveDelivery) return {};

  if (proposedReplyMode === 'dm') return { chatType: 'p2p' };
  if (proposedReplyMode === 'thread') {
    return chatType === 'group'
      ? { replyInThread: true, replyToMessageId: incomingMessageId }
      : { replyToMessageId: incomingMessageId };
  }
  if (proposedReplyMode === 'reply') return { replyToMessageId: incomingMessageId };
  if (proposedReplyMode === 'plain') return {};

  if (chatType === 'group') {
    if (isShortAcknowledgement) return { replyToMessageId: incomingMessageId };
    return { replyInThread: true, replyToMessageId: incomingMessageId };
  }

  return { replyToMessageId: incomingMessageId };
};

const resolveReplyModeChatId = (input: {
  replyMode: ReplyModeConfig;
  message: NormalizedIncomingMessageDTO;
}): string => {
  if (input.replyMode.chatType === 'p2p') {
    return input.message.trace?.larkOpenId ?? input.message.userId;
  }
  return input.message.chatId;
};

const buildReplyModeRedirectText = (hint: ReplyModeHint): string => {
  switch (hint) {
    case 'thread':
      return 'Replied in thread.';
    case 'dm':
      return 'Sent you a DM.';
    case 'plain':
      return 'Replied here.';
    case 'reply':
    default:
      return 'Working on it.';
  }
};

const hasSensitiveToolResults = (input: {
  childRoute: DesktopChildRoute;
  steps: Array<{ toolResults?: Array<{ toolName?: string; output?: unknown }> }>;
  finalText: string;
  pendingApproval: PendingApprovalAction | null;
}): boolean => {
  if (input.pendingApproval) return true;
  if (/(finance|invoice|approval|salary|compensation|personal data)/iu.test(input.finalText)) {
    return true;
  }
  if (/(finance|approval|personal)/iu.test(input.childRoute.normalizedIntent ?? '')) {
    return true;
  }
  return input.steps.some((step) =>
    (step.toolResults ?? []).some((toolResult) =>
      /(books|finance|invoice|approval|memory|personal)/iu.test(toolResult.toolName ?? ''),
    ),
  );
};
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

const trimSupervisorSystemPrompt = (prompt: string): string => {
  if (prompt.length <= SUPERVISOR_PROMPT_MAX_CHARS) {
    return prompt;
  }
  const headChars = 5_000;
  const tailChars = SUPERVISOR_PROMPT_MAX_CHARS - headChars - 48;
  return [
    prompt.slice(0, headChars).trimEnd(),
    '[Tool details trimmed for planning speed]',
    prompt.slice(-tailChars).trimStart(),
  ].join('\n\n');
};

const describeSupervisorSource = (toolName?: string): string => {
  switch (toolName?.trim()) {
    case 'larkTask':
    case 'lark-task-read':
    case 'lark-task-write':
      return 'Lark Tasks';
    case 'zohoBooks':
    case 'booksRead':
    case 'zoho-books-read':
      return 'Zoho Books';
    case 'zohoCrm':
    case 'zoho-read':
    case 'search-zoho-context':
      return 'Zoho CRM';
    case 'contextSearch':
    case 'context-search':
      return 'internal context';
    case 'googleWorkspace':
    case 'google-gmail':
    case 'google-drive':
    case 'google-calendar':
      return 'Google Workspace';
    case 'larkBase':
    case 'lark-base-read':
    case 'lark-base-write':
      return 'Lark Base';
    case 'larkMessage':
    case 'lark-message-read':
    case 'lark-message-write':
      return 'Lark messages';
    case 'larkCalendar':
    case 'lark-calendar-read':
    case 'lark-calendar-write':
    case 'lark-calendar-list':
      return 'Lark Calendar';
    default:
      return 'the records';
  }
};

const hasNaturalLanguageAnswer = (text: string): boolean =>
  text.trim().split(/\s+/u).filter(Boolean).length > 12;

const buildRichDelegatedResultSummary = (
  results: DelegatedAgentExecutionResult[],
): string | null => {
  if (results.length === 0) {
    return null;
  }
  for (const result of results.slice(0, 3)) {
    if (result.status === 'success' && hasNaturalLanguageAnswer(result.text)) {
      return result.text.trim();
    }
  }

  const lines: string[] = [];
  for (const result of results.slice(0, 5)) {
    const firstToolName = (result.toolResults ?? []).find((entry) => entry.toolName)?.toolName;
    const sourceLabel = describeSupervisorSource(firstToolName);
    const outcome =
      summarizeText(result.summary, 120)
      ?? summarizeText(result.text, 120)
      ?? 'Checked but found nothing useful.';
    lines.push(`Checked ${sourceLabel} — ${outcome}`);
  }
  return lines.join('\n');
};

const TOOL_PROGRESS_LABELS: Record<string, { start: string; done: string; failed: string }> = {
  larkTask: { start: 'Searching Lark tasks…', done: 'Lark tasks checked', failed: 'Lark task search failed' },
  larkCalendar: { start: 'Checking your calendar…', done: 'Calendar checked', failed: 'Calendar lookup failed' },
  larkMeeting: { start: 'Looking up meetings…', done: 'Meetings checked', failed: 'Meeting lookup failed' },
  larkDoc: { start: 'Reading the document…', done: 'Document read', failed: 'Document read failed' },
  larkMessage: { start: 'Searching messages…', done: 'Messages scanned', failed: 'Message search failed' },
  zohoBooks: { start: 'Pulling financial records…', done: 'Financial data retrieved', failed: 'Finance data unavailable' },
  zohoCrm: { start: 'Checking CRM records…', done: 'CRM data retrieved', failed: 'CRM lookup failed' },
  zohoSearch: { start: 'Searching across Zoho…', done: 'Zoho search complete', failed: 'Zoho search failed' },
  contextSearch: { start: 'Searching past context…', done: 'Context retrieved', failed: 'Context search failed' },
  outreach: { start: 'Preparing outreach…', done: 'Outreach ready', failed: 'Outreach failed' },
  webSearch: { start: 'Searching the web…', done: 'Web results in', failed: 'Web search failed' },
  booksRead: { start: 'Pulling financial records…', done: 'Financial data retrieved', failed: 'Finance data unavailable' },
  zohoRead: { start: 'Reading Zoho data…', done: 'Zoho data retrieved', failed: 'Zoho read failed' },
};

const TOOL_PROGRESS_DEFAULT = {
  start: 'Working on it…',
  done: 'Step complete',
  failed: 'Step failed',
};

const buildLarkSupervisorScopedContext = (input: {
  step: SupervisorStep;
  conversationSnippets: string[];
  taskState: DesktopTaskState;
  threadSummary: DesktopThreadSummary;
}): string[] => {
  const queryTerms = new Set(
    input.step.objective
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .filter((term) => term.length > 3),
  );
  const scored = input.conversationSnippets
    .map((snippet) => {
      const lowered = snippet.toLowerCase();
      let score = 0;
      for (const term of queryTerms) {
        if (lowered.includes(term)) score += 1;
      }
      return { snippet, score };
    })
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.snippet)
    .slice(0, 6);
  const taskStateContext = buildTaskStateContext(input.taskState);
  const summaryContext = buildThreadSummaryContext(input.threadSummary);
  return [
    ...(scored.length > 0 ? scored : input.conversationSnippets.slice(0, 4)),
    ...(taskStateContext ? [taskStateContext] : []),
    ...(summaryContext ? [summaryContext] : []),
  ];
};

export const buildLarkSupervisorStepMessage = (input: {
  originalUserMessage: string;
  step: SupervisorStep;
  scopedContext: string[];
  dependencyInputs: Array<{
    stepId: string;
    agentId: string;
    summary: string;
    data?: Record<string, unknown>;
  }>;
}): string => {
  const dependencyBlock = input.dependencyInputs.length > 0
    ? input.dependencyInputs.map((entry) => [
      `Step ${entry.stepId} from ${entry.agentId}`,
      `Summary: ${entry.summary}`,
      entry.data ? `Data: ${JSON.stringify(entry.data)}` : null,
    ].filter(Boolean).join('\n')).join('\n\n')
    : 'None';
  const parts = [
    'You are a delegated runtime agent working on one scoped objective.',
    `Original user request: ${input.originalUserMessage}`,
    `Current delegated objective: ${input.step.objective}`,
  ];
  if (input.step.structuredObjective) {
    const obj = input.step.structuredObjective;
    parts.push('', '[Structured Task Context]');
    if (obj.targetEntity) parts.push(`Entity: ${obj.targetEntity}`);
    if (obj.targetSource) parts.push(`Primary source: ${obj.targetSource}`);
    if (obj.dateRange) parts.push(`Date range: ${obj.dateRange.from} to ${obj.dateRange.to}`);
    if (obj.authorityRequired) {
      parts.push('Authority required: do not answer from chat history or public web unless all internal sources are exhausted and explicitly noted.');
    }
    parts.push('[End Structured Task Context]');
  }
  parts.push(
    '',
    'Relevant context:',
    input.scopedContext.length > 0 ? input.scopedContext.join('\n') : 'None',
    '',
    'Dependency results:',
    dependencyBlock,
    '',
    'Complete only the delegated objective for this step. Do not claim unrelated work is done.',
  );
  return parts.join('\n');
};

const buildAbortSignalError = (): Error => {
  const error = new Error('Task cancelled via abort signal');
  error.name = 'AbortError';
  return error;
};

const isExecutionCancellationError = (error: unknown): boolean => {
  if (error instanceof Error) {
    return error.name === 'AbortError'
      || error.message.includes('Task cancelled via control signal')
      || error.message.includes('Task cancelled via abort signal');
  }
  return false;
};

const assertExecutionRunnable = async (
  taskId: string,
  abortSignal?: AbortSignal,
): Promise<void> => {
  if (abortSignal?.aborted) {
    throw buildAbortSignalError();
  }
  await runtimeControlSignalsRepository.assertRunnableAtBoundary(taskId, abortSignal);
  if (abortSignal?.aborted) {
    throw buildAbortSignalError();
  }
};

const appendExecutionEventSafe = async (
  input: Parameters<typeof executionService.appendEvent>[0],
) => {
  try {
    await executionService.appendEvent(input);
  } catch (error) {
    logger.warn('vercel.lark.execution.event.failed', {
      executionId: input.executionId,
      eventType: input.eventType,
      error: error instanceof Error ? error.message : 'unknown_error',
    });
  }
};

const resolveCanonicalExecutionId = (
  task: OrchestrationTaskDTO,
  message: NormalizedIncomingMessageDTO,
): string => message.trace?.requestId?.trim() || task.taskId;

const isPersonalMemoryQuestion = (value: string | null | undefined): boolean =>
  /\b(do you know|do you remember|remember|recall|what(?:'s| is) my|my (?:fav|favorite|favourite|preferred)|favorite|favourite|preferred|preference|about me|my name|my email)\b/i.test(
    value ?? '',
  );

const expandConversationMemoryQuery = (value: string): string => {
  const normalized = value
    .replace(/\bfav\b/gi, 'favorite')
    .replace(/\blang\b/gi, 'language')
    .replace(/\bpref\b/gi, 'preference');
  if (normalized === value) {
    return value;
  }
  return `${value}\n${normalized}`;
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

const deriveEffectiveLatestUserMessage = (input: {
  latestUserMessage: string;
  attentionOnly?: boolean;
  contextMessages: Array<ModelMessage & { id?: string }>;
  taskState: DesktopTaskState;
  threadSummary: DesktopThreadSummary;
}): string => {
  const latestUserMessage = input.latestUserMessage.trim();
  if (!latestUserMessage) {
    return latestUserMessage;
  }
  if (!input.attentionOnly && !isAttentionOnlyText(latestUserMessage)) {
    return latestUserMessage;
  }

  const filteredMessages = filterThreadMessagesForContext(
    input.contextMessages.map((entry) => ({
      role: entry.role === 'assistant' ? 'assistant' : 'user',
      content:
        typeof entry.content === 'string' ? entry.content : flattenModelContent(entry.content),
    })),
  );
  for (let index = filteredMessages.length - 1; index >= 0; index -= 1) {
    const entry = filteredMessages[index];
    if (!entry || entry.role !== 'user') {
      continue;
    }
    const candidate = entry.content.trim();
    if (!candidate || isAttentionOnlyText(candidate)) {
      continue;
    }
    return candidate;
  }

  return (
    input.taskState.activeObjective?.trim()
    || input.threadSummary.latestObjective?.trim()
    || input.threadSummary.latestUserGoal?.trim()
    || latestUserMessage
  );
};

const sanitizeMessagesForProviderRetry = (
  messages: ModelMessage[],
  latestUserMessage: string,
): ModelMessage[] => {
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
    return trimmedHistory.length > 0
      ? trimmedHistory
      : [{ role: 'user', content: 'Continue from the latest verified context.' }];
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

const flattenModelContent = (content: ModelMessage['content'] | string | undefined): string => {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') {
        return '';
      }
      const record = part as Record<string, unknown>;
      return typeof record.text === 'string' ? record.text : '';
    })
    .filter(Boolean)
    .join('\n');
};

const estimateMessageTokens = (messages: ModelMessage[]): number =>
  messages.reduce((sum, message) => sum + estimateTokens(flattenModelContent(message.content)), 0);

const toCamelCase = (value: string): string =>
  value.replace(/[_-]([a-z])/gi, (_match, letter: string) => letter.toUpperCase());

const toSnakeCase = (value: string): string =>
  value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase();

const normalizeResolvedIdVariants = (key: string): string[] => {
  const trimmed = key.trim();
  if (!trimmed) return [];
  return Array.from(new Set([trimmed, toCamelCase(trimmed), toSnakeCase(trimmed)]));
};

const setResolvedId = (
  resolvedIds: Record<string, string>,
  key: string,
  value: unknown,
) => {
  if (typeof value !== 'string' || !value.trim()) {
    return;
  }
  for (const variant of normalizeResolvedIdVariants(key)) {
    if (!resolvedIds[variant]) {
      resolvedIds[variant] = value.trim();
    }
  }
};

const asRecordSafe = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const asStringSafe = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

const asArrayOfRecordsSafe = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.flatMap((entry) => {
      const record = asRecordSafe(entry);
      return record ? [record] : [];
    })
    : [];

const KNOWN_ID_FIELD_KEYS = [
  'recordId',
  'record_id',
  'workflowId',
  'workflow_id',
  'invoiceId',
  'invoice_id',
  'estimateId',
  'estimate_id',
  'contactId',
  'contact_id',
  'messageId',
  'message_id',
  'threadId',
  'thread_id',
  'taskId',
  'task_id',
  'taskGuid',
  'task_guid',
  'commentId',
  'comment_id',
  'approvalId',
  'approval_id',
  'openId',
  'open_id',
  'larkOpenId',
  'chatId',
  'chat_id',
  'salesOrderId',
  'sales_order_id',
  'purchaseOrderId',
  'purchase_order_id',
  'creditNoteId',
  'credit_note_id',
  'creditnote_id',
  'billId',
  'bill_id',
  'customerId',
  'customer_id',
  'vendorPaymentId',
  'vendor_payment_id',
  'invoiceNumber',
  'invoice_number',
  'vendorName',
  'vendor_name',
  'totalAmount',
  'total_amount',
  'closingBalance',
  'closing_balance',
  'transactionCount',
  'transaction_count',
] as const;

const collectResolvedIdsFromValue = (
  value: unknown,
  resolvedIds: Record<string, string>,
  depth = 0,
) => {
  if (depth > 3 || value === null || value === undefined) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value.slice(0, 8)) {
      collectResolvedIdsFromValue(entry, resolvedIds, depth + 1);
    }
    return;
  }
  const record = asRecordSafe(value);
  if (!record) {
    return;
  }
  for (const key of KNOWN_ID_FIELD_KEYS) {
    setResolvedId(resolvedIds, key, record[key]);
  }
  const parsedPayload = asRecordSafe(record.parsed)
    ?? asRecordSafe(asRecordSafe(record.fullPayload)?.parsed);
  if (parsedPayload) {
    const parserFields = [
      'invoiceNumber',
      'invoice_number',
      'vendorName',
      'vendor_name',
      'totalAmount',
      'total_amount',
      'dueAmount',
      'due_amount',
      'closingBalance',
      'closing_balance',
      'transactionCount',
      'transaction_count',
    ] as const;
    for (const field of parserFields) {
      if (parsedPayload[field] !== undefined && parsedPayload[field] !== null && !resolvedIds[field]) {
        resolvedIds[field] = String(parsedPayload[field]);
      }
    }
  }
  for (const nested of Object.values(record).slice(0, 16)) {
    collectResolvedIdsFromValue(nested, resolvedIds, depth + 1);
  }
};

const inferBooksRecordId = (record: Record<string, unknown>): string | undefined =>
  asStringSafe(record.invoice_id)
  ?? asStringSafe(record.estimate_id)
  ?? asStringSafe(record.contact_id)
  ?? asStringSafe(record.creditnote_id)
  ?? asStringSafe(record.salesorder_id)
  ?? asStringSafe(record.purchaseorder_id)
  ?? asStringSafe(record.bill_id)
  ?? asStringSafe(record.vendor_payment_id)
  ?? asStringSafe(record.task_id)
  ?? asStringSafe(record.id);

const inferBooksRecordLabel = (record: Record<string, unknown>): string | undefined =>
  asStringSafe(record.invoice_number)
  ?? asStringSafe(record.estimate_number)
  ?? asStringSafe(record.contact_name)
  ?? asStringSafe(record.customer_name)
  ?? asStringSafe(record.vendor_name)
  ?? asStringSafe(record.summary)
  ?? asStringSafe(record.title)
  ?? asStringSafe(record.name);

const buildHotContextEntityIndexes = (
  toolName: string,
  output: VercelToolEnvelope,
): Record<string, HotContextIndexedEntity[]> | undefined => {
  const payload = output.fullPayload ?? output.keyData;
  if (toolName === 'booksRead') {
    const fullPayload = asRecordSafe(payload);
    const records = asArrayOfRecordsSafe(fullPayload?.records);
    if (records.length === 0) {
      return undefined;
    }
    const moduleName = asStringSafe(output.keyData?.module) ?? 'record';
    const singular = moduleName.endsWith('s') ? moduleName.slice(0, -1) : moduleName;
    const entries = records.flatMap((record, index) => {
      const recordId = inferBooksRecordId(record);
      if (!recordId) return [];
      return [{
        ordinal: index + 1,
        recordId,
        label: inferBooksRecordLabel(record),
        reference: `${moduleName}:${recordId}`,
      }];
    });
    if (entries.length === 0) {
      return undefined;
    }
    return {
      [singular]: entries,
      record: entries,
    };
  }

  if (toolName === 'larkTask') {
    const fullPayload = asRecordSafe(payload);
    const tasks = asArrayOfRecordsSafe(fullPayload?.tasks);
    if (tasks.length === 0) {
      return undefined;
    }
    const entries = tasks.flatMap((task, index) => {
      const recordId = asStringSafe(task.taskId) ?? asStringSafe(task.task_id) ?? asStringSafe(task.id);
      if (!recordId) return [];
      return [{
        ordinal: index + 1,
        recordId,
        label: asStringSafe(task.summary) ?? asStringSafe(task.title),
        reference: `task:${recordId}`,
      }];
    });
    return entries.length > 0 ? { task: entries, record: entries } : undefined;
  }

  return undefined;
};

type RunToolResult = {
  toolId: string;
  toolName: string;
  success: boolean;
  status: VercelToolResultStatus;
  data: unknown;
  confirmedAction: boolean;
  error?: string;
  pendingApproval?: boolean;
  summary?: string;
};

type RunCompletionState =
  | { status: 'completed'; confirmedCount: number; failedCount: number; readOnly?: boolean }
  | { status: 'attempted_failed'; confirmedCount: 0; failedCount: number; errors: string[] }
  | { status: 'no_action_attempted'; confirmedCount: 0; failedCount: 0 };

const evaluateRunCompletion = (
  toolResults: RunToolResult[],
  intentClassification?: Pick<ReturnType<typeof classifyIntent>, 'isWriteLike'>,
): RunCompletionState => {
  if (intentClassification && !intentClassification.isWriteLike) {
    return {
      status: 'completed',
      confirmedCount: 0,
      failedCount: 0,
      readOnly: true,
    };
  }
  const actionResults = toolResults.filter((result) => result.confirmedAction === true);
  const errorResults = toolResults.filter(
    (result) => result.status === 'error' || result.status === 'timeout',
  );
  const attemptedActions = toolResults.filter(
    (result) =>
      result.confirmedAction === true
      || result.status === 'error'
      || result.status === 'timeout',
  );

  if (actionResults.length > 0) {
    return {
      status: 'completed',
      confirmedCount: actionResults.length,
      failedCount: errorResults.length,
    };
  }

  if (attemptedActions.length > 0) {
    return {
      status: 'attempted_failed',
      confirmedCount: 0,
      failedCount: errorResults.length,
      errors: errorResults
        .map((result) => result.error?.trim())
        .filter((value): value is string => Boolean(value)),
    };
  }

  return {
    status: 'no_action_attempted',
    confirmedCount: 0,
    failedCount: 0,
  };
};

export const __vercelMutationGuardTestUtils = {
  evaluateRunCompletion,
  finalizeNoActionAttemptText: (agentComposedAnswer: string): string => {
    const trimmedAnswer = agentComposedAnswer.trim();
    const loweredAnswer = trimmedAnswer.toLowerCase();
    const hasUsefulContent =
      trimmedAnswer.length > 60 &&
      !loweredAnswer.includes('i was unable') &&
      !loweredAnswer.includes('i could not');

    if (hasUsefulContent) {
      return `${trimmedAnswer}\n\n_Note: I wasn't fully able to confirm this completed. If something looks off, just ask me to try again._`;
    }

    return 'I wasn\'t able to confirm this completed. Would you like me to try again?';
  },
};

const delegatedStepLikelyRequiresToolUse = (step: SupervisorStep): boolean =>
  /\b(find|search|look up|retrieve|read|get|fetch|list|send|mail|email|draft|reply|forward|create|update|delete|schedule|run|save|archive|post|message|verify|inspect|check)\b/i
    .test(step.objective);

const resolveMutationGuard = (input: {
  latestUserMessage: string;
  toolResults: RunToolResult[];
  childRouterOperationType?: string | null;
  normalizedIntent?: string | null;
  plannerChosenOperationClass?: string | null;
  priorToolResults?: DesktopTaskState['latestToolResults'];
  pendingApproval: boolean;
  blockingUserInput: boolean;
}): { node: 'synthesis.complete' | 'execution.incomplete'; forcedFinalText?: string } => {
  if (input.pendingApproval || input.blockingUserInput) {
    return {
      node: 'execution.incomplete',
    };
  }
  const canonicalIntent = classifyIntent(
    input.latestUserMessage,
    {
      normalizedIntent: input.normalizedIntent,
      plannerChosenOperationClass: input.plannerChosenOperationClass,
      childRouterOperationType: input.childRouterOperationType,
      priorToolResults: input.priorToolResults,
    },
  );
  const completion = evaluateRunCompletion(input.toolResults, canonicalIntent);
  if (completion.status === 'completed') {
    return {
      node: 'synthesis.complete',
    };
  }
  if (completion.status === 'attempted_failed') {
    const firstError = completion.errors[0];
    return {
      node: 'execution.incomplete',
      forcedFinalText: firstError
        ? `I tried to complete that action, but it failed: ${firstError}`
        : 'I tried to complete that action, but the action failed before it could finish.',
    };
  }
  return {
    node: 'execution.incomplete',
    forcedFinalText: 'I did not complete that action because no confirmed action ran successfully.',
  };
};

const buildHotContextSlot = (toolName: string, output: VercelToolEnvelope): HotContextSlot => {
  const resolvedIds: Record<string, string> = {};
  collectResolvedIdsFromValue(output.keyData, resolvedIds);
  collectResolvedIdsFromValue(output.fullPayload, resolvedIds);
  if (toolName === 'contextSearch') {
    const citations = asArrayOfRecordsSafe(asRecordSafe(output.fullPayload)?.citations);
    if (citations.length > 0) {
      resolvedIds.__contextSearchCitations__ = JSON.stringify(citations.map((citation, index) => ({
        index: typeof citation.index === 'number' ? citation.index : index + 1,
        chunkRef: asStringSafe(citation.chunkRef),
        scope: asStringSafe(citation.scope),
        sourceType: asStringSafe(citation.sourceType),
        sourceLabel: asStringSafe(citation.sourceLabel),
        asOf: asStringSafe(citation.asOf),
        excerpt: asStringSafe(citation.excerpt),
      })));
    }
  }
  if (output.pendingApprovalAction?.kind === 'tool_action') {
    collectResolvedIdsFromValue(output.pendingApprovalAction.payload, resolvedIds);
    setResolvedId(resolvedIds, 'approvalId', output.pendingApprovalAction.approvalId);
  }
  const authorityLevel =
    asStringSafe(asRecordSafe(output.data)?.authorityLevel)
    ?? asStringSafe(asRecordSafe(output.keyData)?.authorityLevel)
    ?? asStringSafe(asRecordSafe(output.fullPayload)?.authorityLevel)
    ?? (() => {
      const results = asArrayOfRecordsSafe(asRecordSafe(output.fullPayload)?.results);
      const firstAuthority = asStringSafe(results[0]?.authorityLevel);
      return firstAuthority === 'authoritative' || firstAuthority === 'documentary'
        ? 'confirmed'
        : firstAuthority === 'contextual' || firstAuthority === 'public'
          ? 'candidate'
          : undefined;
    })();
  return {
    toolName,
    success: output.success,
    summary: output.summary,
    authorityLevel:
      authorityLevel === 'confirmed' || authorityLevel === 'candidate' || authorityLevel === 'not_found'
        ? authorityLevel
        : undefined,
    errorKind: output.errorKind,
    toolId: asStringSafe(output.toolId),
    actionGroup: asStringSafe(output.actionGroup),
    operation: asStringSafe(output.operation),
    resolvedIds,
    entityIndexes: buildHotContextEntityIndexes(toolName, output),
    fullPayload: output.fullPayload ?? output.keyData ?? {},
    completedAt: Date.now(),
  };
};

const AGENT_CAPABILITY_PROFILES: Record<string, string> = {
  'zoho-ops-agent': `
You are the Zoho specialist. Decision rules:

DECISION TREE:
1. Check upstream step results and handoff context first
2. If all required data is present -> execute your primary action immediately
3. If a specific ID, email address, or reference is missing, report exactly what is missing so the supervisor can provide it
4. Personal history showing past failures = irrelevant. Always attempt the action.

FINANCIAL QUERIES (invoices, payments, bills, overdue, balance):
- Always use buildOverdueReport for overdue/due/pending queries — never listRecords
- For entity lookup: search Books first. If no match with reasonable name overlap, try CRM
- For partial or misspelled names: try the closest match, then report what you matched against
- For multi-entity queries (e.g. "ACME Capital and ACME Finvest"): run each entity separately, combine results
- If Books and CRM both return nothing: say exactly that — do not invent, do not guess

CONTACT/PERSON QUERIES:
- Use CRM for people, leads, accounts
- Do not use Books for person lookups
- If a required entity ID or reference is missing, report exactly what is missing so the supervisor can provide it.

WHEN TO STOP:
- After two failed lookups on the same entity, report not found — do not retry indefinitely
- Never answer from chat history or prior context unless the user explicitly references it`,
  'context-agent': `
You are the internal retrieval specialist. Decision rules:

WHEN TO SEARCH CONTEXT:
- Use contextSearch when the user asks about past conversations, previous decisions, or internal knowledge
- Use contextSearch as the first step when no specific data source is clear from the query

AUTHORITY RULES:
- personal_history results = conversation context only — cannot confirm entity existence
- lark_contacts results = people directory only — cannot confirm a company exists
- If authorityRequired is set and you only found contextual results: say "not confirmed internally" explicitly

OUTREACH:
- Only prepare outreach when explicitly asked — do not draft messages speculatively
- Always report which sources you checked and the authority level of each result

FORBIDDEN QUERIES:
- Never use internal tool names or API operation names as search queries (e.g. "googleWorkspace", "googleMail", "contextSearch", "sendEmail", "sendMessage", "createDraft") — these are system identifiers, not useful context terms
- If you find yourself about to search for a tool name or operation name, stop immediately and report that you have no relevant context instead

WHEN TO STOP:
- If contextSearch returns nothing relevant after one attempt: report that clearly, do not retry with the same query
- Suggest the user try a more specific term if the query was broad`,
  'lark-ops-agent': `
You are the Lark workspace specialist. Decision rules:

DECISION TREE:
1. Check upstream step results and handoff context first
2. If all required data is present -> execute your primary action immediately
3. If a specific ID, email address, or reference is missing, report exactly what is missing so the supervisor can provide it
4. Personal history showing past failures = irrelevant. Always attempt the action.

TASK QUERIES ("my tasks", "pending tasks", "tasks due today"):
- Use larkTask with the requester's identity for personal task queries
- For date-relative queries ("today", "this week"): resolve the actual date range before searching
- If search returns empty: retry once with looser terms, then report not found clearly

CALENDAR / MEETING QUERIES:
- Use larkCalendar for events, schedules, availability
- Use larkMeeting for meeting records and minutes
- For "what do I have today/tomorrow": always use calendar, not tasks

MESSAGE / CHAT QUERIES:
- Use larkMessage only when the user explicitly asks about messages or conversations
- Do not use message search as a fallback for task or calendar queries

DOCUMENT QUERIES:
- Use larkDoc for anything referencing a file, doc, wiki, or knowledge base

WHEN AMBIGUOUS:
- If the request could be a task or a message, default to larkTask first
- If the request mentions finance, invoices, or payments: do not act — tell the supervisor this needs Zoho
- Never attempt CRM or Books operations`,
  'google-workspace-agent': `
You are the Google Workspace specialist. Decision rules:

DECISION TREE — follow in order, stop at first match:

1. Does the objective say send/email/mail and is EMAIL CONTENT present in context?
   -> Call googleWorkspace(operation="sendMessage") immediately. Stop.

2. Is a specific email address, draft ID, or file ID missing?
   -> Return exactly which field is missing so the supervisor can provide it.

3. Is this a Gmail search/read task?
   -> Call googleWorkspace(operation="searchMessages" or operation="getMessage").

4. Is this a Calendar or Drive task?
   -> Call googleWorkspace with the appropriate calendar or drive operation.

EMAIL (send, search, draft):
- For sending email: use googleWorkspace tool with operation="sendMessage", plus fields: to, subject, body.
- When the objective or handoff already gives you recipient, subject, or body, you must copy those values into the tool call explicitly. Never call sendMessage with only operation.
- For searching inbox: use googleWorkspace tool with operation="searchMessages", field: query.
- For sending an existing draft: use googleWorkspace tool with operation="sendDraft", field: draftId.
- For creating a draft: use googleWorkspace tool with operation="createDraft", fields: to, subject, body.
- Never say you lack access without first attempting the tool call.
- Sending requires user confirmation via approval flow — do not assume it sent silently.
- If you do not have access to the Gmail tool, explicitly tell the user: "I don't have email access configured for your account. Please contact your admin." Do not fabricate any sending confirmation.

NEVER:
- Let personal history failures stop you from attempting an action.
- Return content without calling the action tool when the objective says send.

CALENDAR:
- For scheduling or availability: use Google Calendar
- Do not use Gmail for calendar queries

DRIVE:
- For file search or document retrieval: use Drive
- If a file is mentioned by name: search Drive before saying it does not exist

WHEN AMBIGUOUS:
- If the request mentions Lark tasks or Zoho data: do not act — tell the supervisor
- Never attempt Lark or Zoho operations`,
  'workspace-agent': `
You are the file and document specialist. Decision rules:

DECISION TREE:
1. Check upstream step results and handoff context first
2. If all required data is present -> execute your primary action immediately
3. If a specific ID, email address, or reference is missing, report exactly what is missing so the supervisor can provide it
4. Personal history showing past failures = irrelevant. Always attempt the action.

FILE OPERATIONS:
- Search files before reporting not found — do not assume absence
- For OCR or document parsing: confirm the file type is supported before attempting
- Always return authorityLevel with every result

CODE / WORKFLOW:
- For coding tasks: clarify the language and scope if not stated
- For workflow automation: confirm trigger and action before building
- If a required file path, document reference, or trigger detail is missing, report that missing field to the supervisor.

WHEN AMBIGUOUS:
- If the request is about a Lark doc or Google Drive file specifically: tell the supervisor, do not guess the source
- Do not attempt Zoho or Lark workspace operations`,
};

const formatActiveTaskContext = (taskId: string): string | null => {
  const hotContext = hotContextStore.get(taskId);
  if (!hotContext || hotContext.slots.length === 0) {
    return null;
  }
  const lines = hotContext.slots.slice(-8).map((slot) => {
    const resolved = Object.entries(slot.resolvedIds)
      .filter(([key]) => !key.startsWith('__'))
      .slice(0, 8)
      .map(([key, value]) => `${key}=${value}`)
      .join(', ');
    return `- ${slot.toolName}: ${slot.summary}${resolved ? ` | resolved: ${resolved}` : ''}`;
  });
  return [
    'Active task context:',
    ...lines,
    'Use these resolved IDs and references directly before asking the user or re-fetching.',
  ].join('\n');
};

const buildStepResultEnvelope = (
  resolvedContext: Record<string, string>,
  stepSummary: string,
  toolResults: RunToolResult[],
): StepResultEnvelope => {
  const firstConfirmedTool = toolResults.find((result) => result.success);
  const summaryText = `${firstConfirmedTool?.summary ?? ''} ${stepSummary}`.toLowerCase();
  const authorityLevel: StepResultEnvelope['authorityLevel'] =
    summaryText.includes('not found')
      ? 'not_found'
      : Object.keys(resolvedContext).length > 0
        ? 'confirmed'
        : 'candidate';

  const resolvedEntity = (() => {
    const entityId = resolvedContext.customerId
      ?? resolvedContext.contactId
      ?? resolvedContext.invoiceId
      ?? resolvedContext.recordId;
    if (!entityId) {
      return undefined;
    }
    const entityType =
      resolvedContext.customerId ? 'customer'
        : resolvedContext.contactId ? 'contact'
          : resolvedContext.invoiceId ? 'invoice'
            : 'record';
    const name = resolvedContext.customerName
      ?? resolvedContext.contactName
      ?? resolvedContext.companyName
      ?? resolvedContext.invoiceNumber
      ?? entityId;
    const source = resolvedContext.organizationId ? 'zoho' : 'workflow';
    return {
      id: entityId,
      type: entityType,
      name,
      source,
      authorityLevel: source === 'zoho' ? 'authoritative' : 'contextual',
    } satisfies NonNullable<StepResultEnvelope['resolvedEntity']>;
  })();

  return {
    ...(resolvedEntity ? { resolvedEntity } : {}),
    resolvedIds: { ...resolvedContext },
    authorityLevel,
    summary: stepSummary,
  };
};

const canResolveFieldFromHotContext = (taskId: string, field: string | null | undefined): boolean => {
  const trimmed = field?.trim();
  if (!trimmed) {
    return false;
  }
  return normalizeResolvedIdVariants(trimmed).some((variant) =>
    Boolean(hotContextStore.getResolvedId(taskId, variant)),
  );
};

const findUnrepairableBlockingUserInput = (
  steps: Array<{ toolResults?: Array<{ output: unknown }> }>,
  taskId: string,
): VercelToolEnvelope | null => {
  const blocking = findBlockingUserInput(steps);
  if (!blocking) {
    return null;
  }
  if (!blocking.missingFields || blocking.missingFields.length === 0) {
    return blocking;
  }
  const unresolvedFields = (blocking.missingFields ?? []).filter(
    (field) => !canResolveFieldFromHotContext(taskId, field),
  );
  return unresolvedFields.length > 0 ? blocking : null;
};

const appendWarmTaskSummary = async (
  summary: DesktopThreadSummary,
  executionId: string | null | undefined,
  taskId: string,
  options?: {
    isPartial?: boolean;
    interruptedAt?: string;
  },
): Promise<DesktopThreadSummary> => {
  const persistedWarm = await getPersistedWarmSummary(executionId);
  const warm = persistedWarm.summary.trim()
    ? persistedWarm
    : hotContextStore.toWarmSummary(taskId);
  if (!warm.summary.trim()) {
    return summary;
  }
  const existing = summary.recentTaskSummaries.filter((entry) => entry.taskId !== taskId);
  return {
    ...summary,
    recentTaskSummaries: [
      {
        taskId,
        summary: warm.summary,
        completedAt: new Date().toISOString(),
        ...(Object.keys(warm.resolvedIds).length > 0 ? { resolvedIds: warm.resolvedIds } : {}),
        ...(options?.isPartial ? { isPartial: true } : {}),
        ...(options?.interruptedAt ? { interruptedAt: options.interruptedAt } : {}),
      },
      ...existing,
    ].slice(0, 10),
  };
};

type CompletedSupervisorStep = {
  stepId: string;
  agentId: string;
  objective: string;
  summary: string;
  resolvedIds: Record<string, string>;
  completedAt: string;
  success: boolean;
};

type WarmStepResult = {
  sequence: number;
  toolName: string;
  actorKey?: string | null;
  summary?: string | null;
  resolvedIds?: unknown;
  authorityLevel?: string | null;
};

const WARM_RESOLVED_AUTHORITY_RANK: Record<string, number> = {
  confirmed: 3,
  candidate: 2,
  not_found: 1,
};

const normalizeWarmResolvedIds = (value: unknown): Record<string, string> => {
  const record = asRecordSafe(value);
  if (!record) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(record)
      .map(([key, rawValue]) => [key, asStringSafe(rawValue)?.trim()] as const)
      .filter((entry): entry is readonly [string, string] => Boolean(entry[1])),
  );
};

const mergeWarmResolvedIdsFromStepResults = (
  stepResults: WarmStepResult[],
): Record<string, string> => {
  const resolvedIds: Record<string, string> = {};
  const selectionMeta = new Map<string, { rank: number; sequence: number }>();

  for (const stepResult of stepResults) {
    const normalizedResolvedIds = normalizeWarmResolvedIds(stepResult.resolvedIds);
    const rank = WARM_RESOLVED_AUTHORITY_RANK[stepResult.authorityLevel ?? ''] ?? 0;
    for (const [key, value] of Object.entries(normalizedResolvedIds)) {
      const current = selectionMeta.get(key);
      if (!current || rank > current.rank || (rank === current.rank && stepResult.sequence >= current.sequence)) {
        resolvedIds[key] = value;
        selectionMeta.set(key, { rank, sequence: stepResult.sequence });
      }
    }
  }

  return resolvedIds;
};

const buildWarmSummaryFromStepResults = (stepResults: WarmStepResult[]): {
  summary: string;
  resolvedIds: Record<string, string>;
} => ({
  summary: stepResults
    .map((stepResult) => {
      const summary = stepResult.summary?.trim();
      if (!summary) {
        return null;
      }
      const actorKey = stepResult.actorKey?.trim();
      return actorKey
        ? `${stepResult.toolName}(${actorKey}): ${summary}`
        : `${stepResult.toolName}: ${summary}`;
    })
    .filter((entry): entry is string => Boolean(entry))
    .join('. '),
  resolvedIds: mergeWarmResolvedIdsFromStepResults(stepResults),
});

const getPersistedWarmSummary = async (executionId: string | null | undefined): Promise<{
  summary: string;
  resolvedIds: Record<string, string>;
}> => {
  if (!executionId) {
    return { summary: '', resolvedIds: {} };
  }
  try {
    const stepResults = (await executionService.listStepResults(executionId)) as WarmStepResult[];
    if (stepResults.length === 0) {
      return { summary: '', resolvedIds: {} };
    }
    return buildWarmSummaryFromStepResults(stepResults);
  } catch (error) {
    logger.warn('supervisor.warm_step_results.failed', {
      executionId,
      error: error instanceof Error ? error.message : 'unknown_error',
    });
    return { summary: '', resolvedIds: {} };
  }
};

const getWarmResolvedIdsForExecution = async (
  executionId: string | null | undefined,
  taskId: string,
): Promise<Record<string, string>> => {
  const persisted = await getPersistedWarmSummary(executionId);
  if (Object.keys(persisted.resolvedIds).length > 0) {
    return persisted.resolvedIds;
  }
  return hotContextStore.toWarmSummary(taskId).resolvedIds;
};

const ensureAllowedActionsByTool = async (input: {
  companyId: string;
  requesterAiRole: string;
  allowedToolIds: string[];
  allowedActionsByTool?: Record<string, string[]>;
}): Promise<Record<string, string[]>> => {
  if (input.allowedActionsByTool) {
    return input.allowedActionsByTool;
  }
  return toolPermissionService.getAllowedActionsByTool(
    input.companyId,
    input.requesterAiRole,
    input.allowedToolIds,
  );
};

const takeRecentMessagesByTokenBudget = <
  T extends { content: ModelMessage['content'] | string; role: string },
>(input: {
  messages: T[];
  tokenBudget: number;
  maxMessages: number;
}): T[] => {
  const selected: T[] = [];
  let usedTokens = 0;
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    const message = input.messages[index]!;
    const estimatedTokens = estimateTokens(flattenModelContent(message.content));
    if (
      selected.length >= input.maxMessages ||
      (selected.length > 0 && usedTokens + estimatedTokens > input.tokenBudget)
    ) {
      break;
    }
    selected.unshift(message);
    usedTokens += estimatedTokens;
  }
  return selected;
};

type LarkContextClass =
  | 'lightweight_chat'
  | 'normal_work'
  | 'long_running_task'
  | 'document_grounded_followup';

const isReferentialFollowup = (value: string | null | undefined): boolean =>
  /\b(next task|pick the next|move on|move to next|continue|next one|same file|same one|next estimate|what next)\b/i.test(
    value ?? '',
  );

const isLightweightChatTurn = (value: string | null | undefined): boolean =>
  /^(hi|hello|hey|thanks|thank you|ok|okay|cool|great|nice|yes|no)[.! ]*$/i.test(
    (value ?? '').trim(),
  );

const summarizeConversationMatches = (matches: PersonalMemoryMatch[], maxCount: number): string[] =>
  matches
    .slice(0, maxCount)
    .map((match) => summarizeText(match.content, 320))
    .filter((entry): entry is string => Boolean(entry));

const dedupeConversationSnippets = (input: {
  snippets: string[];
  threadSummary?: DesktopThreadSummary;
  taskState?: DesktopTaskState;
}): string[] => {
  const summaryText = input.threadSummary ? JSON.stringify(input.threadSummary) : '';
  const taskStateText = input.taskState ? JSON.stringify(input.taskState) : '';
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const snippet of input.snippets) {
    const normalized = snippet.trim();
    if (!normalized || seen.has(normalized)) continue;
    if (summaryText.includes(normalized) || taskStateText.includes(normalized)) continue;
    seen.add(normalized);
    deduped.push(normalized);
  }
  return deduped;
};

const maybeStoreLarkConversationTurn = (input: {
  companyId: string;
  userId?: string;
  conversationKey: string;
  sourceId: string;
  role: 'user' | 'assistant';
  text: string;
  chatId: string;
}): void => {
  if (!input.userId || !input.text.trim()) {
    return;
  }
  void personalVectorMemoryService
    .storeChatTurn({
      companyId: input.companyId,
      requesterUserId: input.userId,
      conversationKey: input.conversationKey,
      sourceId: input.sourceId,
      role: input.role,
      text: input.text,
      channel: 'lark',
      chatId: input.chatId,
    })
    .catch((error) => {
      logger.warn('lark.conversation_vector.store.failed', {
        conversationKey: input.conversationKey,
        sourceId: input.sourceId,
        error: error instanceof Error ? error.message : 'unknown',
      });
    });
  if (input.role === 'user') {
    if (!memoryExtractionService.isExplicitMemoryInstruction(input.text)) {
      void memoryService.recordUserTurn({
        companyId: input.companyId,
        userId: input.userId,
        channelOrigin: 'lark',
        conversationKey: input.conversationKey,
        localTimeZoneHint: LOCAL_TIME_ZONE,
        text: input.text,
      });
    }
  }
};

const resolveLarkExplicitMemoryWriteStatus = async (input: {
  adapter: ReturnType<typeof resolveChannelAdapter>;
  taskId: string;
  companyId?: string;
  userId?: string;
  conversationKey: string;
  message: NormalizedIncomingMessageDTO;
  text: string;
  currentTurnExplicitReplyMode?: 'dm' | 'thread' | 'reply' | 'plain';
}): Promise<string | null> => {
  if (!input.companyId || !input.userId || !memoryExtractionService.isExplicitMemoryInstruction(input.text)) {
    return null;
  }

  const sendStatusMessage = async (text: string): Promise<boolean> => {
    try {
      const replyMode = resolveReplyMode({
        chatType: input.message.chatType,
        incomingMessageId: input.message.messageId,
        isProactiveDelivery: false,
        isSensitiveContent: false,
        isShortAcknowledgement: true,
        userExplicitMode: input.currentTurnExplicitReplyMode,
      });
      await input.adapter.sendMessage({
        chatId: resolveReplyModeChatId({
          replyMode,
          message: input.message,
        }),
        text,
        correlationId: input.taskId,
        ...(replyMode.chatType === 'p2p'
          ? {}
          : {
              replyToMessageId: replyMode.replyToMessageId,
              replyInThread: replyMode.replyInThread,
            }),
      });
      return true;
    } catch (error) {
      logger.warn('lark.memory.explicit_write.notice_failed', {
        taskId: input.taskId,
        messageId: input.message.messageId,
        error: error instanceof Error ? error.message : 'unknown',
      });
      return false;
    }
  };

  try {
    const result = await memoryService.recordUserTurnOrThrow({
      companyId: input.companyId,
      userId: input.userId,
      channelOrigin: 'lark',
      conversationKey: input.conversationKey,
      localTimeZoneHint: LOCAL_TIME_ZONE,
      text: input.text,
    });
    if (result.draftCount > 0) {
      const sent = await sendStatusMessage(
        'Got it. I\'ve saved that. You can check what I remember with /memory.',
      );
      return sent
        ? 'A memory save confirmation has already been sent to the user for this turn. Do not repeat it.'
        : 'The current user turn explicitly asked to save a memory and the write succeeded. Start the response with exactly "Got it. I\\\'ve saved that." once, then continue normally. Do not repeat the confirmation later in the message.';
    }

    const sent = await sendStatusMessage(
      'I couldn\'t save that yet. Please restate it more explicitly.',
    );
    return sent
      ? 'The explicit memory save produced no durable memory item, and a failure notice has already been sent to the user. Do not claim it was saved.'
      : 'The current user turn explicitly asked to save a memory, but nothing durable could be extracted. Start the response with exactly "I couldn\\\'t save that yet. Please restate it more explicitly." once, and do not claim it was saved.';
  } catch (error) {
    logger.error('memory.explicit_write.failed', {
      companyId: input.companyId,
      userId: input.userId,
      conversationKey: input.conversationKey,
      error: error instanceof Error ? error.message : 'unknown',
    });
    const sent = await sendStatusMessage(
      'I tried to save that, but something went wrong. Please try again.',
    );
    return sent
      ? 'The explicit memory save failed for this turn, and a failure notice has already been sent to the user. Do not claim it was saved.'
      : 'The current user turn explicitly asked to save a memory, but the write failed. Start the response with exactly "I tried to save that, but something went wrong. Please try again." once, and do not claim it was saved.';
  }
};

const queryLarkConversationMemoryWithFallback = async (input: {
  companyId: string;
  userId: string;
  conversationKey: string;
  queryText: string;
  limit: number;
  isMemoryQuestion: boolean;
}): Promise<{
  matches: PersonalMemoryMatch[];
  scope: 'conversation' | 'global_personal';
}> => {
  const scopedMatches = await personalVectorMemoryService.query({
    companyId: input.companyId,
    requesterUserId: input.userId,
    conversationKey: input.conversationKey,
    text: input.isMemoryQuestion ? expandConversationMemoryQuery(input.queryText) : input.queryText,
    limit: input.limit,
  });
  if (scopedMatches.length > 0 || !input.isMemoryQuestion) {
    return {
      matches: scopedMatches,
      scope: 'conversation',
    };
  }

  const globalMatches = await personalVectorMemoryService.query({
    companyId: input.companyId,
    requesterUserId: input.userId,
    text: expandConversationMemoryQuery(input.queryText),
    limit: input.limit,
  });

  return {
    matches: globalMatches,
    scope: 'global_personal',
  };
};

const retrieveLarkConversationMemory = async (input: {
  companyId: string;
  userId?: string;
  conversationKey: string;
  queryText: string;
  contextClass: LarkContextClass;
  threadSummary: DesktopThreadSummary;
  taskState: DesktopTaskState;
}): Promise<string[]> => {
  const isMemoryQuestion = isPersonalMemoryQuestion(input.queryText);
  if (
    !input.userId ||
    (input.contextClass === 'lightweight_chat' && !isMemoryQuestion) ||
    !input.queryText.trim() ||
    (!isReferentialFollowup(input.queryText) &&
      !isMemoryQuestion &&
      input.contextClass !== 'long_running_task' &&
      input.contextClass !== 'document_grounded_followup')
  ) {
    return [];
  }

  const limit = isMemoryQuestion ? 6 : input.contextClass === 'document_grounded_followup' ? 6 : 4;
  try {
    logger.info(
      'lark.context.conversation_retrieval.start',
      {
        conversationKey: input.conversationKey,
        contextClass: input.contextClass,
        isMemoryQuestion,
        queryLength: input.queryText.trim().length,
        limit,
      },
      { sampleRate: 0.1 },
    );
    const { matches, scope } = await queryLarkConversationMemoryWithFallback({
      companyId: input.companyId,
      userId: input.userId,
      conversationKey: input.conversationKey,
      queryText: input.queryText,
      limit,
      isMemoryQuestion,
    });
    const snippets = dedupeConversationSnippets({
      snippets: summarizeConversationMatches(matches, limit),
      threadSummary: input.threadSummary,
      taskState: input.taskState,
    });
    logger.info(
      'lark.context.conversation_retrieval.completed',
      {
        conversationKey: input.conversationKey,
        contextClass: input.contextClass,
        isMemoryQuestion,
        scope,
        matchCount: matches.length,
        snippetCount: snippets.length,
        topScores: matches.slice(0, 3).map((match) => Number(match.score.toFixed(4))),
      },
      { sampleRate: 0.1 },
    );
    return snippets;
  } catch (error) {
    logger.warn('lark.context.conversation_retrieval.failed', {
      conversationKey: input.conversationKey,
      error: error instanceof Error ? error.message : 'unknown',
    });
    return [];
  }
};

const hydrateAttachedFilesForArtifacts = async (input: {
  companyId: string;
  artifacts: Array<{ fileAssetId: string }>;
  requesterUserId?: string;
  requesterChannelIdentityId?: string;
  requesterAiRole?: string;
}): Promise<AttachedFileRef[]> => {
  if (input.artifacts.length === 0) {
    return [];
  }

  const fileAssetIds = Array.from(new Set(input.artifacts.map((artifact) => artifact.fileAssetId)));
  const isAdmin =
    input.requesterAiRole === 'COMPANY_ADMIN' || input.requesterAiRole === 'SUPER_ADMIN';
  const ownershipIds = Array.from(
    new Set(
      [
        input.requesterUserId,
        input.requesterChannelIdentityId,
      ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0),
    ),
  );
  const assets = await prisma.fileAsset.findMany({
    where: {
      companyId: input.companyId,
      id: { in: fileAssetIds },
      ...(!isAdmin && ownershipIds.length > 0
        ? {
            OR: [
              { uploaderUserId: { in: ownershipIds } },
              { accessPolicies: { some: { aiRole: input.requesterAiRole, canRead: true } } },
            ],
          }
        : {}),
    },
    select: {
      id: true,
      fileName: true,
      mimeType: true,
      cloudinaryUrl: true,
    },
  });

  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  return fileAssetIds.flatMap((fileAssetId) => {
    const asset = byId.get(fileAssetId);
    if (!asset?.cloudinaryUrl || !asset.mimeType) {
      return [];
    }
    return [
      {
        fileAssetId: asset.id,
        fileName: asset.fileName,
        mimeType: asset.mimeType,
        cloudinaryUrl: asset.cloudinaryUrl,
      },
    ];
  });
};

const resolveLarkGroundingAttachments = async (input: {
  companyId: string;
  message?: string;
  currentAttachedFiles: AttachedFileRef[];
  taskState: DesktopTaskState;
  requesterUserId?: string;
  requesterChannelIdentityId?: string;
  requesterAiRole?: string;
}): Promise<{
  attachments: AttachedFileRef[];
  taskState: DesktopTaskState;
  source: 'current' | 'artifact' | 'none';
}> => {
  let nextTaskState = input.taskState;

  if (input.currentAttachedFiles.length > 0) {
    nextTaskState = upsertDesktopSourceArtifacts({
      taskState: nextTaskState,
      artifacts: buildSourceArtifactEntriesFromAttachments(input.currentAttachedFiles),
    });
  }

  const artifactCandidates =
    input.currentAttachedFiles.length === 0
      ? selectDesktopSourceArtifacts({
          taskState: nextTaskState,
          message: input.message,
        })
      : [];

  const artifactAttachments =
    artifactCandidates.length > 0
      ? await hydrateAttachedFilesForArtifacts({
          companyId: input.companyId,
          artifacts: artifactCandidates,
          requesterUserId: input.requesterUserId,
          requesterChannelIdentityId: input.requesterChannelIdentityId,
          requesterAiRole: input.requesterAiRole,
        })
      : [];

  if (artifactAttachments.length > 0) {
    nextTaskState = markDesktopSourceArtifactsUsed({
      taskState: nextTaskState,
      fileAssetIds: artifactAttachments.map((file) => file.fileAssetId),
    });
  }

  const merged = new Map<string, AttachedFileRef>();
  for (const file of input.currentAttachedFiles) {
    merged.set(file.fileAssetId, file);
  }
  for (const file of artifactAttachments) {
    if (!merged.has(file.fileAssetId)) {
      merged.set(file.fileAssetId, file);
    }
  }

  return {
    attachments: Array.from(merged.values()),
    taskState: nextTaskState,
    source:
      input.currentAttachedFiles.length > 0
        ? 'current'
        : artifactAttachments.length > 0
          ? 'artifact'
          : 'none',
  };
};

const classifyArtifactMode = (
  attachments: AttachedFileRef[],
): 'none' | 'image_only' | 'document_only' | 'mixed' => {
  if (attachments.length === 0) {
    return 'none';
  }
  const hasImages = attachments.some((file) => file.mimeType?.startsWith('image/'));
  const hasNonImages = attachments.some((file) => !file.mimeType?.startsWith('image/'));
  if (hasImages && hasNonImages) return 'mixed';
  return hasImages ? 'image_only' : 'document_only';
};

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
    input.taskState.activeSourceArtifacts.length > 0 &&
    isReferentialFollowup(latestUserMessage)
  ) {
    return 'document_grounded_followup';
  }
  if (
    input.taskState.activeSourceArtifacts.length > 0 ||
    input.taskState.completedMutations.length > 0 ||
    Boolean(input.taskState.pendingApproval) ||
    input.threadSummary.sourceMessageCount >= 10 ||
    input.historyMessageCount >= 16
  ) {
    return 'long_running_task';
  }
  return 'normal_work';
};

const resolveModelCatalogEntry = (resolvedModel: {
  effectiveProvider: string;
  effectiveModelId: string;
}) =>
  AI_MODEL_CATALOG_MAP.get(
    `${resolvedModel.effectiveProvider}:${resolvedModel.effectiveModelId}`,
  ) ??
  (resolvedModel.effectiveProvider === 'google'
    ? (AI_MODEL_CATALOG_MAP.get('google:gemini-3.1-flash-lite-preview') ??
      AI_MODEL_CATALOG_MAP.get('google:gemini-2.5-flash') ??
      null)
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
  const ratio =
    input.contextClass === 'lightweight_chat'
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
  const maxMessages =
    input.contextClass === 'lightweight_chat'
      ? LARK_LIGHTWEIGHT_RAW_HISTORY_MAX_MESSAGES
      : input.contextClass === 'normal_work'
        ? LARK_NORMAL_RAW_HISTORY_MAX_MESSAGES
        : LARK_LONG_RUNNING_RAW_HISTORY_MAX_MESSAGES;
  const rawHistoryTokenBudget =
    input.contextClass === 'lightweight_chat'
      ? LARK_LIGHTWEIGHT_RAW_HISTORY_TOKEN_BUDGET
      : input.contextClass === 'normal_work'
        ? LARK_NORMAL_RAW_HISTORY_TOKEN_BUDGET
        : LARK_LONG_RUNNING_RAW_HISTORY_TOKEN_BUDGET;
  const lowValueFilter = input.contextClass !== 'lightweight_chat';
  const selected: Array<ModelMessage & { id?: string }> = [];
  let used = 0;
  let compactionTier = 1;
  const recent = input.messages
    .slice(-Math.max(LARK_LONG_RUNNING_RAW_HISTORY_MAX_MESSAGES, LARK_THREAD_CONTEXT_MESSAGE_LIMIT))
    .filter((message) => {
      const flattened = flattenModelContent(message.content);
      if (lowValueFilter && isLightweightChatTurn(flattened)) {
        return false;
      }
      return (
        filterThreadMessagesForContext([{ role: message.role, content: flattened }]).length > 0
      );
    });

  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const message = recent[index]!;
    const estimated = estimateTokens(flattenModelContent(message.content));
    if (
      selected.length >= maxMessages ||
      (selected.length > 0 && used + estimated > rawHistoryTokenBudget) ||
      used + estimated + input.reservedTokens > input.targetBudgetTokens
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

const loadLarkThreadMemory = async (
  threadId: string,
  userId: string,
): Promise<{
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
    ...(input.summary !== undefined
      ? {
          summaryJson: input.summary ? (input.summary as unknown as Record<string, unknown>) : null,
        }
      : {}),
    ...(input.taskState !== undefined
      ? {
          taskStateJson: input.taskState
            ? (input.taskState as unknown as Record<string, unknown>)
            : null,
        }
      : {}),
  });
};

const persistLarkSharedChatMemory = async (input: {
  companyId: string;
  chatId: string;
  chatType?: string;
  summary?: DesktopThreadSummary | null;
  taskState?: DesktopTaskState | null;
}) => {
  await larkChatContextService.updateMemory({
    companyId: input.companyId,
    chatId: input.chatId,
    chatType: input.chatType,
    summary: input.summary,
    taskState: input.taskState,
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

const shouldExposeZohoBooksReadForLarkMessage = (message?: string): boolean => {
  const text = message?.trim();
  if (!text) {
    return false;
  }
  const intent = classifyIntent(text);
  return intent.domain === 'zoho_books' && !intent.isWriteLike;
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
    lines.push(
      `Latest Lark event: ${latestEvent.summary ?? latestEvent.eventId} [eventId=${latestEvent.eventId}]`,
    );
  }

  return lines.length > 0 ? ['Conversation refs:', ...lines].join('\n') : null;
};

const buildLatestConversationRefs = (conversationKey: string) => {
  const latestTask = conversationMemoryStore.getLatestLarkTask(conversationKey);
  const latestDoc = conversationMemoryStore.getLatestLarkDoc(conversationKey);
  const latestEvent = conversationMemoryStore.getLatestLarkCalendarEvent(conversationKey);
  const latestFile = conversationMemoryStore.getLatestFileAsset(conversationKey);

  return {
    latestTaskSummary: latestTask?.summary ?? null,
    latestEventSummary: latestEvent?.summary ?? null,
    latestDocTitle: latestDoc?.title ?? null,
    latestFileName: latestFile?.fileName ?? null,
  };
};

const shouldBypassUnverifiedDuplicateTaskFastReply = (input: {
  conversationKey: string;
  childRoute: DesktopChildRoute;
  latestUserMessage: string;
}): boolean => {
  if (input.childRoute.route !== 'fast_reply' || !input.childRoute.reply?.trim()) {
    return false;
  }
  const normalizedIntent = input.childRoute.normalizedIntent?.trim().toLowerCase() ?? '';
  const latestUserMessage = input.latestUserMessage.trim().toLowerCase();
  const looksLikeDuplicateTaskClaim =
    normalizedIntent.includes('duplicate task request') ||
    (latestUserMessage.includes('task') &&
      /already created|already assigned/i.test(input.childRoute.reply));
  if (!looksLikeDuplicateTaskClaim) {
    return false;
  }
  return !conversationMemoryStore.getLatestLarkTask(input.conversationKey);
};

type PersistedConversationRefs = {
  latestLarkDoc?: Record<string, unknown>;
  latestLarkCalendarEvent?: Record<string, unknown>;
  latestLarkTask?: Record<string, unknown>;
};

const buildPersistedConversationRefs = (
  conversationKey: string,
): PersistedConversationRefs | null => {
  const latestDoc = conversationMemoryStore.getLatestLarkDoc(conversationKey);
  const latestEvent = conversationMemoryStore.getLatestLarkCalendarEvent(conversationKey);
  const latestTask = conversationMemoryStore.getLatestLarkTask(conversationKey);

  const refs: PersistedConversationRefs = {
    ...(latestDoc
      ? {
          latestLarkDoc: {
            title: latestDoc.title,
            documentId: latestDoc.documentId,
            ...(latestDoc.url ? { url: latestDoc.url } : {}),
          },
        }
      : {}),
    ...(latestEvent
      ? {
          latestLarkCalendarEvent: {
            eventId: latestEvent.eventId,
            ...(latestEvent.calendarId ? { calendarId: latestEvent.calendarId } : {}),
            ...(latestEvent.summary ? { summary: latestEvent.summary } : {}),
            ...(latestEvent.startTime ? { startTime: latestEvent.startTime } : {}),
            ...(latestEvent.endTime ? { endTime: latestEvent.endTime } : {}),
            ...(latestEvent.url ? { url: latestEvent.url } : {}),
          },
        }
      : {}),
    ...(latestTask
      ? {
          latestLarkTask: {
            taskId: latestTask.taskId,
            ...(latestTask.taskGuid ? { taskGuid: latestTask.taskGuid } : {}),
            ...(latestTask.summary ? { summary: latestTask.summary } : {}),
            ...(latestTask.status ? { status: latestTask.status } : {}),
            ...(latestTask.url ? { url: latestTask.url } : {}),
          },
        }
      : {}),
  };

  return Object.keys(refs).length > 0 ? refs : null;
};

const hydrateConversationRefsFromMetadata = (
  conversationKey: string,
  metadata: Record<string, unknown>,
): void => {
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
  resolvedReplyModeHint?: ReplyModeHint;
  latestUserMessage?: string;
  queryEnrichment?: QueryEnrichment;
  hasAttachedFiles?: boolean;
  groundedFiles?: GroundedFilePromptInfo[];
  threadSummary?: DesktopThreadSummary;
  taskState?: DesktopTaskState;
  conversationRetrievalSnippets?: string[];
  behaviorProfileContext?: string | null;
  durableMemoryContext?: string | null;
  relevantMemoryFactsContext?: string | null;
  memoryWriteStatusContext?: string | null;
  activeTaskContext?: string | null;
  threadSummaryContextOverride?: string | null;
  taskStateContextOverride?: string | null;
}) => {
  const retrievalGuidance = input.latestUserMessage?.trim()
    ? retrievalOrchestratorService.buildPromptGuidance({
        messageText: input.queryEnrichment?.cleanQuery ?? input.latestUserMessage,
        hasAttachments: input.hasAttachedFiles,
      })
    : [];
  return buildSharedAgentSystemPrompt({
    runtimeLabel: 'You are Divo, EMIAC\'s internal AI colleague.',
    conversationKey: input.conversationKey,
    workspace: input.runtime.workspace,
    approvalPolicySummary: input.runtime.desktopApprovalPolicySummary,
    workspaceAvailability:
      input.runtime.desktopExecutionAvailability ??
      (input.runtime.workspace ? 'available' : 'unknown'),
    latestActionResult: input.runtime.latestActionResult,
    allowedToolIds: input.runtime.allowedToolIds,
    runExposedToolIds: input.runtime.runExposedToolIds,
    plannerCandidateToolIds: input.runtime.plannerCandidateToolIds,
    toolSelectionReason: input.runtime.toolSelectionReason,
    plannerChosenToolId: input.runtime.plannerChosenToolId,
    plannerChosenOperationClass: input.runtime.plannerChosenOperationClass,
    allowedActionsByTool: input.runtime.allowedActionsByTool,
    requesterName: input.runtime.requesterName,
    requesterEmail: input.runtime.requesterEmail,
    departmentName: input.runtime.departmentName,
    departmentRoleSlug: input.runtime.departmentRoleSlug,
    departmentSystemPrompt: input.runtime.departmentSystemPrompt,
    departmentSkillsMarkdown: input.runtime.departmentSkillsMarkdown,
    dateScope: input.runtime.dateScope,
    latestUserMessage: input.latestUserMessage,
    queryEnrichment: input.queryEnrichment
      ? {
          cleanQuery: input.queryEnrichment.cleanQuery,
          retrievalQuery: input.queryEnrichment.retrievalQuery,
          exactTerms: input.queryEnrichment.exactTerms,
          contextHints: input.queryEnrichment.contextHints,
        }
      : undefined,
    threadSummaryContext:
      input.threadSummaryContextOverride
      ?? (input.threadSummary ? buildThreadSummaryContext(input.threadSummary) : null),
    taskStateContext:
      input.taskStateContextOverride
      ?? (input.taskState ? buildTaskStateContext(input.taskState) : null),
    conversationRefsContext: buildConversationRefsContext(input.conversationKey),
    conversationRetrievalSnippets: input.conversationRetrievalSnippets,
    behaviorProfileContext: input.behaviorProfileContext,
    durableMemoryContext: input.durableMemoryContext,
    relevantMemoryFactsContext: input.relevantMemoryFactsContext,
    memoryWriteStatusContext: input.memoryWriteStatusContext,
    activeTaskContext: input.activeTaskContext,
    routerAcknowledgement: input.routerAcknowledgement,
    childRouteHints: input.childRouteHints,
    resolvedReplyModeHint: input.resolvedReplyModeHint,
    retrievalGuidance,
    hasAttachedFiles: input.hasAttachedFiles,
    hasActiveSourceArtifacts: (input.taskState?.activeSourceArtifacts.length ?? 0) > 0,
    groundedFiles: input.groundedFiles,
  });
};

const buildMinimalLarkSystemPrompt = (input: {
  taskStateContext?: string | null;
  latestUserMessage?: string;
}): string =>
  [
    'You are Divo, EMIAC\'s internal AI colleague.',
    'Use only the tools available in this run.',
    'Prioritize the latest user request and keep the answer precise.',
    input.taskStateContext?.trim() ? `Task state:\n${input.taskStateContext.trim()}` : '',
    input.latestUserMessage?.trim() ? `Latest user message:\n${input.latestUserMessage.trim()}` : '',
  ].filter(Boolean).join('\n\n');

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
  if (
    lower.includes('need both a dayofweek and time') ||
    lower.includes('need both a weekday and time')
  ) {
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

const buildExplicitMissingInputReason = (output: VercelToolEnvelope): string | null => {
  const denialReason =
    typeof output.fullPayload?.denialReason === 'string' ? output.fullPayload.denialReason : null;
  const summary = summarizeText(output.summary, 600) ?? output.summary;
  const action =
    toClarificationQuestion(output.userAction) ?? summarizeText(output.userAction, 400);

  if (!denialReason || !summary) {
    return null;
  }

  if (
    [
      'books_principal_not_resolved',
      'missing_requester_email',
      'books_module_requires_company_scope',
      'record_not_in_self_scope',
      'ownership_not_matched',
    ].includes(denialReason)
  ) {
    return action ? [summary, '', action].join('\n') : summary;
  }

  return null;
};

const buildMissingInputResponseText = (
  output: VercelToolEnvelope | null | undefined,
): string | null => {
  if (!output) {
    return null;
  }
  const explicitReason = buildExplicitMissingInputReason(output);
  if (explicitReason) {
    return explicitReason;
  }
  const question =
    toClarificationQuestion(output.userAction) ?? toClarificationQuestion(output.summary);
  if (question) {
    return ['I need a bit more information before I can finish this.', '', question].join('\n');
  }
  const action = summarizeText(output.userAction, 400);
  const summary = summarizeText(output.summary, 500);
  if (action) {
    return ['I need a bit more information before I can finish this.', '', action].join('\n');
  }
  if (summary) {
    return ['I need a bit more information before I can finish this.', '', summary].join('\n');
  }
  return null;
};

const buildLarkStatusText = (input: {
  task: OrchestrationTaskDTO;
  message: NormalizedIncomingMessageDTO;
  phase:
    | 'received'
    | 'preparing'
    | 'planning'
    | 'tool_running'
    | 'tool_done'
    | 'analyzing'
    | 'approval'
    | 'failed';
  detail?: string;
  history: string[];
  heartbeatNote?: string;
}) => {
  void input.task;
  void input.message;

  const detail = input.detail?.trim();
  const normalizedHistory = input.history
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const latestHistory = [...normalizedHistory]
    .reverse()
    .find((entry) => entry.length > 0);
  const recentHistory = [...normalizedHistory]
    .slice(-3)
    .reverse()
    .map((s) => `▸ ${s.length > 80 ? `${s.slice(0, 79)}…` : s}`)
    .join('\n');
  const phaseLabel = (() => {
    switch (input.phase) {
      case 'received':
        return 'Received';
      case 'preparing':
        return 'Preparing';
      case 'planning':
        return 'Planning';
      case 'tool_running':
        return 'Running tools';
      case 'tool_done':
        return 'Processing results';
      case 'analyzing':
        return 'Finalizing';
      case 'approval':
        return 'Waiting for approval';
      case 'failed':
        return 'Failed';
      default:
        return 'Working';
    }
  })();
  const phaseHeadline = (() => {
    switch (input.phase) {
      case 'received':
        return 'Thinking';
      case 'preparing':
        return 'Resolving the request context';
      case 'planning':
        return 'Digging through the next step';
      case 'tool_running':
        return 'Fetching the requested data';
      case 'tool_done':
        return 'Checking the retrieved results';
      case 'analyzing':
        return 'Finalizing the response';
      case 'approval':
        return 'Waiting for approval';
      case 'failed':
        return 'Something needs attention';
      default:
        return 'Thinking';
    }
  })();
  const latestAction = summarizeText(
    detail && latestHistory && latestHistory !== detail
      ? `${detail} | ${latestHistory}`
      : detail ?? latestHistory,
    220,
  );
  const lines = [phaseHeadline, '', `Phase: ${phaseLabel}`];
  if (latestAction) {
    lines.push(`Current: ${latestAction}`);
  }
  if (recentHistory) {
    lines.push('', 'Recent progress:');
    lines.push(recentHistory);
  }
  if (input.heartbeatNote?.trim()) {
    lines.push('', input.heartbeatNote.trim());
  }
  return lines.join('\n');
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

const requiresManagerApproval = (
  runtime: VercelRuntimeRequestContext,
  pendingApproval: PendingApprovalAction,
): boolean =>
  pendingApproval.kind === 'tool_action'
  && Boolean(runtime.departmentManagerApprovalConfig?.enabled)
  && runtime.departmentManagerApprovalConfig!.requiredToolIds.includes(
    pendingApproval.toolId,
  );

const buildManagerApprovalText = (input: {
  pendingApproval: PendingApprovalAction;
  requesterLabel: string;
  departmentName?: string;
}): string => {
  const { pendingApproval } = input;
  const departmentLine = input.departmentName ? `Department: ${input.departmentName}` : null;
  const targetLine =
    pendingApproval.kind === 'tool_action'
      ? `Tool: ${pendingApproval.toolId} (${pendingApproval.actionGroup})`
      : null;
  return [
    'Manager approval needed.',
    '',
    `Requester: ${input.requesterLabel}`,
    departmentLine,
    targetLine,
    `Summary: ${pendingApproval.kind === 'tool_action' ? pendingApproval.summary : pendingApproval.title ?? pendingApproval.kind}`,
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');
};

const sendManagerApprovalRequest = async (input: {
  runtime: VercelRuntimeRequestContext;
  message: NormalizedIncomingMessageDTO;
  pendingApproval: PendingApprovalAction;
}): Promise<{ sent: boolean; approverName?: string; approverOpenId?: string; reason?: string }> => {
  if (!requiresManagerApproval(input.runtime, input.pendingApproval)) {
    return { sent: false, reason: 'manager_approval_not_required' };
  }

  const approver = await departmentService.resolveDepartmentApprover({
    companyId: input.runtime.companyId,
    departmentId: input.runtime.departmentId,
  });
  if (!approver?.larkOpenId) {
    return { sent: false, reason: 'no_lark_manager_available' };
  }

  const adapter = resolveChannelAdapter('lark');
  const requesterLabel =
    input.runtime.requesterEmail?.trim()
    || input.message.trace?.requesterEmail?.trim()
    || input.runtime.userId;
  await adapter.sendMessage({
    chatId: approver.larkOpenId,
    text: buildManagerApprovalText({
      pendingApproval: input.pendingApproval,
      requesterLabel,
      departmentName: input.runtime.departmentName,
    }),
    actions: buildLarkApprovalActions(input.pendingApproval),
    correlationId: input.runtime.executionId,
  });

  return {
    sent: true,
    approverName: approver.name ?? approver.email ?? undefined,
    approverOpenId: approver.larkOpenId,
  };
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

export const buildDelegatedLarkStepPrompt = (input: {
  step: SupervisorStep;
  originalUserMessage: string;
  scopedContext: string[];
  upstreamResults: DelegatedAgentExecutionResult[];
  resolvedContext: Record<string, string>;
}): string => {
  const ACTION_AGENTS: Array<SupervisorStep['agentId']> = [
    'google-workspace-agent',
    'lark-ops-agent',
    'zoho-ops-agent',
    'workspace-agent',
  ];
  const objectiveLooksLikeEmailSend = /\b(send|email|mail)\b/i.test(input.step.objective);
  const objectiveLooksLikeAction = /\b(send|create|update|delete|post|publish|assign|schedule|book|draft|write|add|remove)\b/i.test(input.step.objective);
  const objectiveRecipientEmail = input.step.objective.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? null;
  const primaryUpstreamContent = input.upstreamResults
    .map((result) => result.text?.trim() ?? '')
    .find((text) => text.length > 0) ?? '';
  const upstreamContentAvailable = primaryUpstreamContent.length > 0;
  const upstreamContext = input.upstreamResults.length > 0
    ? input.upstreamResults.map((result) => [
      `Step ${result.stepId} (${result.agentId})`,
      `Objective: ${result.objective}`,
      `Summary: ${result.summary}`,
      `Text: ${result.text}`,
      `Resolved context: ${formatSupervisorResolvedContext((result.data?.resolvedContext as Record<string, string> | undefined) ?? {})}`,
      `Structured output: ${JSON.stringify(result.output)}`,
    ].join('\n')).join('\n\n')
    : 'None.';

  const scopedContext = input.scopedContext.length > 0
    ? input.scopedContext.join('\n')
    : 'None.';

  const parts = [
    `You are executing delegated supervisor step ${input.step.stepId}.`,
    `Assigned agent family: ${input.step.agentId}.`,
    `Objective: ${input.step.objective}`,
    `Original user request: ${input.originalUserMessage}`,
  ];
  if (input.step.structuredObjective) {
    const obj = input.step.structuredObjective;
    parts.push('', '[Structured Task Context]');
    if (obj.targetEntity) parts.push(`Entity: ${obj.targetEntity}`);
    if (obj.targetSource) parts.push(`Primary source: ${obj.targetSource}`);
    if (obj.dateRange) parts.push(`Date range: ${obj.dateRange.from} to ${obj.dateRange.to}`);
    if (obj.authorityRequired) {
      parts.push('Authority required: do not answer from chat history or public web unless all internal sources are exhausted and explicitly noted.');
    }
    parts.push('[End Structured Task Context]');
  }
  if (input.step.agentId === 'google-workspace-agent') {
    parts.push(
      '',
      'IMPORTANT: Personal history results showing past failures are NOT your current state. Permissions and capabilities may have changed. Always attempt the action regardless of what past history shows. Past failures do not predict current failures.',
    );
    if (objectiveLooksLikeEmailSend && primaryUpstreamContent) {
      parts.push(
        '',
        'EMAIL CONTENT TO SEND:',
        primaryUpstreamContent,
      );
    }
    if (objectiveLooksLikeEmailSend) {
      parts.push(
        '',
        objectiveRecipientEmail
          ? `The email content above is ready. Your only job is to call googleWorkspace with operation=sendMessage, to=${objectiveRecipientEmail}, subject="Research Findings: Best Agentic AI Platforms", body={EMAIL CONTENT}. Do not call contextSearch. Do not search for anything. Act now.`
          : 'If this is an email send step and the recipient, subject, or body is already present in the objective, resolved handoff context, or EMAIL CONTENT block, copy those values directly into googleWorkspace(operation="sendMessage"). Do not call contextSearch. Do not search for anything. Act now.',
      );
    }
  }
  if (ACTION_AGENTS.includes(input.step.agentId) && objectiveLooksLikeAction && upstreamContentAvailable) {
    parts.push(
      '',
      'ACTION CONTEXT:',
      'You are an action agent. Your upstream step results contain everything you need.',
      'Do NOT call contextSearch — the content is already above.',
      'Execute the action directly using your primary tool.',
      'Past history showing failures is irrelevant — attempt the action now.',
    );
  } else if (ACTION_AGENTS.includes(input.step.agentId) && objectiveLooksLikeAction) {
    parts.push(
      '',
      'ACTION CONTEXT:',
      'You are an action agent.',
      'Your context is provided in the handoff input above.',
      'If critical information is missing, do not search.',
      'Return a concise explanation of exactly what field or reference is missing so the supervisor can provide it.',
    );
  }
  parts.push(
    '',
    'Resolved handoff context:',
    formatSupervisorResolvedContext(input.resolvedContext),
    '',
    'Scoped orchestration context:',
    scopedContext,
    '',
    'Upstream step results:',
    upstreamContext,
    '',
    'Your output is consumed by the supervisor.',
    'Only do the work required for this step. Use only the tools available in this agent family.',
    delegatedStepLikelyRequiresToolUse(input.step)
      ? 'This step obviously requires tool use. Do not spend your first turn narrating a plan. Call the relevant tool immediately, then summarize the result.'
      : 'If a tool is needed, use it directly instead of spending time narrating a plan.',
    'Do not comment on tools owned by other agent families.',
    'Do not say another tool is unavailable just because it is not in your family.',
    'If this step is only gathering data for a later step, return that data plainly and stop.',
    'If the step cannot continue because of approval or missing user input, surface that plainly.',
  );
  return parts.join('\n');
};

export const buildDelegatedAgentSystemPrompt = (baseSystemPrompt: string, agentId: SupervisorStep['agentId']): string => {
  const ACTION_AGENTS: Array<SupervisorStep['agentId']> = [
    'google-workspace-agent',
    'lark-ops-agent',
    'zoho-ops-agent',
    'workspace-agent',
  ];
  const retrievalPolicy = ACTION_AGENTS.includes(agentId)
    ? `Your context is provided in the handoff input above.
If you are missing critical information needed to complete your objective, do not search.
Return a concise explanation of exactly what data is missing and the supervisor will provide it.`
    : 'Use the context and evidence handed to you by the supervisor. If critical information is missing, state exactly what is missing instead of guessing.';
  let systemPrompt = [
    baseSystemPrompt,
    '',
    '## Delegated supervisor execution',
    `You are running inside delegated agent family: ${agentId}.`,
    'You are not the top-level supervisor.',
    'Complete only the assigned step objective.',
    'Do not claim other steps are complete.',
    'Do not act like the final user-facing assistant unless this step explicitly asks for a final answer.',
    'Do not apologize that tools outside your family are unavailable. Another delegated step may handle them.',
    'Treat the "Resolved handoff context" block as authoritative for IDs, emails, invoice numbers, and other concrete entities when it is relevant to this step.',
    'If a required parameter is already present in that block, pass it directly to the tool instead of asking for it again or omitting it.',
    retrievalPolicy,
  ].join('\n');
  const profile = AGENT_CAPABILITY_PROFILES[agentId];
  if (profile) {
    systemPrompt += `\n\n[Agent Capability Profile]\n${profile.trim()}`;
  }
  return systemPrompt;
};

const adaptPlanForVercel = (task: OrchestrationTaskDTO): OrchestrationTaskDTO => ({
  ...task,
  plan: task.plan.map((step) =>
    step === 'agent.invoke.lark-response' ? 'delivery.lark-status' : step,
  ),
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
  const fallbackAllowedToolIds = await toolPermissionService.getAllowedTools(
    companyId,
    requesterAiRole,
  );
  const linkedUserId = await resolveWorkspaceUserIdForLarkMessage(message);
  let departmentId: string | undefined;
  let departmentName: string | undefined;
  let departmentRoleId: string | undefined;
  let departmentRoleSlug: string | undefined;
  let departmentZohoReadScope: 'personalized' | 'show_all' | undefined;
  let departmentZohoRateLimitConfig: VercelRuntimeRequestContext['departmentZohoRateLimitConfig'];
  let departmentManagerApprovalConfig: VercelRuntimeRequestContext['departmentManagerApprovalConfig'];
  let departmentSystemPrompt: string | undefined;
  let departmentSkillsMarkdown: string | undefined;
  let allowedToolIds = fallbackAllowedToolIds;
  let allowedActionsByTool: Record<string, string[]> | undefined;
  if (!linkedUserId) {
    logger.warn('lark.runtime.department_skipped', {
      channelIdentityId: message.trace?.channelIdentityId ?? null,
      requesterEmail: message.trace?.requesterEmail ?? null,
      reason: 'linkedUserId_not_resolved',
    });
  }
  const desktopAvailability = linkedUserId
    ? desktopWsGateway.getRemoteExecutionAvailability(linkedUserId, companyId)
    : { status: 'none' as const };
  const activeWorkspace =
    desktopAvailability.status === 'available'
      ? desktopAvailability.session?.activeWorkspace
      : undefined;

  if (linkedUserId) {
    const departments = await departmentService.listUserDepartments(linkedUserId, companyId);
    const preferredDepartment = await departmentPreferenceService.resolveForRuntime(
      companyId,
      linkedUserId,
      departments,
    );
    if (preferredDepartment.reason === 'needs_selection') {
      throw new DepartmentSelectionRequiredError();
    }
    const resolved = await departmentService.resolveRuntimeContext({
      userId: linkedUserId,
      companyId,
      departmentId: preferredDepartment.departmentId,
      fallbackAllowedToolIds,
      requesterAiRole,
    });
    departmentId = resolved.departmentId;
    departmentName = resolved.departmentName;
    departmentRoleId = resolved.departmentRoleId;
    departmentRoleSlug = resolved.departmentRoleSlug;
    departmentZohoReadScope = resolved.departmentZohoReadScope;
    departmentZohoRateLimitConfig = resolved.departmentZohoRateLimitConfig;
    departmentManagerApprovalConfig = resolved.departmentManagerApprovalConfig;
    departmentSystemPrompt = resolved.systemPrompt;
    departmentSkillsMarkdown = resolved.skillsMarkdown;
    allowedToolIds = resolved.allowedToolIds;
    allowedActionsByTool = resolved.allowedActionsByTool;
  }

  if (!allowedToolIds.includes('contextSearch')) {
    allowedToolIds = [...allowedToolIds, 'contextSearch'];
  }

  if (shouldExposeZohoBooksReadForLarkMessage(message.text) && !allowedToolIds.includes('zohoBooks')) {
    allowedToolIds = [...allowedToolIds, 'zohoBooks'];
  }
  allowedActionsByTool = await ensureAllowedActionsByTool({
    companyId,
    requesterAiRole,
    allowedToolIds,
    allowedActionsByTool,
  });
  if (!allowedActionsByTool.contextSearch?.includes('read')) {
    allowedActionsByTool = {
      ...allowedActionsByTool,
      contextSearch: ['read'],
    };
  }

  return {
    channel: 'lark',
    threadId: persistentThreadId ?? buildConversationKey(message),
    chatId: message.chatId,
    attachedFiles: message.attachedFiles,
    executionId: resolveCanonicalExecutionId(task, message),
    companyId,
    userId: linkedUserId,
    requesterAiRole,
    requesterChannelIdentityId: message.trace?.channelIdentityId,
    requesterName: message.trace?.requesterName,
    requesterEmail: message.trace?.requesterEmail,
    sourceMessageId: message.messageId,
    sourceReplyToMessageId: message.trace?.replyToMessageId ?? message.messageId,
    sourceStatusMessageId: message.trace?.statusMessageId,
    sourceStatusReplyModeHint: message.trace?.statusReplyModeHint,
    sourceChatType: message.chatType,
    sourceChannelUserId: message.userId,
    departmentId,
    departmentName,
    departmentRoleId,
    departmentRoleSlug,
    departmentZohoReadScope,
    departmentZohoRateLimitConfig,
    departmentManagerApprovalConfig,
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
    latestActionResult: taskState?.latestActionResult
      ? {
          kind: taskState.latestActionResult.kind,
          ok: taskState.latestActionResult.ok,
          summary: taskState.latestActionResult.summary,
        }
      : undefined,
    allowedToolIds: allowedToolIds.filter((toolId) => !LARK_BLOCKED_TOOL_IDS.has(toolId)),
    allowedActionsByTool: allowedActionsByTool
      ? Object.fromEntries(
          Object.entries(allowedActionsByTool).filter(
            ([toolId]) => !LARK_BLOCKED_TOOL_IDS.has(toolId),
          ),
        )
      : undefined,
    departmentSystemPrompt,
    departmentSkillsMarkdown,
  };
};

const resolveWorkspaceUserIdForLarkMessage = async (
  message: NormalizedIncomingMessageDTO,
): Promise<string | undefined> => {
  const linkedUserId = message.trace?.linkedUserId;
  if (linkedUserId) {
    return linkedUserId;
  }
  const companyId = message.trace?.companyId;
  const channelIdentityId = message.trace?.channelIdentityId;
  if (!companyId || !channelIdentityId) {
    return undefined;
  }
  try {
    const mapped = await departmentService.resolveWorkspaceMemberFromChannelIdentity({
      companyId,
      channelIdentityId,
    });
    return mapped.userId;
  } catch (error) {
    logger.info('vercel.runtime_context.channel_identity_unresolved', {
      companyId,
      channelIdentityId,
      requesterEmail: message.trace?.requesterEmail ?? null,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
};

const executeLarkVercelTask = async (
  task: OrchestrationTaskDTO,
  message: NormalizedIncomingMessageDTO,
  abortSignal?: AbortSignal,
): Promise<OrchestrationExecutionResult> => {
  const adapter = resolveChannelAdapter('lark');
  const companyId = message.trace?.companyId;
  const linkedUserId = await resolveWorkspaceUserIdForLarkMessage(message);
  const isSharedGroupChat = Boolean(companyId && message.chatType === 'group' && message.chatId);
  await assertExecutionRunnable(task.taskId, abortSignal);
  const sharedChatContext =
    isSharedGroupChat && companyId
      ? await larkChatContextService.load({
          companyId,
          chatId: message.chatId,
          chatType: message.chatType,
        })
      : null;
  const persistentThread =
    !isSharedGroupChat && companyId && linkedUserId
      ? await desktopThreadsService.findOrCreateLarkLifetimeThread(linkedUserId, companyId)
      : null;
  const executionId = resolveCanonicalExecutionId(task, message);
  const contextStorageId = persistentThread?.id ?? sharedChatContext?.id;
  const conversationKey = persistentThread
    ? buildPersistentLarkConversationKey(persistentThread.id)
    : sharedChatContext
      ? buildSharedLarkConversationKey(message.chatId)
      : buildConversationKey(message);
  const statusHistory: string[] = [];
  let currentStatusPhase:
    | 'received'
    | 'preparing'
    | 'planning'
    | 'tool_running'
    | 'tool_done'
    | 'analyzing'
    | 'approval'
    | 'failed' = 'received';
  let currentStatusDetail: string | undefined;
  let currentStatusActions: ChannelAction[] | undefined;
  let heartbeatIndex = 0;
  const completedSupervisorSteps = new Map<string, CompletedSupervisorStep>();
  let runCompletedSuccessfully = false;
  const runStartedAt = Date.now();
  const originalUserMessage = message.text;
  const currentTurnExplicitReplyMode = resolveExplicitReplyModeFromText(originalUserMessage) as
    | 'dm'
    | 'thread'
    | 'reply'
    | 'plain'
    | undefined;
  let explicitReplyMode = currentTurnExplicitReplyMode;
  let proposedReplyMode: ReplyModeHint | undefined;
  const ackMessageId = message.trace?.ackMessageId;
  const ackReplyModeHint = message.trace?.ackReplyModeHint ?? 'reply';
  let activeReplyModeHint: ReplyModeHint = ackReplyModeHint;
  let statusCoordinator: LarkStatusCoordinator | null = null;
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
  const maybeRedirectAckMessage = async (targetHint: ReplyModeHint): Promise<void> => {
    if (!ackMessageId || targetHint === ackReplyModeHint) {
      return;
    }
    try {
      await adapter.updateMessage({
        messageId: ackMessageId,
        text: buildReplyModeRedirectText(targetHint),
        correlationId: task.taskId,
        actions: [],
      });
    } catch (error) {
      logger.warn('lark.ack.redirect_failed', {
        taskId: task.taskId,
        messageId: message.messageId,
        ackMessageId,
        targetHint,
        error: error instanceof Error ? error.message : 'unknown',
      });
    }
  };
  const ensureStatusCoordinator = async (replyMode: ReplyModeConfig): Promise<LarkStatusCoordinator> => {
    const nextHint = buildReplyModeHint(replyMode);
    if (statusCoordinator && replyModeHintsMatch(activeReplyModeHint, nextHint)) {
      return statusCoordinator;
    }
    if (statusCoordinator) {
      await statusCoordinator.close();
      statusCoordinator = null;
    }
    await maybeRedirectAckMessage(nextHint);
    statusCoordinator = new LarkStatusCoordinator({
      adapter,
      chatId: resolveReplyModeChatId({ replyMode, message }),
      correlationId: task.taskId,
      initialStatusMessageId:
        ackMessageId && replyModeHintsMatch(ackReplyModeHint, nextHint)
          ? ackMessageId
          : undefined,
      replyToMessageId: replyMode.replyToMessageId,
      replyInThread: replyMode.replyInThread,
    });
    activeReplyModeHint = nextHint;
    return statusCoordinator;
  };
  const updateStatus = async (
    phase: typeof currentStatusPhase,
    detail?: string,
    actions?: ChannelAction[],
    options?: { force?: boolean },
  ) => {
    currentStatusPhase = phase;
    currentStatusDetail = detail;
    currentStatusActions = actions;
    const coordinator = await ensureStatusCoordinator(resolveReplyMode({
      chatType: message.chatType,
      incomingMessageId: message.messageId,
      isProactiveDelivery: false,
      isSensitiveContent: false,
      isShortAcknowledgement: false,
      proposedReplyMode,
      userExplicitMode: explicitReplyMode,
    }));
    await coordinator.update(renderCurrentStatus(false), options);
  };
  const deliverTerminalResponse = async (input: {
    text: string;
    actions?: ChannelAction[];
    hasToolResults: boolean;
    isSensitiveContent: boolean;
    proposedReplyMode?: ReplyModeHint;
  }): Promise<{ statusMessageId?: string; replyModeHint: ReplyModeHint }> => {
    const finalReplyMode = resolveReplyMode({
      chatType: message.chatType,
      incomingMessageId: message.messageId,
      isProactiveDelivery: false,
      isSensitiveContent: input.isSensitiveContent,
      isShortAcknowledgement: countSentences(input.text) <= 1 && !input.hasToolResults,
      proposedReplyMode: input.proposedReplyMode ?? proposedReplyMode,
      userExplicitMode: explicitReplyMode,
    });
    const finalReplyModeHint = buildReplyModeHint(finalReplyMode);
    if (!replyModeHintsMatch(activeReplyModeHint, finalReplyModeHint)) {
      await ensureStatusCoordinator(finalReplyMode);
    }
    const coordinator = await ensureStatusCoordinator(finalReplyMode);
    await coordinator.replace(input.text, input.actions ?? []);
    return {
      statusMessageId: coordinator.getStatusMessageId(),
      replyModeHint: finalReplyModeHint,
    };
  };
  hotContextStore.init(task.taskId);
  const currentAttachments = (message.attachedFiles ?? []) as AttachedFileRef[];
  let groundingAttachments = currentAttachments;
  let persistedUserMessageId: string | undefined;
  let activeThreadSummary = parseDesktopThreadSummary(null);
  let activeTaskState = createEmptyTaskState();
  if (persistentThread) {
    await assertExecutionRunnable(task.taskId, abortSignal);
    const threadMemory = await loadLarkThreadMemory(persistentThread.id, linkedUserId);
    activeThreadSummary = threadMemory.summary;
    activeTaskState = threadMemory.taskState;
    const grounding = await resolveLarkGroundingAttachments({
      companyId,
      message: message.text,
      currentAttachedFiles: currentAttachments,
      taskState: activeTaskState,
      requesterUserId: linkedUserId ?? message.userId,
      requesterChannelIdentityId: message.trace?.channelIdentityId,
      requesterAiRole: message.trace?.userRole ?? 'MEMBER',
    });
    activeTaskState = grounding.taskState;
    groundingAttachments = grounding.attachments;
    await assertExecutionRunnable(task.taskId, abortSignal);
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
    maybeStoreLarkConversationTurn({
      companyId,
      userId: linkedUserId,
      conversationKey,
      sourceId: userMessage.id,
      role: 'user',
      text: originalUserMessage,
      chatId: message.chatId,
    });
  } else if (sharedChatContext && companyId) {
    await assertExecutionRunnable(task.taskId, abortSignal);
    activeThreadSummary = sharedChatContext.summary;
    activeTaskState = sharedChatContext.taskState;
    const grounding = await resolveLarkGroundingAttachments({
      companyId,
      message: message.text,
      currentAttachedFiles: currentAttachments,
      taskState: activeTaskState,
      requesterUserId: linkedUserId ?? message.userId,
      requesterChannelIdentityId: message.trace?.channelIdentityId,
      requesterAiRole: message.trace?.userRole ?? 'MEMBER',
    });
    activeTaskState = grounding.taskState;
    groundingAttachments = grounding.attachments;
    const existingUserMessage = sharedChatContext.recentMessages.find(
      (entry) => entry.id === message.messageId,
    );
    if (existingUserMessage) {
      persistedUserMessageId = existingUserMessage.id;
    } else {
      await assertExecutionRunnable(task.taskId, abortSignal);
      const storedMessage = await larkChatContextService.appendMessage({
        companyId,
        chatId: message.chatId,
        chatType: message.chatType,
        messageId: message.messageId,
        role: 'user',
        content: message.text,
        metadata: {
          userId: message.userId,
          requesterEmail: message.trace?.requesterEmail,
          larkOpenId: message.trace?.larkOpenId,
          larkUserId: message.trace?.larkUserId,
        },
      });
      persistedUserMessageId = storedMessage?.id ?? message.messageId;
    }
    maybeStoreLarkConversationTurn({
      companyId,
      userId: linkedUserId,
      conversationKey,
      sourceId: persistedUserMessageId ?? message.messageId,
      role: 'user',
      text: originalUserMessage,
      chatId: message.chatId,
    });
  } else {
    conversationMemoryStore.addUserMessage(conversationKey, message.messageId, originalUserMessage);
  }

  const storedReplyMode = resolveStoredReplyMode(activeTaskState);
  if (
    currentTurnExplicitReplyMode
    && currentTurnExplicitReplyMode !== 'dm'
    && activeTaskState.preferredReplyMode !== currentTurnExplicitReplyMode
  ) {
    activeTaskState = {
      ...activeTaskState,
      preferredReplyMode: currentTurnExplicitReplyMode,
      updatedAt: new Date().toISOString(),
    };
  }
  explicitReplyMode = currentTurnExplicitReplyMode ?? storedReplyMode;

  await assertExecutionRunnable(task.taskId, abortSignal);
  let runtime: VercelRuntimeRequestContext;
  try {
    runtime = await resolveRuntimeContext(task, message, contextStorageId, activeTaskState);
  } catch (error) {
    if (error instanceof DepartmentSelectionRequiredError) {
      await adapter.sendMessage({
        chatId: message.chatId,
        text: error.message,
        correlationId: task.taskId,
        replyToMessageId: message.messageId,
      });
      return {
        task,
        status: 'cancelled',
        currentStep: 'department.selection_required',
        latestSynthesis: error.message,
        agentResults: [],
        runtimeMeta: {
          engine: 'vercel',
          threadId: contextStorageId,
          node: 'department.selection_required',
          stepHistory: task.plan,
          canonicalIntent: task.canonicalIntent,
        },
      };
    }
    throw error;
  }
  runtime.attachedFiles =
    groundingAttachments.length > 0 ? groundingAttachments : runtime.attachedFiles;
  const contextMessages = persistentThread
    ? await (async () => {
        await assertExecutionRunnable(task.taskId, abortSignal);
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
              if (
                entry.metadata &&
                typeof entry.metadata === 'object' &&
                !Array.isArray(entry.metadata)
              ) {
                hydrateConversationRefsFromMetadata(
                  conversationKey,
                  entry.metadata as Record<string, unknown>,
                );
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
    : sharedChatContext && companyId
      ? await (async () => {
          await assertExecutionRunnable(task.taskId, abortSignal);
          const latestSharedContext = await larkChatContextService.load({
            companyId,
            chatId: message.chatId,
            chatType: message.chatType,
          });
          const recentMessages = latestSharedContext.recentMessages.slice(
            -LARK_THREAD_CONTEXT_MESSAGE_LIMIT,
          );
          const hydrationVersion = `${latestSharedContext.summary.updatedAt ?? 'none'}:${recentMessages[recentMessages.length - 1]?.id ?? 'empty'}`;
          if (larkConversationHydrationVersions.get(conversationKey) !== hydrationVersion) {
            for (const entry of recentMessages) {
              if (entry.role === 'user') {
                conversationMemoryStore.addUserMessage(conversationKey, entry.id, entry.content);
              } else {
                conversationMemoryStore.addAssistantMessage(
                  conversationKey,
                  entry.id,
                  entry.content,
                );
                if (entry.metadata) {
                  hydrateConversationRefsFromMetadata(conversationKey, entry.metadata);
                }
              }
            }
            larkConversationHydrationVersions.set(conversationKey, hydrationVersion);
          }
          return recentMessages.map((entry) => ({
            id: entry.id,
            role: entry.role,
            content: entry.content,
          })) as Array<ModelMessage & { id?: string }>;
        })()
      : (conversationMemoryStore.getContextMessages(conversationKey).map((entry) => ({
          role: entry.role,
          content: entry.content,
        })) as Array<ModelMessage & { id?: string }>);
  const effectiveUserMessage = deriveEffectiveLatestUserMessage({
    latestUserMessage: originalUserMessage,
    attentionOnly: message.trace?.attentionOnly,
    contextMessages,
    taskState: activeTaskState,
    threadSummary: activeThreadSummary,
  });
  const resolvedUserMessage = resolveOrdinalReferences(
    effectiveUserMessage,
    task.taskId,
    activeTaskState,
  );
  runtime.latestUserMessage = resolvedUserMessage;
  const latestConversationRefs = buildLatestConversationRefs(conversationKey);
  const queryEnrichment = enrichQuery({
    rawMessage: resolvedUserMessage,
    attachedFiles: groundingAttachments,
    taskState: activeTaskState,
    threadSummary: activeThreadSummary,
    recentConversationRefs: latestConversationRefs,
  });
  const memoryWriteStatusContext = await resolveLarkExplicitMemoryWriteStatus({
    adapter,
    taskId: task.taskId,
    companyId,
    userId: linkedUserId,
    conversationKey,
    message,
    text: originalUserMessage,
    currentTurnExplicitReplyMode,
  });
  await resetLatestAgentRunLog(task.taskId, {
    channel: 'lark',
    entrypoint: 'lark_message',
    taskId: task.taskId,
    threadId: contextStorageId ?? message.chatId,
    companyId: runtime.companyId,
    userId: linkedUserId ?? null,
    message: resolvedUserMessage,
    workspace: runtime.workspace ?? null,
  });
  statusHistory.push('Context ready.');
  const persistAssistantTurn = async (input: {
    content: string;
    statusMessageId?: string | null;
    pendingApproval?: PendingApprovalAction | null;
  }) => {
    if (sharedChatContext && companyId) {
      const conversationRefs = buildPersistedConversationRefs(conversationKey);
      const storedMessage = await larkChatContextService.appendMessage({
        companyId,
        chatId: message.chatId,
        chatType: message.chatType,
        messageId: input.statusMessageId ?? undefined,
        role: 'assistant',
        content: input.content,
        metadata: {
          channel: 'lark',
          lark: {
            chatId: message.chatId,
            outboundMessageId: input.statusMessageId ?? null,
            statusMessageId: input.statusMessageId ?? null,
            correlationId: task.taskId,
          },
          ...(input.pendingApproval
            ? {
                pendingApproval: {
                  kind: input.pendingApproval.kind,
                  approvalId:
                    input.pendingApproval.kind === 'tool_action'
                      ? input.pendingApproval.approvalId
                      : null,
                },
              }
            : {}),
          ...(conversationRefs ? { conversationRefs } : {}),
        },
      });
      maybeStoreLarkConversationTurn({
        companyId: runtime.companyId,
        userId: linkedUserId,
        conversationKey,
        sourceId: storedMessage?.id ?? input.statusMessageId ?? task.taskId,
        role: 'assistant',
        text: input.content,
        chatId: message.chatId,
      });
      return;
    }
    if (persistentThread) {
      const conversationRefs = buildPersistedConversationRefs(conversationKey);
      const assistantMessage = await desktopThreadsService.addOwnedThreadMessage(
        persistentThread.id,
        linkedUserId,
        'assistant',
        input.content,
        {
          channel: 'lark',
          lark: {
            chatId: message.chatId,
            outboundMessageId: input.statusMessageId ?? null,
            statusMessageId: input.statusMessageId ?? null,
            correlationId: task.taskId,
          },
          ...(input.pendingApproval
            ? {
                pendingApproval: {
                  kind: input.pendingApproval.kind,
                  approvalId:
                    input.pendingApproval.kind === 'tool_action'
                      ? input.pendingApproval.approvalId
                      : null,
                },
              }
            : {}),
          ...(conversationRefs ? { conversationRefs } : {}),
        },
        {
          requiredChannel: 'lark',
          contextLimit: LARK_THREAD_CONTEXT_MESSAGE_LIMIT,
        },
      );
      maybeStoreLarkConversationTurn({
        companyId: runtime.companyId,
        userId: linkedUserId,
        conversationKey,
        sourceId: assistantMessage.id,
        role: 'assistant',
        text: input.content,
        chatId: message.chatId,
      });
    }
  };
  const persistConversationMemorySnapshot = async (assistantText: string) => {
    const refreshedSummary = await refreshDesktopThreadSummary({
      messages: [
        ...contextMessages.map((entry) => ({
          role: entry.role === 'assistant' ? 'assistant' : 'user',
          content: flattenModelContent(entry.content),
        })),
        {
          role: 'assistant',
          content: assistantText,
        },
      ],
      taskState: activeTaskState,
      currentSummary: activeThreadSummary,
    });
    if (sharedChatContext && companyId) {
      await persistLarkSharedChatMemory({
        companyId,
        chatId: message.chatId,
        chatType: message.chatType,
        summary: refreshedSummary,
        taskState: activeTaskState,
      });
      activeThreadSummary = refreshedSummary;
      return;
    }
    if (persistentThread) {
      await persistLarkThreadMemory({
        threadId: persistentThread.id,
        userId: linkedUserId,
        summary: refreshedSummary,
        taskState: activeTaskState,
      });
      await memoryService.recordTaskStateSnapshot({
        companyId: runtime.companyId,
        userId: linkedUserId,
        channelOrigin: 'lark',
        threadId: persistentThread.id,
        conversationKey,
        activeObjective: activeTaskState.activeObjective,
        completedMutations: activeTaskState.completedMutations.slice(-6).map((mutation) => ({
          module: mutation.module,
          summary: mutation.summary,
          ok: mutation.ok,
        })),
      });
      activeThreadSummary = refreshedSummary;
    }
  };
  const persistSharedChatTaskState = async (taskState: DesktopTaskState): Promise<void> => {
    if (!sharedChatContext || !companyId) {
      return;
    }
    await larkChatContextService.persistTaskState({
      companyId,
      chatId: message.chatId,
      chatType: message.chatType,
      taskState,
    });
  };
  const persistIncrementalStepProgress = async (input: {
    completedStep: CompletedSupervisorStep;
    allCompletedSteps: CompletedSupervisorStep[];
  }): Promise<void> => {
    if (!sharedChatContext || !companyId) {
      return;
    }
    try {
      activeTaskState = {
        ...activeTaskState,
        supervisorProgress: {
          runId: task.taskId,
          updatedAt: new Date().toISOString(),
          completedSteps: input.allCompletedSteps,
          resolvedIds: input.allCompletedSteps.reduce<Record<string, string>>((acc, step) => ({
            ...acc,
            ...(step.resolvedIds ?? {}),
          }), {}),
        },
      };
      await persistSharedChatTaskState(activeTaskState);
    } catch (error) {
      logger.warn('supervisor.step.checkpoint.failed', {
        taskId: task.taskId,
        error: error instanceof Error ? error.message : 'unknown_error',
      });
    }
  };

  await assertExecutionRunnable(task.taskId, abortSignal);
  const childRoute = await runDesktopChildRouter({
    executionId,
    threadId: contextStorageId ?? message.chatId,
    message: resolvedUserMessage,
    queryEnrichment,
    attachedFiles: groundingAttachments,
    workspace: runtime.workspace,
    approvalPolicySummary: runtime.desktopApprovalPolicySummary,
    companyId: runtime.companyId,
    userId: linkedUserId ?? undefined,
    requesterAiRole: runtime.requesterAiRole,
    allowedToolIds: runtime.allowedToolIds,
    allowedActionsByTool: runtime.allowedActionsByTool,
    departmentSystemPrompt: runtime.departmentSystemPrompt,
    departmentSkillsMarkdown: runtime.departmentSkillsMarkdown,
    taskState: activeTaskState,
    threadSummary: activeThreadSummary,
    history: takeRecentMessagesByTokenBudget({
      messages: filterThreadMessagesForContext(
        contextMessages.map((entry) => ({
          role: entry.role === 'assistant' ? 'assistant' : 'user',
          content:
            typeof entry.content === 'string' ? entry.content : flattenModelContent(entry.content),
        })),
      ),
      tokenBudget: LARK_CHILD_ROUTER_HISTORY_TOKEN_BUDGET,
      maxMessages: LARK_CHILD_ROUTER_HISTORY_MAX_MESSAGES,
    }),
    requesterName: message.trace?.requesterName,
    requesterEmail: message.trace?.requesterEmail,
  });
  proposedReplyMode = childRoute.preferredReplyMode;

  const schedulingClarification = buildSchedulingIntentClarification(childRoute);
  if (schedulingClarification) {
    statusHistory.push('Child router requested scheduling clarification.');
    await assertExecutionRunnable(task.taskId, abortSignal);
    const delivery = await deliverTerminalResponse({
      text: schedulingClarification,
      actions: [],
      hasToolResults: false,
      isSensitiveContent: false,
      proposedReplyMode,
    });
    conversationMemoryStore.addAssistantMessage(conversationKey, task.taskId, schedulingClarification);
    await assertExecutionRunnable(task.taskId, abortSignal);
    await persistAssistantTurn({
      content: schedulingClarification,
      statusMessageId: delivery.statusMessageId ?? null,
    });
    await persistConversationMemorySnapshot(schedulingClarification);
    await appendLatestAgentRunLog(task.taskId, 'run.completed', {
      channel: 'lark',
      route: childRoute.route,
      threadId: contextStorageId ?? message.chatId,
      finalText: schedulingClarification,
      pendingApproval: null,
      stepCount: 0,
      schedulingClarification: {
        intentClass: childRoute.intentClass,
        confidence: childRoute.confidence,
        alternativeIntent: childRoute.alternativeIntent ?? null,
      },
    });
    return {
      task,
      status: 'done',
      currentStep: 'planner.clarification',
      latestSynthesis: schedulingClarification,
      agentResults: [],
      runtimeMeta: {
        engine: 'vercel',
        threadId: contextStorageId,
        node: 'planner.clarification',
        stepHistory: task.plan,
        canonicalIntent: task.canonicalIntent,
      },
    };
  }

  if (
    childRoute.route === 'fast_reply' &&
    childRoute.reply?.trim() &&
    !shouldBypassUnverifiedDuplicateTaskFastReply({
      conversationKey,
      childRoute,
      latestUserMessage: resolvedUserMessage,
    })
  ) {
    const reply = childRoute.reply.trim();
    statusHistory.push('Handled directly by child router.');
    await assertExecutionRunnable(task.taskId, abortSignal);
    const delivery = await deliverTerminalResponse({
      text: reply,
      actions: [],
      hasToolResults: false,
      isSensitiveContent: false,
      proposedReplyMode,
    });
    conversationMemoryStore.addAssistantMessage(conversationKey, task.taskId, reply);
    await assertExecutionRunnable(task.taskId, abortSignal);
    await persistAssistantTurn({
      content: reply,
      statusMessageId: delivery.statusMessageId ?? null,
    });
    await persistConversationMemorySnapshot(reply);
    if (linkedUserId) {
      const childRouterPrompt = [
        'Lark child router handled this turn directly.',
        `Latest user message: ${resolvedUserMessage}`,
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
        threadId: contextStorageId,
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
      threadId: contextStorageId ?? message.chatId,
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
        threadId: contextStorageId,
        node: 'child_router.fast_reply',
        stepHistory: task.plan,
        canonicalIntent: task.canonicalIntent,
      },
    };
  }

  const routerAcknowledgement =
    childRoute.route === 'fast_reply'
      ? undefined
      : childRoute.acknowledgement?.trim() || 'I’ll handle that now and keep it moving for you.';
  statusHistory.push('Context ready.');
  const progressReplyMode = resolveReplyMode({
    chatType: message.chatType,
    incomingMessageId: message.messageId,
    isProactiveDelivery: false,
    isSensitiveContent: false,
    isShortAcknowledgement: childRoute.route === 'fast_reply',
    proposedReplyMode,
    userExplicitMode: explicitReplyMode,
  });
  const progressCoordinator = await ensureStatusCoordinator(progressReplyMode);
  progressCoordinator.startHeartbeat(() => renderCurrentStatus(true));
  await updateStatus(
    'planning',
    routerAcknowledgement ?? 'Figuring out the best way to help…',
  );

  await assertExecutionRunnable(task.taskId, abortSignal);
  const toolSelectionStartMs = Date.now();
  const toolSelection = await resolveRunScopedToolSelection({
    channel: 'lark',
    companyId: runtime.companyId,
    userId: linkedUserId,
    threadId: contextStorageId,
    conversationKey,
    latestUserMessage: resolvedUserMessage,
    enrichedQueryText: queryEnrichment.cleanQuery,
    allowedToolIds: runtime.allowedToolIds,
    allowedActionsByTool: runtime.allowedActionsByTool,
    workspaceAvailable: Boolean(runtime.workspace),
    hasActiveArtifacts:
      groundingAttachments.length > 0 || activeTaskState.activeSourceArtifacts.length > 0,
    artifactMode: classifyArtifactMode(groundingAttachments),
    childRoute: {
      confidence: childRoute.confidence,
      domain: childRoute.domain,
      operationType: childRoute.operationType,
      normalizedIntent: childRoute.normalizedIntent,
      reason: childRoute.reason,
      suggestedToolIds: childRoute.suggestedToolIds,
      suggestedActions: childRoute.suggestedActions,
    },
    requestContext: runtime,
  });
  const invariantResult = checkToolSelectionInvariant({
    intentDomain: childRoute.domain ?? toolSelection.inferredDomain,
    runExposedToolIds: toolSelection.runExposedToolIds,
    allowedToolIds: runtime.allowedToolIds,
  });
  if (!invariantResult.passed) {
    logger.warn('tool.invariant.failed', {
      channel: 'lark',
      taskId: task.taskId,
      intentDomain: childRoute.domain ?? toolSelection.inferredDomain,
      runExposedToolIds: toolSelection.runExposedToolIds,
      missingFamily: invariantResult.missingFamily,
      widenedToolIds: invariantResult.widenedToolIds,
    });
    toolSelection.runExposedToolIds = invariantResult.widenedToolIds;
    toolSelection.plannerCandidateToolIds = invariantResult.widenedToolIds;
  }
  logger.info('vercel.tool_selection.resolved', {
    taskId: task.taskId,
    threadId: contextStorageId ?? message.chatId,
    allowedToolIds: runtime.allowedToolIds,
    runExposedToolIds: toolSelection.runExposedToolIds,
    plannerCandidateToolIds: toolSelection.plannerCandidateToolIds,
    plannerChosenToolId: toolSelection.plannerChosenToolId ?? null,
    plannerChosenOperationClass: toolSelection.plannerChosenOperationClass ?? null,
    selectionReason: toolSelection.selectionReason,
    clarificationTriggered: Boolean(toolSelection.clarificationQuestion),
    validationFailureReason: toolSelection.validationFailureReason ?? null,
  });
  await appendLatestAgentRunLog(task.taskId, 'tool_selection.resolved', {
    channel: 'lark',
    threadId: contextStorageId ?? message.chatId,
    allowedToolIds: runtime.allowedToolIds,
    runExposedToolIds: toolSelection.runExposedToolIds,
    plannerCandidateToolIds: toolSelection.plannerCandidateToolIds,
    plannerChosenToolId: toolSelection.plannerChosenToolId ?? null,
    plannerChosenOperationClass: toolSelection.plannerChosenOperationClass ?? null,
    selectionReason: toolSelection.selectionReason,
    clarificationTriggered: Boolean(toolSelection.clarificationQuestion),
    validationFailureReason: toolSelection.validationFailureReason ?? null,
  });
  const analyticsToolDemandPayload = buildExecutionToolDemandPayload({
    channel: 'lark',
    latestUserMessage: resolvedUserMessage,
    enrichedQueryText: queryEnrichment.cleanQuery,
    childRoute: {
      confidence: childRoute.confidence,
      domain: childRoute.domain,
      operationType: childRoute.operationType,
      normalizedIntent: childRoute.normalizedIntent,
      reason: childRoute.reason,
      suggestedToolIds: childRoute.suggestedToolIds,
      suggestedActions: childRoute.suggestedActions,
    },
    hasWorkspace: Boolean(runtime.workspace),
    hasArtifacts:
      groundingAttachments.length > 0 || activeTaskState.activeSourceArtifacts.length > 0,
    inferredDomain: toolSelection.inferredDomain,
    inferredOperationClass: toolSelection.inferredOperationClass,
    plannerChosenToolId: toolSelection.plannerChosenToolId ?? null,
    plannerChosenOperationClass: toolSelection.plannerChosenOperationClass ?? null,
    plannerCandidateToolIds: toolSelection.plannerCandidateToolIds,
    runExposedToolIds: toolSelection.runExposedToolIds,
    selectionReason: toolSelection.selectionReason,
    clarificationTriggered: Boolean(toolSelection.clarificationQuestion),
    validationFailureReason: toolSelection.validationFailureReason ?? null,
  });
  await appendExecutionEventSafe({
    executionId,
    phase: 'planning',
    eventType: EXECUTION_TOOL_DEMAND_EVENT,
    actorType: 'planner',
    actorKey: 'tool-selection',
    title: 'tool demand inferred',
    summary: `${analyticsToolDemandPayload.intendedToolFamily} (${analyticsToolDemandPayload.inferredOperationClass})`,
    status: 'completed',
    payload: {
      ...(analyticsToolDemandPayload as unknown as Record<string, unknown>),
      durationMs: Date.now() - toolSelectionStartMs,
    },
  });
  const toolSelectionMs = Date.now() - toolSelectionStartMs;
  const modelInputPrepStartMs = Date.now();
  const selectionGapPayload = buildCapabilityGapFromSelection(analyticsToolDemandPayload);
  if (selectionGapPayload) {
    await appendExecutionEventSafe({
      executionId,
      phase: 'planning',
      eventType: EXECUTION_CAPABILITY_GAP_EVENT,
      actorType: 'planner',
      actorKey: 'tool-selection',
      title: 'capability gap detected',
      summary: selectionGapPayload.gapLabel,
      status: 'failed',
      payload: selectionGapPayload as unknown as Record<string, unknown>,
    });
  }
  const effectiveRuntime: VercelRuntimeRequestContext = {
    ...runtime,
    latestUserMessage: resolvedUserMessage,
    taskState: activeTaskState,
    runExposedToolIds: toolSelection.runExposedToolIds,
    plannerCandidateToolIds: toolSelection.plannerCandidateToolIds,
    toolSelectionReason: toolSelection.selectionReason,
    toolSelectionFallbackNeeded: toolSelection.selectionFallbackNeeded,
    plannerChosenToolId: toolSelection.plannerChosenToolId,
    plannerChosenOperationClass: toolSelection.plannerChosenOperationClass,
  };
  const executedToolOutcomes: RunToolResult[] = [];
  let modelInputPrepMs = 0;
  let planningMs = 0;
  let executionMs = 0;
  let synthesisMs = 0;
  if (toolSelection.clarificationQuestion?.trim()) {
    const clarificationText = toolSelection.clarificationQuestion.trim();
    await assertExecutionRunnable(task.taskId, abortSignal);
    const delivery = await deliverTerminalResponse({
      text: clarificationText,
      actions: [],
      hasToolResults: false,
      isSensitiveContent: false,
      proposedReplyMode,
    });
    conversationMemoryStore.addAssistantMessage(conversationKey, task.taskId, clarificationText);
    await assertExecutionRunnable(task.taskId, abortSignal);
    await persistAssistantTurn({
      content: clarificationText,
      statusMessageId: delivery.statusMessageId ?? null,
    });
    await persistConversationMemorySnapshot(clarificationText);
    await appendLatestAgentRunLog(task.taskId, 'run.completed', {
      channel: 'lark',
      route: childRoute.route,
      threadId: contextStorageId ?? message.chatId,
      finalText: clarificationText,
      pendingApproval: null,
      stepCount: 0,
      validationFailureReason: toolSelection.validationFailureReason ?? null,
    });
    await appendExecutionEventSafe({
      executionId,
      phase: 'delivery',
      eventType: 'run.timing.summary',
      actorType: 'system',
      actorKey: 'orchestration-engine',
      title: 'Run timing breakdown',
      summary: 'Timing summary recorded.',
      status: 'done',
      payload: {
        totalMs: Date.now() - runStartedAt,
        phases: {
          toolSelectionMs,
          modelInputPrepMs,
          planningMs,
          executionMs,
          synthesisMs,
        },
      },
    });
    return {
      task,
      status: 'done',
      currentStep: 'planner.clarification',
      latestSynthesis: clarificationText,
      agentResults: [],
      runtimeMeta: {
        engine: 'vercel',
        threadId: contextStorageId,
        node: 'planner.clarification',
        stepHistory: task.plan,
        canonicalIntent: task.canonicalIntent,
      },
    };
  }

  await assertExecutionRunnable(task.taskId, abortSignal);
  const resolvedModel = await resolveVercelLanguageModel(effectiveRuntime.mode);
  const contextClass = chooseLarkContextClass({
    latestUserMessage: resolvedUserMessage,
    taskState: activeTaskState,
    threadSummary: activeThreadSummary,
    historyMessageCount: contextMessages.length,
  });
  await assertExecutionRunnable(task.taskId, abortSignal);
  const memoryPromptContext = await memoryService.getPromptContext({
    companyId: runtime.companyId,
    userId: linkedUserId,
    threadId: contextStorageId,
    conversationKey,
    queryText: queryEnrichment.retrievalQuery,
    contextClass,
  });
  if (!activeTaskState.preferredReplyMode && memoryPromptContext.preferredReplyMode) {
    activeTaskState = {
      ...activeTaskState,
      preferredReplyMode: memoryPromptContext.preferredReplyMode,
      updatedAt: new Date().toISOString(),
    };
    if (!currentTurnExplicitReplyMode) {
      explicitReplyMode = memoryPromptContext.preferredReplyMode;
    }
  }
  const conversationSnippets = memoryPromptContext.relevantMemoryFacts;
  const enrichedQueryWithMemory = enrichQuery({
    rawMessage: resolvedUserMessage,
    attachedFiles: groundingAttachments,
    taskState: activeTaskState,
    threadSummary: activeThreadSummary,
    recentConversationRefs: latestConversationRefs,
    relevantMemoryFacts: conversationSnippets,
  });
  const visionBuildResult = groundingAttachments.length > 0
    ? await (async () => {
        await assertExecutionRunnable(task.taskId, abortSignal);
        return buildVisionContentWithGrounding({
        userMessage: resolvedUserMessage,
        attachedFiles: groundingAttachments,
        companyId: runtime.companyId,
        requesterUserId: runtime.userId,
        requesterAiRole: runtime.requesterAiRole,
        });
      })()
    : null;
  const systemPrompt = buildSystemPrompt({
    conversationKey,
    runtime: effectiveRuntime,
    routerAcknowledgement,
    childRouteHints: childRoute,
    resolvedReplyModeHint: activeReplyModeHint,
    latestUserMessage: resolvedUserMessage,
    queryEnrichment: enrichedQueryWithMemory,
    hasAttachedFiles: groundingAttachments.length > 0,
    groundedFiles: visionBuildResult?.groundedFiles,
    threadSummary: activeThreadSummary,
    taskState: activeTaskState,
    conversationRetrievalSnippets: conversationSnippets,
    behaviorProfileContext: memoryPromptContext.behaviorProfileContext,
    durableMemoryContext: memoryPromptContext.durableTaskContextText,
    relevantMemoryFactsContext: memoryPromptContext.relevantMemoryFactsText,
    memoryWriteStatusContext,
    activeTaskContext: formatActiveTaskContext(task.taskId),
  });
  const budget = resolveLarkContextBudget({
    resolvedModel,
    contextClass,
  });
  const reservedTokens =
    estimateTokens(systemPrompt) +
    estimateTokens(resolvedUserMessage) +
    (groundingAttachments.length > 0 ? 8_000 : 1_500);
  const historySelection = buildAdaptiveLarkHistoryMessages({
    messages: contextMessages,
    targetBudgetTokens: budget.targetContextBudget,
    reservedTokens,
    contextClass,
  });
  logger.info('lark.context.summary', {
    taskId: task.taskId,
    threadId: contextStorageId ?? message.chatId,
    contextClass,
    modelId: budget.modelId,
    usableContextBudget: budget.usableContextBudget,
    targetContextBudget: budget.targetContextBudget,
    includedRawMessageCount: historySelection.includedRawMessageCount,
    includedConversationRetrievalCount: conversationSnippets.length,
    includedSourceArtifactCount: groundingAttachments.length,
    includedThreadSummary: activeThreadSummary.sourceMessageCount > 0,
    includedTaskState:
      activeTaskState.completedMutations.length > 0 ||
      activeTaskState.activeSourceArtifacts.length > 0 ||
      Boolean(activeTaskState.pendingApproval) ||
      Boolean(activeTaskState.activeObjective),
    compactionTier: historySelection.compactionTier,
  });
  await appendLatestAgentRunLog(task.taskId, 'lark.context.summary', {
    threadId: contextStorageId ?? message.chatId,
    contextClass,
    modelId: budget.modelId,
    usableContextBudget: budget.usableContextBudget,
    targetContextBudget: budget.targetContextBudget,
    includedRawMessageCount: historySelection.includedRawMessageCount,
    includedConversationRetrievalCount: conversationSnippets.length,
    includedSourceArtifactCount: groundingAttachments.length,
    includedThreadSummary: activeThreadSummary.sourceMessageCount > 0,
    includedTaskState:
      activeTaskState.completedMutations.length > 0 ||
      activeTaskState.activeSourceArtifacts.length > 0 ||
      Boolean(activeTaskState.pendingApproval) ||
      Boolean(activeTaskState.activeObjective),
    compactionTier: historySelection.compactionTier,
  });
  let inputMessages = historySelection.messages.map(({ role, content, id }) => ({
    role,
    content,
    id,
  })) as Array<ModelMessage & { id?: string }>;
  if (visionBuildResult) {
    const visionParts = visionBuildResult.parts;
    if ((persistentThread || sharedChatContext) && persistedUserMessageId) {
      let replacedCurrentMessage = false;
      inputMessages = historySelection.messages.map((entry, index) => {
        const shouldReplace =
          index === historySelection.messages.length - 1 && entry.id === persistedUserMessageId;
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
  } else if (resolvedUserMessage.trim()) {
    const hasCurrentUserTurn =
      persistentThread || sharedChatContext
        ? inputMessages.some((entry) => entry.id === persistedUserMessageId)
        : false;
    if ((persistentThread || sharedChatContext) && hasCurrentUserTurn) {
      inputMessages = inputMessages.map((entry) =>
        entry.id === persistedUserMessageId
          ? { role: 'user', content: resolvedUserMessage }
          : { role: entry.role, content: entry.content },
      ) as ModelMessage[];
    } else if ((!persistentThread && !sharedChatContext) || !hasCurrentUserTurn) {
      inputMessages = [
        ...inputMessages.map(({ role, content }) => ({ role, content })),
        { role: 'user', content: resolvedUserMessage },
      ];
    }
  }

  const threadSummaryContext = buildThreadSummaryContext(activeThreadSummary) ?? '';
  const taskStateContext = buildTaskStateContext(activeTaskState) ?? '';
  const retrievalSnippetsForPrompt: RetrievalSnippet[] = conversationSnippets.map((snippet, index) => ({
    source: `memory_${index + 1}`,
    text: snippet,
    score: Math.max(0.1, 1 - (index * 0.05)),
  }));
  const conversationRetrievalForPrompt: ConversationRetrievalItem[] = [];
  const recentMessagesForCompaction = inputMessages.slice(-PROTECTED_RECENT_MESSAGE_COUNT);
  const olderMessagesForCompaction = inputMessages.slice(
    0,
    Math.max(0, inputMessages.length - PROTECTED_RECENT_MESSAGE_COUNT),
  );
  const toolDefinitionsForEstimate = JSON.stringify({
    allowedToolIds: effectiveRuntime.allowedToolIds,
    runExposedToolIds: effectiveRuntime.runExposedToolIds ?? effectiveRuntime.allowedToolIds,
    allowedActionsByTool: effectiveRuntime.allowedActionsByTool ?? {},
  });
  const systemPromptCore = buildSystemPrompt({
    conversationKey: contextStorageId ?? message.chatId,
    runtime: effectiveRuntime,
    routerAcknowledgement,
    childRouteHints: childRoute,
    resolvedReplyModeHint: activeReplyModeHint,
    latestUserMessage: resolvedUserMessage,
    queryEnrichment: enrichedQueryWithMemory,
    hasAttachedFiles: groundingAttachments.length > 0,
    groundedFiles: visionBuildResult?.groundedFiles,
    threadSummaryContextOverride: '',
    taskStateContextOverride: taskStateContext,
    conversationRetrievalSnippets: [],
    behaviorProfileContext: null,
    durableMemoryContext: null,
    relevantMemoryFactsContext: null,
    memoryWriteStatusContext,
    activeTaskContext: formatActiveTaskContext(task.taskId),
  });
  const compactionResult = runLayeredCompaction({
    systemPromptCore,
    toolDefinitions: toolDefinitionsForEstimate,
    taskState: taskStateContext,
    behaviorProfileContext: memoryPromptContext.behaviorProfileContext ?? '',
    threadSummary: threadSummaryContext,
    retrievalSnippets: retrievalSnippetsForPrompt,
    memoryFacts: memoryPromptContext.relevantMemoryFactsText
      ? [memoryPromptContext.relevantMemoryFactsText]
      : [],
    durableMemoryText: memoryPromptContext.durableTaskContextText ?? '',
    recentMessages: recentMessagesForCompaction,
    olderMessages: olderMessagesForCompaction,
    conversationRetrieval: conversationRetrievalForPrompt,
  });
  if (compactionResult.wasCompacted) {
    await updateStatus(
      'planning',
      'Breaking this down into steps…',
      undefined,
      { force: true },
    );
    logger.warn('context_compaction_triggered', {
      taskId: task.taskId,
      finalEstimatedTokens: compactionResult.finalEstimatedTokens,
      compactionLog: compactionResult.compactionLog,
    });
  }

  inputMessages = [
    ...compactionResult.olderMessages,
    ...compactionResult.recentMessages,
  ];

  const relevantMemoryFactsContextForPrompt = compactionResult.memoryFacts.join('\n');
  let compactedSystemPrompt = buildSystemPrompt({
    conversationKey: contextStorageId ?? message.chatId,
    runtime: effectiveRuntime,
    routerAcknowledgement,
    childRouteHints: childRoute,
    resolvedReplyModeHint: activeReplyModeHint,
    latestUserMessage: resolvedUserMessage,
    queryEnrichment: enrichedQueryWithMemory,
    hasAttachedFiles: groundingAttachments.length > 0,
    groundedFiles: visionBuildResult?.groundedFiles,
    threadSummaryContextOverride: compactionResult.threadSummary,
    taskStateContextOverride: taskStateContext,
    conversationRetrievalSnippets: compactionResult.retrievalSnippets.map((snippet) => snippet.text),
    behaviorProfileContext: compactionResult.behaviorProfileContext,
    durableMemoryContext: compactionResult.durableMemoryText,
    relevantMemoryFactsContext: relevantMemoryFactsContextForPrompt,
    memoryWriteStatusContext,
    activeTaskContext: formatActiveTaskContext(task.taskId),
  });
  let finalPromptEstimate = estimateFinalPromptTokens({
    systemPrompt: compactedSystemPrompt,
    messages: inputMessages,
  });
  if (finalPromptEstimate > FULL_PROMPT_COMPACTION_USABLE_BUDGET) {
    logger.error('context_compaction_failed_hard_limit', {
      taskId: task.taskId,
      estimatedTokens: finalPromptEstimate,
    });
    await updateStatus(
      'planning',
      'Breaking this down into steps…',
      undefined,
      { force: true },
    );
    inputMessages = inputMessages.slice(-4);
    compactedSystemPrompt = buildSystemPrompt({
      conversationKey: contextStorageId ?? message.chatId,
      runtime: effectiveRuntime,
      routerAcknowledgement,
      childRouteHints: childRoute,
      resolvedReplyModeHint: activeReplyModeHint,
      latestUserMessage: resolvedUserMessage,
      queryEnrichment: enrichedQueryWithMemory,
      hasAttachedFiles: groundingAttachments.length > 0,
      groundedFiles: visionBuildResult?.groundedFiles,
      threadSummaryContextOverride: '',
      taskStateContextOverride: taskStateContext,
      conversationRetrievalSnippets: [],
      behaviorProfileContext: null,
      durableMemoryContext: null,
      relevantMemoryFactsContext: null,
      memoryWriteStatusContext,
      activeTaskContext: formatActiveTaskContext(task.taskId),
    });
    finalPromptEstimate = estimateFinalPromptTokens({
      systemPrompt: compactedSystemPrompt,
      messages: inputMessages,
    });
    if (finalPromptEstimate > FULL_PROMPT_COMPACTION_USABLE_BUDGET) {
      compactedSystemPrompt = buildMinimalLarkSystemPrompt({
        taskStateContext,
        latestUserMessage: resolvedUserMessage,
      });
      inputMessages = inputMessages.slice(-2);
      finalPromptEstimate = estimateFinalPromptTokens({
        systemPrompt: compactedSystemPrompt,
        messages: inputMessages,
      });
      logger.error('context_compaction_used_minimal_fallback', {
        taskId: task.taskId,
        estimatedTokens: finalPromptEstimate,
      });
    }
  }

  try {
    const primaryMessages =
      inputMessages.length > 0 ? inputMessages : [{ role: 'user', content: resolvedUserMessage }];
    modelInputPrepMs = Date.now() - modelInputPrepStartMs;
    const modelInputContextSummary = {
      contextClass,
      modelId: budget.modelId,
      usableContextBudget: budget.usableContextBudget,
      targetContextBudget: budget.targetContextBudget,
      includedRawMessageCount: historySelection.includedRawMessageCount,
      includedConversationRetrievalCount: conversationSnippets.length,
      includedSourceArtifactCount: groundingAttachments.length,
      includedThreadSummary: activeThreadSummary.sourceMessageCount > 0,
      compactionTier: historySelection.compactionTier,
    };
    await appendExecutionEventSafe({
      executionId,
      phase: 'planning',
      eventType: 'model.input',
      actorType: 'model',
      actorKey: resolvedModel.effectiveModelId,
      title: 'Prepared model input',
      summary: summarizeText(resolvedUserMessage, 220) ?? 'Prepared model input for generation.',
      status: 'done',
      payload: {
        ...buildExecutionModelInputPayload({
        label: 'lark_generate',
        systemPrompt: compactedSystemPrompt,
        messages: primaryMessages,
        contextSummary: modelInputContextSummary,
        toolAvailability: {
          allowedToolIds: effectiveRuntime.allowedToolIds,
          runExposedToolIds: effectiveRuntime.runExposedToolIds ?? effectiveRuntime.allowedToolIds,
          plannerCandidateToolIds: effectiveRuntime.plannerCandidateToolIds ?? [],
          plannerChosenToolId: effectiveRuntime.plannerChosenToolId ?? null,
          plannerChosenOperationClass: effectiveRuntime.plannerChosenOperationClass ?? null,
          toolSelectionReason: effectiveRuntime.toolSelectionReason ?? null,
        },
      }),
        durationMs: modelInputPrepMs,
        systemPromptLength: compactedSystemPrompt.length,
        contextClass: modelInputContextSummary.contextClass,
        compactionTier: modelInputContextSummary.compactionTier,
      },
    });
    await appendLatestAgentRunLog(task.taskId, 'llm.context', {
      phase: 'lark_generate',
      threadId: contextStorageId ?? message.chatId,
      systemPrompt: compactedSystemPrompt,
      messages: primaryMessages.map((entry, index) => ({
        index,
        role: entry.role,
        content: typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content),
      })),
      runtime: {
        allowedToolIds: effectiveRuntime.allowedToolIds,
        runExposedToolIds: effectiveRuntime.runExposedToolIds ?? effectiveRuntime.allowedToolIds,
        plannerCandidateToolIds: effectiveRuntime.plannerCandidateToolIds ?? [],
        plannerChosenToolId: effectiveRuntime.plannerChosenToolId ?? null,
        plannerChosenOperationClass: effectiveRuntime.plannerChosenOperationClass ?? null,
        toolSelectionReason: effectiveRuntime.toolSelectionReason ?? null,
        allowedActionsByTool: effectiveRuntime.allowedActionsByTool ?? {},
        departmentName: effectiveRuntime.departmentName ?? null,
        departmentRoleSlug: effectiveRuntime.departmentRoleSlug ?? null,
        routerAcknowledgement: routerAcknowledgement ?? null,
        threadSummary: activeThreadSummary,
        taskState: activeTaskState,
        contextClass,
        finalPromptEstimate,
        compactionLog: compactionResult.compactionLog,
      },
    });
    const scopedContext = [
      compactionResult.behaviorProfileContext,
      compactionResult.durableMemoryText,
      relevantMemoryFactsContextForPrompt,
      compactionResult.threadSummary,
      taskStateContext,
    ].filter((value): value is string => Boolean(value?.trim()));
    const supervisorEligibility = resolveSupervisorEligibleAgents({
      runtime: {
        allowedToolIds: effectiveRuntime.allowedToolIds,
        runExposedToolIds: effectiveRuntime.runExposedToolIds ?? effectiveRuntime.allowedToolIds,
        plannerChosenOperationClass:
          toolSelection.inferredOperationClass ?? effectiveRuntime.plannerChosenOperationClass ?? undefined,
        workspace: effectiveRuntime.workspace,
      },
      latestUserMessage: resolvedUserMessage,
      inferredDomain: toolSelection.inferredDomain,
      inferredOperationClass: toolSelection.inferredOperationClass,
      normalizedIntent: childRoute.normalizedIntent ?? null,
    });
    const eligibleAgentIds = Array.from(new Set([
      ...supervisorEligibility.preferredAgentIds,
      ...supervisorEligibility.eligibleAgents.map((agent) => agent.id),
    ])).filter((agentId) => {
      const plannerChosenToolId = effectiveRuntime.plannerChosenToolId ?? toolSelection.plannerChosenToolId;
      if ((plannerChosenToolId === 'zohoBooks' || plannerChosenToolId === 'zoho-books-read' || plannerChosenToolId === 'zoho-books-agent') && agentId === 'lark-ops-agent') {
        return false;
      }
      return true;
    });
    const supervisorPlanningHint = trimSupervisorSystemPrompt([
      effectiveRuntime.toolSelectionReason ? `Tool-selection reason: ${effectiveRuntime.toolSelectionReason}` : '',
      toolSelection.inferredDomain ? `Inferred domain: ${toolSelection.inferredDomain}` : '',
      toolSelection.inferredOperationClass ? `Inferred operation class: ${toolSelection.inferredOperationClass}` : '',
    ].filter(Boolean).join('\n'));
    const supervisorPlanStartedAt = Date.now();
    const supervisorPlan = await planSupervisorDelegation({
      mode: runtime.mode,
      latestUserMessage: resolvedUserMessage,
      childRouteHints: {
        route: childRoute.route,
        domain: childRoute.domain ?? null,
        operationType: childRoute.operationType ?? null,
        normalizedIntent: childRoute.normalizedIntent ?? null,
        suggestedToolIds: childRoute.suggestedToolIds ?? [],
      },
      toolSelectionReason: supervisorPlanningHint || null,
      inferredDomain: toolSelection.inferredDomain,
      inferredOperationClass: toolSelection.inferredOperationClass,
      eligibleAgentIds,
      searchIntent: effectiveRuntime.searchIntent,
      recentTaskSummaries: activeThreadSummary.recentTaskSummaries ?? [],
      threadSummary: activeThreadSummary.summary ?? '',
      supervisorProgress: activeTaskState.supervisorProgress ?? null,
      abortSignal,
    });
    await appendExecutionEventSafe({
      executionId,
      phase: 'planning',
      eventType: 'supervisor.plan',
      actorType: 'planner',
      actorKey: 'supervisor',
      title: 'Supervisor plan created',
      summary: `${supervisorPlan.complexity} with ${supervisorPlan.steps.length} step(s)`,
      status: 'done',
      payload: {
        durationMs: Date.now() - supervisorPlanStartedAt,
        complexity: supervisorPlan.complexity,
        eligibleAgentIds,
        steps: supervisorPlan.steps,
      },
    });
    planningMs = Date.now() - supervisorPlanStartedAt;
    await appendLatestAgentRunLog(task.taskId, 'supervisor.plan', {
      threadId: contextStorageId ?? message.chatId,
      complexity: supervisorPlan.complexity,
      eligibleAgentIds,
      steps: supervisorPlan.steps,
    });

    let delegatedAgentResults: DelegatedAgentExecutionResult[] = [];
    let generatedText = supervisorPlan.directAnswer?.trim() ?? '';
    let steps: Array<{ toolResults?: Array<{ toolName?: string; output?: unknown }> }> = [];
    let pendingApproval: PendingApprovalAction | null = null;
    let blockingUserInput: ReturnType<typeof findUnrepairableBlockingUserInput> = null;

    if (supervisorPlan.complexity !== 'direct') {
      const dagResult = await executeSupervisorDag({
        steps: supervisorPlan.steps,
        runStep: async (step, upstreamResults) => {
          await assertExecutionRunnable(task.taskId, abortSignal);
          const delegatedStepStartedAt = Date.now();
          let delegatedStepFirstToolStartedAt: number | null = null;
          const toolStartedAtByActivity = new Map<string, number>();
          const warmResolvedIds = await getWarmResolvedIdsForExecution(executionId, task.taskId);
          const resolvedHandoffContext = buildSupervisorResolvedContext({
            objective: step.objective,
            recentTaskSummaries: activeThreadSummary.recentTaskSummaries,
            threadSummary: buildThreadSummaryContext(activeThreadSummary) ?? activeThreadSummary.summary ?? '',
            scopedContext,
            warmResolvedIds,
            upstreamResults: upstreamResults.map((result) => ({
              summary: result.summary,
              text: result.text,
              data: result.data,
              output: result.output,
            })),
          });
          const familyToolIds = getSupervisorAgentToolIds(
            step.agentId,
            effectiveRuntime.allowedToolIds,
          ).filter((toolId) => toolId !== 'contextSearch');
          const stepRuntime: VercelRuntimeRequestContext = {
            ...effectiveRuntime,
            allowedToolIds: familyToolIds,
            delegatedAgentId: step.agentId,
            runExposedToolIds: familyToolIds,
            plannerCandidateToolIds: familyToolIds,
            toolSelectionReason: `supervisor delegated to ${step.agentId}`,
          };
          if (step.agentId === 'google-workspace-agent') {
            logger.info('agent.google_workspace.step.start', {
              stepId: step.stepId,
              objective: step.objective,
              familyToolIds: stepRuntime.runExposedToolIds,
              allowedToolIds: stepRuntime.allowedToolIds,
              allowedActionsByTool: stepRuntime.allowedActionsByTool,
              hasGoogleWorkspace: stepRuntime.allowedToolIds?.includes('googleWorkspace'),
              googleWorkspaceActions: stepRuntime.allowedActionsByTool?.googleWorkspace ?? null,
            });
          }
          const stepToolResults: RunToolResult[] = [];
          const stepResolvedContext = { ...resolvedHandoffContext };
          const stepMessages: ModelMessage[] = [
            ...primaryMessages.map(({ role, content }) => ({ role, content })),
            {
              role: 'user',
              content: buildDelegatedLarkStepPrompt({
                step,
                originalUserMessage: resolvedUserMessage,
                scopedContext,
                upstreamResults,
                resolvedContext: resolvedHandoffContext,
              }),
            },
          ];
          await appendExecutionEventSafe({
            executionId,
            phase: 'planning',
            eventType: 'supervisor.step.start',
            actorType: 'planner',
            actorKey: step.agentId,
            title: `Delegated step ${step.stepId}`,
            summary: summarizeText(step.objective, 300) ?? step.objective,
            status: 'running',
            payload: {
              queuedAtMs: Date.now(),
              stepId: step.stepId,
              agentId: step.agentId,
              objective: step.objective,
              dependsOn: step.dependsOn,
              inputRefs: step.inputRefs,
            },
          });
          statusHistory.push(`Running ${step.agentId}: ${summarizeText(step.objective, 140) ?? step.objective}`);
          await updateStatus(
            'planning',
            'Breaking this down into steps…',
          );
          let delegatedStepWatchdog: NodeJS.Timeout | undefined;
          try {
          const allStepTools = createVercelDesktopTools(stepRuntime, {
            onToolStart: async (toolName, activityId, title) => {
              const toolStartedAt = Date.now();
              const toolActivityKey = activityId || `${toolName}:${title}`;
              toolStartedAtByActivity.set(toolActivityKey, toolStartedAt);
              if (delegatedStepFirstToolStartedAt == null) {
                delegatedStepFirstToolStartedAt = toolStartedAt;
              }
              await appendLatestAgentRunLog(task.taskId, 'tool.start', {
                toolName,
                activityId,
                title,
                durationMs: delegatedStepFirstToolStartedAt == null
                  ? null
                  : toolStartedAt - delegatedStepStartedAt,
                channel: 'lark',
                threadId: contextStorageId ?? message.chatId,
                supervisorStepId: step.stepId,
                supervisorAgentId: step.agentId,
              });
              const startLabel = (TOOL_PROGRESS_LABELS[toolName] ?? TOOL_PROGRESS_DEFAULT).start;
              statusHistory.push(startLabel);
              await updateStatus('tool_running', startLabel);
            },
            onToolFinish: async (toolName, activityId, title, output) => {
              const toolFinishedAt = Date.now();
              const toolActivityKey = activityId || `${toolName}:${title}`;
              const toolStartedAt = toolStartedAtByActivity.get(toolActivityKey) ?? null;
              const toolDurationMs = toolStartedAt == null ? null : toolFinishedAt - toolStartedAt;
              if (toolStartedAt != null) {
                toolStartedAtByActivity.delete(toolActivityKey);
              }
              const hotContextSlot = buildHotContextSlot(toolName, output);
              hotContextStore.push(task.taskId, hotContextSlot);
              Object.assign(stepResolvedContext, hotContextSlot.resolvedIds);
              stepToolResults.push({
                toolId: output.toolId,
                toolName,
                success: output.success,
                status: output.status,
                data: output.data,
                confirmedAction: output.confirmedAction,
                ...(output.error ? { error: output.error } : {}),
                pendingApproval: Boolean(output.pendingApprovalAction),
                summary: output.summary,
              });
              await appendLatestAgentRunLog(task.taskId, 'tool.finish', {
                toolName,
                activityId,
                title,
                output,
                durationMs: toolDurationMs,
                channel: 'lark',
                threadId: contextStorageId ?? message.chatId,
                supervisorStepId: step.stepId,
                supervisorAgentId: step.agentId,
              });
              const finishLabels = TOOL_PROGRESS_LABELS[toolName] ?? TOOL_PROGRESS_DEFAULT;
              const finishLabel = output.success ? finishLabels.done : finishLabels.failed;
              const summary = summarizeText(output.summary, 100) ?? output.summary;
              statusHistory.push(`${finishLabel}: ${summary}`);
              await updateStatus('tool_done', finishLabel);
            },
          });
          const stepTools = Object.fromEntries(
            Object.entries(allStepTools).filter(([toolName]) => familyToolIds.includes(toolName)),
          );

          let stepResult;
          delegatedStepWatchdog = setTimeout(() => {
            if (stepToolResults.length > 0) {
              return;
            }
            const waitingSummary = summarizeText(step.objective, 120) ?? step.objective;
            statusHistory.push(
              `${step.agentId} is still reviewing this step before calling tools: ${waitingSummary}`,
            );
            void updateStatus(
              'planning',
              'Still thinking — this one needs a moment…',
            );
            logger.warn('supervisor.step.long_wait', {
              taskId: task.taskId,
              executionId,
              stepId: step.stepId,
              agentId: step.agentId,
              objective: summarizeText(step.objective, 240) ?? step.objective,
              phase: 'model_before_tool',
            });
            void appendExecutionEventSafe({
              executionId,
              phase: 'planning',
              eventType: 'supervisor.step.long_wait',
              actorType: 'planner',
              actorKey: step.agentId,
              title: `Delegated step ${step.stepId}`,
              summary: waitingSummary,
              status: 'running',
              payload: {
                stepId: step.stepId,
                agentId: step.agentId,
                objective: step.objective,
                waitedMs: Date.now() - delegatedStepStartedAt,
              },
            });
            void appendLatestAgentRunLog(task.taskId, 'supervisor.step.long_wait', {
              channel: 'lark',
              threadId: contextStorageId ?? message.chatId,
              supervisorStepId: step.stepId,
              supervisorAgentId: step.agentId,
              objective: step.objective,
              phase: 'model_before_tool',
            });
          }, 15_000);
          delegatedStepWatchdog.unref?.();
          const runDelegatedStepModel = async (
            messagesForStep: ModelMessage[],
            labelSuffix = '',
          ) => {
            try {
              return await runWithModelCircuitBreaker(
                resolvedModel.effectiveProvider,
                `lark_delegate_${step.agentId}${labelSuffix}`,
                () =>
                  generateText({
                    model: resolvedModel.model,
                    system: buildDelegatedAgentSystemPrompt(compactedSystemPrompt, step.agentId),
                    messages: messagesForStep,
                    tools: stepTools,
                    temperature: config.OPENAI_TEMPERATURE,
                    providerOptions: {
                      google: {
                        thinkingConfig: {
                          includeThoughts: resolvedModel.includeThoughts,
                          thinkingLevel: resolvedModel.thinkingLevel,
                        },
                      },
                    },
                    abortSignal,
                    stopWhen: [
                      stopOnPendingApproval,
                      ({ steps: rawSteps }) =>
                        Boolean(
                          findUnrepairableBlockingUserInput(
                            rawSteps as Array<{ toolResults?: Array<{ output: unknown }> }>,
                            task.taskId,
                          ),
                        ),
                      stepCountIs(20),
                    ],
                  }),
              );
            } catch (error) {
              if (!isProviderInvalidArgumentError(error)) {
                throw error;
              }
              const sanitizedMessages = sanitizeMessagesForProviderRetry(
                messagesForStep,
                resolvedUserMessage,
              );
              return runWithModelCircuitBreaker(
                resolvedModel.effectiveProvider,
                `lark_delegate_${step.agentId}${labelSuffix}_provider_retry`,
                () =>
                  generateText({
                    model: resolvedModel.model,
                    system: buildDelegatedAgentSystemPrompt(compactedSystemPrompt, step.agentId),
                    messages: sanitizedMessages,
                    tools: stepTools,
                    temperature: config.OPENAI_TEMPERATURE,
                    providerOptions: {
                      google: {
                        thinkingConfig: {
                          includeThoughts: resolvedModel.includeThoughts,
                          thinkingLevel: resolvedModel.thinkingLevel,
                        },
                      },
                    },
                    abortSignal,
                    stopWhen: [
                      stopOnPendingApproval,
                      ({ steps: rawSteps }) =>
                        Boolean(
                          findUnrepairableBlockingUserInput(
                            rawSteps as Array<{ toolResults?: Array<{ output: unknown }> }>,
                            task.taskId,
                          ),
                        ),
                      stepCountIs(20),
                    ],
                  }),
              );
            }
          };
          stepResult = await runDelegatedStepModel(stepMessages);
          if (delegatedStepWatchdog) {
            clearTimeout(delegatedStepWatchdog);
          }

          let rawSteps = (stepResult.steps ?? []) as Array<{
            toolResults?: Array<{ toolName?: string; output?: unknown }>;
          }>;
          let stepPendingApproval = findPendingApproval(
            rawSteps as Array<{ toolResults?: Array<{ output?: unknown }> }>,
          );
          let stepBlockingUserInput = findUnrepairableBlockingUserInput(
            rawSteps as Array<{ toolResults?: Array<{ output?: unknown }> }>,
            task.taskId,
          );
          if (
            stepToolResults.length === 0 &&
            !stepPendingApproval &&
            !stepBlockingUserInput &&
            delegatedStepLikelyRequiresToolUse(step)
          ) {
            statusHistory.push(`Retrying ${step.agentId}: first pass completed without any tool use.`);
            await updateStatus(
              'planning',
              'Hit a snag, trying another way…',
            );
            await appendLatestAgentRunLog(task.taskId, 'supervisor.step.retry_no_tool_use', {
              channel: 'lark',
              threadId: contextStorageId ?? message.chatId,
              supervisorStepId: step.stepId,
              supervisorAgentId: step.agentId,
              objective: step.objective,
            });
            stepResult = await runDelegatedStepModel([
              ...stepMessages,
              {
                role: 'user',
                content:
                  'Retry this delegated step once. The previous pass finished without using any tools. If this step requires live retrieval or an external action, use one of the available tools in this agent family unless you are blocked by approval or missing input.',
              },
            ], '_no_tool_retry');
            rawSteps = (stepResult.steps ?? []) as Array<{
              toolResults?: Array<{ toolName?: string; output?: unknown }>;
            }>;
            stepPendingApproval = findPendingApproval(
              rawSteps as Array<{ toolResults?: Array<{ output?: unknown }> }>,
            );
            stepBlockingUserInput = findUnrepairableBlockingUserInput(
              rawSteps as Array<{ toolResults?: Array<{ output?: unknown }> }>,
              task.taskId,
            );
          }
          const stepTextValue = (stepResult.text ?? '').trim();
          const stepText = stepBlockingUserInput
            ? (buildMissingInputResponseText(stepBlockingUserInput) ?? stepTextValue) || 'I need one more detail from you before I can continue.'
            : stepPendingApproval
              ? `Approval required before continuing: ${stepPendingApproval.kind === 'run_command' ? stepPendingApproval.command : stepPendingApproval.kind}.`
              : stepTextValue || 'Done.';
          const stepStatus: DelegatedAgentExecutionResult['status'] =
            stepPendingApproval || stepBlockingUserInput
              ? 'blocked'
              : stepToolResults.some((result) => result.status === 'error' || result.status === 'timeout')
                ? 'failed'
                : 'success';
          await appendExecutionEventSafe({
            executionId,
            phase: stepStatus === 'success' ? 'tool' : 'error',
            eventType: stepStatus === 'success' ? 'supervisor.step.complete' : 'supervisor.step.failed',
            actorType: 'agent',
            actorKey: step.agentId,
            title: `Delegated step ${step.stepId}`,
            summary: summarizeText(stepText, 400) ?? stepText,
            status: stepStatus === 'success' ? 'done' : 'failed',
            payload: {
              durationMs: Date.now() - delegatedStepStartedAt,
              ttftMs: delegatedStepFirstToolStartedAt == null
                ? null
                : delegatedStepFirstToolStartedAt - delegatedStepStartedAt,
              stepId: step.stepId,
              agentId: step.agentId,
              objective: step.objective,
              pendingApproval: stepPendingApproval ? { kind: stepPendingApproval.kind } : null,
              blockingUserInput: stepBlockingUserInput?.userAction ?? null,
              toolResults: stepToolResults,
            },
          });
          executionMs += Date.now() - delegatedStepStartedAt;
          const completedStep: CompletedSupervisorStep = {
            stepId: step.stepId,
            agentId: step.agentId,
            objective: step.objective,
            summary: summarizeText(stepText, 240) ?? stepText,
            resolvedIds: { ...stepResolvedContext },
            completedAt: new Date().toISOString(),
            success: stepStatus === 'success',
          };
          const resultEnvelope = buildStepResultEnvelope(
            stepResolvedContext,
            summarizeText(stepText, 240) ?? stepText,
            stepToolResults,
          );
          completedSupervisorSteps.set(step.stepId, completedStep);
          await persistIncrementalStepProgress({
            completedStep,
            allCompletedSteps: Array.from(completedSupervisorSteps.values()),
          });
          return {
            stepId: step.stepId,
            agentId: step.agentId,
            objective: step.objective,
            status: stepStatus,
            text: stepText,
            summary: summarizeText(stepText, 240) ?? stepText,
            data: {
              resolvedContext: stepResolvedContext,
              envelope: resultEnvelope,
            },
            toolResults: stepToolResults,
            pendingApproval: Boolean(stepPendingApproval),
            pendingApprovalAction: stepPendingApproval ?? undefined,
            blockingUserInput: Boolean(stepBlockingUserInput),
            blockingUserInputPayload: stepBlockingUserInput ?? undefined,
            output: {
              rawSteps,
              text: stepTextValue,
              resolvedContext: stepResolvedContext,
              envelope: resultEnvelope,
            },
          };
          } catch (error) {
            if (delegatedStepWatchdog) {
              clearTimeout(delegatedStepWatchdog);
            }
            const wasCancelled = isExecutionCancellationError(error);
            const errorMessage = error instanceof Error ? error.message : 'unknown_error';
            const summary = wasCancelled
              ? 'Execution was cancelled before delegated step completion.'
              : summarizeText(errorMessage, 400) ?? 'Delegated step failed before completion.';
            await appendExecutionEventSafe({
              executionId,
              phase: wasCancelled ? 'control' : 'error',
              eventType: wasCancelled ? 'supervisor.step.cancelled' : 'supervisor.step.failed',
              actorType: 'agent',
              actorKey: step.agentId,
              title: `Delegated step ${step.stepId}`,
              summary,
              status: wasCancelled ? 'cancelled' : 'failed',
              payload: {
                durationMs: Date.now() - delegatedStepStartedAt,
                ttftMs: delegatedStepFirstToolStartedAt == null
                  ? null
                  : delegatedStepFirstToolStartedAt - delegatedStepStartedAt,
                stepId: step.stepId,
                agentId: step.agentId,
                objective: step.objective,
                error: errorMessage,
                toolResults: stepToolResults,
              },
            });
            executionMs += Date.now() - delegatedStepStartedAt;
            throw error;
          }
        },
      });

      delegatedAgentResults = dagResult.orderedResults;
      steps = delegatedAgentResults.flatMap((entry) =>
        Array.isArray(entry.output.rawSteps)
          ? (entry.output.rawSteps as Array<{ toolResults?: Array<{ toolName?: string; output?: unknown }> }>)
          : [],
      );
      for (const delegatedResult of delegatedAgentResults) {
        executedToolOutcomes.push(...(delegatedResult.toolResults ?? []));
      }
      pendingApproval = delegatedAgentResults.find((entry) => entry.pendingApproval)?.pendingApprovalAction as PendingApprovalAction | null ?? null;
      blockingUserInput =
        delegatedAgentResults.find((entry) => entry.blockingUserInput)?.blockingUserInputPayload as ReturnType<typeof findUnrepairableBlockingUserInput> ?? null;

      if (supervisorPlan.complexity === 'single') {
        generatedText = delegatedAgentResults[0]?.text ?? 'Done.';
      } else {
        const synthesisStartMs = Date.now();
        generatedText = await synthesizeSupervisorOutcome({
          mode: runtime.mode,
          systemPrompt: compactedSystemPrompt,
          latestUserMessage: resolvedUserMessage,
          results: delegatedAgentResults,
          abortSignal,
        });
        synthesisMs = Date.now() - synthesisStartMs;
        await appendExecutionEventSafe({
          executionId,
          phase: 'synthesis',
          eventType: 'supervisor.synthesis',
          actorType: 'planner',
          actorKey: 'supervisor',
          title: 'Supervisor synthesis',
          summary: `${delegatedAgentResults.length} delegated result(s)`,
          status: 'done',
          payload: {
            durationMs: synthesisMs,
            stepCount: delegatedAgentResults.length,
          },
        });
      }
    }
    const trimmedGeneratedText = generatedText.trim();
    const preferredGeneratedText = (() => {
      if (delegatedAgentResults.length === 1) {
        const singleResult = delegatedAgentResults[0];
        const singleResultText = (singleResult?.text ?? '').trim();
        if (singleResult?.status === 'success' && singleResultText) {
          return singleResultText;
        }
        return trimmedGeneratedText || singleResultText;
      }
      const richDelegatedSummary = buildRichDelegatedResultSummary(delegatedAgentResults);
      return richDelegatedSummary || trimmedGeneratedText;
    })();

    const mutationGuard = resolveMutationGuard({
      latestUserMessage: resolvedUserMessage,
      toolResults: executedToolOutcomes,
      childRouterOperationType: childRoute.operationType,
      normalizedIntent: childRoute.normalizedIntent,
      plannerChosenOperationClass: effectiveRuntime.plannerChosenOperationClass,
      priorToolResults: activeTaskState.latestToolResults,
      pendingApproval: Boolean(pendingApproval),
      blockingUserInput: Boolean(blockingUserInput),
    });
    const finalText = mutationGuard.forcedFinalText === 'I did not complete that action because no confirmed action ran successfully.'
      ? __vercelMutationGuardTestUtils.finalizeNoActionAttemptText(preferredGeneratedText)
      : mutationGuard.forcedFinalText
      ?? (blockingUserInput
      ? (buildMissingInputResponseText(blockingUserInput) ?? preferredGeneratedText) ||
        'I need one more detail from you before I can continue.'
      : pendingApproval
        ? `Approval required before continuing: ${pendingApproval.kind === 'run_command' ? pendingApproval.command : pendingApproval.kind}.`
        : preferredGeneratedText || 'Done.');
    const deliveryText = (finalText ?? preferredGeneratedText ?? 'Done.').trim() || 'Done.';
    const hasToolResults =
      steps.length > 0
      || steps.some((step) => (step.toolResults?.length ?? 0) > 0);
    const isSensitiveContent = hasSensitiveToolResults({
      childRoute,
      steps,
      finalText: deliveryText,
      pendingApproval,
    });

    statusHistory.push('Execution complete. Preparing the final response.');
    await updateStatus('analyzing', 'Wrapping up your answer…');

    let deliveredStatusMessageId: string | undefined;
    if (pendingApproval) {
      await assertExecutionRunnable(task.taskId, abortSignal);
      const managerApprovalResult = await sendManagerApprovalRequest({
        runtime,
        message,
        pendingApproval,
      });
      statusHistory.push(`Approval required: ${pendingApproval.kind}`);
      const approvalText = managerApprovalResult.sent
          ? `Sent to ${managerApprovalResult.approverName ?? 'the manager'} for approval.`
          : pendingApproval.kind === 'tool_action'
          ? (summarizeText(pendingApproval.summary, 220) ?? deliveryText)
          : deliveryText;
      const approvalActions = managerApprovalResult.sent ? [] : buildLarkApprovalActions(pendingApproval);
      currentStatusPhase = 'approval';
      currentStatusDetail = approvalText;
      currentStatusActions = approvalActions;
      await assertExecutionRunnable(task.taskId, abortSignal);
      const delivery = await deliverTerminalResponse({
        text: approvalText,
        actions: approvalActions,
        hasToolResults,
        isSensitiveContent,
        proposedReplyMode,
      });
      deliveredStatusMessageId = delivery.statusMessageId;
    } else {
      await assertExecutionRunnable(task.taskId, abortSignal);
      const delivery = await deliverTerminalResponse({
        text: deliveryText,
        actions: [],
        hasToolResults,
        isSensitiveContent,
        proposedReplyMode,
      });
      deliveredStatusMessageId = delivery.statusMessageId;
    }

    const statusMessageId = deliveredStatusMessageId ?? statusCoordinator?.getStatusMessageId();
    if (!pendingApproval) {
      conversationMemoryStore.addAssistantMessage(conversationKey, task.taskId, deliveryText);
    }
    if (linkedUserId) {
      const effectiveMessages =
        inputMessages.length > 0 ? inputMessages : [{ role: 'user', content: resolvedUserMessage }];
      const estimatedInputTokens =
        estimateTokens(compactedSystemPrompt) + estimateMessageTokens(effectiveMessages);
      const estimatedOutputTokens = estimateTokens(deliveryText);
      await assertExecutionRunnable(task.taskId, abortSignal);
      await aiTokenUsageService.record({
        userId: linkedUserId,
        companyId: runtime.companyId,
        agentTarget: 'lark.vercel',
        modelId: resolvedModel.effectiveModelId,
        provider: resolvedModel.effectiveProvider,
        channel: 'lark',
        threadId: contextStorageId,
        estimatedInputTokens,
        estimatedOutputTokens,
        actualInputTokens: estimatedInputTokens,
        actualOutputTokens: estimatedOutputTokens,
        wasCompacted: historySelection.compactionTier > 1,
        mode: runtime.mode,
        runExposedToolIds: effectiveRuntime.runExposedToolIds ?? effectiveRuntime.allowedToolIds,
      });
    }

    await assertExecutionRunnable(task.taskId, abortSignal);
    await persistAssistantTurn({
      content: deliveryText,
      statusMessageId: statusMessageId ?? null,
      pendingApproval,
    });

    const agentResults = (
      delegatedAgentResults.length > 0
        ? delegatedAgentResults.map((entry) => ({
            taskId: task.taskId,
            agentKey: entry.agentId,
            status: entry.status === 'success' ? 'success' : 'failed',
            message: entry.summary,
            result: entry.output,
            error: entry.status === 'success'
              ? undefined
              : {
                  type: 'TOOL_ERROR',
                  classifiedReason: entry.pendingApproval
                    ? 'approval_required'
                    : entry.blockingUserInput
                      ? 'missing_input'
                      : 'delegated_step_failed',
                  rawMessage: entry.text,
                  retriable: false,
                },
            metrics: { apiCalls: Math.max(1, (entry.toolResults ?? []).length) },
          }))
        : mapToolStepsToAgentResults(steps).map((entry) => ({
            ...entry,
            taskId: task.taskId,
          }))
    ) satisfies AgentResultDTO[];
    for (const step of steps) {
      for (const toolResult of step.toolResults ?? []) {
        const output = toolResult.output as VercelToolEnvelope | undefined;
        if (!output) continue;
        activeTaskState = updateTaskStateFromToolEnvelope({
          taskState: activeTaskState,
          toolName: toolResult.toolName ?? 'unknown-tool',
          output,
          latestObjective: resolvedUserMessage,
        });
      }
    }
    if (activeTaskState.supervisorProgress) {
      const cleanedTaskState: DesktopTaskState = { ...activeTaskState };
      delete cleanedTaskState.supervisorProgress;
      activeTaskState = cleanedTaskState;
    }
    await assertExecutionRunnable(task.taskId, abortSignal);
    await persistConversationMemorySnapshot(finalText);
    await assertExecutionRunnable(task.taskId, abortSignal);
    await memoryService.recordToolSelectionOutcome({
      companyId: runtime.companyId,
      userId: linkedUserId,
      channelOrigin: 'lark',
      threadId: contextStorageId,
      conversationKey,
      latestUserMessage: resolvedUserMessage,
      childRoute: {
        confidence: childRoute.confidence,
        domain: childRoute.domain,
        operationType: childRoute.operationType,
        normalizedIntent: childRoute.normalizedIntent,
        reason: childRoute.reason,
        suggestedToolIds: childRoute.suggestedToolIds,
        suggestedActions: childRoute.suggestedActions,
      },
      hasWorkspace: Boolean(runtime.workspace),
      hasArtifacts:
        groundingAttachments.length > 0 || activeTaskState.activeSourceArtifacts.length > 0,
      plannerChosenToolId: effectiveRuntime.plannerChosenToolId,
      plannerChosenOperationClass: effectiveRuntime.plannerChosenOperationClass,
      runExposedToolIds: effectiveRuntime.runExposedToolIds,
      selectionReason: effectiveRuntime.toolSelectionReason,
      toolResults: executedToolOutcomes,
    });
    await appendLatestAgentRunLog(
      task.taskId,
      pendingApproval ? 'run.waiting_for_approval' : 'run.completed',
      {
        channel: 'lark',
        route: childRoute.route,
        threadId: contextStorageId ?? message.chatId,
        durationMs: Date.now() - runStartedAt,
        finalText,
        pendingApproval: pendingApproval
          ? {
              kind: pendingApproval.kind,
              approvalId:
                pendingApproval.kind === 'tool_action' ? pendingApproval.approvalId : null,
            }
          : null,
        stepCount: delegatedAgentResults.length > 0 ? delegatedAgentResults.length : steps.length,
        supervisorPlan,
      },
    );
    await appendExecutionEventSafe({
      executionId,
      phase: 'delivery',
      eventType: 'run.timing.summary',
      actorType: 'system',
      actorKey: 'orchestration-engine',
      title: 'Run timing breakdown',
      summary: 'Timing summary recorded.',
      status: 'done',
      payload: {
        totalMs: Date.now() - runStartedAt,
        phases: {
          toolSelectionMs,
          modelInputPrepMs,
          planningMs,
          executionMs,
          synthesisMs,
        },
      },
    });
    runCompletedSuccessfully = true;

    return {
      task,
      status: 'done',
      currentStep: pendingApproval ? 'control.requested' : mutationGuard.node,
      latestSynthesis: finalText,
      agentResults,
      runtimeMeta: {
        engine: 'vercel',
        threadId: contextStorageId,
        node: pendingApproval ? 'control.requested' : mutationGuard.node,
        stepHistory: task.plan,
        canonicalIntent: task.canonicalIntent,
        supervisorPlan,
        delegatedAgentResults,
      },
    };
  } catch (error) {
    if (isExecutionCancellationError(error)) {
      await appendLatestAgentRunLog(task.taskId, 'run.cancelled', {
        channel: 'lark',
        threadId: contextStorageId ?? message.chatId,
        error: error instanceof Error ? error.message : 'Execution cancelled.',
      });
      statusHistory.push('Cancelled before completion.');
      return {
        task,
        status: 'cancelled',
        currentStep: 'execution.cancelled',
        latestSynthesis: 'Execution cancelled.',
        agentResults: [],
        runtimeMeta: {
          engine: 'vercel',
          threadId: contextStorageId,
          node: 'execution.cancelled',
          stepHistory: task.plan,
          canonicalIntent: task.canonicalIntent,
        },
      };
    }
    const errorMessage = error instanceof Error ? error.message : 'Vercel Lark runtime failed.';
    await appendLatestAgentRunLog(task.taskId, 'run.failed', {
      channel: 'lark',
      threadId: contextStorageId ?? message.chatId,
      error: errorMessage,
    });
    statusHistory.push(`Failed: ${errorMessage}`);
    const failureCoordinator = await ensureStatusCoordinator({
      replyToMessageId: message.messageId,
    });
    await failureCoordinator.replace(
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
    try {
      const interruptedAt = runCompletedSuccessfully ? undefined : new Date().toISOString();
      activeThreadSummary = await appendWarmTaskSummary(activeThreadSummary, executionId, task.taskId, {
        isPartial: !runCompletedSuccessfully,
        interruptedAt,
      });
      if (!runCompletedSuccessfully && activeTaskState.supervisorProgress) {
        activeTaskState = {
          ...activeTaskState,
          supervisorProgress: {
            ...activeTaskState.supervisorProgress,
            updatedAt: interruptedAt ?? new Date().toISOString(),
            isPartial: true,
            interruptedAt,
          },
        };
      }
      if (sharedChatContext && companyId) {
        await larkChatContextService.updateMemory({
          companyId,
          chatId: message.chatId,
          chatType: message.chatType,
          summary: activeThreadSummary,
          taskState: activeTaskState,
        });
      }
    } catch (error) {
      logger.warn('supervisor.partial.snapshot.failed', {
        taskId: task.taskId,
        error: error instanceof Error ? error.message : 'unknown_error',
      });
    }
    hotContextStore.clear(task.taskId);
    await statusCoordinator?.close();
  }
};

const executeByChannel = async (
  input: OrchestrationExecutionInput,
): Promise<OrchestrationExecutionResult> => {
  switch (input.message.channel) {
    case 'lark':
      return executeLarkVercelTask(input.task, input.message, input.abortSignal);
    default:
      logger.warn('vercel.engine.channel_fallback', {
        taskId: input.task.taskId,
        messageId: input.message.messageId,
        channel: input.message.channel,
      });
      return legacyOrchestrationEngine.executeTask(input);
  }
};

export const vercelOrchestrationEngine: OrchestrationEngine = {
  id: 'vercel',
  async buildTask(taskId, message) {
    const task = await legacyOrchestrationEngine.buildTask(taskId, message);
    return adaptPlanForVercel(task);
  },
  async executeTask(input) {
    return executeByChannel(input);
  },
};

export const __test__ = {
  normalizeWarmResolvedIds,
  mergeWarmResolvedIdsFromStepResults,
  buildWarmSummaryFromStepResults,
  ensureAllowedActionsByTool,
};
