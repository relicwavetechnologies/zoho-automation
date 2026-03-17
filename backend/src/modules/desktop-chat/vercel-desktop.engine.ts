import { randomUUID } from 'crypto';

import { generateText, stepCountIs, streamText, type ModelMessage } from 'ai';
import { Request, Response } from 'express';
import { z } from 'zod';

import { ApiResponse } from '../../core/api-response';
import config from '../../config';
import { resolveVercelLanguageModel } from '../../company/orchestration/vercel/model-factory';
import { createVercelDesktopTools } from '../../company/orchestration/vercel/tools';
import type {
  PendingApprovalAction,
  VercelRuntimeRequestContext,
  VercelToolEnvelope,
} from '../../company/orchestration/vercel/types';
import { desktopThreadsService } from '../desktop-threads/desktop-threads.service';
import type { MemberSessionDTO } from '../member-auth/member-auth.service';
import { buildVisionContent, type AttachedFileRef } from './file-vision.builder';
import { executionService } from '../../company/observability';
import { conversationMemoryStore } from '../../company/state/conversation/conversation-memory.store';
import { toolPermissionService } from '../../company/tools/tool-permission.service';
import { logger } from '../../utils/logger';
import { departmentService } from '../../company/departments/department.service';

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
  attachedFiles: z.array(attachedFileSchema).optional().default([]),
  workspace: workspaceSchema.optional(),
  mode: z.enum(['fast', 'high', 'xtreme']).optional().default('xtreme'),
  executionId: z.string().uuid().optional(),
});

const actionResultSchema = z.object({
  kind: z.enum(['list_files', 'read_file', 'write_file', 'mkdir', 'delete_path', 'run_command']),
  ok: z.boolean(),
  summary: z.string().min(1).max(30000),
});

const actSchema = z.object({
  message: z.string().min(1).max(10000).optional(),
  workspace: workspaceSchema,
  actionResult: actionResultSchema.optional(),
  mode: z.enum(['fast', 'high', 'xtreme']).optional().default('xtreme'),
  executionId: z.string().uuid().optional(),
});

type DesktopWorkspaceAction =
  | { kind: 'list_files'; path?: string }
  | { kind: 'read_file'; path: string }
  | { kind: 'write_file'; path: string; content: string }
  | { kind: 'mkdir'; path: string }
  | { kind: 'delete_path'; path: string }
  | { kind: 'run_command'; command: string };

type PersistedContentBlock =
  | { type: 'thinking'; text?: string }
  | { type: 'tool'; id: string; name: string; label: string; icon: string; status: 'running' | 'done' | 'failed'; resultSummary?: string }
  | { type: 'text'; content: string };

type PersistedConversationRefs = {
  latestLarkDoc?: Record<string, unknown>;
  latestLarkCalendarEvent?: Record<string, unknown>;
  latestLarkTask?: Record<string, unknown>;
};

type ThreadHistorySnapshot = Awaited<ReturnType<typeof desktopThreadsService.getThread>>;

const buildConversationKey = (threadId: string): string => `desktop:${threadId}`;
const LOCAL_TIME_ZONE = 'Asia/Kolkata';

