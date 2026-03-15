import { Request, Response } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';

import { RequestContext } from '@mastra/core/di';
import { ApiResponse } from '../../core/api-response';
import { BaseController } from '../../core/controller';
import { HttpException } from '../../core/http-exception';
import { MemberSessionDTO } from '../member-auth/member-auth.service';
import { desktopThreadsService } from '../desktop-threads/desktop-threads.service';
import { mastra } from '../../company/integrations/mastra';
import {
  buildMastraAgentRunOptions,
  MASTRA_AGENT_TARGETS,
  type MastraAgentTargetId,
} from '../../company/integrations/mastra/mastra-model-control';
import { personalVectorMemoryService } from '../../company/integrations/vector/personal-vector-memory.service';
import { buildVisionContent, type AttachedFileRef } from './file-vision.builder';
import { conversationMemoryStore } from '../../company/state/conversation/conversation-memory.store';
import { toolPermissionService } from '../../company/tools/tool-permission.service';
import { logger } from '../../utils/logger';
import { knowledgeShareService } from '../../company/knowledge-share/knowledge-share.service';
import {
  registerActivityBus,
  unregisterActivityBus,
  type ActivityPayload,
} from '../../company/integrations/mastra/tools/activity-bus';
import {
  buildExecutionPlanContext,
  completeExecutionPlan,
  executionPlanSchema,
  failExecutionPlan,
  initializeExecutionPlanFromWorkflow,
  resolveActivePlanTaskId,
  resolvePlanOwnerFromActionKind,
  resolvePlanOwnerFromToolName,
  updateExecutionPlanTask,
  type ExecutionPlan,
} from './desktop-plan';
import { registerPlanBus, unregisterPlanBus } from '../../company/integrations/mastra/tools/plan-bus';
import { maybeCompactHistory } from './context-compactor';
import { aiTokenUsageService } from '../../company/ai-usage/ai-token-usage.service';
import { AI_MODEL_CATALOG_MAP } from '../../company/ai-models/catalog';
import { estimateTokens, extractActualTokenUsage } from '../../utils/token-estimator';
import { aiModelControlService } from '../../company/ai-models';
import { resolveMastraLanguageModel } from '../../company/integrations/mastra/mastra-model-control';
import { executionService } from '../../company/observability';
import { langGraphDesktopChatEngine } from './langgraph-desktop.engine';

const KNOWN_AGENTS = [
  'supervisorAgent',
  'zohoAgent',
  'outreachAgent',
  'searchAgent',
  'larkBaseAgent',
  'larkTaskAgent',
  'larkCalendarAgent',
  'larkMeetingAgent',
  'larkApprovalAgent',
] as const;
const DEFAULT_AGENT = 'supervisorAgent';

const attachedFileSchema = z.object({
  fileAssetId: z.string(),
  cloudinaryUrl: z.string().url(),
  mimeType: z.string(),
  fileName: z.string(),
});

const workspaceSchema = z.object({
  name: z.string().min(1).max(255),
  path: z.string().min(1).max(4096),
});

const sendSchema = z.object({
  message: z.string().max(10000).optional().default(''),
  agentId: z.string().optional(),
  attachedFiles: z.array(attachedFileSchema).optional().default([]),
  mode: z.enum(['fast', 'high', 'xtreme']).optional().default('xtreme'),
  engine: z.enum(['mastra', 'langgraph']).optional(),
  workspace: workspaceSchema.optional(),
  executionId: z.string().uuid().optional(),
});

const actionResultSchema = z.object({
  kind: z.enum(['list_files', 'read_file', 'write_file', 'mkdir', 'delete_path', 'run_command']),
  ok: z.boolean(),
  summary: z.string().min(1).max(30000),
  details: z.record(z.string(), z.unknown()).optional(),
});

const actSchema = z.object({
  message: z.string().min(1).max(10000).optional(),
  agentId: z.string().optional(),
  workspace: workspaceSchema,
  actionResult: actionResultSchema.optional(),
  plan: executionPlanSchema.optional(),
  mode: z.enum(['fast', 'high', 'xtreme']).optional().default('xtreme'),
  engine: z.enum(['mastra', 'langgraph']).optional(),
  executionId: z.string().uuid().optional(),
});

const shareConversationSchema = z.object({
  reason: z.string().max(1000).optional(),
});

type MemberRequest = Request & { memberSession?: MemberSessionDTO };
type DesktopEngine = 'mastra' | 'langgraph';

type ToolBlock = {
  type: 'tool';
  id: string;
  name: string;
  label: string;
  icon: string;
  status: 'running' | 'done' | 'failed';
  resultSummary?: string;
  externalRef?: string;
};
type TextBlock = { type: 'text'; content: string };
// Thinking block carries live reasoning text streamed from the model
type ThinkingBlock = { type: 'thinking'; text?: string; durationMs?: number };
type ContentBlock = ToolBlock | TextBlock | ThinkingBlock;
type CitationSummary = {
  id: string;
  title: string;
  url?: string;
  kind?: string;
  sourceType?: string;
  sourceId?: string;
  fileAssetId?: string;
  chunkIndex?: number;
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

const buildConversationRefsContext = (conversationKey: string): string => {
  const latestDoc = conversationMemoryStore.getLatestLarkDoc(conversationKey);
  const latestEvent = conversationMemoryStore.getLatestLarkCalendarEvent(conversationKey);
  const latestTask = conversationMemoryStore.getLatestLarkTask(conversationKey);
  const lines: string[] = [];

  if (latestTask) {
    lines.push(`Latest Lark task in this conversation: ${latestTask.summary ?? latestTask.taskId} [taskId=${latestTask.taskId}${latestTask.taskGuid ? `, taskGuid=${latestTask.taskGuid}` : ''}${latestTask.status ? `, status=${latestTask.status}` : ''}]`);
  }
  if (latestDoc) {
    lines.push(`Latest Lark doc in this conversation: ${latestDoc.title} [documentId=${latestDoc.documentId}]`);
  }
  if (latestEvent) {
    lines.push(`Latest Lark calendar event in this conversation: ${latestEvent.summary ?? latestEvent.eventId} [eventId=${latestEvent.eventId}]`);
  }

  return lines.length > 0
    ? ['--- Conversation refs ---', ...lines, '--- End refs ---'].join('\n')
    : '';
};

const hydrateConversationRefsFromMetadata = (
  conversationKey: string,
  metadata: Record<string, unknown>,
): void => {
  const refs = metadata.conversationRefs;
  if (!refs || typeof refs !== 'object') {
    return;
  }

  const record = refs as PersistedConversationRefs;
  const latestDoc = record.latestLarkDoc;
  if (latestDoc && typeof latestDoc === 'object') {
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
  if (latestEvent && typeof latestEvent === 'object') {
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
  if (latestTask && typeof latestTask === 'object') {
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

type ShareActionSummary = {
  type: 'conversation';
  conversationKey: string;
  label: string;
};

type DesktopAction = {
  kind: 'list_files' | 'read_file' | 'write_file' | 'mkdir' | 'delete_path' | 'run_command';
  path?: string;
  content?: string;
  command?: string;
};

const extractToolResultText = (resultSummary?: string): string | null => {
  if (!resultSummary) return null;

  try {
    const parsed = JSON.parse(resultSummary) as { type?: string; answer?: string };
    if (
      (parsed?.type === 'structured_search' || parsed?.type === 'structured_knowledge')
      && typeof parsed.answer === 'string'
      && parsed.answer.trim()
    ) {
      return parsed.answer.trim();
    }
  } catch {
    // Ignore parse failures and fall back to the raw summary.
  }

  return resultSummary.trim() || null;
};

const extractToolCitations = (resultSummary?: string): CitationSummary[] => {
  if (!resultSummary) return [];

  try {
    const parsed = JSON.parse(resultSummary) as { type?: string; sources?: CitationSummary[] };
    if (
      (parsed?.type === 'structured_search' || parsed?.type === 'structured_knowledge')
      && Array.isArray(parsed.sources)
    ) {
      return parsed.sources
        .filter((source): source is CitationSummary => Boolean(source && typeof source.id === 'string'))
        .map((source) => ({
          id: source.id,
          title: typeof source.title === 'string' ? source.title : source.id,
          url: typeof source.url === 'string' ? source.url : undefined,
          kind: typeof source.kind === 'string' ? source.kind : undefined,
          sourceType: typeof source.sourceType === 'string' ? source.sourceType : undefined,
          sourceId: typeof source.sourceId === 'string' ? source.sourceId : undefined,
          fileAssetId: typeof source.fileAssetId === 'string' ? source.fileAssetId : undefined,
          chunkIndex: typeof source.chunkIndex === 'number' ? source.chunkIndex : undefined,
        }));
    }
  } catch {
    return [];
  }

  return [];
};

const buildShareAction = (conversationKey: string): ShareActionSummary => ({
  type: 'conversation',
  conversationKey,
  label: "Share this chat's knowledge",
});

const buildTemporalContext = (): string => {
  const now = new Date();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const exactDate = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone,
  }).format(now);
  const exactTime = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  }).format(now);

  return [
    '--- CURRENT DATE CONTEXT ---',
    `Today is ${exactDate}. Current local time is ${exactTime}.`,
    `Use timezone ${timeZone} for relative scheduling requests.`,
    'Resolve relative dates like "today", "tomorrow", "next Monday", and "next week" against this date.',
    'When scheduling or confirming dates, include the exact calendar date in the final answer.',
    '--- END CURRENT DATE CONTEXT ---',
  ].join('\n');
};

const RAW_TOOL_JSON_PATTERN = /\{\s*"success"\s*:\s*(true|false)[\s\S]*\}/i;
const shouldResynthesizeAssistantText = (assistantText: string): boolean => {
  const trimmed = assistantText.trim();
  if (!trimmed) {
    return false;
  }

  return RAW_TOOL_JSON_PATTERN.test(trimmed)
    || trimmed.includes('did not complete. Check server logs for the underlying tool failure.');
};

const buildGroundedFallbackAssistantText = (input: {
  contentBlocks: ContentBlock[];
  activePlan: ExecutionPlan | null;
}): string | null => {
  const completedToolSummaries = input.contentBlocks
    .filter((block): block is ToolBlock => block.type === 'tool' && block.status === 'done')
    .map((block) => ({
      label: block.label,
      summary: extractToolResultText(block.resultSummary),
    }))
    .filter((item) => !!item.summary)
    .slice(0, 4);

  if (completedToolSummaries.length === 0) {
    return null;
  }

  const goalLead = input.activePlan?.goal?.trim()
    ? `Completed the requested workflow for: ${input.activePlan.goal.trim()}.`
    : 'Completed the requested workflow.';

  const bullets = completedToolSummaries
    .map((item) => `- **${item.label}:** ${item.summary}`)
    .join('\n');

  return `${goalLead}\n\n**Grounded results**\n${bullets}`;
};

const buildGroundedSynthesisPrompt = (input: {
  userMessage: string;
  activePlan: ExecutionPlan | null;
  contentBlocks: ContentBlock[];
}): string | null => {
  const completedToolSummaries = input.contentBlocks
    .filter((block): block is ToolBlock => block.type === 'tool' && block.status === 'done')
    .map((block) => ({
      label: block.label,
      summary: extractToolResultText(block.resultSummary),
    }))
    .filter((item) => !!item.summary)
    .slice(0, 6);

  if (completedToolSummaries.length === 0) {
    return null;
  }

  const planSection = input.activePlan
    ? [
      `Goal: ${input.activePlan.goal}`,
      'Success criteria:',
      ...input.activePlan.successCriteria.map((criterion) => `- ${criterion}`),
    ].join('\n')
    : 'No explicit execution plan was active.';

  const toolSection = completedToolSummaries
    .map((item, index) => `${index + 1}. ${item.label}\n${item.summary}`)
    .join('\n\n');

  return [
    'Produce the final user-facing answer for this desktop workflow.',
    'Use only the grounded tool results below. Do not invent extra work, records, or document outcomes.',
    'Summarize what was found, mention important failures or gaps if any, and end with the actual outcome.',
    '',
    'Original user request:',
    input.userMessage,
    '',
    'Execution context:',
    planSection,
    '',
    'Grounded completed tool results:',
    toolSection,
  ].join('\n');
};

type ExecutionEventQueue = {
  enqueue: (task: () => Promise<void>) => void;
  flush: () => Promise<void>;
};

const isMissingExecutionRunError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  return error.message.includes('executionRun.update')
    && error.message.includes('No record was found for an update');
};

