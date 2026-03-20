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
import { logger } from '../../../utils/logger';
import { resolveVercelLanguageModel } from '../vercel/model-factory';
import { createVercelDesktopTools } from '../vercel/tools';
import type {
  PendingApprovalAction,
  VercelRuntimeRequestContext,
  VercelToolEnvelope,
} from '../vercel/types';
import type { OrchestrationEngine, OrchestrationExecutionInput, OrchestrationExecutionResult } from './types';
import { legacyOrchestrationEngine } from './legacy-orchestration.engine';
import { buildVisionContent, type AttachedFileRef } from '../../../modules/desktop-chat/file-vision.builder';
import { desktopThreadsService } from '../../../modules/desktop-threads/desktop-threads.service';
import { LarkStatusCoordinator } from './lark-status.coordinator';

const LOCAL_TIME_ZONE = 'Asia/Kolkata';
const LARK_BLOCKED_TOOL_IDS = new Set(['coding']);
const LARK_VERCEL_MODE: VercelRuntimeRequestContext['mode'] = 'fast';
const LARK_THREAD_CONTEXT_MESSAGE_LIMIT = 20;
const LARK_STATUS_HEARTBEAT_MESSAGES = [
  'Still working on this.',
  'Still gathering the right details.',
  'Still working through the next step.',
] as const;

const buildConversationKey = (message: NormalizedIncomingMessageDTO): string => `${message.channel}:${message.chatId}`;
const buildPersistentLarkConversationKey = (threadId: string): string => `lark-thread:${threadId}`;

const summarizeText = (value: string | null | undefined, limit = 280): string | null => {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}...` : trimmed;
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
}) => {
  const parts = [
    'You are the Vercel AI SDK runtime for a tool-using assistant.',
    'Use the available comprehensive tools directly.',
    'Do not refer to Mastra, LangGraph, workflows, or internal orchestration.',
    'Only claim actions and results that are confirmed by tool outputs.',
    'If a tool returns a pending approval action, treat that as the next required step instead of inventing completion.',
    'Prefer the coding tool for local workspace work and the repo tool only for remote GitHub repositories.',
    'For specialized or complex workflows, first search relevant skills with the skillSearch tool, read the chosen skill, and then proceed with the task.',
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
  const refsContext = buildConversationRefsContext(input.conversationKey);
  if (refsContext) {
    parts.push(refsContext);
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
    return 'Working on it.';
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

  let persistedUserMessageId: string | undefined;
  if (persistentThread) {
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

  const runtime = await resolveRuntimeContext(task, message, persistentThread?.id);
  statusHistory.push('Context ready.');
  await updateStatus('planning', 'Choosing the right tools and approach for this request.');

  const tools = createVercelDesktopTools(runtime, {
    onToolStart: async (_toolName, _activityId, title) => {
      statusHistory.push(`Started ${title}`);
      await updateStatus('tool_running', `Using ${title}.`);
    },
    onToolFinish: async (toolName, _activityId, title, output) => {
      const summary = summarizeText(output.summary, 180) ?? output.summary;
      statusHistory.push(`${output.success ? 'Completed' : 'Failed'} ${title}: ${summary}`);
      await updateStatus('tool_done', `${title}: ${summary}`);
    },
  });
  const contextMessages = persistentThread
    ? (await desktopThreadsService.getCachedOwnedThreadContext(
      persistentThread.id,
      linkedUserId,
      LARK_THREAD_CONTEXT_MESSAGE_LIMIT,
    )).messages.map((entry) => {
      if (entry.role === 'user') {
        conversationMemoryStore.addUserMessage(conversationKey, entry.id, entry.content);
      } else {
        conversationMemoryStore.addAssistantMessage(conversationKey, entry.id, entry.content);
        if (entry.metadata && typeof entry.metadata === 'object' && !Array.isArray(entry.metadata)) {
          hydrateConversationRefsFromMetadata(conversationKey, entry.metadata as Record<string, unknown>);
        }
      }
      return {
        id: entry.id,
        role: entry.role === 'assistant' ? 'assistant' : 'user',
        content: entry.content,
      };
    }) as Array<ModelMessage & { id?: string }>
    : conversationMemoryStore.getContextMessages(conversationKey).map((entry) => ({
      role: entry.role,
      content: entry.content,
    })) as Array<ModelMessage & { id?: string }>;
  const currentAttachments = (message.attachedFiles ?? []) as AttachedFileRef[];
  let inputMessages = contextMessages.map(({ role, content }) => ({ role, content })) as ModelMessage[];
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
      inputMessages = contextMessages.map((entry, index) => {
        const shouldReplace = index === contextMessages.length - 1 && entry.id === persistedUserMessageId;
        if (shouldReplace) {
          replacedCurrentMessage = true;
        }
        return shouldReplace
          ? { role: 'user', content: visionParts as ModelMessage['content'] }
          : { role: entry.role, content: entry.content };
      }) as ModelMessage[];
      if (!replacedCurrentMessage) {
        inputMessages = [
          ...contextMessages.map(({ role, content }) => ({ role, content })),
          { role: 'user', content: visionParts as ModelMessage['content'] },
        ];
      }
    } else {
      inputMessages = [
        ...contextMessages.map(({ role, content }) => ({ role, content })),
        { role: 'user', content: visionParts as ModelMessage['content'] },
      ];
    }
  } else if (message.text.trim() && !persistentThread) {
    inputMessages = [
      ...contextMessages.map(({ role, content }) => ({ role, content })),
      { role: 'user', content: message.text },
    ];
  }
  const resolvedModel = await resolveVercelLanguageModel(runtime.mode);

  try {
    const result = await generateText({
      model: resolvedModel.model,
      system: buildSystemPrompt({ conversationKey, runtime }),
      messages: inputMessages.length > 0
        ? inputMessages
        : [{ role: 'user', content: message.text }],
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

    const steps = result.steps as Array<{ toolResults?: Array<{ toolName?: string; output?: unknown }> }>;
    const pendingApproval = findPendingApproval(steps as Array<{ toolResults?: Array<{ output: unknown }> }>);
    const finalText = pendingApproval
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