const summarizeText = (value: string | null | undefined, limit = 280): string | null => {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}...` : trimmed;
};

const sendSseEvent = (res: Response, type: string, data: unknown) => {
  res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
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

const isBareContinuationMessage = (message?: string): boolean => {
  const value = message?.trim().toLowerCase();
  if (!value) return false;
  return ['continue', 'go on', 'carry on', 'proceed', 'keep going', 'retry'].includes(value);
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

const persistUiEvent = async (
  executionId: string,
  type: 'thinking' | 'thinking_token' | 'activity' | 'activity_done' | 'action' | 'text' | 'done' | 'error',
  data: unknown,
) => {
  const phase = type === 'thinking' || type === 'thinking_token'
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
    actorType: type === 'text' || type === 'done' ? 'delivery' : type === 'thinking' || type === 'thinking_token' ? 'model' : type === 'error' || type === 'action' ? 'system' : 'tool',
    actorKey: 'vercel',
    title: `UI event: ${type}`,
    summary: summarizeText(typeof data === 'string' ? data : JSON.stringify(data), 600),
    status: type === 'error' ? 'failed' : type === 'activity' ? 'running' : type === 'action' ? 'pending' : 'done',
    payload: typeof data === 'object' && data !== null && !Array.isArray(data)
      ? data as Record<string, unknown>
      : { value: data as unknown },
  });
};

const startRun = async (input: {
  executionId: string;
  threadId: string;
  messageId: string;
  entrypoint: 'desktop_send' | 'desktop_act';
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
  const history = await desktopThreadsService.getThread(threadId, session.userId);
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

const mapHistoryToMessages = async (
  threadId: string,
  session: MemberSessionDTO,
): Promise<{ messages: ModelMessage[]; history: ThreadHistorySnapshot }> => {
  const history = await hydrateConversationState(threadId, session);
  const messages: ModelMessage[] = [];
  for (const message of history.messages.slice(-12)) {
    messages.push({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: message.content,
    });
  }
  return { messages, history };
};

const buildSystemPrompt = (input: {
  threadId: string;
  workspace?: { name: string; path: string };
  dateScope?: string;
  latestActionResult?: { kind: string; ok: boolean; summary: string };
  latestUserMessage?: string;
  departmentName?: string;
  departmentRoleSlug?: string;
  departmentSystemPrompt?: string;
  departmentSkillsMarkdown?: string;
}) => {
  const parts = [
    'You are the Vercel AI SDK desktop runtime for a tool-using assistant.',
    'Use the available comprehensive tools directly.',
    'Do not refer to Mastra, LangGraph, workflows, or internal orchestration.',
    'Only claim actions and results that are confirmed by tool outputs.',
    'If a tool returns a pending approval action, treat that as the next required step instead of inventing completion.',
    'Prefer the coding tool for local workspace work and the repo tool only for remote GitHub repositories.',
    'For specialized or complex workflows, first search relevant skills with the skillSearch tool, read the chosen skill, and then proceed with the task.',
  ];
  if (input.workspace) {
    parts.push(
      `Open workspace name: ${input.workspace.name}.`,
      `Open workspace root: ${input.workspace.path}.`,
      'References like "this repo" or "this workspace" refer to that local root.',
    );
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
  const conversationRefsContext = buildConversationRefsContext(buildConversationKey(input.threadId));
  if (conversationRefsContext) {
    parts.push(conversationRefsContext);
  }
  if (input.latestActionResult) {
    parts.push(
      'Latest approved local action result:',
      `- kind: ${input.latestActionResult.kind}`,
      `- ok: ${String(input.latestActionResult.ok)}`,
      `- summary: ${input.latestActionResult.summary}`,
    );
  }
  const continuationHint = buildContinuationHint(input.latestUserMessage);
  if (continuationHint) {
    parts.push(continuationHint);
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
    departmentName: resolved.departmentName,
    departmentRoleSlug: resolved.departmentRoleSlug,
    departmentSystemPrompt: resolved.systemPrompt,
    departmentSkillsMarkdown: resolved.skillsMarkdown,
  };
};

const mapPendingApprovalAction = (action: PendingApprovalAction): DesktopWorkspaceAction => {
  switch (action.kind) {
    case 'run_command':
      return { kind: 'run_command', command: action.command };
    case 'write_file':
      return { kind: 'write_file', path: action.path, content: action.content };
    case 'create_directory':
      return { kind: 'mkdir', path: action.path };
    case 'delete_path':
      return { kind: 'delete_path', path: action.path };
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
    stopWhen: [stopOnPendingApproval, stepCountIs(20)],
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
    stopWhen: [stopOnPendingApproval, stepCountIs(20)],
  });
};

export class VercelDesktopEngine {
  async stream(req: Request, res: Response, session: MemberSessionDTO): Promise<void> {
    const threadId = req.params.threadId;
    const { message, attachedFiles, workspace, mode, executionId: requestedExecutionId } = sendSchema.parse(req.body);
    const executionId = requestedExecutionId ?? randomUUID();
    const messageId = randomUUID();
    const requesterAiRole = session.aiRole ?? session.role;
    const fallbackAllowedToolIds = await toolPermissionService.getAllowedTools(session.companyId, requesterAiRole);
    const departmentRuntime = await resolveDepartmentRuntime(session, threadId, fallbackAllowedToolIds);

    await startRun({
      executionId,
      threadId,
      messageId,
      entrypoint: 'desktop_send',
      session,
      mode,
      message,
    });
    await appendEventSafe({
      executionId,
      phase: 'request',
      eventType: 'execution.started',
      actorType: 'system',
      actorKey: 'vercel',
      title: 'Vercel desktop execution started',
      summary: summarizeText(message),
      status: 'running',
      payload: { threadId, mode },
    });
    logger.info('vercel.stream.request.start', {
      executionId,
      threadId,
      mode,
      messagePreview: summarizeText(message, 200),
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

      await desktopThreadsService.addMessage(
        threadId,
        session.userId,
        'user',
        message,
        attachedFiles.length > 0 ? { attachedFiles } : undefined,
      );
      conversationMemoryStore.addUserMessage(buildConversationKey(threadId), messageId, message);
      let persistedBlocks: PersistedContentBlock[] = [];

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
        dateScope: inferDateScope(message),
        allowedToolIds: departmentRuntime.allowedToolIds,
        departmentSystemPrompt: departmentRuntime.departmentSystemPrompt,
        departmentSkillsMarkdown: departmentRuntime.departmentSkillsMarkdown,
      };

      const { messages: historyMessages, history } = await mapHistoryToMessages(threadId, session);
      const mergedAttachments = new Map<string, AttachedFileRef>();
      for (const file of collectRecentAttachedFiles(history)) {
        mergedAttachments.set(file.fileAssetId, file);
      }
      for (const file of attachedFiles) {
        mergedAttachments.set(file.fileAssetId, file);
      }

      let inputMessages = historyMessages;
      const activeAttachments = Array.from(mergedAttachments.values());
      if (activeAttachments.length > 0) {
        const visionParts = await buildVisionContent({
          userMessage: message,
          attachedFiles: activeAttachments,
          companyId: session.companyId,
          requesterUserId: session.userId,
          requesterAiRole,
        });
        inputMessages = [
          ...historyMessages,
          { role: 'user', content: visionParts as ModelMessage['content'] },
        ];
      } else if (message.trim()) {
        inputMessages = [...historyMessages, { role: 'user', content: message }];
      }

      const result = await runVercelStreamLoop({
        runtime,
        system: buildSystemPrompt({
          threadId,
          workspace,
          dateScope: runtime.dateScope,
          latestUserMessage: message,
          departmentName: departmentRuntime.departmentName,
          departmentRoleSlug: departmentRuntime.departmentRoleSlug,
          departmentSystemPrompt: departmentRuntime.departmentSystemPrompt,
          departmentSkillsMarkdown: departmentRuntime.departmentSkillsMarkdown,
        }),
        messages: inputMessages,
        onToolStart: async (toolName, activityId, title) => {
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
      const finalText = pendingApproval
        ? `Approval required before continuing: ${pendingApproval.kind === 'run_command' ? pendingApproval.command : pendingApproval.kind}.`
        : streamedText.trim();
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
      logger.info('vercel.stream.response.summary', {
        executionId,
        threadId,
        pendingApproval: pendingApproval?.kind ?? null,
        textChars: finalText.length,
        citations: citations.length,
        responsePreview: summarizeText(finalText, 240),
      });

      if (pendingApproval && finalText && streamedText.trim() !== finalText) {
        sendSseEvent(res, 'text', finalText);
        queueUiEvent('text', finalText);
        persistedBlocks = appendTextBlock(persistedBlocks, finalText);
      }

      if (pendingAction) {
        sendSseEvent(res, 'action', { action: pendingAction, executionId });
        queueUiEvent('action', { action: pendingAction, executionId });
      }

      const conversationRefs = buildPersistedConversationRefs(buildConversationKey(threadId));

      const assistantMessage = await desktopThreadsService.addMessage(
        threadId,
        session.userId,
        'assistant',
        finalText,
        {
          executionId,
          contentBlocks: persistedBlocks,
          ...(citations.length > 0 ? { citations } : {}),
          ...(conversationRefs ? { conversationRefs } : {}),
        },
      );
      conversationMemoryStore.addAssistantMessage(buildConversationKey(threadId), assistantMessage.id, finalText);

      await appendEventSafe({
        executionId,
        phase: pendingApproval ? 'control' : 'synthesis',
        eventType: pendingApproval ? 'control.requested' : 'synthesis.completed',
        actorType: pendingApproval ? 'system' : 'agent',
        actorKey: pendingApproval ? pendingApproval.kind : 'vercel',
        title: pendingApproval ? 'Approval requested' : 'Generated assistant response',
        summary: summarizeText(finalText, 600),
        status: pendingApproval ? 'pending' : 'done',
      });

      if (!pendingApproval) {
        await completeRun(executionId, finalText);
      }
      queueUiEvent('done', { executionId, pendingApproval: pendingApproval ?? null, actionIssued: Boolean(pendingAction) });
      await uiEventQueue;
      sendSseEvent(res, 'done', { message: assistantMessage, executionId, pendingApproval: pendingApproval ?? null, actionIssued: Boolean(pendingAction) });
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
    const { message, workspace, actionResult, mode, executionId: requestedExecutionId } = actSchema.parse(req.body);
    const executionId = requestedExecutionId ?? randomUUID();
    const messageId = randomUUID();
    const requesterAiRole = session.aiRole ?? session.role;
    const fallbackAllowedToolIds = await toolPermissionService.getAllowedTools(session.companyId, requesterAiRole);
    const departmentRuntime = await resolveDepartmentRuntime(session, threadId, fallbackAllowedToolIds);

    await startRun({
      executionId,
      threadId,
      messageId,
      entrypoint: 'desktop_act',
      session,
      mode,
      message: message ?? actionResult?.summary ?? 'Local action continuation',
    });

    await appendEventSafe({
      executionId,
      phase: 'request',
      eventType: 'execution.started',
      actorType: 'system',
      actorKey: 'vercel',
      title: 'Vercel desktop action turn started',
      summary: summarizeText(message ?? actionResult?.summary),
      status: 'running',
      payload: {
        threadId,
        workspacePath: workspace.path,
        hasActionResult: Boolean(actionResult),
      },
    });

    try {
      if (message) {
        await desktopThreadsService.addMessage(threadId, session.userId, 'user', message);
        conversationMemoryStore.addUserMessage(buildConversationKey(threadId), messageId, message);
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
        dateScope: inferDateScope(message),
        latestActionResult: actionResult,
        allowedToolIds: departmentRuntime.allowedToolIds,
        departmentSystemPrompt: departmentRuntime.departmentSystemPrompt,
        departmentSkillsMarkdown: departmentRuntime.departmentSkillsMarkdown,
      };

      let persistedBlocks: PersistedContentBlock[] = [];
      const { messages: historyMessages } = await mapHistoryToMessages(threadId, session);
      const continuationText = message ?? (actionResult ? `Continue from this local action result:\n${actionResult.summary}` : undefined);
      const result = await runVercelLoop({
        runtime,
        system: buildSystemPrompt({
          threadId,
          workspace,
          dateScope: runtime.dateScope,
          latestActionResult: actionResult,
          latestUserMessage: message,
          departmentName: departmentRuntime.departmentName,
          departmentRoleSlug: departmentRuntime.departmentRoleSlug,
          departmentSystemPrompt: departmentRuntime.departmentSystemPrompt,
          departmentSkillsMarkdown: departmentRuntime.departmentSkillsMarkdown,
        }),
        messages: continuationText
          ? [...historyMessages, { role: 'user', content: continuationText }]
          : historyMessages,
        onToolStart: async (toolName, activityId, title) => {
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
          plan: null,
          executionId,
        }, 'Local action requested'));
      }

      const assistantText = result.text.trim();
      persistedBlocks = appendTextBlock(persistedBlocks, assistantText);
      await persistUiEvent(executionId, 'text', assistantText);
      const citations = (result.steps as Array<{ toolResults?: Array<{ output?: unknown }> }>).flatMap((step) =>
        (step.toolResults ?? []).flatMap((toolResult) => {
          const output = toolResult.output as VercelToolEnvelope | undefined;
          return output?.citations ?? [];
        }));
      const conversationRefs = buildPersistedConversationRefs(buildConversationKey(threadId));
      const assistantMessage = await desktopThreadsService.addMessage(
        threadId,
        session.userId,
        'assistant',
        assistantText,
        {
          executionId,
          contentBlocks: persistedBlocks,
          ...(citations.length > 0 ? { citations } : {}),
          ...(conversationRefs ? { conversationRefs } : {}),
        },
      );
      conversationMemoryStore.addAssistantMessage(buildConversationKey(threadId), assistantMessage.id, assistantText);

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
      await persistUiEvent(executionId, 'done', { executionId });
      await completeRun(executionId, assistantText);

      return res.json(ApiResponse.success({
        kind: 'answer',
        message: assistantMessage,
        plan: null,
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
    const { message, workspace, actionResult, mode, executionId: requestedExecutionId } = actSchema.parse(req.body);
    const executionId = requestedExecutionId ?? randomUUID();
    const messageId = randomUUID();
    const requesterAiRole = session.aiRole ?? session.role;
    const fallbackAllowedToolIds = await toolPermissionService.getAllowedTools(session.companyId, requesterAiRole);
    const departmentRuntime = await resolveDepartmentRuntime(session, threadId, fallbackAllowedToolIds);

    await startRun({
      executionId,
      threadId,
      messageId,
      entrypoint: 'desktop_act',
      session,
      mode,
      message: message ?? actionResult?.summary ?? 'Local action continuation',
    });
    await appendEventSafe({
      executionId,
      phase: 'request',
      eventType: 'execution.started',
      actorType: 'system',
      actorKey: 'vercel',
      title: 'Vercel desktop action stream started',
      summary: summarizeText(message ?? actionResult?.summary),
      status: 'running',
      payload: {
        threadId,
        workspacePath: workspace.path,
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
        await desktopThreadsService.addMessage(threadId, session.userId, 'user', message);
        conversationMemoryStore.addUserMessage(buildConversationKey(threadId), messageId, message);
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
        dateScope: inferDateScope(message),
        latestActionResult: actionResult,
        allowedToolIds: departmentRuntime.allowedToolIds,
        departmentSystemPrompt: departmentRuntime.departmentSystemPrompt,
        departmentSkillsMarkdown: departmentRuntime.departmentSkillsMarkdown,
      };

      let persistedBlocks: PersistedContentBlock[] = [];
      const { messages: historyMessages } = await mapHistoryToMessages(threadId, session);
      const continuationText = message ?? (actionResult ? `Continue from this local action result:\n${actionResult.summary}` : undefined);
      const result = await runVercelStreamLoop({
        runtime,
        system: buildSystemPrompt({
          threadId,
          workspace,
          dateScope: runtime.dateScope,
          latestActionResult: actionResult,
          latestUserMessage: message,
          departmentName: departmentRuntime.departmentName,
          departmentRoleSlug: departmentRuntime.departmentRoleSlug,
          departmentSystemPrompt: departmentRuntime.departmentSystemPrompt,
          departmentSkillsMarkdown: departmentRuntime.departmentSkillsMarkdown,
        }),
        messages: continuationText
          ? [...historyMessages, { role: 'user', content: continuationText }]
          : historyMessages,
        onToolStart: async (toolName, activityId, title) => {
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
      const finalText = pendingApproval
        ? `Approval required before continuing: ${pendingApproval.kind === 'run_command' ? pendingApproval.command : pendingApproval.kind}.`
        : streamedText.trim();
      const citations = (steps as Array<{ toolResults?: Array<{ output?: unknown }> }>).flatMap((step) =>
        (step.toolResults ?? []).flatMap((toolResult) => {
          const output = toolResult.output as VercelToolEnvelope | undefined;
          return output?.citations ?? [];
        }));

      if (pendingApproval && finalText && streamedText.trim() !== finalText) {
        sendSseEvent(res, 'text', finalText);
        queueUiEvent('text', finalText);
        persistedBlocks = appendTextBlock(persistedBlocks, finalText);
      }

      if (pendingAction) {
        sendSseEvent(res, 'action', { action: pendingAction, executionId });
        queueUiEvent('action', { action: pendingAction, executionId });
      }

      const conversationRefs = buildPersistedConversationRefs(buildConversationKey(threadId));
      const assistantMessage = await desktopThreadsService.addMessage(
        threadId,
        session.userId,
        'assistant',
        finalText,
        {
          executionId,
          contentBlocks: persistedBlocks,
          ...(citations.length > 0 ? { citations } : {}),
          ...(conversationRefs ? { conversationRefs } : {}),
        },
      );
      conversationMemoryStore.addAssistantMessage(buildConversationKey(threadId), assistantMessage.id, finalText);

      await appendEventSafe({
        executionId,
        phase: pendingApproval ? 'control' : 'synthesis',
        eventType: pendingApproval ? 'control.requested' : 'synthesis.completed',
        actorType: pendingApproval ? 'system' : 'agent',
        actorKey: pendingApproval ? pendingApproval.kind : 'vercel',
        title: pendingApproval ? 'Approval requested' : 'Generated assistant response',
        summary: summarizeText(finalText, 600),
        status: pendingApproval ? 'pending' : 'done',
      });

      if (!pendingApproval) {
        await completeRun(executionId, finalText);
      }

      queueUiEvent('done', { executionId, pendingApproval: pendingApproval ?? null, actionIssued: Boolean(pendingAction) });
      await uiEventQueue;
      sendSseEvent(res, 'done', { message: assistantMessage, executionId, pendingApproval: pendingApproval ?? null, actionIssued: Boolean(pendingAction) });
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
