import { randomUUID } from 'crypto';

import { generateObject, generateText, stepCountIs, streamText, type ModelMessage } from 'ai';
import { Request, Response } from 'express';
import { z } from 'zod';

import { ApiResponse } from '../../core/api-response';
import config from '../../config';
import { resolveVercelLanguageModel } from '../../company/orchestration/vercel/model-factory';
import { createVercelDesktopTools } from '../../company/orchestration/vercel/tools';
import {
  scheduledWorkflowCapabilitySummarySchema,
  scheduledWorkflowScheduleConfigSchema,
} from '../../company/scheduled-workflows/contracts';
import type {
  PendingApprovalAction,
  VercelRuntimeRequestContext,
  VercelToolEnvelope,
} from '../../company/orchestration/vercel/types';
import { desktopThreadsService } from '../desktop-threads/desktop-threads.service';
import type { MemberSessionDTO } from '../member-auth/member-auth.service';
import { buildVisionContent, type AttachedFileRef } from './file-vision.builder';
import { actSchema, attachedFileSchema, sendSchema } from './desktop-chat.schemas';
import {
  desktopThreadContextCache,
  DESKTOP_THREAD_CONTEXT_MESSAGE_LIMIT,
  type CachedDesktopThreadContext,
  type CachedDesktopThreadMessage,
} from './desktop-thread-context.cache';
import { executionService } from '../../company/observability';
import { conversationMemoryStore } from '../../company/state/conversation/conversation-memory.store';
import { toolPermissionService } from '../../company/tools/tool-permission.service';
import { logger } from '../../utils/logger';
import { departmentService } from '../../company/departments/department.service';
import { prisma } from '../../utils/prisma';
import { aiTokenUsageService } from '../../company/ai-usage/ai-token-usage.service';
import { AI_MODEL_CATALOG_MAP, type AiModelCatalogEntry } from '../../company/ai-models';
import { personalVectorMemoryService, type PersonalMemoryMatch } from '../../company/integrations/vector';
import { retrievalOrchestratorService } from '../../company/retrieval';
import { estimateTokens, getTokenBudget } from '../../utils/token-estimator';
import {
  buildDesktopPlannerPrompt,
  completeExecutionPlan,
  executionPlanSchema,
  failExecutionPlan,
  formatExecutionPlanForLog,
  initializeExecutionPlan,
  plannerDraftSchema,
  resolvePlanOwnerFromActionKind,
  resolvePlanOwnerFromToolName,
  updateExecutionPlanTask,
  type ExecutionPlan,
  type ExecutionPlanOwner,
} from './desktop-plan';
import {
  applyActionResultToTaskState,
  buildTaskStateContext,
  buildThreadSummaryContext,
  createEmptyTaskState,
  markDesktopSourceArtifactsUsed,
  parseDesktopTaskState,
  parseDesktopThreadSummary,
  refreshDesktopThreadSummary,
  resolveDesktopTaskReferences,
  selectDesktopSourceArtifacts,
  upsertDesktopSourceArtifacts,
  updateTaskStateFromToolEnvelope,
  type DesktopTaskState,
  type DesktopThreadSummary,
} from './desktop-thread-memory';

type DesktopWorkspaceAction =
  | { kind: 'list_files'; path?: string }
  | { kind: 'read_file'; path: string }
  | { kind: 'write_file'; path: string; content: string }
  | { kind: 'mkdir'; path: string }
  | { kind: 'delete_path'; path: string }
  | { kind: 'run_command'; command: string };

type RemoteApprovalAction = {
  kind: 'tool_action';
  toolId: string;
  actionGroup: 'read' | 'create' | 'update' | 'delete' | 'send' | 'execute';
  operation: string;
  title: string;
  summary: string;
  subject?: string;
  explanation?: string;
};

type PersistedContentBlock =
  | { type: 'thinking'; text?: string }
  | { type: 'tool'; id: string; name: string; label: string; icon: string; status: 'running' | 'done' | 'failed'; resultSummary?: string }
  | { type: 'text'; content: string };

type PersistedConversationRefs = {
  latestLarkDoc?: Record<string, unknown>;
  latestLarkCalendarEvent?: Record<string, unknown>;
  latestLarkTask?: Record<string, unknown>;
};

type PersistedPlanMetadata = {
  plan?: ExecutionPlan;
};

type DesktopExecutionState = 'running' | 'waiting_for_approval' | 'running_after_approval' | 'completed' | 'failed' | 'cancelled';

type PersistedExecutionMetadata = {
  executionState?: {
    state: DesktopExecutionState;
    paused?: boolean;
    resumeOfExecutionId?: string;
  };
  pendingApprovalAction?: PendingApprovalAction;
  desktopPendingAction?: DesktopWorkspaceAction | RemoteApprovalAction;
  taskStateSnapshot?: DesktopTaskState;
  threadSummarySnapshot?: DesktopThreadSummary;
  contextAssembly?: DesktopContextAssemblyMetrics;
};

type ThreadHistorySnapshot = CachedDesktopThreadContext;
type DesktopContextClass =
  | 'lightweight_chat'
  | 'normal_work'
  | 'long_running_task'
  | 'document_grounded_followup';

type DesktopContextAssemblyMetrics = {
  contextClass: DesktopContextClass;
  modelId: string;
  usableContextBudget: number;
  targetContextBudget: number;
  estimatedPromptTokens: number;
  usedContextBudgetPercent: number;
  includedRawMessageCount: number;
  includedConversationRetrievalCount: number;
  includedSourceArtifactCount: number;
  includedThreadSummary: boolean;
  includedTaskState: boolean;
  includedWorkspaceContext: boolean;
  compactionTier: number;
};

const resolveWorkflowInvocationMessage = async (input: {
  companyId: string;
  userId: string;
  workflowId: string;
  workflowName?: string;
  overrideText?: string;
}): Promise<{
  requestMessage: string;
  storedUserMessage: string;
}> => {
  const workflow = await prisma.scheduledWorkflow.findFirst({
    where: {
      id: input.workflowId,
      companyId: input.companyId,
      createdByUserId: input.userId,
      status: { notIn: ['draft', 'archived'] },
    },
    select: {
      id: true,
      name: true,
      status: true,
      compiledPrompt: true,
      capabilitySummaryJson: true,
      scheduleConfigJson: true,
    },
  });
  if (!workflow) {
    throw new Error('Saved workflow not found or is no longer available.');
  }

  const capabilitySummary = scheduledWorkflowCapabilitySummarySchema.parse(workflow.capabilitySummaryJson);
  const schedule = scheduledWorkflowScheduleConfigSchema.parse(workflow.scheduleConfigJson);
  const overrideText = input.overrideText?.trim() ?? '';
  if (overrideText && capabilitySummary.requiresPublishApproval) {
    throw new Error('Temporary overrides are blocked for workflows that can write, send, delete, or execute.');
  }

  const workflowName = input.workflowName?.trim() || workflow.name;
  const requestMessage = [
    workflow.compiledPrompt.trim(),
    '',
    'Manual workflow invocation request:',
    `- Workflow: ${workflowName}`,
    `- Schedule type: ${schedule.type} (${schedule.timezone})`,
    '- Run this workflow now inside the current desktop thread.',
    '- Keep the saved workflow definition as the source of truth.',
    ...(overrideText
      ? [
        '- Apply this one-time override without mutating the saved workflow definition.',
        '',
        'Run-specific override:',
        overrideText,
      ]
      : []),
  ].join('\n');

  const storedUserMessage = overrideText
    ? `Run workflow "${workflowName}" with a one-time override.`
    : `Run saved workflow "${workflowName}".`;

  return {
    requestMessage,
    storedUserMessage,
  };
};

const desktopChildRouteSchema = z.object({
  route: z.enum(['fast_reply', 'direct_execute', 'handoff']),
  reply: z.string().min(1).max(600).optional(),
  acknowledgement: z.string().min(1).max(400).optional(),
  reason: z.string().min(1).max(200).optional(),
});

export type DesktopChildRoute = z.infer<typeof desktopChildRouteSchema>;

const buildConversationKey = (threadId: string): string => `desktop:${threadId}`;
const LOCAL_TIME_ZONE = 'Asia/Kolkata';
const MODEL_HISTORY_MESSAGE_LIMIT = 8;
const DESKTOP_CONTEXT_TARGET_RATIO = 0.6;
const DESKTOP_LIGHT_CONTEXT_TARGET_RATIO = 0.12;
const DESKTOP_NORMAL_CONTEXT_TARGET_RATIO = 0.28;
const DESKTOP_MAX_LOOP_STEPS = 200;
const WORKFLOW_AUTOCONTINUE_LIMIT = 2;

