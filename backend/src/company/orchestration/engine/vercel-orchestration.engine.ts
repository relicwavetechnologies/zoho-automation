import { generateText, stepCountIs, type ModelMessage } from 'ai';

import config from '../../../config';
import type { ChannelAction } from '../../channels/base/channel-adapter';
import { resolveChannelAdapter } from '../../channels';
import { larkChatContextService } from '../../channels/lark/lark-chat-context.service';
import { departmentService } from '../../departments/department.service';
import { zohoRoleAccessService } from '../../tools/zoho-role-access.service';
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
import { estimateTokens } from '../../../utils/token-estimator';
import { AI_MODEL_CATALOG_MAP } from '../../ai-models';
import { personalVectorMemoryService, type PersonalMemoryMatch } from '../../integrations/vector';
import { memoryExtractionService, memoryService } from '../../memory';
import { enrichQuery, type QueryEnrichment } from '../query-enrichment.service';
import { classifyIntent } from '../intent/canonical-intent';
import { hotContextStore, type HotContextIndexedEntity, type HotContextSlot } from '../hot-context.store';
import { resolveOrdinalReferences } from '../utils/resolve-ordinal-references';
import { runtimeControlSignalsRepository } from '../../queue/runtime/control-signals.repository';
import { desktopWsGateway } from '../../../modules/desktop-live/desktop-ws.gateway';
import {
  appendLatestAgentRunLog,
  resetLatestAgentRunLog,
} from '../../../utils/latest-agent-run-log';
import { prisma } from '../../../utils/prisma';

const LOCAL_TIME_ZONE = 'Asia/Kolkata';
const LARK_BLOCKED_TOOL_IDS = new Set<string>();
const LARK_VERCEL_MODE: VercelRuntimeRequestContext['mode'] = 'high';
const LARK_THREAD_CONTEXT_MESSAGE_LIMIT = DESKTOP_THREAD_CONTEXT_MESSAGE_LIMIT;
const LARK_CONTEXT_TARGET_RATIO = 0.6;
const LARK_LIGHT_CONTEXT_TARGET_RATIO = 0.12;
const LARK_NORMAL_CONTEXT_TARGET_RATIO = 0.28;
const LARK_CHILD_ROUTER_HISTORY_TOKEN_BUDGET = 8_000;
const LARK_CHILD_ROUTER_HISTORY_MAX_MESSAGES = 16;
const LARK_LIGHTWEIGHT_RAW_HISTORY_TOKEN_BUDGET = 6_000;
const LARK_NORMAL_RAW_HISTORY_TOKEN_BUDGET = 40_000;
const LARK_LONG_RUNNING_RAW_HISTORY_TOKEN_BUDGET = 80_000;
const LARK_LIGHTWEIGHT_RAW_HISTORY_MAX_MESSAGES = 12;
const LARK_NORMAL_RAW_HISTORY_MAX_MESSAGES = 60;
const LARK_LONG_RUNNING_RAW_HISTORY_MAX_MESSAGES = 120;
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
  return {
    toolName,
    success: output.success,
    summary: output.summary,
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
  const unresolvedFields = blocking.missingFields.filter(
    (field) => !canResolveFieldFromHotContext(taskId, field),
  );
  return unresolvedFields.length > 0 ? blocking : null;
};