const createExecutionEventQueue = (options?: {
  executionId?: string;
  ensureRun?: () => Promise<void>;
}): ExecutionEventQueue => {
  let queue = Promise.resolve();

  return {
    enqueue(task) {
      queue = queue
        .then(task)
        .catch(async (error) => {
          if (options?.ensureRun && isMissingExecutionRunError(error)) {
            await options.ensureRun();
            await task();
            logger.warn('execution.event.enqueue.recovered', {
              executionId: options.executionId,
            });
            return;
          }
          logger.warn('execution.event.enqueue.failed', {
            executionId: options?.executionId,
            error: error instanceof Error ? error.message : 'unknown_execution_event_error',
          });
        });
    },
    async flush() {
      await queue;
    },
  };
};

const summarizeText = (value: string | null | undefined, limit = 280): string | null => {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}...` : trimmed;
};

const buildPlanStatusSnapshot = (plan: ExecutionPlan | null | undefined): Map<string, ExecutionPlan['tasks'][number]['status']> =>
  new Map((plan?.tasks ?? []).map((task) => [task.id, task.status]));

const queuePlanLifecycleEvents = (
  queue: ExecutionEventQueue,
  executionId: string,
  previousPlan: ExecutionPlan | null | undefined,
  nextPlan: ExecutionPlan,
): void => {
  const previousStatuses = buildPlanStatusSnapshot(previousPlan);
  const nextStatuses = buildPlanStatusSnapshot(nextPlan);

  if (!previousPlan) {
    queue.enqueue(async () => {
      await executionService.appendEvent({
        executionId,
        phase: 'planning',
        eventType: 'plan.created',
        actorType: 'planner',
        actorKey: 'planner-agent',
        title: 'Created execution plan',
        summary: summarizeText(nextPlan.goal),
        status: nextPlan.status,
        payload: {
          goal: nextPlan.goal,
          successCriteria: nextPlan.successCriteria,
          tasks: nextPlan.tasks.map((task, index) => ({
            index: index + 1,
            id: task.id,
            title: task.title,
            ownerAgent: task.ownerAgent,
            status: task.status,
          })),
        },
      });
    });
  }

  for (const task of nextPlan.tasks) {
    const previousStatus = previousStatuses.get(task.id);
    const nextStatus = nextStatuses.get(task.id);

    if (nextStatus === 'running' && previousStatus !== 'running') {
      queue.enqueue(async () => {
        await executionService.appendEvent({
          executionId,
          phase: 'planning',
          eventType: 'plan.task.started',
          actorType: 'planner',
          actorKey: task.ownerAgent,
          title: `Started task: ${task.title}`,
          summary: summarizeText(task.resultSummary),
          status: task.status,
          payload: {
            taskId: task.id,
            ownerAgent: task.ownerAgent,
            title: task.title,
          },
        });
      });
    }

    if (
      previousStatus !== nextStatus
      && nextStatus
      && ['done', 'failed', 'blocked', 'skipped'].includes(nextStatus)
    ) {
      queue.enqueue(async () => {
        await executionService.appendEvent({
          executionId,
          phase: 'planning',
          eventType: 'plan.task.completed',
          actorType: 'planner',
          actorKey: task.ownerAgent,
          title: `${nextStatus === 'done' ? 'Completed' : 'Updated'} task: ${task.title}`,
          summary: summarizeText(task.resultSummary),
          status: nextStatus,
          payload: {
            taskId: task.id,
            ownerAgent: task.ownerAgent,
            title: task.title,
            resultSummary: summarizeText(task.resultSummary, 600),
          },
        });
      });
    }
  }
};

const isActivityFailure = (payload: ActivityPayload): boolean => {
  const label = (payload.label ?? '').toLowerCase();
  const summary = (payload.resultSummary ?? '').toLowerCase();
  return (
    label.includes('failed')
    || label.includes('error')
    || summary === 'error'
    || summary.includes('failed')
    || summary.includes('error:')
    || summary.includes('not permitted')
  );
};

const LOCAL_ACTION_TAG = 'desktop-action';

const parseDesktopAction = (text: string): DesktopAction | null => {
  const match = text.match(new RegExp(`<${LOCAL_ACTION_TAG}>([\\s\\S]*?)</${LOCAL_ACTION_TAG}>`, 'i'));
  if (!match) return null;

  try {
    const parsed = JSON.parse(match[1].trim()) as DesktopAction;
    if (typeof parsed?.kind !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
};

const LOCAL_ACTION_REQUIRED_PATTERN = /\b(file|files|folder|directory|workspace|script|python|py\b|javascript|typescript|create|write|edit|rewrite|update|save|read|open|run|execute|terminal|command|shell|install|pnpm|npm|node|python3|git|tsc)\b/i;

const LOCAL_CAPABILITY_REFUSAL_PATTERN = /\b(i (?:can(?:not|'t)|do not|don't) (?:run|execute|access|create|write|edit|save)|i do not have (?:a )?(?:local|execution|filesystem|terminal)|i can't run python|i don't have a local execution environment)\b/i;

const LARK_DOC_COMPLETION_CLAIM_PATTERN = /\b(created|updated|saved|compiled|exported|wrote)\b[\s\S]{0,80}\b(lark doc|lark document|document)\b/i;

type WorkflowDomain = 'zoho' | 'outreach' | 'search' | 'larkDoc';

const WORKFLOW_DOMAIN_PATTERNS: Array<{ domain: WorkflowDomain; pattern: RegExp }> = [
  { domain: 'zoho', pattern: /\b(zoho|crm|coql|lead|leads|deal|deals|contact|contacts|ticket|tickets|pipeline)\b/i },
  { domain: 'outreach', pattern: /\b(outreach|publisher|publishers|guest post|backlink|seo|da\b|dr\b)\b/i },
  { domain: 'search', pattern: /\b(search|research|google|web|best practice|best practices|find out|compare|audit|analyze|analysis|learn|check)\b/i },
  { domain: 'larkDoc', pattern: /\b(lark\s+doc|lark\s+document|save\s+.*\s+doc|write\s+.*\s+doc|export\s+.*\s+doc|document\s+it|put\s+.*\s+in\s+.*doc)\b/i },
];

const analyzeWorkflowPolicy = (message: string): {
  domains: WorkflowDomain[];
  forcePlanning: boolean;
  requireGroundedTooling: boolean;
  requireLarkDocTool: boolean;
} => {
  const domains = WORKFLOW_DOMAIN_PATTERNS
    .filter(({ pattern }) => pattern.test(message))
    .map(({ domain }) => domain);
  const uniqueDomains = Array.from(new Set(domains));
  const crossDomain = uniqueDomains.length >= 2;
  const requireLarkDocTool = uniqueDomains.includes('larkDoc') && uniqueDomains.length > 1;
  const requireGroundedTooling =
    crossDomain
    || /\b(research|analyze|analysis|audit|compare|check|best use|best practices|workflow|strategy)\b/i.test(message);

  return {
    domains: uniqueDomains,
    forcePlanning: crossDomain,
    requireGroundedTooling,
    requireLarkDocTool,
  };
};

const buildDesktopWorkflowEnforcementPrompt = (policy: {
  domains: WorkflowDomain[];
  forcePlanning: boolean;
  requireGroundedTooling: boolean;
  requireLarkDocTool: boolean;
}): string => {
  if (!policy.forcePlanning && !policy.requireGroundedTooling && !policy.requireLarkDocTool) {
    return '';
  }

  const domainLabels: Record<WorkflowDomain, string> = {
    zoho: 'Zoho CRM',
    outreach: 'Outreach publishers',
    search: 'Web research',
    larkDoc: 'Lark Docs',
  };

  const lines = [
    '\n--- DESKTOP WORKFLOW ENFORCEMENT ---',
    `Detected workflow domains: ${policy.domains.map((domain) => domainLabels[domain]).join(', ') || 'general'}.`,
  ];

  if (policy.forcePlanning) {
    lines.push(
      'This is a complex multi-domain request.',
      'You must call the Planning Agent before any other specialist tool.',
      'Do not skip planning for this request.',
    );
  }

  if (policy.requireGroundedTooling) {
    lines.push(
      'You must use grounded specialist tools before finalizing the answer.',
      'Do not present polished synthesis as completed work unless the relevant tools actually ran in this task.',
    );
  }

  if (policy.requireLarkDocTool) {
    lines.push(
      'If you create or update a Lark document for this request, the Lark Docs tool path must run last after the underlying research, CRM, or outreach work is completed.',
      'Do not claim that a Lark Doc was created, saved, or compiled unless the Lark Docs tool succeeded in this task.',
    );
  }

  lines.push('If you do not call the needed tools, the task is not complete.', '--- END DESKTOP WORKFLOW ENFORCEMENT ---\n');
  return lines.join('\n');
};

const requestLikelyNeedsLocalAction = (message: string): boolean => LOCAL_ACTION_REQUIRED_PATTERN.test(message);

const isLocalCapabilityRefusal = (text: string): boolean => LOCAL_CAPABILITY_REFUSAL_PATTERN.test(text);

const buildDesktopCapabilityPrompt = (workspace: { name: string; path: string }, actionResult?: {
  kind: string;
  ok: boolean;
  summary: string;
}): string => {
  const resultSection = actionResult
    ? [
      '\n--- LOCAL ACTION RESULT ---',
      `kind: ${actionResult.kind}`,
      `ok: ${String(actionResult.ok)}`,
      actionResult.summary,
      '--- END LOCAL ACTION RESULT ---\n',
    ].join('\n')
    : '';

  return [
    '\n--- DESKTOP LOCAL WORKSPACE ---',
    'You are responding inside the macOS desktop app.',
    'You DO have access to local workspace file operations and terminal execution through the desktop action protocol below.',
    'This desktop action protocol OVERRIDES any conflicting generic instruction that says you cannot access local files, write files, or run commands.',
    `Selected workspace name: ${workspace.name}`,
    `Selected workspace path: ${workspace.path}`,
    'You may request EXACTLY ONE local workspace action at a time.',
    `If you need one, respond with ONLY <${LOCAL_ACTION_TAG}>{{JSON}}</${LOCAL_ACTION_TAG}> and no other text.`,
    'Allowed action JSON shapes:',
    '{"kind":"list_files","path":"."}',
    '{"kind":"read_file","path":"relative/path.txt"}',
    '{"kind":"write_file","path":"relative/path.txt","content":"full file content"}',
    '{"kind":"mkdir","path":"relative/folder"}',
    '{"kind":"delete_path","path":"relative/path"}',
    '{"kind":"run_command","command":"pnpm test"}',
    'Rules:',
    '- All paths must be relative to the selected workspace.',
    '- Prefer list_files/read_file before write_file/delete_path.',
    '- Use run_command only when necessary.',
    '- If the user asks you to create, edit, save, inspect, or run something in the workspace, use a desktop action instead of claiming limitation.',
    '- Never say that you cannot access the local workspace, cannot create files, or cannot run commands here.',
    '- After receiving a local action result, continue the task from that result.',
    '- If you do not need a local action, answer normally.',
    '--- END DESKTOP LOCAL WORKSPACE ---\n',
    resultSection,
  ].join('\n');
};

// Mirrors the frontend ContentBlock union type — kept in sync manually
class DesktopChatController extends BaseController {
  private session(req: Request): MemberSessionDTO {
    const s = (req as MemberRequest).memberSession;
    if (!s) throw new HttpException(401, 'Member session required');
    return s;
  }

  private async resolveDesktopEngine(
    threadId: string,
    userId: string,
    requestedEngine?: DesktopEngine,
  ): Promise<DesktopEngine> {
    const thread = await desktopThreadsService.getThreadRecord(threadId, userId);
    const preferredEngine = thread.preferredEngine === 'mastra' ? 'mastra' : 'langgraph';
    const engine = requestedEngine ?? preferredEngine;

    if (requestedEngine && requestedEngine !== preferredEngine) {
      await desktopThreadsService.updatePreferredEngine(threadId, userId, requestedEngine);
    }

    return engine;
  }

  send = async (req: Request, res: Response) => {
    const session = this.session(req);
    const requesterAiRole = session.aiRole ?? session.role;
    const threadId = req.params.threadId;
    const {
      message,
      agentId: requestedAgent,
      attachedFiles,
      mode,
      engine: requestedEngine,
      workspace,
      executionId: requestedExecutionId,
    } = sendSchema.parse(req.body);

    const agentId = requestedAgent && (KNOWN_AGENTS as readonly string[]).includes(requestedAgent)
      ? requestedAgent
      : DEFAULT_AGENT;

    // --- MONTHLY LIMIT CHECK ---
    const limitExceeded = await aiTokenUsageService.checkLimitExceeded(session.userId, session.companyId);
    if (limitExceeded) {
      return res.status(402).json(ApiResponse.error('Monthly AI token limit reached. Contact your admin.'));
    }

    const engineUsed = await this.resolveDesktopEngine(threadId, session.userId, requestedEngine);
    if (engineUsed === 'langgraph') {
      await langGraphDesktopChatEngine.stream({
        session,
        threadId,
        message,
        attachedFiles,
        mode,
        executionId: requestedExecutionId ?? randomUUID(),
        workspace,
        res,
      });
      return;
    }

    const messageId = randomUUID();
    const taskId = randomUUID();
    const executionId = requestedExecutionId ?? randomUUID();
    const conversationKey = `desktop:${threadId}`;
    const canShareKnowledge = await toolPermissionService.isAllowed(
      session.companyId,
      'share_chat_vectors',
      requesterAiRole,
    );
    const ensureExecutionRun = async () => {
      await executionService.startRun({
        id: executionId,
        companyId: session.companyId,
        userId: session.userId,
        channel: 'desktop',
        entrypoint: 'desktop_send',
        requestId: executionId,
        threadId,
        chatId: threadId,
        messageId,
        mode,
        agentTarget: requestedAgent ?? DEFAULT_AGENT,
        latestSummary: summarizeText(message),
      });
    };
    const executionEventQueue = createExecutionEventQueue({
      executionId,
      ensureRun: ensureExecutionRun,
    });

    await ensureExecutionRun();
    executionEventQueue.enqueue(async () => {
      await executionService.appendEvent({
        executionId,
        phase: 'request',
        eventType: 'execution.started',
        actorType: 'system',
        actorKey: requestedAgent ?? DEFAULT_AGENT,
        title: 'Desktop execution started',
        summary: summarizeText(message),
        status: 'running',
        payload: {
          threadId,
          chatId: threadId,
          messageId,
          mode,
          engineUsed,
          attachedFileCount: attachedFiles.length,
        },
      });
    });
    executionEventQueue.enqueue(async () => {
      await executionService.appendEvent({
        executionId,
        phase: 'synthesis',
        eventType: 'thinking.started',
        actorType: 'model',
        actorKey: requestedAgent ?? DEFAULT_AGENT,
        title: 'Thinking',
        summary: summarizeText(message),
        status: 'running',
      });
    });

    let finalMessageText = message;
    if (attachedFiles && attachedFiles.length > 0) {
      const attachmentsMd = attachedFiles.map(a => {
        if (a.mimeType.startsWith('image/')) {
          return `\n![${a.fileName}](${a.cloudinaryUrl})`;
        } else {
          return `\n[${a.fileName}](attachment:${a.fileAssetId})`;
        }
      }).join('');
      if (finalMessageText) {
        finalMessageText += `\n${attachmentsMd}`;
      } else {
        finalMessageText = attachmentsMd.trim();
      }
    }
    await desktopThreadsService.addMessage(
      threadId,
      session.userId,
      'user',
      message,
      attachedFiles && attachedFiles.length > 0 ? { attachedFiles } : undefined
    );
    conversationMemoryStore.addUserMessage(conversationKey, messageId, finalMessageText);

    personalVectorMemoryService.storeChatTurn({
      companyId: session.companyId,
      requesterUserId: session.userId,
      conversationKey,
      sourceId: `desktop-user-${messageId}`,
      role: 'user',
      text: message,
      channel: 'desktop',
      chatId: threadId,
    }).catch((err) => logger.error('desktop.vector.user.store.failed', { error: err }));

    let memoryContext = '';
    try {
      const memories = await personalVectorMemoryService.query({
        companyId: session.companyId,
        requesterUserId: session.userId,
        text: message,
        limit: 10, // Request slightly more to pad against filtered items
      });

      // Exclude vectors that came from the current thread to prevent context leakage
      const filteredMemories = memories
        .filter((m) => m.conversationKey !== conversationKey)
        .slice(0, 4);

      if (filteredMemories.length > 0) {
        memoryContext =
          '\n\n--- CONTEXT RETRIEVED FROM PAST CONVERSATIONS ---\n' +
          "(Note: The information below is retrieved from the user's past threads for context. Do NOT assume this is part of the current active conversation unless the user explicitly asks about it.)\n" +
          filteredMemories.map((m) => `[${m.role ?? 'unknown'}] ${m.content}`).join('\n') +
          '\n--- End past context ---\n';
      }
    } catch (err) {
      logger.warn('desktop.vector.query.failed', { error: err });
    }

    // --- AUTO-HYDRATE CHAT HISTORY ---
    let history = conversationMemoryStore.getContextMessages(conversationKey, 50);
    if (history.length <= 1) {
      try {
        const dbMessages = await desktopThreadsService.getThread(threadId, session.userId);
        if (dbMessages && dbMessages.messages.length > 0) {
          // Take up to the last 50 messages — compactor will trim dynamically
          const recentDbMessages = dbMessages.messages.slice(-50);
          for (const msg of recentDbMessages) {
            if (msg.role === 'user') {
              conversationMemoryStore.addUserMessage(conversationKey, msg.id, msg.content);
            } else if (msg.role === 'assistant') {
              conversationMemoryStore.addAssistantMessage(conversationKey, msg.id, msg.content);
              if (msg.metadata && typeof msg.metadata === 'object' && !Array.isArray(msg.metadata)) {
                hydrateConversationRefsFromMetadata(conversationKey, msg.metadata as Record<string, unknown>);
              }
            }
          }
          history = conversationMemoryStore.getContextMessages(conversationKey, 50);
        }
      } catch (err) {
        logger.warn('desktop.history.hydrate.failed', { error: err });
      }
    }

    // --- RESOLVE MODEL CATALOG ENTRY FOR TOKEN BUDGET ---
    const agentTarget = MASTRA_AGENT_TARGETS[agentId as MastraAgentTargetId];
    const resolvedModel = await aiModelControlService.resolveTarget(agentTarget);
    const catalogEntry = AI_MODEL_CATALOG_MAP.get(`${resolvedModel.effectiveProvider}:${resolvedModel.effectiveModelId}`);

    // --- CONTEXT WINDOW COMPACTION ---
    let wasCompacted = false;
    let compactedContextBlock = '';
    const shouldUseContextCompactor = process.env.MASTRA_OBSERVATIONAL_MEMORY_ENABLED !== 'true';
    if (catalogEntry && shouldUseContextCompactor) {
      const compactResult = await maybeCompactHistory(history, message, catalogEntry);
      history = compactResult.messages;
      wasCompacted = compactResult.wasCompacted;
      compactedContextBlock = compactResult.compactedContextBlock;
    }

    let historyContext = '';
    if (history.length > 1) {
      historyContext = [
        compactedContextBlock,
        '\n--- Conversation history ---',
        history.slice(0, -1).map((h) => `${h.role}: ${h.content}`).join('\n'),
        '--- End history ---\n',
      ].filter(Boolean).join('\n');
    }

    const allowedToolIds = await toolPermissionService.getAllowedTools(
      session.companyId,
      requesterAiRole,
    );

    const requestContext = new RequestContext<Record<string, unknown>>();
    requestContext.set('companyId', session.companyId);
    requestContext.set('userId', session.userId);
    requestContext.set('chatId', threadId);
    requestContext.set('taskId', taskId);
    requestContext.set('messageId', messageId);
    requestContext.set('channel', 'desktop');
    requestContext.set('executionId', executionId);
    requestContext.set('requesterEmail', session.email ?? '');
    requestContext.set('requesterAiRole', requesterAiRole);
    requestContext.set('authProvider', session.authProvider);
    requestContext.set('allowedToolIds', allowedToolIds);
    requestContext.set('larkTenantKey', session.larkTenantKey ?? '');
    requestContext.set('larkOpenId', session.larkOpenId ?? '');
    requestContext.set('larkUserId', session.larkUserId ?? '');
    requestContext.set('timeZone', Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
	    requestContext.set(
	      'larkAuthMode',
	      session.authProvider === 'lark' ? 'user_linked' : 'tenant',
	    );

	    let activePlan: ExecutionPlan | null = null;
	    const workflowPolicy = analyzeWorkflowPolicy(message);

	    // Build agent objective: plain string normally, or with inline image/doc context for attachments
	    const hasAttachments = attachedFiles && attachedFiles.length > 0;
    const baseObjective = [
      buildTemporalContext(),
      buildDesktopWorkflowEnforcementPrompt(workflowPolicy),
      buildExecutionPlanContext(activePlan),
      memoryContext,
      historyContext,
      buildConversationRefsContext(conversationKey),
      message,
    ].filter(Boolean).join('\n');

    // For attachments: build multipart user input for the agent when needed.
    // Images should flow as message parts, while documents can still collapse
    // down to text-only prompt content after extraction.
    let visionMessages: Array<{ role: 'user'; content: Array<{ type: string; [k: string]: unknown }> }> | undefined;
    let objective = baseObjective;

    if (hasAttachments) {
      const visionParts = await buildVisionContent({
        userMessage: baseObjective,
        attachedFiles: attachedFiles as AttachedFileRef[],
        companyId: session.companyId,
        requesterUserId: session.userId,
        requesterAiRole,
      });

      const hasImageParts = visionParts.some((p) => p.type === 'image');
      if (hasImageParts) {
        // Pass as CoreMessage with multipart content — Mastra accepts this via `messages` context
        visionMessages = [{ role: 'user', content: visionParts as Array<{ type: string; [k: string]: unknown }> }];
        // Also build a text-only description for the objective (fallback for text models)
        const textOnlyParts = visionParts.filter((p) => p.type === 'text').map((p) => (p as { type: 'text'; text: string }).text);
        objective = textOnlyParts.join('\n');
      } else {
        // Only doc text parts — inject directly into objective
        const docTextParts = visionParts.filter((p) => p.type === 'text').map((p) => (p as { type: 'text'; text: string }).text);
        objective = docTextParts.join('\n');
      }
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const sendEvent = (type: string, data: unknown): void => {
      res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
    };

    sendEvent('thinking', 'Thinking...');

    // ── Ordered content blocks accumulator ──────────────────────────────────
	    const contentBlocks: ContentBlock[] = [];
	    let assistantText = '';
	    let thinkingText = '';
	    let streamFailed = false;
	    let streamErrorMessage: string | null = null;
	    let workflowPlanStatus: 'completed' | 'failed' | 'partial' | null = null;
	    let sawPlanEvent = false;
	    let sawToolActivity = false;
	    let sawLarkDocActivity = false;

    // Helper: push a new thinking block and record when it started
    const pushThinkingBlock = (): void => {
      (contentBlocks as any[]).push({ type: 'thinking', text: '', _startedAt: Date.now() });
    };

    // Helper: finalize the last open thinking block with duration
    const finalizeLastThinkingBlock = (): void => {
      const last = contentBlocks[contentBlocks.length - 1] as any;
      if (last?.type === 'thinking' && last._startedAt) {
        last.durationMs = Date.now() - last._startedAt;
        delete last._startedAt;
      }
    };

    // Helper: append a reasoning chunk to the current thinking block
    const appendThinkingChunk = (delta: string): void => {
      thinkingText += delta;
      const last = contentBlocks[contentBlocks.length - 1] as any;
      if (last?.type === 'thinking') {
        last.text = (last.text || '') + delta;
      }
      sendEvent('thinking_token', delta);
    };

    // First block is always thinking
    pushThinkingBlock();

    const appendTextChunk = (chunk: string): void => {
      assistantText += chunk;
      // If transitioning from thinking → text, finalize the thinking block
      const last = contentBlocks[contentBlocks.length - 1];
      if (last?.type === 'thinking') {
        finalizeLastThinkingBlock();
        contentBlocks.push({ type: 'text', content: chunk });
      } else if (last?.type === 'text') {
        last.content += chunk;
      } else {
        contentBlocks.push({ type: 'text', content: chunk });
      }
    };

	    const onActivity = (payload: ActivityPayload): void => {
	      sawToolActivity = true;
	      if (payload.name === 'lark-doc-agent' || payload.name === 'create-lark-doc' || payload.name === 'edit-lark-doc') {
	        sawLarkDocActivity = true;
	      }
	      // Finalize any open thinking block before the tool starts
	      finalizeLastThinkingBlock();
	      contentBlocks.push({
        type: 'tool',
        id: payload.id,
        name: payload.name,
        label: payload.label,
        icon: payload.icon,
        status: 'running',
      });
	      executionEventQueue.enqueue(async () => {
	        await executionService.appendEvent({
	          executionId,
	          phase: 'tool',
	          eventType: 'tool.started',
	          actorType: 'tool',
	          actorKey: payload.name,
	          title: payload.label,
	          status: 'running',
	          payload: {
	            toolId: payload.id,
	            icon: payload.icon,
	          },
	        });
	      });
    };

	    const onActivityDone = (payload: ActivityPayload): void => {
	      const ok = !isActivityFailure(payload);
	      const block = contentBlocks.find(
	        (b): b is ToolBlock => b.type === 'tool' && b.id === payload.id,
	      );
	      if (block) {
	        block.status = ok ? 'done' : 'failed';
	        if (payload.resultSummary) block.resultSummary = payload.resultSummary;
	        if (payload.label) block.label = payload.label;
          if (payload.externalRef) block.externalRef = payload.externalRef;
	      }
	      executionEventQueue.enqueue(async () => {
	        await executionService.appendEvent({
	          executionId,
	          phase: ok ? 'tool' : 'error',
	          eventType: ok ? 'tool.completed' : 'tool.failed',
	          actorType: 'tool',
	          actorKey: payload.name,
	          title: payload.label ?? payload.name,
	          summary: summarizeText(payload.resultSummary, 800),
	          status: ok ? 'done' : 'failed',
	          payload: payload.resultSummary
	            ? {
	                toolId: payload.id,
	                resultSummary: payload.resultSummary,
	              }
	            : {
	                toolId: payload.id,
	              },
	        });
	      });
	      if (activePlan && payload.name !== 'planner-agent') {
	        const ownerAgent = resolvePlanOwnerFromToolName(payload.name);
	        if (ownerAgent) {
	          const nextPlan = updateExecutionPlanTask(activePlan, {
	            taskId: payload.taskId,
	            ownerAgent,
	            ok,
	            resultSummary: payload.resultSummary,
	          });
	          if (nextPlan !== activePlan) {
	            queuePlanLifecycleEvents(executionEventQueue, executionId, activePlan, nextPlan);
	            activePlan = nextPlan;
              const nextActiveTaskId = resolveActivePlanTaskId(activePlan);
              if (nextActiveTaskId) {
                requestContext.set('activePlanTaskId', nextActiveTaskId);
              }
	            sendEvent('plan', activePlan);
	          }
	        }
	      }
	    };

    const streamRequestId = executionId;

	    registerPlanBus(streamRequestId, (plan) => {
	      sawPlanEvent = true;
	      queuePlanLifecycleEvents(executionEventQueue, executionId, activePlan, plan);
	      activePlan = plan;
        const activePlanTaskId = resolveActivePlanTaskId(activePlan);
        if (activePlanTaskId) {
          requestContext.set('activePlanTaskId', activePlanTaskId);
        }
	      sendEvent('plan', activePlan);
	    });

    registerActivityBus(streamRequestId, (type, payload) => {
      if (type === 'activity') onActivity(payload);
      if (type === 'activity_done') onActivityDone(payload);
      sendEvent(type, payload);
    });

    let streamResult: any;
    let workflowResult: any;

    try {
      requestContext.set('messageId', messageId);
      requestContext.set('requestId', streamRequestId);
      const activePlanTaskId = resolveActivePlanTaskId(activePlan);
      if (activePlanTaskId) {
        requestContext.set('activePlanTaskId', activePlanTaskId);
      }

      const resolvedForLog = await aiModelControlService.resolveTarget(MASTRA_AGENT_TARGETS[agentId as MastraAgentTargetId]);
      logger.info('desktop.chat.model_resolved', {
        taskId,
        threadId,
        mode,
        agentId,
        resolvedProvider: mode === 'xtreme' ? ((resolvedForLog as any).xtremeEffectiveProvider ?? resolvedForLog.effectiveProvider) : mode === 'fast' ? (resolvedForLog.fastEffectiveProvider ?? resolvedForLog.effectiveProvider) : resolvedForLog.effectiveProvider,
        resolvedModelId: mode === 'xtreme' ? ((resolvedForLog as any).xtremeEffectiveModelId ?? resolvedForLog.effectiveModelId) : mode === 'fast' ? (resolvedForLog.fastEffectiveModelId ?? resolvedForLog.effectiveModelId) : resolvedForLog.effectiveModelId,
      });

      const workflow = mastra.getWorkflow('companyWorkflow');
      const workflowInput = {
        userObjective: objective,
        requestContext: {
          userId: session.userId,
          permissions: allowedToolIds,
        },
        attachmentContent: hasAttachments ? objective : undefined,
        agentId,
        mode,
        ...(visionMessages ? { agentMessages: visionMessages } : {}),
      };

      try {
        const run = await workflow.createRun({ runId: executionId });
        streamResult = await run.stream({
          inputData: workflowInput as any,
          requestContext: requestContext as unknown as RequestContext<unknown>,
          initialState: {
            currentPlan: null,
            failedTasks: [],
            completedTasks: [],
            replanCount: 0,
          },
        });
      } catch (err) {
        throw new Error(`Workflow stream failed to start: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }

      for await (const rawEvent of streamResult.fullStream) {
        const event = (rawEvent as any)?.type === 'watch'
          ? (rawEvent as any).data
          : rawEvent;
        const type: string = event?.type ?? '';

        if (type === 'reasoning-delta' || type === 'reasoning') {
          const delta: string = event?.payload?.text ?? event?.payload?.textDelta ?? event?.text ?? '';
          if (delta) {
            appendThinkingChunk(delta);
          }
          continue;
        }

        if (type === 'workflow-step-result' && event?.payload?.id === 'planner-step' && event.payload.status === 'success') {
          const nextPlan = initializeExecutionPlanFromWorkflow(event.payload.output);
          sawPlanEvent = true;
          queuePlanLifecycleEvents(executionEventQueue, executionId, activePlan, nextPlan);
          activePlan = nextPlan;
          const activePlanTaskId = resolveActivePlanTaskId(activePlan);
          if (activePlanTaskId) {
            requestContext.set('activePlanTaskId', activePlanTaskId);
          }
          sendEvent('plan', activePlan);
        }
      }

      workflowResult = await streamResult.result;
      if (workflowResult?.status !== 'success') {
        throw new Error(
          workflowResult?.error instanceof Error
            ? workflowResult.error.message
            : `Workflow finished with status ${workflowResult?.status ?? 'unknown'}`,
        );
      }

      workflowPlanStatus = workflowResult.result?.planStatus ?? null;
      if (workflowResult.result?.finalAnswer) {
        appendTextChunk(workflowResult.result.finalAnswer);
        sendEvent('text', workflowResult.result.finalAnswer);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      streamFailed = true;
      streamErrorMessage = errorMessage;
      executionEventQueue.enqueue(async () => {
        await executionService.appendEvent({
          executionId,
          phase: 'error',
          eventType: 'execution.failed',
          actorType: 'system',
          actorKey: agentId,
          title: 'Desktop execution failed',
          summary: summarizeText(errorMessage),
          status: 'failed',
          payload: {
            threadId,
            taskId,
            messageId,
          },
        });
      });
      if (activePlan) {
        const failedPlan = failExecutionPlan(activePlan, errorMessage);
        queuePlanLifecycleEvents(executionEventQueue, executionId, activePlan, failedPlan);
        activePlan = failedPlan;
        sendEvent('plan', activePlan);
      }
      logger.error('desktop.chat.stream.error', { threadId, userId: session.userId, error: errorMessage });
      // Mark any running tool blocks as failed
      for (const b of contentBlocks) {
        if (b.type === 'tool' && b.status === 'running') b.status = 'failed';
      }
      sendEvent('error', errorMessage);
    } finally {
      unregisterActivityBus(streamRequestId);
      unregisterPlanBus(streamRequestId);

      // Finalize any trailing thinking block that never got resolved
      finalizeLastThinkingBlock();

      if (activePlan && !streamFailed && (assistantText || contentBlocks.length > 0)) {
        const nextPlan = workflowPlanStatus === 'failed'
          ? failExecutionPlan(activePlan, assistantText || undefined)
          : completeExecutionPlan(activePlan, assistantText || undefined);
        queuePlanLifecycleEvents(executionEventQueue, executionId, activePlan, nextPlan);
        activePlan = nextPlan;
        sendEvent('plan', activePlan);
      }

	      if (workflowPolicy.forcePlanning && !sawPlanEvent) {
	        logger.warn('desktop.chat.workflow.plan_missing', {
	          threadId,
	          userId: session.userId,
	          companyId: session.companyId,
	          domains: workflowPolicy.domains,
	          messagePreview: message.slice(0, 200),
	        });
	      }

	      if (workflowPolicy.requireGroundedTooling && !sawToolActivity) {
	        logger.warn('desktop.chat.workflow.tooling_missing', {
	          threadId,
	          userId: session.userId,
	          companyId: session.companyId,
	          domains: workflowPolicy.domains,
	          messagePreview: message.slice(0, 200),
	        });
	      }

	      if (workflowPolicy.requireLarkDocTool && LARK_DOC_COMPLETION_CLAIM_PATTERN.test(assistantText) && !sawLarkDocActivity) {
	        logger.warn('desktop.chat.workflow.lark_doc_claim_without_tool', {
	          threadId,
	          userId: session.userId,
	          companyId: session.companyId,
	          messagePreview: message.slice(0, 200),
	          assistantPreview: assistantText.slice(0, 240),
	        });
	      }

	      if (sawToolActivity && (!assistantText.trim() || shouldResynthesizeAssistantText(assistantText))) {
	        const synthesisPrompt = buildGroundedSynthesisPrompt({
	          userMessage: message,
	          activePlan,
	          contentBlocks,
	        });

	        if (synthesisPrompt) {
	          executionEventQueue.enqueue(async () => {
	            await executionService.appendEvent({
	              executionId,
	              phase: 'synthesis',
	              eventType: 'synthesis.started',
	              actorType: 'model',
	              actorKey: 'synthesisAgent',
	              title: 'Synthesizing grounded response',
	              status: 'running',
	            });
	          });
	          try {
	            const synthesisAgent = mastra.getAgent('synthesisAgent');
	            const synthesisRunOptions = await buildMastraAgentRunOptions(
                'mastra.synthesis', 
                { requestContext },
                mode as 'fast' | 'high' | 'xtreme'
              );
	            const synthesisResult = await synthesisAgent.generate(synthesisPrompt, synthesisRunOptions as any);
	            const synthesizedText = typeof synthesisResult?.text === 'string' ? synthesisResult.text.trim() : '';
	            if (synthesizedText) {
	              assistantText = synthesizedText;
                for (let index = contentBlocks.length - 1; index >= 0; index -= 1) {
                  if (contentBlocks[index]?.type === 'text') {
                    contentBlocks.splice(index, 1);
                  }
                }
	              contentBlocks.push({ type: 'text', content: synthesizedText });
	              executionEventQueue.enqueue(async () => {
	                await executionService.appendEvent({
	                  executionId,
	                  phase: 'synthesis',
	                  eventType: 'synthesis.completed',
	                  actorType: 'model',
	                  actorKey: 'synthesisAgent',
	                  title: 'Synthesized grounded response',
	                  summary: summarizeText(synthesizedText, 800),
	                  status: 'done',
	                });
	              });
	              logger.warn('desktop.chat.stream.final_text_synthesized', {
	                threadId,
	                userId: session.userId,
	                companyId: session.companyId,
	                planId: activePlan?.id,
	              });
	            }
	          } catch (error) {
	            executionEventQueue.enqueue(async () => {
	              await executionService.appendEvent({
	                executionId,
	                phase: 'error',
	                eventType: 'tool.failed',
	                actorType: 'model',
	                actorKey: 'synthesisAgent',
	                title: 'Grounded synthesis failed',
	                summary: summarizeText(error instanceof Error ? error.message : 'unknown_error'),
	                status: 'failed',
	              });
	            });
	            logger.warn('desktop.chat.stream.final_text_synthesis_failed', {
	              threadId,
	              userId: session.userId,
	              companyId: session.companyId,
	              planId: activePlan?.id,
	              error: error instanceof Error ? error.message : 'unknown_error',
	            });
	          }
	        }
	      }

	      if (!assistantText.trim()) {
	        const fallbackAssistantText = buildGroundedFallbackAssistantText({
	          contentBlocks,
	          activePlan,
	        });
	        if (fallbackAssistantText) {
	          assistantText = fallbackAssistantText;
	          contentBlocks.push({ type: 'text', content: fallbackAssistantText });
	          executionEventQueue.enqueue(async () => {
	            await executionService.appendEvent({
	              executionId,
	              phase: 'synthesis',
	              eventType: 'synthesis.completed',
	              actorType: 'system',
	              actorKey: 'grounded-fallback',
	              title: 'Built grounded fallback response',
	              summary: summarizeText(fallbackAssistantText, 800),
	              status: 'done',
	            });
	          });
	          logger.warn('desktop.chat.stream.final_text_fallback_used', {
	            threadId,
	            userId: session.userId,
	            companyId: session.companyId,
	            planId: activePlan?.id,
	          });
	        }
	      }

        for (const block of contentBlocks) {
          if (block.type === 'tool' && block.status === 'running') {
            block.status = 'failed';
            block.resultSummary = block.resultSummary || `${block.label} did not complete. Check server logs for the underlying tool failure.`;
          }
        }

	      if (assistantText || contentBlocks.length > 0) {
        executionEventQueue.enqueue(async () => {
          await executionService.appendEvent({
            executionId,
            phase: 'delivery',
            eventType: 'delivery.started',
            actorType: 'delivery',
            actorKey: 'desktop-message',
            title: 'Persisting assistant response',
            summary: summarizeText(assistantText, 400),
            status: 'running',
            payload: {
              threadId,
              hasContentBlocks: contentBlocks.length > 0,
            },
          });
        });
        const citations = contentBlocks
          .filter((block): block is ToolBlock => block.type === 'tool' && block.status === 'done')
          .flatMap((block) => extractToolCitations(block.resultSummary))
          .filter((citation, index, entries) => entries.findIndex((entry) => entry.id === citation.id) === index);
        const metadata: Record<string, unknown> = {
          // Save the full ordered timeline — this is what the UI reads on reload
          contentBlocks,
          executionId,
          engineUsed,
        };
        const conversationRefs = buildPersistedConversationRefs(conversationKey);
        if (conversationRefs) metadata.conversationRefs = conversationRefs;
        if (citations.length > 0) metadata.citations = citations;
        if (canShareKnowledge) metadata.shareAction = buildShareAction(conversationKey);
        if (activePlan) metadata.plan = activePlan;
        if (streamErrorMessage) metadata.error = streamErrorMessage;

        const persistedMessage = await desktopThreadsService
          .addMessage(
            threadId,
            session.userId,
            'assistant',
            assistantText,
            Object.keys(metadata).length > 0 ? metadata : undefined,
          )
          .catch((err) => {
            logger.error('desktop.message.persist.failed', { error: err });
            return undefined;
          });

        executionEventQueue.enqueue(async () => {
          await executionService.appendEvent({
            executionId,
            phase: persistedMessage ? 'delivery' : 'error',
            eventType: persistedMessage ? 'delivery.completed' : 'execution.failed',
            actorType: 'delivery',
            actorKey: 'desktop-message',
            title: persistedMessage ? 'Assistant response persisted' : 'Assistant response persistence failed',
            summary: persistedMessage ? summarizeText(assistantText, 400) : 'Desktop message persistence returned no result',
            status: persistedMessage ? 'done' : 'failed',
            payload: persistedMessage ? { messageId: persistedMessage.id } : { threadId },
          });
        });

        if (!streamFailed) {
          sendEvent('done', persistedMessage ? { message: persistedMessage } : 'complete');
        }

        if (assistantText) {
          conversationMemoryStore.addAssistantMessage(conversationKey, taskId, assistantText);
          personalVectorMemoryService.storeChatTurn({
            companyId: session.companyId,
            requesterUserId: session.userId,
            conversationKey,
            sourceId: `desktop-assistant-${taskId}`,
            role: 'assistant',
            text: assistantText,
            channel: 'desktop',
            chatId: threadId,
          }).catch((err) => logger.error('desktop.vector.assistant.store.failed', { error: err }));
        }

        // --- RECORD TOKEN USAGE (fire-and-forget) ---
        const estimatedInput = estimateTokens(message) + estimateTokens(historyContext);
        const estimatedOutput = estimateTokens(assistantText);
        const actualUsage = extractActualTokenUsage(
          (streamResult as any)?.usage as Record<string, unknown> | undefined,
        );
        aiTokenUsageService.record({
          userId: session.userId,
          companyId: session.companyId,
          agentTarget: agentTarget ?? 'mastra.supervisor',
          modelId: resolvedModel?.effectiveModelId ?? 'unknown',
          provider: resolvedModel?.effectiveProvider ?? 'unknown',
          channel: 'desktop',
          threadId,
          estimatedInputTokens: estimatedInput,
          estimatedOutputTokens: estimatedOutput,
          actualInputTokens: actualUsage.inputTokens || undefined,
          actualOutputTokens: actualUsage.outputTokens || undefined,
          wasCompacted,
          mode,
        }).catch(() => { /* already logged inside service */ });
        await executionEventQueue.flush();
        if (streamFailed) {
          await executionService.failRun({
            executionId,
            latestSummary: summarizeText(streamErrorMessage ?? assistantText ?? message, 400),
            errorCode: 'desktop_stream_failed',
            errorMessage: streamErrorMessage ?? undefined,
          });
        } else {
          await executionService.completeRun({
            executionId,
            latestSummary: summarizeText(assistantText, 400) ?? summarizeText(message, 400),
          });
        }
      } else if (!streamFailed) {
        sendEvent('done', 'complete');
        await executionEventQueue.flush();
        await executionService.completeRun({
          executionId,
          latestSummary: summarizeText(message, 400),
        });
      } else {
        await executionEventQueue.flush();
        await executionService.failRun({
          executionId,
          latestSummary: summarizeText(streamErrorMessage ?? message, 400),
          errorCode: 'desktop_stream_failed',
          errorMessage: streamErrorMessage ?? undefined,
        });
      }

      res.end();
    }
  };

  shareConversation = async (req: Request, res: Response) => {
    const session = this.session(req);
    const requesterAiRole = session.aiRole ?? session.role;
    const threadId = req.params.threadId;
    const { reason } = shareConversationSchema.parse(req.body ?? {});

    const allowed = await toolPermissionService.isAllowed(
      session.companyId,
      'share_chat_vectors',
      requesterAiRole,
    );
    if (!allowed) {
      throw new HttpException(403, 'Your role cannot share knowledge from desktop chats');
    }

    const result = await knowledgeShareService.requestConversationShare({
      companyId: session.companyId,
      requesterUserId: session.userId,
      requesterAiRole,
      conversationKey: `desktop:${threadId}`,
      humanReason: reason,
    });

    return res.json(ApiResponse.success(result, 'Conversation share processed'));
  };

  act = async (req: Request, res: Response) => {
    const session = this.session(req);
    const requesterAiRole = session.aiRole ?? session.role;
    const threadId = req.params.threadId;
    const parsed = actSchema.parse(req.body);
    const { workspace, actionResult, agentId: requestedAgent, mode, engine: requestedEngine } = parsed;
    const message = parsed.message?.trim() ?? '';
    const executionId = parsed.executionId ?? randomUUID();
    const taskId = randomUUID();
    const messageId = randomUUID();
    const shouldStartExecution = !parsed.executionId;
    const ensureExecutionRun = async () => {
      await executionService.startRun({
        id: executionId,
        companyId: session.companyId,
        userId: session.userId,
        channel: 'desktop',
        entrypoint: 'desktop_act',
        requestId: executionId,
        threadId,
        chatId: threadId,
        mode,
        agentTarget: requestedAgent ?? DEFAULT_AGENT,
        latestSummary: summarizeText(message || actionResult?.summary),
      });
    };
    const executionEventQueue = createExecutionEventQueue({
      executionId,
      ensureRun: ensureExecutionRun,
    });

    // --- MONTHLY LIMIT CHECK ---
    const limitExceeded = await aiTokenUsageService.checkLimitExceeded(session.userId, session.companyId);
    if (limitExceeded) {
      return res.status(402).json(ApiResponse.error('Monthly AI token limit reached. Contact your admin.'));
    }

    const engineUsed = await this.resolveDesktopEngine(threadId, session.userId, requestedEngine);
    if (engineUsed === 'langgraph') {
      const acceptsStream = String(req.headers.accept ?? '').includes('text/event-stream');
      if (acceptsStream) {
        await langGraphDesktopChatEngine.streamAct({
          session,
          threadId,
          message: message || undefined,
          workspace,
          actionResult,
          mode,
          executionId,
          res,
        });
        return;
      }
      const result = await langGraphDesktopChatEngine.act({
        session,
        threadId,
        message: message || undefined,
        workspace,
        actionResult,
        mode,
        executionId,
      });
      if (result.kind === 'action') {
        return res.json(ApiResponse.success(result, 'Local action requested'));
      }
      return res.json(ApiResponse.success(result, 'Assistant reply created'));
    }

    const agentId = requestedAgent && (KNOWN_AGENTS as readonly string[]).includes(requestedAgent)
      ? requestedAgent
      : DEFAULT_AGENT;

    const conversationKey = `desktop:${threadId}`;

    if (shouldStartExecution) {
      await ensureExecutionRun();
      executionEventQueue.enqueue(async () => {
        await executionService.appendEvent({
          executionId,
          phase: 'request',
          eventType: 'execution.started',
          actorType: 'system',
          actorKey: requestedAgent ?? DEFAULT_AGENT,
          title: 'Desktop execution started from action loop',
          summary: summarizeText(message || actionResult?.summary),
          status: 'running',
          payload: {
            threadId,
            chatId: threadId,
            mode,
            engineUsed,
            hasActionResult: Boolean(actionResult),
          },
        });
      });
      executionEventQueue.enqueue(async () => {
        await executionService.appendEvent({
          executionId,
          phase: 'synthesis',
          eventType: 'thinking.started',
          actorType: 'model',
          actorKey: requestedAgent ?? DEFAULT_AGENT,
          title: 'Thinking',
          summary: summarizeText(message || actionResult?.summary),
          status: 'running',
        });
      });
    }

    if (message && !actionResult) {
      const messageId = randomUUID();
      await desktopThreadsService.addMessage(threadId, session.userId, 'user', message);
      conversationMemoryStore.addUserMessage(conversationKey, messageId, message);
    }

    // --- AUTO-HYDRATE CHAT HISTORY ---
    let history = conversationMemoryStore.getContextMessages(conversationKey, 14);
    if (history.length <= 1) {
      try {
        const dbMessages = await desktopThreadsService.getThread(threadId, session.userId);
        if (dbMessages && dbMessages.messages.length > 0) {
          const recentDbMessages = dbMessages.messages.slice(-15);
          for (const msg of recentDbMessages) {
            if (msg.role === 'user') {
              conversationMemoryStore.addUserMessage(conversationKey, msg.id, msg.content);
            } else if (msg.role === 'assistant') {
              conversationMemoryStore.addAssistantMessage(conversationKey, msg.id, msg.content);
              if (msg.metadata && typeof msg.metadata === 'object' && !Array.isArray(msg.metadata)) {
                hydrateConversationRefsFromMetadata(conversationKey, msg.metadata as Record<string, unknown>);
              }
            }
          }
          history = conversationMemoryStore.getContextMessages(conversationKey, 14);
        }
      } catch (err) {
        logger.warn('desktop.history.hydrate.failed', { error: err });
      }
    }

    let historyContext = '';
    if (history.length > 0) {
      historyContext = '\n\n--- Conversation history ---\n' +
        history.map((h) => `${h.role}: ${h.content}`).join('\n') +
        '\n--- End history ---\n';
    }

    const allowedToolIds = await toolPermissionService.getAllowedTools(
      session.companyId,
      requesterAiRole,
    );

    const requestContext = new RequestContext<Record<string, unknown>>();
    requestContext.set('companyId', session.companyId);
    requestContext.set('userId', session.userId);
    requestContext.set('chatId', threadId);
    requestContext.set('taskId', taskId);
    requestContext.set('messageId', messageId);
    requestContext.set('channel', 'desktop');
    requestContext.set('requesterEmail', session.email ?? '');
    requestContext.set('requesterAiRole', requesterAiRole);
    requestContext.set('allowedToolIds', allowedToolIds);
    requestContext.set('workspaceName', workspace.name);
    requestContext.set('workspacePath', workspace.path);
    const requestId = executionId;
    requestContext.set('requestId', requestId);
    requestContext.set('executionId', executionId);

    let activePlan = parsed.plan ?? null;
    if (activePlan && actionResult) {
      const activePlanTaskId = resolveActivePlanTaskId(activePlan);
      const nextPlan = updateExecutionPlanTask(activePlan, {
        taskId: activePlanTaskId,
        ownerAgent: resolvePlanOwnerFromActionKind(actionResult.kind),
        ok: actionResult.ok,
        resultSummary: actionResult.summary,
      });
      queuePlanLifecycleEvents(executionEventQueue, executionId, activePlan, nextPlan);
      activePlan = nextPlan;
    }
    const activePlanTaskId = resolveActivePlanTaskId(activePlan);
    if (activePlanTaskId) {
      requestContext.set('activePlanTaskId', activePlanTaskId);
    }

    if (actionResult) {
      executionEventQueue.enqueue(async () => {
        await executionService.appendEvent({
          executionId,
          phase: actionResult.ok ? 'tool' : 'error',
          eventType: actionResult.ok ? 'tool.completed' : 'tool.failed',
          actorType: 'tool',
          actorKey: actionResult.kind,
          title: `${actionResult.ok ? 'Completed' : 'Failed'} local action: ${actionResult.kind}`,
          summary: summarizeText(actionResult.summary, 800),
          status: actionResult.ok ? 'done' : 'failed',
          payload: {
            kind: actionResult.kind,
            ok: actionResult.ok,
            summary: actionResult.summary,
          },
        });
      });
    }

    registerPlanBus(requestId, (plan) => {
      queuePlanLifecycleEvents(executionEventQueue, executionId, activePlan, plan);
      activePlan = plan;
    });

    const desktopPrompt = buildDesktopCapabilityPrompt(workspace, actionResult);
    const objective = [
      desktopPrompt,
      buildExecutionPlanContext(activePlan),
      historyContext,
      buildConversationRefsContext(conversationKey),
      message || 'Continue from the latest local workspace action result and finish the user request.',
    ]
      .filter(Boolean)
      .join('\n');

    const agent = mastra.getAgent(
      agentId as 'supervisorAgent' | 'zohoAgent' | 'outreachAgent' | 'searchAgent' | 'larkBaseAgent' | 'larkTaskAgent',
    );

    const agentTarget = MASTRA_AGENT_TARGETS[agentId as MastraAgentTargetId];
    const runOptions = await buildMastraAgentRunOptions(
      agentTarget,
      { requestContext },
      mode as 'fast' | 'high' | 'xtreme'
    );

    const dynamicModel = await resolveMastraLanguageModel(
      agentTarget,
      mode as 'fast' | 'high' | 'xtreme'
    );

    const generateDesktopTurn = async (prompt: string) => {
      const result = await agent.generate(prompt, { ...runOptions, model: dynamicModel } as any);
      const assistantText = typeof result?.text === 'string' ? result.text.trim() : '';
      
      const estimatedInput = estimateTokens(prompt);
      const estimatedOutput = estimateTokens(assistantText);
      const actualUsage = extractActualTokenUsage((result as any)?.usage);
      
      const resolvedModel = await aiModelControlService.resolveTarget(agentTarget);
      await aiTokenUsageService.record({
        userId: session.userId,
        companyId: session.companyId,
        agentTarget: agentTarget ?? 'mastra.supervisor',
        modelId: resolvedModel?.effectiveModelId ?? 'unknown',
        provider: resolvedModel?.effectiveProvider ?? 'unknown',
        channel: 'desktop',
        threadId,
        estimatedInputTokens: estimatedInput,
        estimatedOutputTokens: estimatedOutput,
        actualInputTokens: actualUsage.inputTokens || undefined,
        actualOutputTokens: actualUsage.outputTokens || undefined,
        wasCompacted: false,
        mode: mode as 'fast' | 'high' | 'xtreme',
      }).catch(() => {});

      return {
        assistantText,
        requestedAction: parseDesktopAction(assistantText),
      };
    };

    let assistantText = '';
    let requestedAction: DesktopAction | null = null;
    try {
      executionEventQueue.enqueue(async () => {
        await executionService.appendEvent({
          executionId,
          phase: 'synthesis',
          eventType: 'synthesis.started',
          actorType: 'agent',
          actorKey: agentId,
          title: 'Generating assistant response',
          summary: summarizeText(message || actionResult?.summary, 400),
          status: 'running',
        });
      });
      ({ assistantText, requestedAction } = await generateDesktopTurn(objective));

      if (
        !requestedAction
        && !actionResult
        && message
        && requestLikelyNeedsLocalAction(message)
        && isLocalCapabilityRefusal(assistantText)
      ) {
        logger.warn('desktop.chat.act.local_capability_refusal_retry', {
          threadId,
          userId: session.userId,
          companyId: session.companyId,
          messagePreview: message.slice(0, 160),
          assistantPreview: assistantText.slice(0, 200),
        });

        const retryObjective = [
          desktopPrompt,
          buildExecutionPlanContext(activePlan),
          historyContext,
          'Your previous response was invalid for the desktop app because you claimed you could not access local files or terminal execution.',
          'For this request, you must either output exactly one <desktop-action>...</desktop-action> action, or answer normally only if no local action is needed.',
          'This request DOES require local workspace capability. Output exactly one desktop action now.',
          message,
        ].filter(Boolean).join('\n');

        ({ assistantText, requestedAction } = await generateDesktopTurn(retryObjective));
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Desktop action loop failed';
      executionEventQueue.enqueue(async () => {
        await executionService.appendEvent({
          executionId,
          phase: 'error',
          eventType: 'execution.failed',
          actorType: 'system',
          actorKey: agentId,
          title: 'Desktop action loop failed',
          summary: summarizeText(errorMessage),
          status: 'failed',
          payload: {
            threadId,
            workspacePath: workspace.path,
            hasActionResult: Boolean(actionResult),
          },
        });
      });
      if (activePlan) {
        const failedPlan = failExecutionPlan(activePlan, errorMessage);
        queuePlanLifecycleEvents(executionEventQueue, executionId, activePlan, failedPlan);
        activePlan = failedPlan;
      }
      await executionEventQueue.flush();
      await executionService.failRun({
        executionId,
        latestSummary: summarizeText(errorMessage, 400),
        errorCode: 'desktop_action_loop_failed',
        errorMessage,
      });
      throw error;
    } finally {
      unregisterPlanBus(requestId);
    }

    if (requestedAction) {
      executionEventQueue.enqueue(async () => {
        await executionService.appendEvent({
          executionId,
          phase: 'control',
          eventType: 'control.requested',
          actorType: 'system',
          actorKey: requestedAction.kind,
          title: `Requested local action: ${requestedAction.kind}`,
          summary: summarizeText(requestedAction.kind === 'run_command' ? requestedAction.command : requestedAction.path),
          status: 'pending',
          payload: requestedAction as unknown as Record<string, unknown>,
        });
      });
      await executionEventQueue.flush();
      return res.json(ApiResponse.success({
        kind: 'action',
        action: requestedAction,
        plan: activePlan,
        executionId,
      }, 'Local action requested'));
    }

    if (activePlan) {
      const completedPlan = completeExecutionPlan(activePlan, assistantText || undefined);
      queuePlanLifecycleEvents(executionEventQueue, executionId, activePlan, completedPlan);
      activePlan = completedPlan;
    }

    const canShareKnowledge = await toolPermissionService.isAllowed(
      session.companyId,
      'share_chat_vectors',
      requesterAiRole,
    );

    executionEventQueue.enqueue(async () => {
      await executionService.appendEvent({
        executionId,
        phase: 'synthesis',
        eventType: 'synthesis.completed',
        actorType: 'agent',
        actorKey: agentId,
        title: 'Generated assistant response',
        summary: summarizeText(assistantText, 800),
        status: 'done',
      });
    });
    executionEventQueue.enqueue(async () => {
      await executionService.appendEvent({
        executionId,
        phase: 'delivery',
        eventType: 'delivery.started',
        actorType: 'delivery',
        actorKey: 'desktop-message',
        title: 'Persisting assistant response',
        summary: summarizeText(assistantText, 400),
        status: 'running',
      });
    });

    try {
      const assistantMessage = await desktopThreadsService.addMessage(
        threadId,
        session.userId,
        'assistant',
        assistantText,
        {
          executionId,
          engineUsed,
          ...(buildPersistedConversationRefs(conversationKey) ? { conversationRefs: buildPersistedConversationRefs(conversationKey) } : {}),
          ...(activePlan ? { plan: activePlan } : {}),
          ...(canShareKnowledge ? { shareAction: buildShareAction(conversationKey) } : {}),
        },
      );
      executionEventQueue.enqueue(async () => {
        await executionService.appendEvent({
          executionId,
          phase: 'delivery',
          eventType: 'delivery.completed',
          actorType: 'delivery',
          actorKey: 'desktop-message',
          title: 'Assistant response persisted',
          summary: summarizeText(assistantText, 400),
          status: 'done',
          payload: {
            messageId: assistantMessage.id,
          },
        });
      });
      await executionEventQueue.flush();
      await executionService.completeRun({
        executionId,
        latestSummary: summarizeText(assistantText, 400),
      });
      conversationMemoryStore.addAssistantMessage(conversationKey, randomUUID(), assistantText);

      return res.json(ApiResponse.success({
        kind: 'answer',
        message: assistantMessage,
        plan: activePlan,
        executionId,
      }, 'Assistant reply created'));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to persist assistant response';
      executionEventQueue.enqueue(async () => {
        await executionService.appendEvent({
          executionId,
          phase: 'error',
          eventType: 'execution.failed',
          actorType: 'delivery',
          actorKey: 'desktop-message',
          title: 'Assistant response persistence failed',
          summary: summarizeText(errorMessage),
          status: 'failed',
          payload: {
            threadId,
          },
        });
      });
      await executionEventQueue.flush();
      await executionService.failRun({
        executionId,
        latestSummary: summarizeText(errorMessage, 400),
        errorCode: 'desktop_message_persist_failed',
        errorMessage,
      });
      throw error;
    }
  };
}

export const desktopChatController = new DesktopChatController();