const summarizeText = (value: string | null | undefined, limit = 280): string | null => {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}...` : trimmed;
};

const isWorkflowExecutionRequest = (metadata?: Record<string, unknown>): boolean =>
  typeof metadata?.workflowId === 'string' && metadata.workflowId.trim().length > 0;

const isWorkflowProgressOnlyResponse = (value: string | null | undefined): boolean => {
  const text = value?.trim();
  if (!text) return false;
  return /\b(execution plan:|i am starting the execution|i am now proceeding|i will begin execution now|i will report back|i am proceeding to execute|i have successfully loaded and parsed)\b/i.test(text);
};

const buildWorkflowAutoContinuationMessage = (input: {
  assistantText: string;
  toolOutputs: VercelToolEnvelope[];
}): string => {
  const completedSteps = input.toolOutputs
    .slice(-6)
    .map((output, index) => `${index + 1}. ${output.summary}`)
    .join('\n');
  return [
    'Continue the workflow execution now.',
    'Do not restate the execution plan, task list, or promise future work.',
    'Perform the next actual workflow steps immediately using tools.',
    'Only stop if one of these is true:',
    '1. The workflow is fully complete and the final deliverable is ready.',
    '2. A real approval gate blocks the next step.',
    '3. A true hard block prevents progress.',
    completedSteps ? 'Completed steps so far:' : '',
    completedSteps,
    'Your next response must reflect concrete progress, a true block, or final completion.',
    `Latest response to avoid repeating:\n${input.assistantText.trim().slice(0, 1200)}`,
  ].filter(Boolean).join('\n\n');
};

const isReferentialFollowup = (value: string | null | undefined): boolean =>
  /\b(next task|pick the next|move on|move to next|continue|next one|same file|same one|next estimate|what next)\b/i.test(value ?? '');

const isPersonalMemoryQuestion = (value: string | null | undefined): boolean =>
  /\b(do you know|do you remember|remember|recall|what(?:'s| is) my|my (?:fav|favorite|favourite|preferred)|favorite|favourite|preferred|preference|about me|my name|my email)\b/i.test(value ?? '');

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

const isLightweightChatTurn = (value: string | null | undefined): boolean =>
  /^(hi|hello|hey|thanks|thank you|ok|okay|cool|great|nice|yes|no)[.! ]*$/i.test((value ?? '').trim());

const resolveModelCatalogEntry = (resolvedModel: {
  effectiveProvider: string;
  effectiveModelId: string;
}): AiModelCatalogEntry | null => {
  const direct = AI_MODEL_CATALOG_MAP.get(
    `${resolvedModel.effectiveProvider}:${resolvedModel.effectiveModelId}`,
  );
  if (direct) return direct;

  if (resolvedModel.effectiveProvider === 'google') {
    return AI_MODEL_CATALOG_MAP.get('google:gemini-3.1-flash-lite-preview')
      ?? AI_MODEL_CATALOG_MAP.get('google:gemini-2.5-flash')
      ?? null;
  }

  return null;
};

const SHOULD_LOG_LLM_CONTEXT = ['1', 'true', 'yes', 'on'].includes(
  String(process.env.LOG_LLM_CONTEXT ?? '').trim().toLowerCase(),
);

const logLlmContext = (input: {
  phase: 'send' | 'act' | 'streamAct';
  executionId: string;
  threadId: string;
  systemPrompt: string;
  messages: ModelMessage[];
  workspace?: { name: string; path: string };
  taskState?: DesktopTaskState;
  threadSummary?: DesktopThreadSummary;
  resolvedUserReferences?: string[];
}): void => {
  if (!SHOULD_LOG_LLM_CONTEXT) {
    return;
  }

  logger.error('vercel.llm.context', {
    phase: input.phase,
    executionId: input.executionId,
    threadId: input.threadId,
    workspace: input.workspace ?? null,
    resolvedUserReferences: input.resolvedUserReferences ?? [],
    activeSourceArtifacts: input.taskState?.activeSourceArtifacts ?? [],
    threadSummary: input.threadSummary ?? null,
    taskState: input.taskState ?? null,
    systemPrompt: input.systemPrompt,
    messages: input.messages.map((message, index) => ({
      index,
      role: message.role,
      content: typeof message.content === 'string'
        ? message.content
        : JSON.stringify(message.content),
    })),
  }, { always: true });
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

const recordTokenUsage = async (input: {
  userId?: string | null;
  companyId?: string | null;
  channel: 'desktop' | 'lark';
  threadId?: string;
  mode: 'fast' | 'high' | 'xtreme';
  agentTarget: string;
  systemPrompt: string;
  messages: ModelMessage[];
  outputText: string;
}): Promise<void> => {
  if (!input.userId || !input.companyId) {
    return;
  }

  const resolvedModel = await resolveVercelLanguageModel(input.mode);
  const estimatedInputTokens = estimateTokens(input.systemPrompt) + estimateMessageTokens(input.messages);
  const estimatedOutputTokens = estimateTokens(input.outputText);

  await aiTokenUsageService.record({
    userId: input.userId,
    companyId: input.companyId,
    agentTarget: input.agentTarget,
    modelId: resolvedModel.effectiveModelId,
    provider: resolvedModel.effectiveProvider,
    channel: input.channel,
    threadId: input.threadId,
    estimatedInputTokens,
    estimatedOutputTokens,
    actualInputTokens: estimatedInputTokens,
    actualOutputTokens: estimatedOutputTokens,
    wasCompacted: false,
    mode: input.mode,
  });
};

export const buildChildRouterPrompt = (input: {
  message: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  workspace?: { name: string; path: string };
  requesterName?: string;
  requesterEmail?: string;
  retrievedMemorySnippets?: string[];
}): string => {
  const historyBlock = input.history.length > 0
    ? input.history
      .slice(-6)
      .map((entry, index) => `${index + 1}. ${entry.role.toUpperCase()}: ${entry.content}`)
      .join('\n')
    : 'No useful prior conversation history.';

  const workspaceBlock = input.workspace
    ? `Workspace is open at ${input.workspace.path} (${input.workspace.name}).`
    : 'No workspace context is active.';
  const requesterContext = buildRequesterIdentityContext({
    requesterName: input.requesterName,
    requesterEmail: input.requesterEmail,
  });
  const retrievedMemoryBlock = input.retrievedMemorySnippets && input.retrievedMemorySnippets.length > 0
    ? input.retrievedMemorySnippets.map((snippet, index) => `${index + 1}. ${snippet}`).join('\n')
    : 'No retrieved conversation memory.';

  return [
    'Classify this desktop chat turn for a two-tier assistant runtime.',
    'Return structured JSON only.',
    'Routes:',
    '- fast_reply: greetings, thanks, chit-chat, identity/capability questions, or short conversational replies that need no tools.',
    '- direct_execute: straightforward work that should go directly to the main executor without a pre-ack.',
    '- handoff: multi-step or heavier work likely to require more than 2-3 tool calls, iteration, or planning. Provide a short acknowledgement the user should see immediately.',
    'Rules:',
    '- Do not use tools.',
    '- If retrieved conversation memory clearly answers a personal-memory question, prefer fast_reply and answer from that memory.',
    '- For fast_reply, fill reply and keep it short.',
    '- For handoff, fill acknowledgement and keep it short, concrete, and action-oriented.',
    '- Do not overuse handoff for tiny requests.',
    workspaceBlock,
    `Current local date/time: ${getLocalDateTimeContext()} (${LOCAL_TIME_ZONE}).`,
    requesterContext ?? '',
    'Retrieved conversation memory:',
    retrievedMemoryBlock,
    'Recent conversation:',
    historyBlock,
    'Latest user message:',
    input.message,
  ].join('\n\n');
};

export const runDesktopChildRouter = async (input: {
  executionId: string;
  threadId: string;
  message: string;
  workspace?: { name: string; path: string };
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  requesterName?: string;
  requesterEmail?: string;
  companyId?: string;
  userId?: string;
}): Promise<DesktopChildRoute> => {
  logger.info('vercel.child_router.start', {
    executionId: input.executionId,
    threadId: input.threadId,
    messagePreview: summarizeText(input.message, 200),
    historyCount: input.history.length,
    hasWorkspace: Boolean(input.workspace),
  });

  try {
    const retrievedMemorySnippets = await retrieveConversationMemoryForChildRouter({
      executionId: input.executionId,
      threadId: input.threadId,
      message: input.message,
      companyId: input.companyId,
      userId: input.userId,
    });
    const model = await resolveVercelLanguageModel('fast');
    const result = await generateObject({
      model: model.model,
      schema: desktopChildRouteSchema,
      schemaName: 'desktop_child_route',
      schemaDescription: 'Routing decision for a fast desktop child assistant that either replies quickly or hands off to the main executor.',
      prompt: buildChildRouterPrompt({
        ...input,
        retrievedMemorySnippets,
      }),
      temperature: 0,
      providerOptions: {
        google: {
          thinkingConfig: {
            includeThoughts: false,
            thinkingLevel: 'minimal',
          },
        },
      },
    });
    logger.info('vercel.child_router.completed', {
      executionId: input.executionId,
      threadId: input.threadId,
      route: result.object.route,
      reason: result.object.reason ?? null,
      retrievedMemorySnippetCount: retrievedMemorySnippets.length,
    });
    if (result.object.route === 'fast_reply' && isPersonalMemoryQuestion(input.message)) {
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
        };
      }
    }
    return result.object;
  } catch (error) {
    const fallbackRoute: DesktopChildRoute = shouldPlanDesktopTask(input.message)
      ? {
        route: 'handoff',
        acknowledgement: 'I’ll handle this in steps and start gathering the required context now.',
        reason: 'router_fallback_complex',
      }
      : {
        route: 'direct_execute',
        reason: 'router_fallback_direct',
      };
    logger.warn('vercel.child_router.failed', {
      executionId: input.executionId,
      threadId: input.threadId,
      error: error instanceof Error ? error.message : 'unknown_error',
      fallbackRoute: fallbackRoute.route,
    });
    return fallbackRoute;
  }
};

const retrieveConversationMemoryForChildRouter = async (input: {
  executionId: string;
  threadId: string;
  message: string;
  companyId?: string;
  userId?: string;
}): Promise<string[]> => {
  const isMemoryQuestion = isPersonalMemoryQuestion(input.message);
  const referentialFollowup = isReferentialFollowup(input.message);
  if ((!isMemoryQuestion && !referentialFollowup) || !input.companyId || !input.userId || !input.message.trim()) {
    return [];
  }

  const limit = isMemoryQuestion ? 3 : 2;
  logger.info('vercel.child_router.retrieval.start', {
    executionId: input.executionId,
    threadId: input.threadId,
    isMemoryQuestion,
    isReferentialFollowup: referentialFollowup,
    queryLength: input.message.trim().length,
    limit,
  });

  try {
    const { matches, scope } = await queryConversationMemoryWithFallback({
      companyId: input.companyId,
      userId: input.userId,
      threadId: input.threadId,
      queryText: input.message,
      limit,
      isMemoryQuestion,
      logPrefix: 'vercel.child_router.retrieval',
    });
    const snippets = dedupeConversationSnippets({
      snippets: summarizeConversationMatches(matches, limit),
      threadSummary: parseDesktopThreadSummary(null),
      taskState: createEmptyTaskState(),
    });
    logger.info('vercel.child_router.retrieval.completed', {
      executionId: input.executionId,
      threadId: input.threadId,
      scope,
      matchCount: matches.length,
      snippetCount: snippets.length,
      topScores: matches.slice(0, 3).map((match) => Number(match.score.toFixed(4))),
    });
    return snippets;
  } catch (error) {
    logger.warn('vercel.child_router.retrieval.failed', {
      executionId: input.executionId,
      threadId: input.threadId,
      error: error instanceof Error ? error.message : 'unknown',
    });
    return [];
  }
};

const shouldPlanDesktopTask = (message?: string): boolean => {
  const input = message?.trim();
  if (!input) return false;
  const lowered = input.toLowerCase();
  if (isBareContinuationMessage(input)) return false;
  if (input.length >= 120) return true;
  if (/\b(and|then|after that|also|compare|audit|investigate|analyze|review|summarize|implement|debug|refactor|prepare)\b/i.test(input)) {
    return true;
  }
  if (/\b(create|update|send|draft|write|read|search)\b/i.test(input) && /\b(zoho|lark|google|repo|workspace|file|document|calendar|task|invoice|payment)\b/i.test(input)) {
    return true;
  }
  return false;
};

const extractLatestExecutionPlan = (history: ThreadHistorySnapshot): ExecutionPlan | null => {
  for (const message of [...history.messages].reverse()) {
    const metadata = message.metadata;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) continue;
    const parsed = executionPlanSchema.safeParse((metadata as PersistedPlanMetadata).plan);
    if (parsed.success) {
      return parsed.data;
    }
  }
  return null;
};

const ensurePlanTaskRunning = (
  plan: ExecutionPlan,
  ownerAgent: ExecutionPlanOwner,
): ExecutionPlan => {
  if (plan.status !== 'running') return plan;
  const tasks = plan.tasks.map((task) => ({ ...task }));
  const runningIndex = tasks.findIndex((task) => task.status === 'running');
  if (runningIndex >= 0 && tasks[runningIndex]?.ownerAgent === ownerAgent) {
    return plan;
  }
  const targetIndex = tasks.findIndex((task) => task.status === 'pending' && task.ownerAgent === ownerAgent);
  if (targetIndex === -1) {
    return plan;
  }
  if (runningIndex >= 0) {
    tasks[runningIndex].status = 'blocked';
  }
  tasks[targetIndex].status = 'running';
  return {
    ...plan,
    updatedAt: new Date().toISOString(),
    tasks,
  };
};

const sendSseEvent = (res: Response, type: string, data: unknown) => {
  res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
};

const CHILD_TEXT_STREAM_CHUNK_SIZE = 28;
const CHILD_TEXT_STREAM_DELAY_MS = 14;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const chunkTextForChildStream = (text: string): string[] => {
  const normalized = text.replace(/\r\n/g, '\n');
  if (normalized.length <= CHILD_TEXT_STREAM_CHUNK_SIZE) {
    return [normalized];
  }

  const chunks: string[] = [];
  let buffer = '';
  const tokens = normalized.split(/(\s+)/);

  for (const token of tokens) {
    if (!token) {
      continue;
    }
    if ((buffer + token).length > CHILD_TEXT_STREAM_CHUNK_SIZE && buffer.length > 0) {
      chunks.push(buffer);
      buffer = token;
      continue;
    }
    buffer += token;
  }

  if (buffer.length > 0) {
    chunks.push(buffer);
  }

  return chunks.length > 0 ? chunks : [normalized];
};

const streamChildText = async (
  res: Response,
  text: string,
  queueUiEvent: (
    type: Parameters<typeof persistUiEvent>[1],
    data: Parameters<typeof persistUiEvent>[2],
  ) => void,
): Promise<void> => {
  const chunks = chunkTextForChildStream(text);
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    sendSseEvent(res, 'text', chunk);
    queueUiEvent('text', chunk);
    if (index < chunks.length - 1) {
      await sleep(CHILD_TEXT_STREAM_DELAY_MS);
    }
  }
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

const getLocalDateContext = (): string => {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: LOCAL_TIME_ZONE,
    weekday: 'long',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(new Date());
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

const shouldRecommendSkillFirst = (message?: string): boolean => {
  const lowered = message?.trim().toLowerCase();
  if (!lowered) return false;

  const obviousDirectReadPatterns = [
    /\b(show|get|list|what are|what is|which)\b.*\b(tasks|task|meetings|calendar|events|emails|docs)\b/,
    /\bsearch\b.*\b(web|internet|online)\b/,
  ];
  if (obviousDirectReadPatterns.some((pattern) => pattern.test(lowered))) {
    return false;
  }

  const uncertainWorkflowSignals = [
    /\b(schedule|book|create|set up|setup|arrange)\b.*\b(meeting|event|calendar|invite)\b/,
    /\b(send|submit|share|follow up|follow-up|approve|approval|reconcile|prepare|draft)\b/,
    /\bzoho\b|\blark\b|\bgoogle\b/,
    /\bworkflow\b|\bprocess\b|\boperation\b/,
    /\bthen\b|\band then\b|\balso\b/,
  ];

  return uncertainWorkflowSignals.some((pattern) => pattern.test(lowered));
};

const isBareContinuationMessage = (message?: string): boolean => {
  const value = message?.trim().toLowerCase();
  if (!value) return false;
  return ['continue', 'go on', 'carry on', 'proceed', 'keep going', 'retry', 'try again'].includes(value);
};

const buildContinuationHint = (message?: string): string | null => {
  if (!isBareContinuationMessage(message)) return null;
  return 'The latest user message is a continuation request. Continue the latest active user-requested task in this conversation, and prefer the most recent topic over older abandoned work.';
};

const appendEventSafe = async (input: Parameters<typeof executionService.appendEvent>[0]) => {
  try {
    await executionService.appendEvent(input);
  } catch (error) {
    logger.warn('vercel.execution.event.failed', {
      executionId: input.executionId,
      eventType: input.eventType,
      error: error instanceof Error ? error.message : 'unknown_error',
    });
  }
};

const runInBackground = (label: string, task: () => Promise<void>): void => {
  queueMicrotask(() => {
    void task().catch((error) => {
      logger.warn('vercel.desktop.background_task.failed', {
        label,
        error: error instanceof Error ? error.message : 'unknown_error',
      });
    });
  });
};

const buildExecutionMetadata = (input: {
  state: DesktopExecutionState;
  executionId: string;
  contentBlocks?: PersistedContentBlock[];
  plan?: ExecutionPlan | null;
  citations?: Array<Record<string, unknown>>;
  conversationRefs?: PersistedConversationRefs | null;
  pendingApprovalAction?: PendingApprovalAction | null;
  desktopPendingAction?: DesktopWorkspaceAction | RemoteApprovalAction | null;
  workflowExecution?: Record<string, unknown>;
  resumeOfExecutionId?: string;
  taskStateSnapshot?: DesktopTaskState | null;
  threadSummarySnapshot?: DesktopThreadSummary | null;
  contextAssembly?: DesktopContextAssemblyMetrics | null;
}): Record<string, unknown> => ({
  executionId: input.executionId,
  ...(input.contentBlocks ? { contentBlocks: input.contentBlocks } : {}),
  ...(input.plan ? { plan: input.plan } : {}),
  ...(input.citations && input.citations.length > 0 ? { citations: input.citations } : {}),
  ...(input.conversationRefs ? { conversationRefs: input.conversationRefs } : {}),
  ...(input.workflowExecution ? { workflowExecution: input.workflowExecution } : {}),
  ...(input.taskStateSnapshot ? { taskStateSnapshot: input.taskStateSnapshot } : {}),
  ...(input.threadSummarySnapshot ? { threadSummarySnapshot: input.threadSummarySnapshot } : {}),
  ...(input.contextAssembly ? { contextAssembly: input.contextAssembly } : {}),
  executionState: {
    state: input.state,
    paused: input.state === 'waiting_for_approval',
    ...(input.resumeOfExecutionId ? { resumeOfExecutionId: input.resumeOfExecutionId } : {}),
  },
  ...(input.pendingApprovalAction ? { pendingApprovalAction: input.pendingApprovalAction } : {}),
  ...(input.desktopPendingAction ? { desktopPendingAction: input.desktopPendingAction } : {}),
});

const persistAssistantMessage = async (input: {
  threadId: string;
  userId: string;
  content: string;
  metadata: Record<string, unknown>;
  existingMessageId?: string;
}): Promise<Awaited<ReturnType<typeof desktopThreadsService.addMessage>>> =>
  desktopThreadsService.addOwnedThreadMessage(
    input.threadId,
    input.userId,
    'assistant',
    input.content,
    input.metadata,
    {
      requiredChannel: 'desktop',
      contextLimit: DESKTOP_THREAD_CONTEXT_MESSAGE_LIMIT,
      ...(input.existingMessageId ? { existingMessageId: input.existingMessageId } : {}),
    },
  );

const loadContinuationMessageState = async (input: {
  threadId: string;
  userId: string;
  messageId?: string;
}): Promise<{
  persistedBlocks: PersistedContentBlock[];
  plan: ExecutionPlan | null;
  taskState: DesktopTaskState;
  threadSummary: DesktopThreadSummary;
}> => {
  if (!input.messageId) {
    return {
      persistedBlocks: [],
      plan: null,
      taskState: createEmptyTaskState(),
      threadSummary: parseDesktopThreadSummary(null),
    };
  }

  const message = await desktopThreadsService.getOwnedThreadMessage(input.threadId, input.userId, input.messageId);
  const metadata = message.metadata && typeof message.metadata === 'object' && !Array.isArray(message.metadata)
    ? message.metadata as Record<string, unknown>
    : {};

  const rawBlocks = Array.isArray(metadata.contentBlocks) ? metadata.contentBlocks : [];
  const persistedBlocks = rawBlocks.flatMap((block) => {
    const record = block && typeof block === 'object' && !Array.isArray(block)
      ? block as Record<string, unknown>
      : null;
    if (!record || typeof record.type !== 'string') return [];
    if (record.type === 'text' && typeof record.content === 'string') {
      return [{ type: 'text', content: record.content } satisfies PersistedContentBlock];
    }
    if (record.type === 'thinking') {
      return [{ type: 'thinking', text: typeof record.text === 'string' ? record.text : undefined } satisfies PersistedContentBlock];
    }
    if (
      record.type === 'tool'
      && typeof record.id === 'string'
      && typeof record.name === 'string'
      && typeof record.label === 'string'
      && typeof record.icon === 'string'
      && (record.status === 'running' || record.status === 'done' || record.status === 'failed')
    ) {
      return [{
        type: 'tool',
        id: record.id,
        name: record.name,
        label: record.label,
        icon: record.icon,
        status: record.status,
        resultSummary: typeof record.resultSummary === 'string' ? record.resultSummary : undefined,
      } satisfies PersistedContentBlock];
    }
    return [];
  });

  const plan = metadata.plan && typeof metadata.plan === 'object' && !Array.isArray(metadata.plan)
    ? executionPlanSchema.safeParse(metadata.plan).success
      ? executionPlanSchema.parse(metadata.plan)
      : null
    : null;

  return {
    persistedBlocks,
    plan,
    taskState: parseDesktopTaskState(metadata.taskStateSnapshot),
    threadSummary: parseDesktopThreadSummary(metadata.threadSummarySnapshot),
  };
};

const loadThreadMemory = async (threadId: string, userId: string): Promise<{
  summary: DesktopThreadSummary;
  taskState: DesktopTaskState;
}> => {
  const thread = await desktopThreadsService.getThreadMeta(threadId, userId);
  return {
    summary: parseDesktopThreadSummary((thread as Record<string, unknown>).summaryJson),
    taskState: parseDesktopTaskState((thread as Record<string, unknown>).taskStateJson),
  };
};

const persistThreadMemory = async (input: {
  threadId: string;
  userId: string;
  summary?: DesktopThreadSummary | null;
  taskState?: DesktopTaskState | null;
}): Promise<void> => {
  await desktopThreadsService.updateOwnedThreadMemory(input.threadId, input.userId, {
    ...(input.summary !== undefined ? { summaryJson: input.summary ? input.summary as unknown as Record<string, unknown> : null } : {}),
    ...(input.taskState !== undefined ? { taskStateJson: input.taskState ? input.taskState as unknown as Record<string, unknown> : null } : {}),
  });
};

const persistUiEvent = async (
  executionId: string,
  type: 'thinking' | 'thinking_token' | 'activity' | 'activity_done' | 'action' | 'text' | 'done' | 'error' | 'plan',
  data: unknown,
) => {
  const phase = type === 'thinking' || type === 'thinking_token'
    ? 'planning'
    : type === 'plan'
      ? 'planning'
    : type === 'action'
      ? 'control'
    : type === 'text' || type === 'done'
      ? 'delivery'
      : type === 'error'
        ? 'error'
        : 'tool';

  await appendEventSafe({
    executionId,
    phase,
    eventType: `ui.${type}`,
    actorType: type === 'text' || type === 'done'
      ? 'delivery'
      : type === 'thinking' || type === 'thinking_token'
        ? 'model'
        : type === 'plan'
          ? 'planner'
          : type === 'error' || type === 'action'
            ? 'system'
            : 'tool',
    actorKey: type === 'plan' ? 'planner' : 'vercel',
    title: `UI event: ${type}`,
    summary: summarizeText(typeof data === 'string' ? data : JSON.stringify(data), 600),
    status: type === 'error' ? 'failed' : type === 'activity' ? 'running' : type === 'action' ? 'pending' : type === 'plan' ? 'running' : 'done',
    payload: typeof data === 'object' && data !== null && !Array.isArray(data)
      ? data as Record<string, unknown>
      : { value: data as unknown },
  });
};

const startRun = async (input: {
  executionId: string;
  threadId: string;
  messageId: string;
  entrypoint: 'desktop_send' | 'desktop_act' | 'desktop_scheduled_workflow';
  session: MemberSessionDTO;
  mode: 'fast' | 'high' | 'xtreme';
  message: string;
}) => {
  await executionService.startRun({
    id: input.executionId,
    companyId: input.session.companyId,
    userId: input.session.userId,
    channel: 'desktop',
    entrypoint: input.entrypoint,
    requestId: input.executionId,
    threadId: input.threadId,
    chatId: input.threadId,
    messageId: input.messageId,
    mode: input.mode,
    agentTarget: 'vercel',
    latestSummary: summarizeText(input.message),
  });
};

const completeRun = async (executionId: string, summary: string) => {
  await executionService.completeRun({
    executionId,
    latestSummary: summarizeText(summary, 400),
  });
};

const failRun = async (executionId: string, errorMessage: string) => {
  await executionService.failRun({
    executionId,
    latestSummary: summarizeText(errorMessage, 400),
    errorCode: 'vercel_runtime_failed',
    errorMessage,
  });
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

const buildConversationRefsContext = (conversationKey: string): string | null => {
  const latestDoc = conversationMemoryStore.getLatestLarkDoc(conversationKey);
  const latestEvent = conversationMemoryStore.getLatestLarkCalendarEvent(conversationKey);
  const latestTask = conversationMemoryStore.getLatestLarkTask(conversationKey);
  const lines: string[] = [];

  if (latestTask) {
    lines.push(`Latest Lark task: ${latestTask.summary ?? latestTask.taskId} [taskId=${latestTask.taskId}${latestTask.taskGuid ? `, taskGuid=${latestTask.taskGuid}` : ''}${latestTask.status ? `, status=${latestTask.status}` : ''}]`);
  }
  if (latestDoc) {
    lines.push(`Latest Lark doc: ${latestDoc.title} [documentId=${latestDoc.documentId}]`);
  }
  if (latestEvent) {
    lines.push(`Latest Lark event: ${latestEvent.summary ?? latestEvent.eventId} [eventId=${latestEvent.eventId}]`);
  }

  return lines.length > 0 ? ['Conversation refs:', ...lines].join('\n') : null;
};

const hydrateConversationState = async (
  threadId: string,
  session: MemberSessionDTO,
): Promise<ThreadHistorySnapshot> => {
  const history = await desktopThreadContextCache.getOrLoad({
    threadId,
    userId: session.userId,
    loader: async () => {
      const loaded = await desktopThreadsService.getThreadContext(threadId, session.userId);
      return {
        threadId,
        userId: session.userId,
        messages: loaded.messages.map((message) => ({
          id: message.id,
          role: message.role,
          content: message.content,
          metadata: message.metadata && typeof message.metadata === 'object' && !Array.isArray(message.metadata)
            ? message.metadata as Record<string, unknown>
            : undefined,
        })),
        cachedAt: new Date().toISOString(),
      };
    },
  });
  const conversationKey = buildConversationKey(threadId);

  for (const message of history.messages.slice(-20)) {
    if (message.role === 'user') {
      conversationMemoryStore.addUserMessage(conversationKey, message.id, message.content);
    } else {
      conversationMemoryStore.addAssistantMessage(conversationKey, message.id, message.content);
      if (message.metadata && typeof message.metadata === 'object' && !Array.isArray(message.metadata)) {
        hydrateConversationRefsFromMetadata(conversationKey, message.metadata as Record<string, unknown>);
      }
    }
  }

  return history;
};

const appendMessageToHistory = (
  history: ThreadHistorySnapshot,
  message: CachedDesktopThreadMessage,
): ThreadHistorySnapshot => ({
  ...history,
  cachedAt: new Date().toISOString(),
  messages: [...history.messages.filter((entry) => entry.id !== message.id), message].slice(-DESKTOP_THREAD_CONTEXT_MESSAGE_LIMIT),
});

const readAttachedFilesFromMetadata = (metadata: unknown): AttachedFileRef[] => {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return [];
  const attachedFiles = (metadata as Record<string, unknown>).attachedFiles;
  if (!Array.isArray(attachedFiles)) return [];
  return attachedFiles.flatMap((entry) => {
    const parsed = attachedFileSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
};

const collectRecentAttachedFiles = (history: ThreadHistorySnapshot): AttachedFileRef[] => {
  const merged = new Map<string, AttachedFileRef>();
  for (const message of history.messages.slice(-8)) {
    const files = readAttachedFilesFromMetadata(message.metadata);
    for (const file of files) {
      if (!merged.has(file.fileAssetId)) {
        merged.set(file.fileAssetId, file);
      }
    }
  }
  return Array.from(merged.values());
};

const hydrateAttachedFilesForArtifacts = async (input: {
  companyId: string;
  artifacts: Array<{ fileAssetId: string }>;
}): Promise<AttachedFileRef[]> => {
  if (input.artifacts.length === 0) {
    return [];
  }

  const fileAssetIds = input.artifacts.map((artifact) => artifact.fileAssetId);
  const assets = await prisma.fileAsset.findMany({
    where: {
      companyId: input.companyId,
      id: { in: fileAssetIds },
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
    if (!asset) return [];
    return [{
      fileAssetId: asset.id,
      fileName: asset.fileName,
      mimeType: asset.mimeType,
      cloudinaryUrl: asset.cloudinaryUrl,
    }];
  });
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

const resolveDesktopGroundingAttachments = async (input: {
  companyId: string;
  message?: string;
  currentAttachedFiles: AttachedFileRef[];
  recentAttachedFiles: AttachedFileRef[];
  taskState: DesktopTaskState;
}): Promise<{
  attachments: AttachedFileRef[];
  taskState: DesktopTaskState;
  source: 'current' | 'artifact' | 'recent' | 'none';
}> => {
  let nextTaskState = input.taskState;

  if (input.currentAttachedFiles.length > 0) {
    nextTaskState = upsertDesktopSourceArtifacts({
      taskState: nextTaskState,
      artifacts: buildSourceArtifactEntriesFromAttachments(input.currentAttachedFiles),
    });
  }

  const artifactCandidates = input.currentAttachedFiles.length === 0
    ? selectDesktopSourceArtifacts({
      taskState: nextTaskState,
      message: input.message,
    })
    : [];

  const artifactAttachments = artifactCandidates.length > 0
    ? await hydrateAttachedFilesForArtifacts({
      companyId: input.companyId,
      artifacts: artifactCandidates,
    })
    : [];

  if (artifactCandidates.length > 0) {
    logger.info('desktop.source_artifacts.selected', {
      companyId: input.companyId,
      requestedMessage: summarizeText(input.message, 180),
      candidates: artifactCandidates.map((artifact) => ({
        fileAssetId: artifact.fileAssetId,
        fileName: artifact.fileName,
      })),
      hydratedCount: artifactAttachments.length,
    });
  }

  if (artifactAttachments.length > 0) {
    nextTaskState = markDesktopSourceArtifactsUsed({
      taskState: nextTaskState,
      fileAssetIds: artifactAttachments.map((file) => file.fileAssetId),
    });
  } else if (artifactCandidates.length > 0) {
    logger.warn('desktop.source_artifacts.no_usable_files', {
      companyId: input.companyId,
      requestedMessage: summarizeText(input.message, 180),
      fileAssetIds: artifactCandidates.map((artifact) => artifact.fileAssetId),
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
  for (const file of input.recentAttachedFiles) {
    if (!merged.has(file.fileAssetId)) {
      merged.set(file.fileAssetId, file);
    }
  }

  const attachments = Array.from(merged.values());
  return {
    attachments,
    taskState: nextTaskState,
    source: input.currentAttachedFiles.length > 0
      ? 'current'
      : artifactAttachments.length > 0
        ? 'artifact'
        : input.recentAttachedFiles.length > 0
          ? 'recent'
          : 'none',
  };
};

const maybeStoreConversationTurn = (input: {
  companyId: string;
  userId: string;
  threadId: string;
  sourceId: string;
  role: 'user' | 'assistant';
  text: string;
}): void => {
  if (!input.text.trim()) {
    return;
  }
  runInBackground(`personal-vector-store:${input.sourceId}`, async () => {
    await personalVectorMemoryService.storeChatTurn({
      companyId: input.companyId,
      requesterUserId: input.userId,
      conversationKey: buildConversationKey(input.threadId),
      sourceId: input.sourceId,
      role: input.role,
      text: input.text,
      channel: 'desktop',
      chatId: input.threadId,
    });
  });
};

const queryConversationMemoryWithFallback = async (input: {
  companyId: string;
  userId: string;
  threadId: string;
  queryText: string;
  limit: number;
  isMemoryQuestion: boolean;
  logPrefix: 'desktop.context.conversation_retrieval' | 'vercel.child_router.retrieval';
}): Promise<{
  matches: PersonalMemoryMatch[];
  scope: 'conversation' | 'global_personal';
}> => {
  const scopedMatches = await personalVectorMemoryService.query({
    companyId: input.companyId,
    requesterUserId: input.userId,
    conversationKey: buildConversationKey(input.threadId),
    text: input.isMemoryQuestion ? expandConversationMemoryQuery(input.queryText) : input.queryText,
    limit: input.limit,
  });
  if (scopedMatches.length > 0 || !input.isMemoryQuestion) {
    return {
      matches: scopedMatches,
      scope: 'conversation',
    };
  }

  logger.info(`${input.logPrefix}.global_fallback.start`, {
    threadId: input.threadId,
    queryLength: input.queryText.trim().length,
    limit: input.limit,
  });

  const globalMatches = await personalVectorMemoryService.query({
    companyId: input.companyId,
    requesterUserId: input.userId,
    text: expandConversationMemoryQuery(input.queryText),
    limit: input.limit,
  });

  logger.info(`${input.logPrefix}.global_fallback.completed`, {
    threadId: input.threadId,
    matchCount: globalMatches.length,
  });

  return {
    matches: globalMatches,
    scope: 'global_personal',
  };
};

const retrieveConversationMemory = async (input: {
  companyId: string;
  userId: string;
  threadId: string;
  queryText: string;
  contextClass: DesktopContextClass;
  threadSummary: DesktopThreadSummary;
  taskState: DesktopTaskState;
}): Promise<string[]> => {
  const isMemoryQuestion = isPersonalMemoryQuestion(input.queryText);
  if (
    (input.contextClass === 'lightweight_chat' && !isMemoryQuestion)
    || !input.queryText.trim()
    || (!isReferentialFollowup(input.queryText)
      && !isMemoryQuestion
      && input.contextClass !== 'long_running_task'
      && input.contextClass !== 'document_grounded_followup')
  ) {
    return [];
  }

  const limit = isMemoryQuestion ? 6 : input.contextClass === 'document_grounded_followup' ? 6 : 4;
  try {
    logger.info('desktop.context.conversation_retrieval.start', {
      threadId: input.threadId,
      contextClass: input.contextClass,
      isMemoryQuestion,
      queryLength: input.queryText.trim().length,
      limit,
    });
    const { matches, scope } = await queryConversationMemoryWithFallback({
      companyId: input.companyId,
      userId: input.userId,
      threadId: input.threadId,
      queryText: input.queryText,
      limit,
      isMemoryQuestion,
      logPrefix: 'desktop.context.conversation_retrieval',
    });
    const snippets = dedupeConversationSnippets({
      snippets: summarizeConversationMatches(matches, limit),
      threadSummary: input.threadSummary,
      taskState: input.taskState,
    });
    logger.info('desktop.context.conversation_retrieval.completed', {
      threadId: input.threadId,
      contextClass: input.contextClass,
      isMemoryQuestion,
      scope,
      matchCount: matches.length,
      snippetCount: snippets.length,
    });
    return snippets;
  } catch (error) {
    logger.warn('desktop.context.conversation_retrieval.failed', {
      threadId: input.threadId,
      error: error instanceof Error ? error.message : 'unknown',
    });
    return [];
  }
};

const mapHistoryToMessages = async (
  threadId: string,
  session: MemberSessionDTO,
): Promise<{ messages: ModelMessage[]; history: ThreadHistorySnapshot }> => {
  const history = await hydrateConversationState(threadId, session);
  const messages = mapHistorySnapshotToMessages(history, { limit: MODEL_HISTORY_MESSAGE_LIMIT });
  return { messages, history };
};

const mapHistorySnapshotToMessages = (
  history: ThreadHistorySnapshot,
  options?: { limit?: number; lowValueFilter?: boolean },
): ModelMessage[] => {
  const limit = options?.limit ?? MODEL_HISTORY_MESSAGE_LIMIT;
  const lowValueFilter = options?.lowValueFilter ?? false;
  const selected = lowValueFilter
    ? history.messages.filter((message) => !isLightweightChatTurn(message.content)).slice(-limit)
    : history.messages.slice(-limit);
  const messages: ModelMessage[] = [];
  for (const message of selected) {
    messages.push({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: message.content,
    });
  }
  return messages;
};

const chooseDesktopContextClass = (input: {
  latestUserMessage?: string;
  taskState: DesktopTaskState;
  threadSummary: DesktopThreadSummary;
  history: ThreadHistorySnapshot;
}): DesktopContextClass => {
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
    || input.history.messages.length >= 16
  ) {
    return 'long_running_task';
  }
  return 'normal_work';
};

const getDesktopContextBudget = (input: {
  resolvedModel: { effectiveProvider: string; effectiveModelId: string };
  contextClass: DesktopContextClass;
}): { usableContextBudget: number; targetContextBudget: number; modelId: string } => {
  const catalogEntry = resolveModelCatalogEntry(input.resolvedModel);
  const usableContextBudget = catalogEntry
    ? getTokenBudget(catalogEntry)
    : input.resolvedModel.effectiveProvider === 'google'
      ? 1_048_576 - 32_768
      : 128_000 - 16_384;
  const ratio = input.contextClass === 'lightweight_chat'
    ? DESKTOP_LIGHT_CONTEXT_TARGET_RATIO
    : input.contextClass === 'normal_work'
      ? DESKTOP_NORMAL_CONTEXT_TARGET_RATIO
      : DESKTOP_CONTEXT_TARGET_RATIO;
  return {
    usableContextBudget,
    targetContextBudget: Math.max(12_000, Math.floor(usableContextBudget * ratio)),
    modelId: input.resolvedModel.effectiveModelId,
  };
};

const summarizeConversationMatches = (
  matches: PersonalMemoryMatch[],
  maxCount: number,
): string[] =>
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

const buildAdaptiveHistoryMessages = (input: {
  history: ThreadHistorySnapshot;
  targetBudgetTokens: number;
  reservedTokens: number;
  contextClass: DesktopContextClass;
}): {
  messages: ModelMessage[];
  includedRawMessageCount: number;
  compactionTier: number;
} => {
  const maxMessages = input.contextClass === 'lightweight_chat'
    ? 8
    : input.contextClass === 'normal_work'
      ? 16
      : 32;
  const lowValueFilter = input.contextClass !== 'lightweight_chat';
  const selected: typeof input.history.messages = [];
  let used = 0;
  let compactionTier = 1;
  const recent = input.history.messages.slice(-40).filter((message) =>
    lowValueFilter ? !isLightweightChatTurn(message.content) : true,
  );

  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const message = recent[index]!;
    const estimated = estimateTokens(message.content);
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
    messages: selected.map((message) => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: message.content,
    })),
    includedRawMessageCount: selected.length,
    compactionTier,
  };
};

const logDesktopContextSummary = (input: DesktopContextAssemblyMetrics & {
  executionId: string;
  threadId: string;
}): void => {
  logger.info('desktop.context.summary', input);
};

const buildDesktopContextAssembly = async (input: {
  executionId: string;
  threadId: string;
  session: MemberSessionDTO;
  mode: 'fast' | 'high' | 'xtreme';
  latestUserMessage: string;
  history: ThreadHistorySnapshot;
  workspace?: { name: string; path: string };
  taskState: DesktopTaskState;
  threadSummary: DesktopThreadSummary;
  resolvedUserReferences: string[];
  routerAcknowledgement?: string;
  departmentName?: string;
  departmentRoleSlug?: string;
  departmentSystemPrompt?: string;
  departmentSkillsMarkdown?: string;
  dateScope?: string;
  latestActionResult?: { kind: string; ok: boolean; summary: string };
  activeAttachments: AttachedFileRef[];
}): Promise<{
  systemPrompt: string;
  historyMessages: ModelMessage[];
  contextClass: DesktopContextClass;
  conversationSnippets: string[];
  metrics: DesktopContextAssemblyMetrics;
}> => {
  const resolvedModel = await resolveVercelLanguageModel(input.mode);
  const contextClass = chooseDesktopContextClass({
    latestUserMessage: input.latestUserMessage,
    taskState: input.taskState,
    threadSummary: input.threadSummary,
    history: input.history,
  });
  const conversationSnippets = await retrieveConversationMemory({
    companyId: input.session.companyId,
    userId: input.session.userId,
    threadId: input.threadId,
    queryText: input.latestUserMessage,
    contextClass,
    threadSummary: input.threadSummary,
    taskState: input.taskState,
  });
  const systemPrompt = buildSystemPrompt({
    threadId: input.threadId,
    workspace: input.workspace,
    requesterName: input.session.name,
    requesterEmail: input.session.email,
    dateScope: input.dateScope,
    latestActionResult: input.latestActionResult,
    latestUserMessage: input.latestUserMessage,
    resolvedUserReferences: input.resolvedUserReferences,
    routerAcknowledgement: input.routerAcknowledgement,
    departmentName: input.departmentName,
    departmentRoleSlug: input.departmentRoleSlug,
    departmentSystemPrompt: input.departmentSystemPrompt,
    departmentSkillsMarkdown: input.departmentSkillsMarkdown,
    threadSummary: input.threadSummary,
    taskState: input.taskState,
    conversationRetrievalSnippets: conversationSnippets,
    contextClass,
    hasAttachedFiles: input.activeAttachments.length > 0,
  });
  const budget = getDesktopContextBudget({
    resolvedModel,
    contextClass,
  });
  const reservedTokens =
    estimateTokens(systemPrompt)
    + estimateTokens(input.latestUserMessage)
    + (input.activeAttachments.length > 0 ? 8_000 : 1_500);
  const historySelection = buildAdaptiveHistoryMessages({
    history: input.history,
    targetBudgetTokens: budget.targetContextBudget,
    reservedTokens,
    contextClass,
  });
  const historyMessages = historySelection.messages;
  const estimatedPromptTokens =
    estimateTokens(systemPrompt)
    + estimateMessageTokens(historyMessages)
    + estimateTokens(input.latestUserMessage);
  const usedContextBudgetPercent = Number(
    ((estimatedPromptTokens / Math.max(1, budget.usableContextBudget)) * 100).toFixed(2),
  );
  const metrics: DesktopContextAssemblyMetrics = {
    contextClass,
    modelId: budget.modelId,
    usableContextBudget: budget.usableContextBudget,
    targetContextBudget: budget.targetContextBudget,
    estimatedPromptTokens,
    usedContextBudgetPercent,
    includedRawMessageCount: historySelection.includedRawMessageCount,
    includedConversationRetrievalCount: conversationSnippets.length,
    includedSourceArtifactCount: input.activeAttachments.length,
    includedThreadSummary: input.threadSummary.sourceMessageCount > 0,
    includedTaskState:
      input.taskState.completedMutations.length > 0
      || input.taskState.activeSourceArtifacts.length > 0
      || Boolean(input.taskState.pendingApproval)
      || Boolean(input.taskState.activeObjective),
    includedWorkspaceContext: Boolean(input.workspace),
    compactionTier: Math.max(
      historySelection.compactionTier,
      conversationSnippets.length > 0 ? 3 : 1,
      (input.threadSummary.sourceMessageCount > 0 || Boolean(input.taskState.activeObjective)) ? 2 : 1,
      estimatedPromptTokens > budget.targetContextBudget ? 5 : 1,
    ),
  };

  logDesktopContextSummary({
    executionId: input.executionId,
    threadId: input.threadId,
    ...metrics,
  });

  return {
    systemPrompt,
    historyMessages,
    contextClass,
    conversationSnippets,
    metrics,
  };
};

const buildSystemPrompt = (input: {
  threadId: string;
  workspace?: { name: string; path: string };
  requesterName?: string;
  requesterEmail?: string;
  dateScope?: string;
  latestActionResult?: { kind: string; ok: boolean; summary: string };
  latestUserMessage?: string;
  resolvedUserReferences?: string[];
  routerAcknowledgement?: string;
  departmentName?: string;
  departmentRoleSlug?: string;
  departmentSystemPrompt?: string;
  departmentSkillsMarkdown?: string;
  threadSummary?: DesktopThreadSummary;
  taskState?: DesktopTaskState;
  conversationRetrievalSnippets?: string[];
  contextClass?: DesktopContextClass;
  hasAttachedFiles?: boolean;
}) => {
  const latestMessage = input.latestUserMessage?.trim() ?? '';
  const shouldPrioritizeInternalDocs = /\b(uploaded|upload|company doc|company docs|internal doc|internal docs|document|documents|file|files|csv|pdf|sheet|spreadsheet|assignment)\b/i.test(latestMessage);
  const retrievalGuidance = latestMessage
    ? retrievalOrchestratorService.buildPromptGuidance({
      messageText: latestMessage,
      hasAttachments: input.hasAttachedFiles,
    })
    : [];
  const parts = [
    'You are the Vercel AI SDK desktop runtime for a tool-using assistant.',
    'Use the available comprehensive tools directly.',
    'Do not refer to Mastra, LangGraph, workflows, or internal orchestration.',
    'Only claim actions and results that are confirmed by tool outputs.',
    'If a tool returns a pending approval action, treat that as the next required step instead of inventing completion.',
    'Prefer the coding tool for local workspace work and the repo tool only for remote GitHub repositories.',
    'For uploaded files or internal company documents, prioritize the internal document tools before any workspace, Google Drive, local filesystem, or remote repository search.',
    'Use internal indexed document search when you need retrieval or matching against company documents. Use OCR/direct uploaded-file reading when you need the exact uploaded file contents. Both of these internal document paths come before workspace, Drive, or repo inspection.',
    'Do not inspect the workspace, local filesystem, Google Drive, or remote repositories to find an uploaded/company document unless the internal document tools failed or the user explicitly asked for those other sources.',
    'For specialized or complex workflows, first search relevant skills with the skillSearch tool, read the chosen skill, and then proceed with the task.',
    'If the user asks about prior conversation facts, personal preferences, or things they told you before, first use thread context and retrieved conversation memory. Do not call business tools like Zoho, Lark Base, Google Drive, or coding just to answer a personal-memory question unless the user explicitly asks for those systems.',
    'When a local action result is available, use that result as the source of truth for the next step instead of repeating the same command or rereading the same file without a concrete reason.',
    'Do not repeat a successful local command, file read, or file write unless you explicitly need a different verification step or the user asked to retry.',
    'For coding: planCommand and runScriptPlan require an exact command. writeFilePlan requires the full target path and full file content in contentPlan.',
    'After an approved local action finishes, prefer verifyResult or the next logically required step over restarting the whole plan.',
  ];
  if (input.workspace) {
    parts.push(
      `Open workspace name: ${input.workspace.name}.`,
      `Open workspace root: ${input.workspace.path}.`,
      'References like "this repo" or "this workspace" refer to that local root.',
    );
  }
  if (shouldPrioritizeInternalDocs) {
    parts.push(
      'Document retrieval priority for this request:',
      '1. Use the internal document tools first: indexed company-document search and OCR/direct uploaded-file reading.',
      '2. Choose indexed search for retrieval/matching and OCR/direct file reading for exact file extraction when needed.',
      '3. Only after those internal document paths fail, consider workspace files, Google Drive, or repo sources, unless the user explicitly asked for those sources.',
    );
  }
  if ((input.taskState?.activeSourceArtifacts.length ?? 0) > 0) {
    parts.push(
      'This thread has active source artifacts from uploaded/company documents.',
      'For follow-up requests like "next task", "continue", or "pick the next one", treat those source artifacts as the default grounding context.',
      'Do not search Google Drive, the workspace, local filesystem, or remote repos for a previously uploaded/company file unless artifact retrieval produced no relevant match or the user explicitly asked for those sources.',
    );
  }
  if (input.contextClass) {
    parts.push(`Context assembly class: ${input.contextClass}.`);
  }
  if (retrievalGuidance.length > 0) {
    parts.push('Retrieval portfolio guidance for this request:', ...retrievalGuidance);
  }
  parts.push(`Local date context: ${getLocalDateContext()} (${LOCAL_TIME_ZONE}).`);
  parts.push(`Current local date/time: ${getLocalDateTimeContext()} (${LOCAL_TIME_ZONE}).`);
  const requesterContext = buildRequesterIdentityContext({
    requesterName: input.requesterName,
    requesterEmail: input.requesterEmail,
  });
  if (requesterContext) {
    parts.push(requesterContext);
  }
  if (input.dateScope) {
    parts.push(`Inferred date scope: ${input.dateScope}.`);
  }
  if (input.departmentName) {
    parts.push(`Active department: ${input.departmentName}.`);
  }
  if (input.departmentRoleSlug) {
    parts.push(`Requester department role: ${input.departmentRoleSlug}.`);
  }
  if (input.departmentSystemPrompt?.trim()) {
    parts.push('Department instructions:', input.departmentSystemPrompt.trim());
  }
  if (input.departmentSkillsMarkdown?.trim()) {
    parts.push('Legacy department skills fallback context (use skillSearch for the structured skill flow first):', input.departmentSkillsMarkdown.trim());
  }
  if (shouldRecommendSkillFirst(input.latestUserMessage)) {
    parts.push(
      'Skill-first routing is recommended for this request.',
      'If the correct operational tool path is not obvious, first call skillSearch.searchSkills with a precise workflow query.',
      'If a relevant skill appears, immediately call skillSearch.readSkill and use that skill as the guide for choosing the real tool.',
      'Do not guess a workflow/tool route when a skill can clarify it.',
      'Once a relevant skill is loaded in this turn, do not keep re-searching skills unless the first one is clearly irrelevant.',
    );
  }
  const conversationRefsContext = buildConversationRefsContext(buildConversationKey(input.threadId));
  if (conversationRefsContext) {
    parts.push(conversationRefsContext);
  }
  const threadSummaryContext = input.threadSummary ? buildThreadSummaryContext(input.threadSummary) : null;
  if (threadSummaryContext) {
    parts.push(threadSummaryContext);
  }
  const taskStateContext = input.taskState ? buildTaskStateContext(input.taskState) : null;
  if (taskStateContext) {
    parts.push(taskStateContext);
  }
  if (input.resolvedUserReferences && input.resolvedUserReferences.length > 0) {
    parts.push(
      'Deterministic reference resolution:',
      ...input.resolvedUserReferences.map((entry) => `- ${entry}`),
      'Use these resolved identifiers as the source of truth unless the user explicitly asks to refresh from the system of record.',
    );
  }
  if (input.conversationRetrievalSnippets && input.conversationRetrievalSnippets.length > 0) {
    parts.push(
      'Retrieved conversation memory:',
      ...input.conversationRetrievalSnippets.map((entry) => `- ${entry}`),
    );
  }
  if (input.latestActionResult) {
    parts.push(
      'Latest approved local action result:',
      `- kind: ${input.latestActionResult.kind}`,
      `- ok: ${String(input.latestActionResult.ok)}`,
      `- summary: ${input.latestActionResult.summary}`,
      input.latestActionResult.ok
        ? '- guidance: do not repeat this same action unless a new verification or different follow-up step is necessary.'
        : '- guidance: adapt to the failure details above; do not blindly retry the identical step unless the error indicates a transient issue.',
    );
  }
  const continuationHint = buildContinuationHint(input.latestUserMessage);
  if (continuationHint) {
    parts.push(continuationHint);
  }
  if (input.routerAcknowledgement?.trim()) {
    parts.push(
      `The user has already seen this short intake acknowledgement: "${input.routerAcknowledgement.trim()}"`,
      'Do not repeat that acknowledgement verbatim. Continue from it and focus on execution.',
    );
  }
  parts.push(`Conversation key: ${buildConversationKey(input.threadId)}.`);
  return parts.join('\n');
};

const resolveDepartmentRuntime = async (
  session: MemberSessionDTO,
  threadId: string,
  fallbackAllowedToolIds: string[],
): Promise<{
  threadDepartmentId?: string;
  threadDepartmentName?: string;
  threadDepartmentSlug?: string;
  allowedToolIds: string[];
  allowedActionsByTool?: Record<string, import('../../company/tools/tool-action-groups').ToolActionGroup[]>;
  departmentName?: string;
  departmentRoleSlug?: string;
  departmentSystemPrompt?: string;
  departmentSkillsMarkdown?: string;
}> => {
  const threadSnapshot = await desktopThreadsService.getThread(threadId, session.userId);
  const pinnedDepartment = threadSnapshot.thread?.department;
  const pinnedDepartmentId = threadSnapshot.thread?.departmentId ?? session.resolvedDepartmentId;

  const resolved = await departmentService.resolveRuntimeContext({
    userId: session.userId,
    companyId: session.companyId,
    departmentId: pinnedDepartmentId,
    fallbackAllowedToolIds,
  });

  return {
    threadDepartmentId: resolved.departmentId ?? pinnedDepartmentId ?? undefined,
    threadDepartmentName: resolved.departmentName ?? pinnedDepartment?.name ?? session.resolvedDepartmentName,
    threadDepartmentSlug: pinnedDepartment?.slug ?? undefined,
    allowedToolIds: resolved.allowedToolIds,
    allowedActionsByTool: resolved.allowedActionsByTool,
    departmentName: resolved.departmentName,
    departmentRoleSlug: resolved.departmentRoleSlug,
    departmentSystemPrompt: resolved.systemPrompt,
    departmentSkillsMarkdown: resolved.skillsMarkdown,
  };
};

const mapPendingApprovalAction = (action: PendingApprovalAction): DesktopWorkspaceAction | RemoteApprovalAction => {
  switch (action.kind) {
    case 'run_command':
      return { kind: 'run_command', command: action.command };
    case 'write_file':
      return { kind: 'write_file', path: action.path, content: action.content };
    case 'create_directory':
      return { kind: 'mkdir', path: action.path };
    case 'delete_path':
      return { kind: 'delete_path', path: action.path };
    case 'tool_action':
      return {
        kind: 'tool_action',
        approvalId: action.approvalId,
        toolId: action.toolId,
        actionGroup: action.actionGroup,
        operation: action.operation,
        title: action.title,
        summary: action.summary,
        subject: action.subject,
        explanation: action.explanation,
      };
  }
};

const appendTextBlock = (blocks: PersistedContentBlock[], chunk: string): PersistedContentBlock[] => {
  const next = [...blocks];
  const last = next[next.length - 1];
  if (last?.type === 'text') {
    last.content += chunk;
    return next;
  }
  next.push({ type: 'text', content: chunk });
  return next;
};

const ensureThinkingBlock = (blocks: PersistedContentBlock[]): PersistedContentBlock[] => {
  const last = blocks[blocks.length - 1];
  if (last?.type === 'thinking') {
    return blocks;
  }
  return [...blocks, { type: 'thinking', text: '' }];
};

const appendThinkingBlock = (blocks: PersistedContentBlock[], chunk: string): PersistedContentBlock[] => {
  const next = ensureThinkingBlock(blocks).slice();
  const last = next[next.length - 1];
  if (last?.type === 'thinking') {
    last.text = `${last.text ?? ''}${chunk}`;
  }
  return next;
};

const findPendingApproval = (steps: Array<{ toolResults?: Array<{ output: unknown }> }>): PendingApprovalAction | null => {
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

const resolveTargetKey = async (mode: 'fast' | 'high' | 'xtreme') => resolveVercelLanguageModel(mode);

const generateExecutionPlan = async (input: {
  message: string;
  workspace?: { name: string; path: string };
}): Promise<ExecutionPlan | null> => {
  if (!shouldPlanDesktopTask(input.message)) {
    return null;
  }

  const plannerModel = await resolveVercelLanguageModel('fast');
  const result = await generateText({
    model: plannerModel.model,
    system: 'Return JSON only.',
    prompt: buildDesktopPlannerPrompt(input),
    temperature: 0,
    providerOptions: {
      google: {
        thinkingConfig: {
          includeThoughts: false,
          thinkingLevel: 'minimal',
        },
      },
    },
  }).catch(() => null);

  const raw = result?.text?.trim();
  if (!raw) {
    return null;
  }

  try {
    const parsed = plannerDraftSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      return null;
    }
    return initializeExecutionPlan(parsed.data);
  } catch {
    return null;
  }
};

const logAndPersistPlan = async (input: {
  executionId: string;
  threadId: string;
  plan: ExecutionPlan;
  eventType: 'plan.created' | 'plan.updated' | 'plan.completed' | 'plan.failed';
  emitSse?: (plan: ExecutionPlan) => void;
  queueUiPlan?: (plan: ExecutionPlan) => void;
}) => {
  logger.info('vercel.plan.state', {
    executionId: input.executionId,
    threadId: input.threadId,
    eventType: input.eventType,
    status: input.plan.status,
    plan: formatExecutionPlanForLog(input.plan),
  });
  await appendEventSafe({
    executionId: input.executionId,
    phase: 'planning',
    eventType: input.eventType,
    actorType: 'planner',
    actorKey: 'planner',
    title: input.eventType.replace('.', ' '),
    summary: summarizeText(formatExecutionPlanForLog(input.plan), 1200),
    status: input.plan.status === 'failed' ? 'failed' : input.plan.status === 'completed' ? 'done' : 'running',
    payload: input.plan as unknown as Record<string, unknown>,
  });
  input.emitSse?.(input.plan);
  input.queueUiPlan?.(input.plan);
};

const runVercelLoop = async (input: {
  runtime: VercelRuntimeRequestContext;
  system: string;
  messages: ModelMessage[];
  onToolStart: (toolName: string, activityId: string, title: string) => Promise<void>;
  onToolFinish: (toolName: string, activityId: string, title: string, output: VercelToolEnvelope) => Promise<void>;
}) => {
  const resolvedModel = await resolveTargetKey(input.runtime.mode);
  const tools = createVercelDesktopTools(input.runtime, {
    onToolStart: async (toolName, activityId, title) => input.onToolStart(toolName, activityId, title),
    onToolFinish: async (toolName, activityId, title, output) => input.onToolFinish(toolName, activityId, title, output),
  });

  return generateText({
    model: resolvedModel.model,
    system: input.system,
    messages: input.messages,
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
    stopWhen: [stopOnPendingApproval, stepCountIs(DESKTOP_MAX_LOOP_STEPS)],
  });
};

const runVercelStreamLoop = async (input: {
  runtime: VercelRuntimeRequestContext;
  system: string;
  messages: ModelMessage[];
  onToolStart: (toolName: string, activityId: string, title: string) => Promise<void>;
  onToolFinish: (toolName: string, activityId: string, title: string, output: VercelToolEnvelope) => Promise<void>;
}) => {
  const resolvedModel = await resolveTargetKey(input.runtime.mode);
  const tools = createVercelDesktopTools(input.runtime, {
    onToolStart: async (toolName, activityId, title) => input.onToolStart(toolName, activityId, title),
    onToolFinish: async (toolName, activityId, title, output) => input.onToolFinish(toolName, activityId, title, output),
  });

  return streamText({
    model: resolvedModel.model,
    system: input.system,
    messages: input.messages,
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
    stopWhen: [stopOnPendingApproval, stepCountIs(DESKTOP_MAX_LOOP_STEPS)],
  });
};

export const executeAutomatedDesktopTurn = async (input: {
  session: MemberSessionDTO;
  threadId: string;
  prompt: string;
  mode?: 'fast' | 'high' | 'xtreme';
  executionId?: string;
  entrypoint?: 'desktop_scheduled_workflow';
  attachedFiles?: AttachedFileRef[];
  metadata?: Record<string, unknown>;
}): Promise<{
  executionId: string;
  text: string;
  pendingApproval: PendingApprovalAction | null;
  hadToolFailures: boolean;
  failedToolSummaries: string[];
  message: Awaited<ReturnType<typeof desktopThreadsService.addMessage>>;
}> => {
  const mode = input.mode ?? 'high';
  const executionId = input.executionId ?? randomUUID();
  const messageId = randomUUID();
  const requesterAiRole = input.session.aiRole ?? input.session.role;
  const fallbackAllowedToolIds = await toolPermissionService.getAllowedTools(input.session.companyId, requesterAiRole);
  const departmentRuntime = await resolveDepartmentRuntime(input.session, input.threadId, fallbackAllowedToolIds);

  await startRun({
    executionId,
    threadId: input.threadId,
    messageId,
    entrypoint: input.entrypoint ?? 'desktop_scheduled_workflow',
    session: input.session,
    mode,
    message: input.prompt,
  });

  await appendEventSafe({
    executionId,
    phase: 'request',
    eventType: 'execution.started',
    actorType: 'system',
    actorKey: 'vercel',
    title: 'Scheduled desktop workflow execution started',
    summary: summarizeText(input.prompt),
    status: 'running',
    payload: { threadId: input.threadId, mode },
  });
  logger.info('desktop.workflow.execution.start', {
    executionId,
    threadId: input.threadId,
    companyId: input.session.companyId,
    userId: input.session.userId,
    mode,
    authProvider: input.session.authProvider,
    promptPreview: summarizeText(input.prompt, 1200),
  });

  try {
    const threadMemory = await loadThreadMemory(input.threadId, input.session.userId);
    const resolvedUserContext = resolveDesktopTaskReferences(input.prompt, threadMemory.taskState);
    const runtime: VercelRuntimeRequestContext = {
      channel: 'desktop',
      threadId: input.threadId,
      chatId: input.threadId,
      executionId,
      companyId: input.session.companyId,
      userId: input.session.userId,
      requesterAiRole,
      requesterEmail: input.session.email ?? undefined,
      departmentId: departmentRuntime.threadDepartmentId,
      departmentName: departmentRuntime.departmentName,
      departmentRoleSlug: departmentRuntime.departmentRoleSlug,
      larkTenantKey: input.session.larkTenantKey ?? undefined,
      larkOpenId: input.session.larkOpenId ?? undefined,
      larkUserId: input.session.larkUserId ?? undefined,
      authProvider: input.session.authProvider,
      mode,
      dateScope: inferDateScope(resolvedUserContext.message),
      allowedToolIds: departmentRuntime.allowedToolIds,
      allowedActionsByTool: departmentRuntime.allowedActionsByTool,
      departmentSystemPrompt: departmentRuntime.departmentSystemPrompt,
      departmentSkillsMarkdown: departmentRuntime.departmentSkillsMarkdown,
    };
    logger.info('desktop.workflow.execution.runtime', {
      executionId,
      threadId: input.threadId,
      companyId: input.session.companyId,
      userId: input.session.userId,
      authProvider: input.session.authProvider,
      hasLarkTenantKey: Boolean(input.session.larkTenantKey),
      hasLarkOpenId: Boolean(input.session.larkOpenId),
      hasLarkUserId: Boolean(input.session.larkUserId),
      allowedToolCount: departmentRuntime.allowedToolIds.length,
    });

    let persistedBlocks: PersistedContentBlock[] = [];
    const { history } = await mapHistoryToMessages(input.threadId, input.session);
    const grounding = await resolveDesktopGroundingAttachments({
      companyId: input.session.companyId,
      message: resolvedUserContext.message,
      currentAttachedFiles: input.attachedFiles ?? [],
      recentAttachedFiles: collectRecentAttachedFiles(history),
      taskState: threadMemory.taskState,
    });
    const contextAssembly = await buildDesktopContextAssembly({
      executionId,
      threadId: input.threadId,
      session: input.session,
      mode,
      latestUserMessage: resolvedUserContext.message,
      history,
      taskState: grounding.taskState,
      threadSummary: threadMemory.summary,
      resolvedUserReferences: resolvedUserContext.resolvedReferences,
      departmentName: departmentRuntime.departmentName,
      departmentRoleSlug: departmentRuntime.departmentRoleSlug,
      departmentSystemPrompt: departmentRuntime.departmentSystemPrompt,
      departmentSkillsMarkdown: departmentRuntime.departmentSkillsMarkdown,
      dateScope: runtime.dateScope,
      activeAttachments: grounding.attachments,
    });
    const workflowMessages = [...contextAssembly.historyMessages, { role: 'user', content: resolvedUserContext.message }];
    logLlmContext({
      phase: 'workflow',
      executionId,
      threadId: input.threadId,
      systemPrompt: contextAssembly.systemPrompt,
      messages: workflowMessages,
      taskState: grounding.taskState,
      threadSummary: threadMemory.summary,
      resolvedUserReferences: resolvedUserContext.resolvedReferences,
    });
    let activeWorkflowMessages = workflowMessages;
    let continuationCount = 0;
    let result: Awaited<ReturnType<typeof runVercelLoop>>;
    let toolOutputs: VercelToolEnvelope[] = [];
    let failedToolOutputs: VercelToolEnvelope[] = [];
    let failedToolSummaries: string[] = [];
    let pendingApproval: PendingApprovalAction | null = null;
    let assistantText = '';

    while (true) {
      result = await runVercelLoop({
        runtime,
        system: contextAssembly.systemPrompt,
        messages: activeWorkflowMessages,
        onToolStart: async (toolName, activityId, title) => {
          logger.info('desktop.workflow.execution.tool.start', {
            executionId,
            threadId: input.threadId,
          toolName,
          activityId,
          title,
        });
        persistedBlocks = [
          ...persistedBlocks,
          { type: 'tool', id: activityId, name: toolName, label: title, icon: 'tool', status: 'running' },
        ];
        await appendEventSafe({
          executionId,
          phase: 'tool',
          eventType: 'tool.started',
          actorType: 'tool',
          actorKey: toolName,
          title,
          status: 'running',
        });
      },
        onToolFinish: async (toolName, activityId, title, output) => {
          logger.info('desktop.workflow.execution.tool.finish', {
            executionId,
            threadId: input.threadId,
          toolName,
          activityId,
          title,
          success: output.success,
          pendingApproval: output.pendingApprovalAction?.kind ?? null,
          summary: summarizeText(output.summary, 600),
        });
        persistedBlocks = persistedBlocks.map((block) =>
          block.type === 'tool' && block.id === activityId
            ? {
              ...block,
              name: toolName,
              label: title,
              icon: output.success ? 'tool' : 'x-circle',
              status: output.success ? 'done' : 'failed',
              resultSummary: output.summary,
            }
            : block,
        );
        await appendEventSafe({
          executionId,
          phase: output.pendingApprovalAction ? 'control' : 'tool',
          eventType: output.pendingApprovalAction ? 'control.requested' : 'tool.completed',
          actorType: output.pendingApprovalAction ? 'system' : 'tool',
          actorKey: toolName,
          title,
          summary: summarizeText(output.summary, 600),
          status: output.pendingApprovalAction ? 'pending' : output.success ? 'done' : 'failed',
          payload: {
            success: output.success,
            pendingApprovalAction: output.pendingApprovalAction ?? null,
          },
        });
        },
      });
      logger.info('desktop.workflow.execution.model.completed', {
        executionId,
        threadId: input.threadId,
        continuationCount,
        stepCount: Array.isArray(result.steps) ? result.steps.length : null,
        textPreview: summarizeText(result.text, 1200),
      });

      toolOutputs = (result.steps as Array<{ toolResults?: Array<{ output?: unknown }> }>).flatMap((step) =>
        (step.toolResults ?? [])
          .map((toolResult) => toolResult.output as VercelToolEnvelope | undefined)
          .filter((output): output is VercelToolEnvelope => Boolean(output)));
      failedToolOutputs = toolOutputs.filter((output) => output.success === false);
      failedToolSummaries = failedToolOutputs.map((output) => output.summary);
      pendingApproval = findPendingApproval(result.steps as Array<{ toolResults?: Array<{ output: unknown }> }>);
      assistantText = pendingApproval
        ? `Workflow execution blocked: ${pendingApproval.kind === 'tool_action' ? pendingApproval.summary : 'approval is required before the next step can continue.'}`
        : result.text.trim();

      const shouldAutoContinue = isWorkflowExecutionRequest(input.metadata)
        && !pendingApproval
        && failedToolOutputs.length === 0
        && continuationCount < WORKFLOW_AUTOCONTINUE_LIMIT
        && isWorkflowProgressOnlyResponse(assistantText);
      if (!shouldAutoContinue) {
        break;
      }

      continuationCount += 1;
      logger.info('desktop.workflow.execution.autocontinue', {
        executionId,
        threadId: input.threadId,
        continuationCount,
        toolCount: toolOutputs.length,
        assistantTextPreview: summarizeText(assistantText, 600),
      });
      activeWorkflowMessages = [
        ...activeWorkflowMessages,
        { role: 'assistant', content: assistantText },
        {
          role: 'user',
          content: buildWorkflowAutoContinuationMessage({
            assistantText,
            toolOutputs,
          }),
        },
      ];
    }

    persistedBlocks = appendTextBlock(persistedBlocks, assistantText);

    const citations = (result.steps as Array<{ toolResults?: Array<{ output?: unknown }> }>).flatMap((step) =>
      (step.toolResults ?? []).flatMap((toolResult) => {
        const output = toolResult.output as VercelToolEnvelope | undefined;
        return output?.citations ?? [];
      }));
    const conversationRefs = buildPersistedConversationRefs(buildConversationKey(input.threadId));
    const assistantMessage = await desktopThreadsService.addMessage(
      input.threadId,
      input.session.userId,
      'assistant',
      assistantText,
      {
        ...buildExecutionMetadata({
          state: pendingApproval ? 'waiting_for_approval' : 'completed',
          executionId,
          contentBlocks: persistedBlocks,
          citations: citations as Array<Record<string, unknown>>,
          conversationRefs,
          workflowExecution: input.metadata,
          pendingApprovalAction: pendingApproval ?? null,
          taskStateSnapshot: grounding.taskState,
          threadSummarySnapshot: threadMemory.summary,
          contextAssembly: contextAssembly.metrics,
        }),
      },
    );
    logger.info('desktop.workflow.execution.message.persisted', {
      executionId,
      threadId: input.threadId,
      assistantMessageId: assistantMessage.id,
      pendingApproval: Boolean(pendingApproval),
      hadToolFailures: failedToolOutputs.length > 0,
      assistantTextPreview: summarizeText(assistantText, 1200),
    });
    conversationMemoryStore.addAssistantMessage(buildConversationKey(input.threadId), assistantMessage.id, assistantText);
    maybeStoreConversationTurn({
      companyId: input.session.companyId,
      userId: input.session.userId,
      threadId: input.threadId,
      sourceId: assistantMessage.id,
      role: 'assistant',
      text: assistantText,
    });
    runInBackground(`workflow-record-token-usage:${executionId}`, async () => {
      await recordTokenUsage({
        userId: input.session.userId,
        companyId: input.session.companyId,
        channel: 'desktop',
        threadId: input.threadId,
        mode,
        agentTarget: 'desktop.workflow',
        systemPrompt: contextAssembly.systemPrompt,
        messages: workflowMessages,
        outputText: assistantText,
      });
    });

    await appendEventSafe({
      executionId,
      phase: pendingApproval ? 'control' : 'synthesis',
      eventType: pendingApproval ? 'control.requested' : 'synthesis.completed',
      actorType: pendingApproval ? 'system' : 'agent',
      actorKey: pendingApproval ? pendingApproval.kind : 'vercel',
      title: pendingApproval ? 'Approval requested' : 'Generated assistant response',
      summary: summarizeText(assistantText, 600),
      status: pendingApproval ? 'pending' : 'done',
    });

    if (pendingApproval) {
      await failRun(executionId, assistantText);
    } else {
      await completeRun(executionId, assistantText);
    }
    logger.info('desktop.workflow.execution.completed', {
      executionId,
      threadId: input.threadId,
      pendingApproval: Boolean(pendingApproval),
      hadToolFailures: failedToolOutputs.length > 0,
      assistantMessageId: assistantMessage.id,
    });

    return {
      executionId,
      text: assistantText,
      pendingApproval,
      hadToolFailures: failedToolOutputs.length > 0,
      failedToolSummaries,
      message: assistantMessage,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Scheduled desktop workflow execution failed';
    logger.error('desktop.workflow.execution.failed', {
      executionId,
      threadId: input.threadId,
      error: errorMessage,
    });
    await appendEventSafe({
      executionId,
      phase: 'error',
      eventType: 'execution.failed',
      actorType: 'system',
      actorKey: 'vercel',
      title: 'Scheduled desktop workflow execution failed',
      summary: summarizeText(errorMessage),
      status: 'failed',
    });
    await failRun(executionId, errorMessage);
    throw error;
  }
};

export class VercelDesktopEngine {
  async stream(req: Request, res: Response, session: MemberSessionDTO): Promise<void> {
    const threadId = req.params.threadId;
    const {
      message,
      attachedFiles,
      workspace,
      mode,
      executionId: requestedExecutionId,
      workflowInvocation,
    } = sendSchema.parse(req.body);
    const resolvedInvocation = workflowInvocation
      ? await resolveWorkflowInvocationMessage({
        companyId: session.companyId,
        userId: session.userId,
        workflowId: workflowInvocation.workflowId,
        workflowName: workflowInvocation.workflowName,
        overrideText: workflowInvocation.overrideText,
      })
      : null;
    const effectiveMessage = resolvedInvocation?.requestMessage ?? message;
    const storedUserMessage = resolvedInvocation?.storedUserMessage ?? message;
    const executionId = requestedExecutionId ?? randomUUID();
    const messageId = randomUUID();
    const requesterAiRole = session.aiRole ?? session.role;
    const fallbackAllowedToolIds = await toolPermissionService.getAllowedTools(session.companyId, requesterAiRole);
    const departmentRuntime = await resolveDepartmentRuntime(session, threadId, fallbackAllowedToolIds);
    const baseThreadMemory = await loadThreadMemory(threadId, session.userId);
    let activeThreadSummary = baseThreadMemory.summary;
    let activeTaskState = baseThreadMemory.taskState;
    if (attachedFiles.length > 0) {
      activeTaskState = upsertDesktopSourceArtifacts({
        taskState: activeTaskState,
        artifacts: buildSourceArtifactEntriesFromAttachments(attachedFiles),
      });
    }
    if ((storedUserMessage || effectiveMessage).trim()) {
      activeTaskState = {
        ...activeTaskState,
        activeObjective: summarizeText((storedUserMessage || effectiveMessage).trim(), 300),
        updatedAt: new Date().toISOString(),
      };
    }
    const resolvedUserContext = resolveDesktopTaskReferences(effectiveMessage, activeTaskState);
    const effectivePromptMessage = resolvedUserContext.message;

    await startRun({
      executionId,
      threadId,
      messageId,
      entrypoint: 'desktop_send',
      session,
      mode,
      message: effectivePromptMessage,
    });
    await appendEventSafe({
      executionId,
      phase: 'request',
      eventType: 'execution.started',
      actorType: 'system',
      actorKey: 'vercel',
      title: 'Vercel desktop execution started',
      summary: summarizeText(storedUserMessage || effectivePromptMessage),
      status: 'running',
      payload: { threadId, mode },
    });
    logger.info('vercel.stream.request.start', {
      executionId,
      threadId,
      mode,
      messagePreview: summarizeText(storedUserMessage || effectivePromptMessage, 200),
      attachedFileCount: attachedFiles.length,
    });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    try {
      let uiEventQueue = Promise.resolve();
      const queueUiEvent = (
        type: Parameters<typeof persistUiEvent>[1],
        data: Parameters<typeof persistUiEvent>[2],
      ): void => {
        uiEventQueue = uiEventQueue
          .then(() => persistUiEvent(executionId, type, data))
          .catch(() => undefined);
      };

      const preRouterHistory = await hydrateConversationState(threadId, session);
      const childRoute = await runDesktopChildRouter({
        executionId,
        threadId,
        message: effectivePromptMessage,
        workspace,
        companyId: session.companyId,
        userId: session.userId,
        requesterName: session.name,
        requesterEmail: session.email,
        history: preRouterHistory.messages.slice(-6).map((entry) => ({
          role: entry.role === 'assistant' ? 'assistant' : 'user',
          content: entry.content,
        })),
      });

      const userMessage = await desktopThreadsService.addMessage(
        threadId,
        session.userId,
        'user',
        storedUserMessage,
        {
          ...(attachedFiles.length > 0 ? { attachedFiles } : {}),
          ...(workflowInvocation ? { workflowInvocation } : {}),
        },
      );
      conversationMemoryStore.addUserMessage(buildConversationKey(threadId), messageId, storedUserMessage);
      maybeStoreConversationTurn({
        companyId: session.companyId,
        userId: session.userId,
        threadId,
        sourceId: userMessage.id,
        role: 'user',
        text: storedUserMessage,
      });
      const history = appendMessageToHistory(preRouterHistory, {
        id: userMessage.id,
        role: userMessage.role,
        content: userMessage.content,
        metadata: userMessage.metadata && typeof userMessage.metadata === 'object' && !Array.isArray(userMessage.metadata)
          ? userMessage.metadata as Record<string, unknown>
          : undefined,
      });

      if (childRoute.route === 'fast_reply' && childRoute.reply?.trim()) {
        const reply = childRoute.reply.trim();
        const childRouterPrompt = buildChildRouterPrompt({
          message: effectivePromptMessage,
          workspace,
          requesterName: session.name,
          requesterEmail: session.email,
          history: preRouterHistory.messages.slice(-6).map((entry) => ({
            role: entry.role === 'assistant' ? 'assistant' : 'user',
            content: entry.content,
          })),
        });
        logger.info('vercel.child_router.fast_reply', {
          executionId,
          threadId,
          reason: childRoute.reason ?? null,
          textPreview: summarizeText(reply, 200),
        });
        await streamChildText(res, reply, queueUiEvent);
        const assistantMessage = await desktopThreadsService.addMessage(
          threadId,
          session.userId,
          'assistant',
          reply,
          {
            executionId,
            childRoute: {
              route: childRoute.route,
              reason: childRoute.reason ?? null,
            },
          },
        );
        conversationMemoryStore.addAssistantMessage(buildConversationKey(threadId), assistantMessage.id, reply);
        maybeStoreConversationTurn({
          companyId: session.companyId,
          userId: session.userId,
          threadId,
          sourceId: assistantMessage.id,
          role: 'assistant',
          text: reply,
        });
        runInBackground(`child-router-fast-reply:${executionId}`, async () => {
          await recordTokenUsage({
            userId: session.userId,
            companyId: session.companyId,
            channel: 'desktop',
            threadId,
            mode: 'fast',
            agentTarget: 'desktop.child_router',
            systemPrompt: 'Desktop child router',
            messages: [{ role: 'user', content: childRouterPrompt }],
            outputText: reply,
          });
          await appendEventSafe({
            executionId,
            phase: 'delivery',
            eventType: 'child_router.fast_reply',
            actorType: 'agent',
            actorKey: 'child_router',
            title: 'Fast child reply delivered',
            summary: summarizeText(reply, 600),
            status: 'done',
          });
          await completeRun(executionId, reply);
          await uiEventQueue;
        });
        queueUiEvent('done', { executionId, pendingApproval: null, actionIssued: false, state: 'completed' });
        sendSseEvent(res, 'done', { message: assistantMessage, executionId, pendingApproval: null, actionIssued: false, state: 'completed' });
        res.end();
        return;
      }

      let persistedBlocks: PersistedContentBlock[] = [];
      const routerAcknowledgement = childRoute.route === 'handoff'
        ? childRoute.acknowledgement?.trim() || 'I’ll take this in steps and start working through it now.'
        : null;
      if (routerAcknowledgement) {
        logger.info('vercel.child_router.handoff', {
          executionId,
          threadId,
          reason: childRoute.reason ?? null,
          textPreview: summarizeText(routerAcknowledgement, 200),
        });
        const ackChunk = `${routerAcknowledgement}\n\n`;
        await streamChildText(res, ackChunk, queueUiEvent);
        persistedBlocks = appendTextBlock(persistedBlocks, ackChunk);
        await appendEventSafe({
          executionId,
          phase: 'planning',
          eventType: 'child_router.handoff',
          actorType: 'agent',
          actorKey: 'child_router',
          title: 'Child router handed off to main executor',
          summary: summarizeText(routerAcknowledgement, 600),
          status: 'done',
        });
      }
      let activePlan = await generateExecutionPlan({ message: effectivePromptMessage, workspace });
      const emitPlan = (plan: ExecutionPlan) => {
        sendSseEvent(res, 'plan', plan);
        queueUiEvent('plan', plan);
      };
      if (activePlan) {
        await logAndPersistPlan({
          executionId,
          threadId,
          plan: activePlan,
          eventType: 'plan.created',
          emitSse: emitPlan,
          queueUiPlan: undefined,
        });
      }

      const runtime: VercelRuntimeRequestContext = {
        channel: 'desktop',
        threadId,
        chatId: threadId,
        executionId,
        companyId: session.companyId,
        userId: session.userId,
        requesterAiRole,
        requesterEmail: session.email ?? undefined,
        departmentId: departmentRuntime.threadDepartmentId,
        departmentName: departmentRuntime.departmentName,
        departmentRoleSlug: departmentRuntime.departmentRoleSlug,
        larkTenantKey: session.larkTenantKey ?? undefined,
        larkOpenId: session.larkOpenId ?? undefined,
        larkUserId: session.larkUserId ?? undefined,
        authProvider: session.authProvider,
        mode,
        workspace,
        dateScope: inferDateScope(effectivePromptMessage),
        allowedActionsByTool: departmentRuntime.allowedActionsByTool,
        allowedToolIds: departmentRuntime.allowedToolIds,
        departmentSystemPrompt: departmentRuntime.departmentSystemPrompt,
        departmentSkillsMarkdown: departmentRuntime.departmentSkillsMarkdown,
      };
      const grounding = await resolveDesktopGroundingAttachments({
        companyId: session.companyId,
        message: effectivePromptMessage,
        currentAttachedFiles: attachedFiles,
        recentAttachedFiles: collectRecentAttachedFiles(history),
        taskState: activeTaskState,
      });
      activeTaskState = grounding.taskState;
      logger.info('desktop.source_artifacts.grounding', {
        executionId,
        threadId,
        source: grounding.source,
        attachmentCount: grounding.attachments.length,
        activeSourceArtifacts: activeTaskState.activeSourceArtifacts.map((artifact) => artifact.fileName),
      });
      const activeAttachments = grounding.attachments;
      const contextAssembly = await buildDesktopContextAssembly({
        executionId,
        threadId,
        session,
        mode,
        latestUserMessage: effectivePromptMessage,
        history,
        workspace,
        taskState: activeTaskState,
        threadSummary: activeThreadSummary,
        resolvedUserReferences: resolvedUserContext.resolvedReferences,
        routerAcknowledgement: routerAcknowledgement ?? undefined,
        departmentName: departmentRuntime.departmentName,
        departmentRoleSlug: departmentRuntime.departmentRoleSlug,
        departmentSystemPrompt: departmentRuntime.departmentSystemPrompt,
        departmentSkillsMarkdown: departmentRuntime.departmentSkillsMarkdown,
        dateScope: runtime.dateScope,
        activeAttachments,
      });

      let inputMessages = contextAssembly.historyMessages;
      if (activeAttachments.length > 0) {
        const visionParts = await buildVisionContent({
          userMessage: effectivePromptMessage,
          attachedFiles: activeAttachments,
          companyId: session.companyId,
          requesterUserId: session.userId,
          requesterAiRole,
        });
        inputMessages = [
          ...contextAssembly.historyMessages,
          { role: 'user', content: visionParts as ModelMessage['content'] },
        ];
      } else if (effectivePromptMessage.trim()) {
        inputMessages = [...contextAssembly.historyMessages, { role: 'user', content: effectivePromptMessage }];
      }

      logLlmContext({
        phase: 'send',
        executionId,
        threadId,
        systemPrompt: contextAssembly.systemPrompt,
        messages: inputMessages,
        workspace,
        taskState: activeTaskState,
        threadSummary: activeThreadSummary,
        resolvedUserReferences: resolvedUserContext.resolvedReferences,
      });

      const result = await runVercelStreamLoop({
        runtime,
        system: contextAssembly.systemPrompt,
        messages: inputMessages,
        onToolStart: async (toolName, activityId, title) => {
          const ownerAgent = resolvePlanOwnerFromToolName(toolName);
          if (activePlan && ownerAgent) {
            const nextPlan = ensurePlanTaskRunning(activePlan, ownerAgent);
            if (nextPlan !== activePlan) {
              activePlan = nextPlan;
              await logAndPersistPlan({
                executionId,
                threadId,
                plan: activePlan,
                eventType: 'plan.updated',
                emitSse: emitPlan,
              });
            }
          }
          logger.info('vercel.stream.tool.start', {
            executionId,
            threadId,
            toolName,
            activityId,
            title,
          });
          sendSseEvent(res, 'activity', {
            id: activityId,
            name: toolName,
            label: title,
            icon: 'tool',
          });
          queueUiEvent('activity', {
            id: activityId,
            name: toolName,
            label: title,
            icon: 'tool',
          });
          persistedBlocks = [
            ...persistedBlocks,
            { type: 'tool', id: activityId, name: toolName, label: title, icon: 'tool', status: 'running' },
          ];
          await appendEventSafe({
            executionId,
            phase: 'tool',
            eventType: 'tool.started',
            actorType: 'tool',
            actorKey: toolName,
            title,
            status: 'running',
          });
        },
        onToolFinish: async (toolName, activityId, title, output) => {
          activeTaskState = updateTaskStateFromToolEnvelope({
            taskState: activeTaskState,
            toolName,
            output,
            latestObjective: storedUserMessage || effectiveMessage,
          });
          const ownerAgent = resolvePlanOwnerFromToolName(toolName);
          if (activePlan && ownerAgent) {
            activePlan = updateExecutionPlanTask(activePlan, {
              ownerAgent,
              ok: output.success && !output.pendingApprovalAction,
              resultSummary: output.summary,
            });
            await logAndPersistPlan({
              executionId,
              threadId,
              plan: activePlan,
              eventType: activePlan.status === 'failed' ? 'plan.failed' : activePlan.status === 'completed' ? 'plan.completed' : 'plan.updated',
              emitSse: emitPlan,
            });
          }
          logger.info('vercel.stream.tool.finish', {
            executionId,
            threadId,
            toolName,
            activityId,
            title,
            success: output.success,
            summary: summarizeText(output.summary, 280),
            pendingApproval: output.pendingApprovalAction?.kind ?? null,
          });
          sendSseEvent(res, 'activity_done', {
            id: activityId,
            name: toolName,
            label: title,
            icon: output.success ? 'tool' : 'x-circle',
            resultSummary: output.summary,
          });
          queueUiEvent('activity_done', {
            id: activityId,
            name: toolName,
            label: title,
            icon: output.success ? 'tool' : 'x-circle',
            resultSummary: output.summary,
          });
          persistedBlocks = persistedBlocks.map((block) =>
            block.type === 'tool' && block.id === activityId
              ? {
                ...block,
                name: toolName,
                label: title,
                icon: output.success ? 'tool' : 'x-circle',
                status: output.success ? 'done' : 'failed',
                resultSummary: output.summary,
              }
              : block,
          );
          await appendEventSafe({
            executionId,
            phase: 'tool',
            eventType: 'tool.completed',
            actorType: 'tool',
            actorKey: toolName,
            title,
            summary: summarizeText(output.summary, 600),
            status: output.success ? 'done' : 'failed',
            payload: {
              success: output.success,
              pendingApprovalAction: output.pendingApprovalAction ?? null,
            },
          });
        },
      });

      let streamedText = '';
      let hasReasoningBlock = false;
      let reasoningDeltaCount = 0;
      let reasoningCharCount = 0;
      for await (const part of result.fullStream) {
        if (part.type === 'reasoning-start') {
          hasReasoningBlock = true;
          logger.info('vercel.stream.reasoning.start', {
            executionId,
            threadId,
          });
          sendSseEvent(res, 'thinking', { text: '' });
          queueUiEvent('thinking', { text: '' });
          persistedBlocks = ensureThinkingBlock(persistedBlocks);
          continue;
        }

        if (part.type === 'reasoning-delta') {
          if (!part.text) continue;
          if (!hasReasoningBlock) {
            hasReasoningBlock = true;
            logger.info('vercel.stream.reasoning.implicit_start', {
              executionId,
              threadId,
            });
            sendSseEvent(res, 'thinking', { text: '' });
            queueUiEvent('thinking', { text: '' });
            persistedBlocks = ensureThinkingBlock(persistedBlocks);
          }
          reasoningDeltaCount += 1;
          reasoningCharCount += part.text.length;
          logger.info('vercel.stream.reasoning.delta', {
            executionId,
            threadId,
            chars: part.text.length,
            deltaCount: reasoningDeltaCount,
            totalChars: reasoningCharCount,
          });
          sendSseEvent(res, 'thinking_token', part.text);
          queueUiEvent('thinking_token', part.text);
          persistedBlocks = appendThinkingBlock(persistedBlocks, part.text);
          continue;
        }

        if (part.type === 'reasoning-end') {
          logger.info('vercel.stream.reasoning.end', {
            executionId,
            threadId,
            deltaCount: reasoningDeltaCount,
            totalChars: reasoningCharCount,
          });
          continue;
        }

        if (part.type === 'text-delta') {
          if (!part.text) continue;
          streamedText += part.text;
          sendSseEvent(res, 'text', part.text);
          queueUiEvent('text', part.text);
          persistedBlocks = appendTextBlock(persistedBlocks, part.text);
        }
      }

      const steps = await result.steps;
      const pendingApproval = findPendingApproval(steps as Array<{ toolResults?: Array<{ output: unknown }> }>);
      const pendingAction = pendingApproval ? mapPendingApprovalAction(pendingApproval) : null;
      const combinedText = `${routerAcknowledgement ? `${routerAcknowledgement}\n\n` : ''}${streamedText.trim()}`.trim();
      const finalText = pendingApproval ? (routerAcknowledgement ?? '') : combinedText;
      const citations = (steps as Array<{ toolResults?: Array<{ output?: unknown }> }>).flatMap((step) =>
        (step.toolResults ?? []).flatMap((toolResult) => {
          const output = toolResult.output as VercelToolEnvelope | undefined;
          return output?.citations ?? [];
        }));

      logger.info('vercel.stream.reasoning.summary', {
        executionId,
        threadId,
        sawReasoning: hasReasoningBlock,
        deltaCount: reasoningDeltaCount,
        totalChars: reasoningCharCount,
      });
      const approvalSummary = pendingAction
        ? pendingAction.kind === 'run_command'
          ? pendingAction.command
          : pendingAction.kind === 'tool_action'
            ? pendingAction.summary
            : pendingAction.kind
        : pendingApproval?.kind ?? null;

      logger.info('vercel.stream.response.summary', {
        executionId,
        threadId,
        pendingApproval: pendingApproval?.kind ?? null,
        textChars: finalText.length,
        citations: citations.length,
        responsePreview: summarizeText(finalText || approvalSummary || '', 240),
      });

      if (pendingAction) {
        if (activePlan) {
          const completedPlan = completeExecutionPlan(activePlan, approvalSummary ?? 'Approval required to continue.');
          activePlan = completedPlan;
          await logAndPersistPlan({
            executionId,
            threadId,
            plan: activePlan,
            eventType: activePlan.status === 'completed' ? 'plan.completed' : 'plan.updated',
            emitSse: emitPlan,
          });
        }
        sendSseEvent(res, 'action', { action: pendingAction, executionId });
        queueUiEvent('action', { action: pendingAction, executionId });
      }

      const conversationRefs = buildPersistedConversationRefs(buildConversationKey(threadId));
      const assistantMessage = await persistAssistantMessage({
        threadId,
        userId: session.userId,
        content: finalText,
        metadata: buildExecutionMetadata({
          state: pendingApproval ? 'waiting_for_approval' : 'completed',
          executionId,
          contentBlocks: persistedBlocks,
          plan: activePlan,
          citations: citations as Array<Record<string, unknown>>,
          conversationRefs,
          pendingApprovalAction: pendingApproval ?? null,
          desktopPendingAction: pendingAction ?? null,
          taskStateSnapshot: activeTaskState,
          threadSummarySnapshot: activeThreadSummary,
          contextAssembly: contextAssembly.metrics,
        }),
      });
      conversationMemoryStore.addAssistantMessage(buildConversationKey(threadId), assistantMessage.id, finalText);
      maybeStoreConversationTurn({
        companyId: session.companyId,
        userId: session.userId,
        threadId,
        sourceId: assistantMessage.id,
        role: 'assistant',
        text: finalText || approvalSummary || '',
      });
      const updatedHistoryForSummary = appendMessageToHistory(history, {
        id: assistantMessage.id,
        role: assistantMessage.role,
        content: assistantMessage.content,
        metadata: assistantMessage.metadata && typeof assistantMessage.metadata === 'object' && !Array.isArray(assistantMessage.metadata)
          ? assistantMessage.metadata as Record<string, unknown>
          : undefined,
      });
      runInBackground(`persist-thread-memory:${executionId}`, async () => {
        const refreshedSummary = await refreshDesktopThreadSummary({
          messages: updatedHistoryForSummary.messages.map((entry) => ({
            role: entry.role,
            content: entry.content,
          })),
          taskState: activeTaskState,
          currentSummary: activeThreadSummary,
        });
        await persistThreadMemory({
          threadId,
          userId: session.userId,
          summary: refreshedSummary,
          taskState: activeTaskState,
        });
      });
      runInBackground(`record-token-usage:${executionId}`, async () => {
        await recordTokenUsage({
        userId: session.userId,
        companyId: session.companyId,
        channel: 'desktop',
        threadId,
        mode,
        agentTarget: 'desktop.vercel',
        systemPrompt: contextAssembly.systemPrompt,
        messages: inputMessages,
        outputText: finalText || approvalSummary || '',
        });
      });

      runInBackground(`stream-finish:${executionId}`, async () => {
        await appendEventSafe({
        executionId,
        phase: pendingApproval ? 'control' : 'synthesis',
        eventType: pendingApproval ? 'control.requested' : 'synthesis.completed',
        actorType: pendingApproval ? 'system' : 'agent',
        actorKey: pendingApproval ? pendingApproval.kind : 'vercel',
        title: pendingApproval ? 'Approval requested' : 'Generated assistant response',
        summary: summarizeText(finalText || approvalSummary || 'Approval requested', 600),
        status: pendingApproval ? 'pending' : 'done',
        });

        if (!pendingApproval) {
          if (activePlan) {
            activePlan = completeExecutionPlan(activePlan, finalText);
            await logAndPersistPlan({
              executionId,
              threadId,
              plan: activePlan,
              eventType: activePlan.status === 'completed' ? 'plan.completed' : activePlan.status === 'failed' ? 'plan.failed' : 'plan.updated',
              emitSse: emitPlan,
            });
          }
          await completeRun(executionId, finalText);
        }
        await uiEventQueue;
      });
      queueUiEvent('done', {
        executionId,
        pendingApproval: pendingApproval ?? null,
        actionIssued: Boolean(pendingAction),
        state: pendingApproval ? 'waiting_for_approval' : 'completed',
      });
      sendSseEvent(res, 'done', {
        message: assistantMessage,
        executionId,
        pendingApproval: pendingApproval ?? null,
        actionIssued: Boolean(pendingAction),
        state: pendingApproval ? 'waiting_for_approval' : 'completed',
      });
      res.end();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Vercel desktop stream failed';
      logger.error('vercel.stream.failed', {
        executionId,
        threadId,
        error: errorMessage,
      });
      await appendEventSafe({
        executionId,
        phase: 'error',
        eventType: 'execution.failed',
        actorType: 'system',
        actorKey: 'vercel',
        title: 'Vercel desktop stream failed',
        summary: summarizeText(errorMessage),
        status: 'failed',
      });
      await failRun(executionId, errorMessage);
      await persistUiEvent(executionId, 'error', { message: errorMessage });
      sendSseEvent(res, 'error', { message: errorMessage });
      res.end();
    }
  }

  async act(req: Request, res: Response, session: MemberSessionDTO): Promise<Response> {
    const threadId = req.params.threadId;
    const {
      message,
      workspace,
      actionResult,
      mode,
      executionId: requestedExecutionId,
      continuationMessageId,
    } = actSchema.parse(req.body);
    const executionId = requestedExecutionId ?? randomUUID();
    const messageId = randomUUID();
    const requesterAiRole = session.aiRole ?? session.role;
    const fallbackAllowedToolIds = await toolPermissionService.getAllowedTools(session.companyId, requesterAiRole);
    const departmentRuntime = await resolveDepartmentRuntime(session, threadId, fallbackAllowedToolIds);
    const baseThreadMemory = await loadThreadMemory(threadId, session.userId);
    const continuationState = await loadContinuationMessageState({
      threadId,
      userId: session.userId,
      messageId: continuationMessageId,
    });
    let activeThreadSummary = continuationState.threadSummary.sourceMessageCount > 0
      ? continuationState.threadSummary
      : baseThreadMemory.summary;
    let activeTaskState = continuationState.taskState.updatedAt !== new Date(0).toISOString()
      ? continuationState.taskState
      : baseThreadMemory.taskState;
    activeTaskState = applyActionResultToTaskState({
      taskState: activeTaskState,
      actionResult: actionResult ?? null,
    });
    if (message?.trim()) {
      activeTaskState = {
        ...activeTaskState,
        activeObjective: summarizeText(message.trim(), 300),
        updatedAt: new Date().toISOString(),
      };
    }
    const resolvedUserContext = message
      ? resolveDesktopTaskReferences(message, activeTaskState)
      : { message: message ?? '', resolvedReferences: [] };

    await startRun({
      executionId,
      threadId,
      messageId,
      entrypoint: 'desktop_act',
      session,
      mode,
      message: resolvedUserContext.message || message || actionResult?.summary || 'Local action continuation',
    });

    await appendEventSafe({
      executionId,
      phase: 'request',
      eventType: 'execution.started',
      actorType: 'system',
      actorKey: 'vercel',
      title: 'Vercel desktop action turn started',
      summary: summarizeText(resolvedUserContext.message || message || actionResult?.summary || 'Local action continuation'),
      status: 'running',
      payload: {
        threadId,
        workspacePath: workspace?.path ?? null,
        hasActionResult: Boolean(actionResult),
      },
    });

    try {
      if (message) {
        const userMessage = await desktopThreadsService.addMessage(threadId, session.userId, 'user', message);
        conversationMemoryStore.addUserMessage(buildConversationKey(threadId), messageId, message);
        maybeStoreConversationTurn({
          companyId: session.companyId,
          userId: session.userId,
          threadId,
          sourceId: userMessage.id,
          role: 'user',
          text: message,
        });
      }

      const runtime: VercelRuntimeRequestContext = {
        threadId,
        executionId,
        companyId: session.companyId,
        userId: session.userId,
        requesterAiRole,
        requesterEmail: session.email ?? undefined,
        departmentId: departmentRuntime.threadDepartmentId,
        departmentName: departmentRuntime.departmentName,
        departmentRoleSlug: departmentRuntime.departmentRoleSlug,
        larkTenantKey: session.larkTenantKey ?? undefined,
        larkOpenId: session.larkOpenId ?? undefined,
        larkUserId: session.larkUserId ?? undefined,
        authProvider: session.authProvider,
        mode,
        workspace,
        dateScope: inferDateScope(resolvedUserContext.message || message),
        latestActionResult: actionResult,
        allowedToolIds: departmentRuntime.allowedToolIds,
        allowedActionsByTool: departmentRuntime.allowedActionsByTool,
        departmentSystemPrompt: departmentRuntime.departmentSystemPrompt,
        departmentSkillsMarkdown: departmentRuntime.departmentSkillsMarkdown,
      };

      let persistedBlocks: PersistedContentBlock[] = continuationState.persistedBlocks;
      const { history } = await mapHistoryToMessages(threadId, session);
      let activePlan = continuationState.plan ?? extractLatestExecutionPlan(history);
      if (activePlan && actionResult) {
        activePlan = updateExecutionPlanTask(activePlan, {
          ownerAgent: resolvePlanOwnerFromActionKind(actionResult.kind === 'tool_action' ? 'run_command' : actionResult.kind),
          ok: actionResult.ok,
          resultSummary: actionResult.summary,
        });
        await logAndPersistPlan({
          executionId,
          threadId,
          plan: activePlan,
          eventType: activePlan.status === 'failed' ? 'plan.failed' : activePlan.status === 'completed' ? 'plan.completed' : 'plan.updated',
        });
      }
      const continuationText = (message ? resolvedUserContext.message : undefined) ?? (actionResult
        ? [
          'Continue from this local action result.',
          `kind: ${actionResult.kind}`,
          `ok: ${String(actionResult.ok)}`,
          'summary:',
          actionResult.summary,
          actionResult.payload ? `payload:\n${JSON.stringify(actionResult.payload)}` : '',
          actionResult.ok
            ? 'Do not repeat the same successful action unless a different verification or follow-up step is required.'
            : 'Use the failure details above to choose a different next step or a corrected retry.',
          ].join('\n')
        : undefined);
      const grounding = await resolveDesktopGroundingAttachments({
        companyId: session.companyId,
        message: continuationText ?? resolvedUserContext.message ?? message,
        currentAttachedFiles: [],
        recentAttachedFiles: collectRecentAttachedFiles(history),
        taskState: activeTaskState,
      });
      activeTaskState = grounding.taskState;
      logger.info('desktop.source_artifacts.grounding', {
        executionId,
        threadId,
        source: grounding.source,
        attachmentCount: grounding.attachments.length,
        activeSourceArtifacts: activeTaskState.activeSourceArtifacts.map((artifact) => artifact.fileName),
      });
      const activeAttachments = grounding.attachments;
      const latestContinuationMessage = continuationText
        || resolvedUserContext.message
        || message
        || actionResult?.summary
        || 'Local action continuation';
      const contextAssembly = await buildDesktopContextAssembly({
        executionId,
        threadId,
        session,
        mode,
        latestUserMessage: latestContinuationMessage,
        history,
        workspace,
        taskState: activeTaskState,
        threadSummary: activeThreadSummary,
        resolvedUserReferences: resolvedUserContext.resolvedReferences,
        departmentName: departmentRuntime.departmentName,
        departmentRoleSlug: departmentRuntime.departmentRoleSlug,
        departmentSystemPrompt: departmentRuntime.departmentSystemPrompt,
        departmentSkillsMarkdown: departmentRuntime.departmentSkillsMarkdown,
        dateScope: runtime.dateScope,
        latestActionResult: actionResult,
        activeAttachments,
      });
      const modelMessages = continuationText
        ? activeAttachments.length > 0
          ? [...contextAssembly.historyMessages, {
            role: 'user',
            content: await buildVisionContent({
              userMessage: continuationText,
              attachedFiles: activeAttachments,
              companyId: session.companyId,
              requesterUserId: session.userId,
              requesterAiRole,
            }) as ModelMessage['content'],
          }]
          : [...contextAssembly.historyMessages, { role: 'user', content: continuationText }]
        : contextAssembly.historyMessages;
      logLlmContext({
        phase: 'act',
        executionId,
        threadId,
        systemPrompt: contextAssembly.systemPrompt,
        messages: modelMessages,
        workspace,
        taskState: activeTaskState,
        threadSummary: activeThreadSummary,
        resolvedUserReferences: resolvedUserContext.resolvedReferences,
      });
      const result = await runVercelLoop({
        runtime,
        system: contextAssembly.systemPrompt,
        messages: modelMessages,
        onToolStart: async (toolName, activityId, title) => {
          const ownerAgent = resolvePlanOwnerFromToolName(toolName);
          if (activePlan && ownerAgent) {
            activePlan = ensurePlanTaskRunning(activePlan, ownerAgent);
          }
          await persistUiEvent(executionId, 'activity', {
            id: activityId,
            name: toolName,
            label: title,
            icon: 'tool',
          });
          persistedBlocks = [
            ...persistedBlocks,
            { type: 'tool', id: activityId, name: toolName, label: title, icon: 'tool', status: 'running' },
          ];
          await appendEventSafe({
            executionId,
            phase: 'tool',
            eventType: 'tool.started',
            actorType: 'tool',
            actorKey: toolName,
            title,
            status: 'running',
          });
        },
        onToolFinish: async (toolName, activityId, title, output) => {
          activeTaskState = updateTaskStateFromToolEnvelope({
            taskState: activeTaskState,
            toolName,
            output,
            latestObjective: message ?? actionResult?.summary,
          });
          const ownerAgent = resolvePlanOwnerFromToolName(toolName);
          if (activePlan && ownerAgent) {
            activePlan = updateExecutionPlanTask(activePlan, {
              ownerAgent,
              ok: output.success && !output.pendingApprovalAction,
              resultSummary: output.summary,
            });
            await logAndPersistPlan({
              executionId,
              threadId,
              plan: activePlan,
              eventType: activePlan.status === 'failed' ? 'plan.failed' : activePlan.status === 'completed' ? 'plan.completed' : 'plan.updated',
            });
          }
          await persistUiEvent(executionId, 'activity_done', {
            id: activityId,
            name: toolName,
            label: title,
            icon: output.success ? 'tool' : 'x-circle',
            resultSummary: output.summary,
          });
          persistedBlocks = persistedBlocks.map((block) =>
            block.type === 'tool' && block.id === activityId
              ? {
                ...block,
                name: toolName,
                label: title,
                icon: output.success ? 'tool' : 'x-circle',
                status: output.success ? 'done' : 'failed',
                resultSummary: output.summary,
              }
              : block,
          );
          await appendEventSafe({
            executionId,
            phase: output.pendingApprovalAction ? 'control' : 'tool',
            eventType: output.pendingApprovalAction ? 'control.requested' : 'tool.completed',
            actorType: output.pendingApprovalAction ? 'system' : 'tool',
            actorKey: toolName,
            title,
            summary: summarizeText(output.summary, 600),
            status: output.pendingApprovalAction ? 'pending' : output.success ? 'done' : 'failed',
            payload: {
              success: output.success,
              pendingApprovalAction: output.pendingApprovalAction ?? null,
            },
          });
        },
      });

      const pendingApproval = findPendingApproval(result.steps as Array<{ toolResults?: Array<{ output: unknown }> }>);
      if (pendingApproval) {
        const action = mapPendingApprovalAction(pendingApproval);
        await persistUiEvent(executionId, 'action', { action, executionId });
        return res.json(ApiResponse.success({
          kind: 'action',
          action,
          plan: activePlan,
          executionId,
        }, 'Local action requested'));
      }

      const assistantText = result.text.trim();
      if (activePlan) {
        activePlan = completeExecutionPlan(activePlan, assistantText);
        await logAndPersistPlan({
          executionId,
          threadId,
          plan: activePlan,
          eventType: activePlan.status === 'completed' ? 'plan.completed' : activePlan.status === 'failed' ? 'plan.failed' : 'plan.updated',
        });
      }
      persistedBlocks = appendTextBlock(persistedBlocks, assistantText);
      await persistUiEvent(executionId, 'text', assistantText);
      const citations = (result.steps as Array<{ toolResults?: Array<{ output?: unknown }> }>).flatMap((step) =>
        (step.toolResults ?? []).flatMap((toolResult) => {
          const output = toolResult.output as VercelToolEnvelope | undefined;
          return output?.citations ?? [];
        }));
      const conversationRefs = buildPersistedConversationRefs(buildConversationKey(threadId));
      const assistantMessage = await persistAssistantMessage({
        threadId,
        userId: session.userId,
        content: assistantText,
        metadata: buildExecutionMetadata({
          state: 'completed',
          executionId,
          contentBlocks: persistedBlocks,
          plan: activePlan,
          citations: citations as Array<Record<string, unknown>>,
          conversationRefs,
          taskStateSnapshot: activeTaskState,
          threadSummarySnapshot: activeThreadSummary,
          contextAssembly: contextAssembly.metrics,
        }),
        ...(continuationMessageId ? { existingMessageId: continuationMessageId } : {}),
      });
      conversationMemoryStore.addAssistantMessage(buildConversationKey(threadId), assistantMessage.id, assistantText);
      maybeStoreConversationTurn({
        companyId: session.companyId,
        userId: session.userId,
        threadId,
        sourceId: assistantMessage.id,
        role: 'assistant',
        text: assistantText,
      });
      const updatedHistoryForSummary = appendMessageToHistory(history, {
        id: assistantMessage.id,
        role: assistantMessage.role,
        content: assistantMessage.content,
        metadata: assistantMessage.metadata && typeof assistantMessage.metadata === 'object' && !Array.isArray(assistantMessage.metadata)
          ? assistantMessage.metadata as Record<string, unknown>
          : undefined,
      });
      runInBackground(`persist-thread-memory:${executionId}`, async () => {
        const refreshedSummary = await refreshDesktopThreadSummary({
          messages: updatedHistoryForSummary.messages.map((entry) => ({
            role: entry.role,
            content: entry.content,
          })),
          taskState: activeTaskState,
          currentSummary: activeThreadSummary,
        });
        await persistThreadMemory({
          threadId,
          userId: session.userId,
          summary: refreshedSummary,
          taskState: activeTaskState,
        });
      });
      runInBackground(`record-token-usage:${executionId}`, async () => {
        await recordTokenUsage({
        userId: session.userId,
        companyId: session.companyId,
        channel: 'desktop',
        threadId,
        mode,
        agentTarget: 'desktop.vercel',
        systemPrompt: contextAssembly.systemPrompt,
        messages: modelMessages,
        outputText: assistantText,
        });
      });

      runInBackground(`act-finish:${executionId}`, async () => {
        await appendEventSafe({
        executionId,
        phase: 'synthesis',
        eventType: 'synthesis.completed',
        actorType: 'agent',
        actorKey: 'vercel',
        title: 'Generated assistant response',
        summary: summarizeText(assistantText, 600),
        status: 'done',
        });
        await persistUiEvent(executionId, 'done', { executionId, state: 'completed' });
        await completeRun(executionId, assistantText);
      });

      return res.json(ApiResponse.success({
        kind: 'answer',
        message: assistantMessage,
        plan: activePlan,
        executionId,
      }, 'Assistant reply created'));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Vercel desktop action loop failed';
      await appendEventSafe({
        executionId,
        phase: 'error',
        eventType: 'execution.failed',
        actorType: 'system',
        actorKey: 'vercel',
        title: 'Vercel desktop action loop failed',
        summary: summarizeText(errorMessage),
        status: 'failed',
      });
      await persistUiEvent(executionId, 'error', { message: errorMessage });
      await failRun(executionId, errorMessage);
      throw error;
    }
  }

  async streamAct(req: Request, res: Response, session: MemberSessionDTO): Promise<void> {
    const threadId = req.params.threadId;
    const {
      message,
      workspace,
      actionResult,
      mode,
      executionId: requestedExecutionId,
      continuationMessageId,
    } = actSchema.parse(req.body);
    const executionId = requestedExecutionId ?? randomUUID();
    const messageId = randomUUID();
    const requesterAiRole = session.aiRole ?? session.role;
    const fallbackAllowedToolIds = await toolPermissionService.getAllowedTools(session.companyId, requesterAiRole);
    const departmentRuntime = await resolveDepartmentRuntime(session, threadId, fallbackAllowedToolIds);
    const baseThreadMemory = await loadThreadMemory(threadId, session.userId);
    const continuationState = await loadContinuationMessageState({
      threadId,
      userId: session.userId,
      messageId: continuationMessageId,
    });
    let activeThreadSummary = continuationState.threadSummary.sourceMessageCount > 0
      ? continuationState.threadSummary
      : baseThreadMemory.summary;
    let activeTaskState = continuationState.taskState.updatedAt !== new Date(0).toISOString()
      ? continuationState.taskState
      : baseThreadMemory.taskState;
    activeTaskState = applyActionResultToTaskState({
      taskState: activeTaskState,
      actionResult: actionResult ?? null,
    });
    if (message?.trim()) {
      activeTaskState = {
        ...activeTaskState,
        activeObjective: summarizeText(message.trim(), 300),
        updatedAt: new Date().toISOString(),
      };
    }
    const resolvedUserContext = message
      ? resolveDesktopTaskReferences(message, activeTaskState)
      : { message: message ?? '', resolvedReferences: [] };

    await startRun({
      executionId,
      threadId,
      messageId,
      entrypoint: 'desktop_act',
      session,
      mode,
      message: resolvedUserContext.message || message || actionResult?.summary || 'Local action continuation',
    });
    await appendEventSafe({
      executionId,
      phase: 'request',
      eventType: 'execution.started',
      actorType: 'system',
      actorKey: 'vercel',
      title: 'Vercel desktop action stream started',
      summary: summarizeText(resolvedUserContext.message || message || actionResult?.summary || 'Local action continuation'),
      status: 'running',
      payload: {
        threadId,
        workspacePath: workspace?.path ?? null,
        hasActionResult: Boolean(actionResult),
      },
    });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    try {
      let uiEventQueue = Promise.resolve();
      const queueUiEvent = (
        type: Parameters<typeof persistUiEvent>[1],
        data: Parameters<typeof persistUiEvent>[2],
      ): void => {
        uiEventQueue = uiEventQueue
          .then(() => persistUiEvent(executionId, type, data))
          .catch(() => undefined);
      };

      if (message) {
        const userMessage = await desktopThreadsService.addMessage(threadId, session.userId, 'user', message);
        conversationMemoryStore.addUserMessage(buildConversationKey(threadId), messageId, message);
        maybeStoreConversationTurn({
          companyId: session.companyId,
          userId: session.userId,
          threadId,
          sourceId: userMessage.id,
          role: 'user',
          text: message,
        });
      }

      const runtime: VercelRuntimeRequestContext = {
        channel: 'desktop',
        threadId,
        chatId: threadId,
        executionId,
        companyId: session.companyId,
        userId: session.userId,
        requesterAiRole,
        requesterEmail: session.email ?? undefined,
        departmentId: departmentRuntime.threadDepartmentId,
        departmentName: departmentRuntime.departmentName,
        departmentRoleSlug: departmentRuntime.departmentRoleSlug,
        larkTenantKey: session.larkTenantKey ?? undefined,
        larkOpenId: session.larkOpenId ?? undefined,
        larkUserId: session.larkUserId ?? undefined,
        authProvider: session.authProvider,
        mode,
        workspace,
        dateScope: inferDateScope(resolvedUserContext.message || message),
        latestActionResult: actionResult,
        allowedToolIds: departmentRuntime.allowedToolIds,
        allowedActionsByTool: departmentRuntime.allowedActionsByTool,
        departmentSystemPrompt: departmentRuntime.departmentSystemPrompt,
        departmentSkillsMarkdown: departmentRuntime.departmentSkillsMarkdown,
      };

      let persistedBlocks: PersistedContentBlock[] = continuationState.persistedBlocks;
      const { history } = await mapHistoryToMessages(threadId, session);
      let activePlan = continuationState.plan ?? extractLatestExecutionPlan(history);
      const emitPlan = (plan: ExecutionPlan) => {
        sendSseEvent(res, 'plan', plan);
        queueUiEvent('plan', plan);
      };
      if (activePlan && actionResult) {
        activePlan = updateExecutionPlanTask(activePlan, {
          ownerAgent: resolvePlanOwnerFromActionKind(actionResult.kind === 'tool_action' ? 'run_command' : actionResult.kind),
          ok: actionResult.ok,
          resultSummary: actionResult.summary,
        });
        await logAndPersistPlan({
          executionId,
          threadId,
          plan: activePlan,
          eventType: activePlan.status === 'failed' ? 'plan.failed' : activePlan.status === 'completed' ? 'plan.completed' : 'plan.updated',
          emitSse: emitPlan,
        });
      }
      const continuationText = (message ? resolvedUserContext.message : undefined) ?? (actionResult
        ? [
          'Continue from this local action result.',
          `kind: ${actionResult.kind}`,
          `ok: ${String(actionResult.ok)}`,
          'summary:',
          actionResult.summary,
          actionResult.payload ? `payload:\n${JSON.stringify(actionResult.payload)}` : '',
          actionResult.ok
            ? 'Do not repeat the same successful action unless a different verification or follow-up step is required.'
            : 'Use the failure details above to choose a different next step or a corrected retry.',
          ].join('\n')
        : undefined);
      const grounding = await resolveDesktopGroundingAttachments({
        companyId: session.companyId,
        message: continuationText ?? resolvedUserContext.message ?? message,
        currentAttachedFiles: [],
        recentAttachedFiles: collectRecentAttachedFiles(history),
        taskState: activeTaskState,
      });
      activeTaskState = grounding.taskState;
      logger.info('desktop.source_artifacts.grounding', {
        executionId,
        threadId,
        source: grounding.source,
        attachmentCount: grounding.attachments.length,
        activeSourceArtifacts: activeTaskState.activeSourceArtifacts.map((artifact) => artifact.fileName),
      });
      const activeAttachments = grounding.attachments;
      const latestContinuationMessage = continuationText
        || resolvedUserContext.message
        || message
        || actionResult?.summary
        || 'Local action continuation';
      const contextAssembly = await buildDesktopContextAssembly({
        executionId,
        threadId,
        session,
        mode,
        latestUserMessage: latestContinuationMessage,
        history,
        workspace,
        taskState: activeTaskState,
        threadSummary: activeThreadSummary,
        resolvedUserReferences: resolvedUserContext.resolvedReferences,
        departmentName: departmentRuntime.departmentName,
        departmentRoleSlug: departmentRuntime.departmentRoleSlug,
        departmentSystemPrompt: departmentRuntime.departmentSystemPrompt,
        departmentSkillsMarkdown: departmentRuntime.departmentSkillsMarkdown,
        dateScope: runtime.dateScope,
        latestActionResult: actionResult,
        activeAttachments,
      });
      const modelMessages = continuationText
        ? activeAttachments.length > 0
          ? [...contextAssembly.historyMessages, {
            role: 'user',
            content: await buildVisionContent({
              userMessage: continuationText,
              attachedFiles: activeAttachments,
              companyId: session.companyId,
              requesterUserId: session.userId,
              requesterAiRole,
            }) as ModelMessage['content'],
          }]
          : [...contextAssembly.historyMessages, { role: 'user', content: continuationText }]
        : contextAssembly.historyMessages;
      logLlmContext({
        phase: 'streamAct',
        executionId,
        threadId,
        systemPrompt: contextAssembly.systemPrompt,
        messages: modelMessages,
        workspace,
        taskState: activeTaskState,
        threadSummary: activeThreadSummary,
        resolvedUserReferences: resolvedUserContext.resolvedReferences,
      });
      const result = await runVercelStreamLoop({
        runtime,
        system: contextAssembly.systemPrompt,
        messages: modelMessages,
        onToolStart: async (toolName, activityId, title) => {
          const ownerAgent = resolvePlanOwnerFromToolName(toolName);
          if (activePlan && ownerAgent) {
            const nextPlan = ensurePlanTaskRunning(activePlan, ownerAgent);
            if (nextPlan !== activePlan) {
              activePlan = nextPlan;
              await logAndPersistPlan({
                executionId,
                threadId,
                plan: activePlan,
                eventType: 'plan.updated',
                emitSse: emitPlan,
              });
            }
          }
          logger.info('vercel.stream.tool.start', {
            executionId,
            threadId,
            toolName,
            activityId,
            title,
          });
          sendSseEvent(res, 'activity', {
            id: activityId,
            name: toolName,
            label: title,
            icon: 'tool',
          });
          queueUiEvent('activity', {
            id: activityId,
            name: toolName,
            label: title,
            icon: 'tool',
          });
          persistedBlocks = [
            ...persistedBlocks,
            { type: 'tool', id: activityId, name: toolName, label: title, icon: 'tool', status: 'running' },
          ];
          await appendEventSafe({
            executionId,
            phase: 'tool',
            eventType: 'tool.started',
            actorType: 'tool',
            actorKey: toolName,
            title,
            status: 'running',
          });
        },
        onToolFinish: async (toolName, activityId, title, output) => {
          activeTaskState = updateTaskStateFromToolEnvelope({
            taskState: activeTaskState,
            toolName,
            output,
            latestObjective: message ?? actionResult?.summary,
          });
          const ownerAgent = resolvePlanOwnerFromToolName(toolName);
          if (activePlan && ownerAgent) {
            activePlan = updateExecutionPlanTask(activePlan, {
              ownerAgent,
              ok: output.success && !output.pendingApprovalAction,
              resultSummary: output.summary,
            });
            await logAndPersistPlan({
              executionId,
              threadId,
              plan: activePlan,
              eventType: activePlan.status === 'failed' ? 'plan.failed' : activePlan.status === 'completed' ? 'plan.completed' : 'plan.updated',
              emitSse: emitPlan,
            });
          }
          logger.info('vercel.stream.tool.finish', {
            executionId,
            threadId,
            toolName,
            activityId,
            title,
            success: output.success,
            summary: summarizeText(output.summary, 280),
            pendingApproval: output.pendingApprovalAction?.kind ?? null,
          });
          sendSseEvent(res, 'activity_done', {
            id: activityId,
            name: toolName,
            label: title,
            icon: output.success ? 'tool' : 'x-circle',
            resultSummary: output.summary,
          });
          queueUiEvent('activity_done', {
            id: activityId,
            name: toolName,
            label: title,
            icon: output.success ? 'tool' : 'x-circle',
            resultSummary: output.summary,
          });
          persistedBlocks = persistedBlocks.map((block) =>
            block.type === 'tool' && block.id === activityId
              ? {
                ...block,
                name: toolName,
                label: title,
                icon: output.success ? 'tool' : 'x-circle',
                status: output.success ? 'done' : 'failed',
                resultSummary: output.summary,
              }
              : block,
          );
          await appendEventSafe({
            executionId,
            phase: output.pendingApprovalAction ? 'control' : 'tool',
            eventType: output.pendingApprovalAction ? 'control.requested' : 'tool.completed',
            actorType: output.pendingApprovalAction ? 'system' : 'tool',
            actorKey: output.pendingApprovalAction ? output.pendingApprovalAction.kind : toolName,
            title,
            summary: summarizeText(output.summary, 600),
            status: output.pendingApprovalAction ? 'pending' : output.success ? 'done' : 'failed',
            payload: {
              success: output.success,
              pendingApprovalAction: output.pendingApprovalAction ?? null,
            },
          });
        },
      });

      let streamedText = '';
      let hasReasoningBlock = false;
      let reasoningDeltaCount = 0;
      let reasoningCharCount = 0;
      for await (const part of result.fullStream) {
        if (part.type === 'reasoning-start') {
          hasReasoningBlock = true;
          sendSseEvent(res, 'thinking', { text: '' });
          queueUiEvent('thinking', { text: '' });
          persistedBlocks = ensureThinkingBlock(persistedBlocks);
          continue;
        }

        if (part.type === 'reasoning-delta') {
          if (!part.text) continue;
          if (!hasReasoningBlock) {
            hasReasoningBlock = true;
            sendSseEvent(res, 'thinking', { text: '' });
            queueUiEvent('thinking', { text: '' });
            persistedBlocks = ensureThinkingBlock(persistedBlocks);
          }
          reasoningDeltaCount += 1;
          reasoningCharCount += part.text.length;
          sendSseEvent(res, 'thinking_token', part.text);
          queueUiEvent('thinking_token', part.text);
          persistedBlocks = appendThinkingBlock(persistedBlocks, part.text);
          continue;
        }

        if (part.type === 'text-delta') {
          if (!part.text) continue;
          streamedText += part.text;
          sendSseEvent(res, 'text', part.text);
          queueUiEvent('text', part.text);
          persistedBlocks = appendTextBlock(persistedBlocks, part.text);
        }
      }

      logger.info('vercel.stream.reasoning.summary', {
        executionId,
        threadId,
        sawReasoning: hasReasoningBlock,
        deltaCount: reasoningDeltaCount,
        totalChars: reasoningCharCount,
      });

      const steps = await result.steps;
      const pendingApproval = findPendingApproval(steps as Array<{ toolResults?: Array<{ output: unknown }> }>);
      const pendingAction = pendingApproval ? mapPendingApprovalAction(pendingApproval) : null;
      const finalText = pendingApproval ? '' : streamedText.trim();
      const approvalSummary = pendingAction
        ? pendingAction.kind === 'run_command'
          ? pendingAction.command
          : pendingAction.kind === 'tool_action'
            ? pendingAction.summary
            : pendingAction.kind
        : pendingApproval?.kind ?? null;
      const citations = (steps as Array<{ toolResults?: Array<{ output?: unknown }> }>).flatMap((step) =>
        (step.toolResults ?? []).flatMap((toolResult) => {
          const output = toolResult.output as VercelToolEnvelope | undefined;
          return output?.citations ?? [];
        }));

      if (pendingAction) {
        if (activePlan) {
          activePlan = completeExecutionPlan(activePlan, approvalSummary ?? 'Approval required to continue.');
          await logAndPersistPlan({
            executionId,
            threadId,
            plan: activePlan,
            eventType: activePlan.status === 'completed' ? 'plan.completed' : 'plan.updated',
            emitSse: emitPlan,
          });
        }
        sendSseEvent(res, 'action', { action: pendingAction, executionId });
        queueUiEvent('action', { action: pendingAction, executionId });
      }

      const conversationRefs = buildPersistedConversationRefs(buildConversationKey(threadId));
      const assistantMessage = await persistAssistantMessage({
        threadId,
        userId: session.userId,
        content: finalText,
        metadata: buildExecutionMetadata({
          state: pendingApproval ? 'waiting_for_approval' : 'completed',
          executionId,
          contentBlocks: persistedBlocks,
          plan: activePlan,
          citations: citations as Array<Record<string, unknown>>,
          conversationRefs,
          pendingApprovalAction: pendingApproval ?? null,
          desktopPendingAction: pendingAction ?? null,
          taskStateSnapshot: activeTaskState,
          threadSummarySnapshot: activeThreadSummary,
          contextAssembly: contextAssembly.metrics,
        }),
        ...(continuationMessageId ? { existingMessageId: continuationMessageId } : {}),
      });
      conversationMemoryStore.addAssistantMessage(buildConversationKey(threadId), assistantMessage.id, finalText);
      maybeStoreConversationTurn({
        companyId: session.companyId,
        userId: session.userId,
        threadId,
        sourceId: assistantMessage.id,
        role: 'assistant',
        text: finalText || approvalSummary || '',
      });
      const updatedHistoryForSummary = appendMessageToHistory(history, {
        id: assistantMessage.id,
        role: assistantMessage.role,
        content: assistantMessage.content,
        metadata: assistantMessage.metadata && typeof assistantMessage.metadata === 'object' && !Array.isArray(assistantMessage.metadata)
          ? assistantMessage.metadata as Record<string, unknown>
          : undefined,
      });
      runInBackground(`persist-thread-memory:${executionId}`, async () => {
        const refreshedSummary = await refreshDesktopThreadSummary({
          messages: updatedHistoryForSummary.messages.map((entry) => ({
            role: entry.role,
            content: entry.content,
          })),
          taskState: activeTaskState,
          currentSummary: activeThreadSummary,
        });
        await persistThreadMemory({
          threadId,
          userId: session.userId,
          summary: refreshedSummary,
          taskState: activeTaskState,
        });
      });
      runInBackground(`record-token-usage:${executionId}`, async () => {
        await recordTokenUsage({
        userId: session.userId,
        companyId: session.companyId,
        channel: 'desktop',
        threadId,
        mode,
        agentTarget: 'desktop.vercel',
        systemPrompt: contextAssembly.systemPrompt,
        messages: modelMessages,
        outputText: finalText || approvalSummary || '',
        });
      });

      runInBackground(`streamAct-finish:${executionId}`, async () => {
        await appendEventSafe({
        executionId,
        phase: pendingApproval ? 'control' : 'synthesis',
        eventType: pendingApproval ? 'control.requested' : 'synthesis.completed',
        actorType: pendingApproval ? 'system' : 'agent',
        actorKey: pendingApproval ? pendingApproval.kind : 'vercel',
        title: pendingApproval ? 'Approval requested' : 'Generated assistant response',
        summary: summarizeText(finalText || approvalSummary || 'Approval requested', 600),
        status: pendingApproval ? 'pending' : 'done',
        });
        if (!pendingApproval) {
          if (activePlan) {
            activePlan = completeExecutionPlan(activePlan, finalText);
            await logAndPersistPlan({
              executionId,
              threadId,
              plan: activePlan,
              eventType: activePlan.status === 'completed' ? 'plan.completed' : activePlan.status === 'failed' ? 'plan.failed' : 'plan.updated',
              emitSse: emitPlan,
            });
          }
          await completeRun(executionId, finalText);
        }
        await uiEventQueue;
      });

      queueUiEvent('done', {
        executionId,
        pendingApproval: pendingApproval ?? null,
        actionIssued: Boolean(pendingAction),
        state: pendingApproval ? 'waiting_for_approval' : 'completed',
      });
      sendSseEvent(res, 'done', {
        message: assistantMessage,
        executionId,
        pendingApproval: pendingApproval ?? null,
        actionIssued: Boolean(pendingAction),
        state: pendingApproval ? 'waiting_for_approval' : 'completed',
      });
      res.end();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Vercel desktop action stream failed';
      logger.error('vercel.stream.failed', {
        executionId,
        threadId,
        error: errorMessage,
      });
      await appendEventSafe({
        executionId,
        phase: 'error',
        eventType: 'execution.failed',
        actorType: 'system',
        actorKey: 'vercel',
        title: 'Vercel desktop action stream failed',
        summary: summarizeText(errorMessage),
        status: 'failed',
      });
      await failRun(executionId, errorMessage);
      await persistUiEvent(executionId, 'error', { message: errorMessage });
      sendSseEvent(res, 'error', { message: errorMessage });
      res.end();
    }
  }
}

export const vercelDesktopEngine = new VercelDesktopEngine();