const appendWarmTaskSummary = (
  summary: DesktopThreadSummary,
  taskId: string,
): DesktopThreadSummary => {
  const warm = hotContextStore.toWarmSummary(taskId);
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
      },
      ...existing,
    ].slice(0, 10),
  };
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
  requesterAiRole?: string;
}): Promise<AttachedFileRef[]> => {
  if (input.artifacts.length === 0) {
    return [];
  }

  const fileAssetIds = Array.from(new Set(input.artifacts.map((artifact) => artifact.fileAssetId)));
  const isAdmin =
    input.requesterAiRole === 'COMPANY_ADMIN' || input.requesterAiRole === 'SUPER_ADMIN';
  const assets = await prisma.fileAsset.findMany({
    where: {
      companyId: input.companyId,
      id: { in: fileAssetIds },
      ...(!isAdmin && input.requesterUserId
        ? {
            OR: [
              { uploaderUserId: input.requesterUserId },
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
    threadSummaryContext: input.threadSummary
      ? buildThreadSummaryContext(input.threadSummary)
      : null,
    taskStateContext: input.taskState ? buildTaskStateContext(input.taskState) : null,
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
  const linkedUserId = message.trace?.linkedUserId ?? message.userId;
  let departmentId: string | undefined;
  let departmentName: string | undefined;
  let departmentRoleSlug: string | undefined;
  let departmentZohoReadScope: 'personalized' | 'show_all' | undefined;
  let departmentZohoRateLimitConfig: VercelRuntimeRequestContext['departmentZohoRateLimitConfig'];
  let departmentManagerApprovalConfig: VercelRuntimeRequestContext['departmentManagerApprovalConfig'];
  let departmentSystemPrompt: string | undefined;
  let departmentSkillsMarkdown: string | undefined;
  let canFallbackToCompanyScopedBooksRead = false;
  let allowedToolIds = fallbackAllowedToolIds;
  let allowedActionsByTool: Record<string, string[]> | undefined;
  const desktopAvailability = linkedUserId
    ? desktopWsGateway.getRemoteExecutionAvailability(linkedUserId, companyId)
    : { status: 'none' as const };
  const activeWorkspace =
    desktopAvailability.status === 'available'
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
    departmentZohoReadScope = resolved.departmentZohoReadScope;
    departmentZohoRateLimitConfig = resolved.departmentZohoRateLimitConfig;
    departmentManagerApprovalConfig = resolved.departmentManagerApprovalConfig;
    departmentSystemPrompt = resolved.systemPrompt;
    departmentSkillsMarkdown = resolved.skillsMarkdown;
    allowedToolIds = resolved.allowedToolIds;
    allowedActionsByTool = resolved.allowedActionsByTool;
    canFallbackToCompanyScopedBooksRead =
      (await zohoRoleAccessService.resolveScopeMode(companyId, requesterAiRole)) === 'company_scoped';
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
    requesterEmail: message.trace?.requesterEmail,
    sourceMessageId: message.messageId,
    sourceReplyToMessageId: message.trace?.replyToMessageId ?? message.messageId,
    sourceStatusMessageId: message.trace?.statusMessageId,
    sourceStatusReplyModeHint: message.trace?.statusReplyModeHint,
    sourceChatType: message.chatType,
    sourceChannelUserId: message.userId,
    departmentId,
    departmentName,
    departmentRoleSlug,
    departmentZohoReadScope,
    canFallbackToCompanyScopedBooksRead,
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

const executeLarkVercelTask = async (
  task: OrchestrationTaskDTO,
  message: NormalizedIncomingMessageDTO,
  abortSignal?: AbortSignal,
): Promise<OrchestrationExecutionResult> => {
  const adapter = resolveChannelAdapter('lark');
  const companyId = message.trace?.companyId;
  const linkedUserId = message.trace?.linkedUserId;
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
  const runtime = await resolveRuntimeContext(task, message, contextStorageId, activeTaskState);
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
    routerAcknowledgement ?? 'Choosing the right tools and approach for this request.',
  );

  await assertExecutionRunnable(task.taskId, abortSignal);
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
    payload: analyticsToolDemandPayload as unknown as Record<string, unknown>,
  });
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

  const tools = createVercelDesktopTools(effectiveRuntime, {
    onToolStart: async (_toolName, _activityId, title) => {
      await appendLatestAgentRunLog(task.taskId, 'tool.start', {
        toolName: _toolName,
        activityId: _activityId,
        title,
        channel: 'lark',
        threadId: contextStorageId ?? message.chatId,
      });
      statusHistory.push(`Started ${title}`);
      await updateStatus('tool_running', `Using ${title}.`);
    },
    onToolFinish: async (toolName, _activityId, title, output) => {
      hotContextStore.push(task.taskId, buildHotContextSlot(toolName, output));
      executedToolOutcomes.push({
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
        activityId: _activityId,
        title,
        output,
        channel: 'lark',
        threadId: contextStorageId ?? message.chatId,
      });
      const capabilityGapPayload = buildCapabilityGapFromToolFailure(
        analyticsToolDemandPayload,
        toolName,
        output,
      );
      if (capabilityGapPayload) {
        await appendExecutionEventSafe({
          executionId,
          phase: 'tool',
          eventType: EXECUTION_CAPABILITY_GAP_EVENT,
          actorType: 'tool',
          actorKey: toolName,
          title: 'capability gap detected',
          summary: capabilityGapPayload.gapLabel,
          status: 'failed',
          payload: capabilityGapPayload as unknown as Record<string, unknown>,
        });
      }
      const summary = summarizeText(output.summary, 180) ?? output.summary;
      statusHistory.push(`${output.success ? 'Completed' : 'Failed'} ${title}: ${summary}`);
      await updateStatus('tool_done', `${title}: ${summary}`);
    },
  });
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

  try {
    const primaryMessages =
      inputMessages.length > 0 ? inputMessages : [{ role: 'user', content: resolvedUserMessage }];
    await appendExecutionEventSafe({
      executionId,
      phase: 'planning',
      eventType: 'model.input',
      actorType: 'model',
      actorKey: resolvedModel.effectiveModelId,
      title: 'Prepared model input',
      summary: summarizeText(resolvedUserMessage, 220) ?? 'Prepared model input for generation.',
      status: 'done',
      payload: buildExecutionModelInputPayload({
        label: 'lark_generate',
        systemPrompt,
        messages: primaryMessages,
        contextSummary: {
          contextClass,
          modelId: budget.modelId,
          usableContextBudget: budget.usableContextBudget,
          targetContextBudget: budget.targetContextBudget,
          includedRawMessageCount: historySelection.includedRawMessageCount,
          includedConversationRetrievalCount: conversationSnippets.length,
          includedSourceArtifactCount: groundingAttachments.length,
          includedThreadSummary: activeThreadSummary.sourceMessageCount > 0,
          compactionTier: historySelection.compactionTier,
        },
        toolAvailability: {
          allowedToolIds: effectiveRuntime.allowedToolIds,
          runExposedToolIds: effectiveRuntime.runExposedToolIds ?? effectiveRuntime.allowedToolIds,
          plannerCandidateToolIds: effectiveRuntime.plannerCandidateToolIds ?? [],
          plannerChosenToolId: effectiveRuntime.plannerChosenToolId ?? null,
          plannerChosenOperationClass: effectiveRuntime.plannerChosenOperationClass ?? null,
          toolSelectionReason: effectiveRuntime.toolSelectionReason ?? null,
        },
      }),
    });
    await appendLatestAgentRunLog(task.taskId, 'llm.context', {
      phase: 'lark_generate',
      threadId: contextStorageId ?? message.chatId,
      systemPrompt,
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
      },
    });
    let result;
    try {
      await assertExecutionRunnable(task.taskId, abortSignal);
      result = await runWithModelCircuitBreaker(
        resolvedModel.effectiveProvider,
        'lark_generate',
        () =>
          generateText({
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
            abortSignal,
            stopWhen: [
              stopOnPendingApproval,
              ({ steps }) =>
                Boolean(
                  findUnrepairableBlockingUserInput(
                    steps as Array<{ toolResults?: Array<{ output: unknown }> }>,
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
        primaryMessages,
        resolvedUserMessage,
      );
      logger.warn('lark.generate.retry_with_sanitized_messages', {
        taskId: task.taskId,
        messageId: message.messageId,
        originalMessageCount: primaryMessages.length,
        sanitizedMessageCount: sanitizedMessages.length,
        originalLatestUserLength: resolvedUserMessage.length,
        sanitizedLatestUserLength:
          typeof sanitizedMessages[sanitizedMessages.length - 1]?.content === 'string'
            ? sanitizedMessages[sanitizedMessages.length - 1]!.content.length
            : 0,
        error: error instanceof Error ? error.message : 'invalid_argument',
      });
      result = await runWithModelCircuitBreaker(
        resolvedModel.effectiveProvider,
        'lark_generate_sanitized_retry',
        () =>
          generateText({
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
            abortSignal,
            stopWhen: [
              stopOnPendingApproval,
              ({ steps }) =>
                Boolean(
                  findUnrepairableBlockingUserInput(
                    steps as Array<{ toolResults?: Array<{ output: unknown }> }>,
                    task.taskId,
                  ),
                ),
              stepCountIs(20),
            ],
          }),
      );
    }
    logger.info('vercel.tool_loop.summary', {
      mode: runtime.mode,
      modelId: resolvedModel.effectiveModelId,
      stepCount: Array.isArray(result.steps) ? result.steps.length : 0,
      stepLimit: 20,
      hitStepLimit: Array.isArray(result.steps) ? result.steps.length >= 20 : false,
      channel: 'lark',
    });

    const steps = result.steps as Array<{
      toolResults?: Array<{ toolName?: string; output?: unknown }>;
    }>;
    const pendingApproval = findPendingApproval(
      steps as Array<{ toolResults?: Array<{ output: unknown }> }>,
    );
    const blockingUserInput = findUnrepairableBlockingUserInput(
      steps as Array<{ toolResults?: Array<{ output: unknown }> }>,
      task.taskId,
    );
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
      ? __vercelMutationGuardTestUtils.finalizeNoActionAttemptText(result.text.trim())
      : mutationGuard.forcedFinalText
      ?? (blockingUserInput
      ? (buildMissingInputResponseText(blockingUserInput) ?? result.text.trim()) ||
        'I need one more detail from you before I can continue.'
      : pendingApproval
        ? `Approval required before continuing: ${pendingApproval.kind === 'run_command' ? pendingApproval.command : pendingApproval.kind}.`
        : result.text.trim() || 'Done.');
    const hasToolResults =
      steps.length > 0
      || steps.some((step) => (step.toolResults?.length ?? 0) > 0);
    const isSensitiveContent = hasSensitiveToolResults({
      childRoute,
      steps,
      finalText,
      pendingApproval,
    });

    statusHistory.push('Execution complete. Preparing the final response.');
    await updateStatus('analyzing', 'Finalizing the response for you.');

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
          ? (summarizeText(pendingApproval.summary, 220) ?? finalText)
          : finalText;
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
        text: finalText,
        actions: [],
        hasToolResults,
        isSensitiveContent,
        proposedReplyMode,
      });
      deliveredStatusMessageId = delivery.statusMessageId;
    }

    const statusMessageId = deliveredStatusMessageId ?? statusCoordinator?.getStatusMessageId();
    if (!pendingApproval) {
      conversationMemoryStore.addAssistantMessage(conversationKey, task.taskId, finalText);
    }
    if (linkedUserId) {
      const effectiveMessages =
        inputMessages.length > 0 ? inputMessages : [{ role: 'user', content: resolvedUserMessage }];
      const estimatedInputTokens =
        estimateTokens(systemPrompt) + estimateMessageTokens(effectiveMessages);
      const estimatedOutputTokens = estimateTokens(finalText);
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
      content: finalText,
      statusMessageId: statusMessageId ?? null,
      pendingApproval,
    });

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
          latestObjective: resolvedUserMessage,
        });
      }
    }
    activeThreadSummary = appendWarmTaskSummary(activeThreadSummary, task.taskId);
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
        finalText,
        pendingApproval: pendingApproval
          ? {
              kind: pendingApproval.kind,
              approvalId:
                pendingApproval.kind === 'tool_action' ? pendingApproval.approvalId : null,
            }
          : null,
        stepCount: Array.isArray(result.steps) ? result.steps.length : 0,
      },
    );

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
