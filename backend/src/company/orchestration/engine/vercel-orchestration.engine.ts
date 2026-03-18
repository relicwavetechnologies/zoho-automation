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

const LOCAL_TIME_ZONE = 'Asia/Kolkata';
const LARK_BLOCKED_TOOL_IDS = new Set(['coding']);
const LARK_VERCEL_MODE: VercelRuntimeRequestContext['mode'] = 'fast';

const buildConversationKey = (message: NormalizedIncomingMessageDTO): string => `${message.channel}:${message.chatId}`;

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

const buildSystemPrompt = (input: {
  message: NormalizedIncomingMessageDTO;
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
  const refsContext = buildConversationRefsContext(buildConversationKey(input.message));
  if (refsContext) {
    parts.push(refsContext);
  }
  parts.push(`Conversation key: ${buildConversationKey(input.message)}.`);
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
  phase: 'processing' | 'tool_running' | 'tool_done' | 'approval' | 'processed' | 'failed';
  detail?: string;
  history: string[];
}) => {
  if (input.phase === 'processed') {
    return 'Completed request.';
  }

  const lines: string[] = [];
  const mode = input.task.executionMode ?? 'sequential';
  if (input.phase === 'processing') {
    lines.push(`Processing request (${input.task.taskId.slice(0, 8)})...`);
  } else if (input.phase === 'tool_running') {
    lines.push(`Running (${mode}) for message ${input.message.messageId}.`);
  } else if (input.phase === 'tool_done') {
    lines.push(`Updated (${mode}) for message ${input.message.messageId}.`);
  } else if (input.phase === 'approval') {
    lines.push(`Approval required (${input.task.taskId.slice(0, 8)})...`);
  } else {
    lines.push(`Failed (${mode}) for message ${input.message.messageId}.`);
  }
  lines.push(`Plan: ${input.task.plan.join(' -> ')}`);
  if (input.detail) {
    lines.push(input.detail);
  }
  if (input.history.length > 0) {
    lines.push('Logs:');
    lines.push(...input.history.slice(-6));
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
    threadId: buildConversationKey(message),
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
  const runtime = await resolveRuntimeContext(task, message);
  const adapter = resolveChannelAdapter('lark');
  const conversationKey = buildConversationKey(message);
  conversationMemoryStore.addUserMessage(conversationKey, message.messageId, message.text);

  const statusHistory: string[] = [];
  let statusMessageId: string | undefined;
  const updateStatus = async (
    phase: 'processing' | 'tool_running' | 'tool_done' | 'approval' | 'processed' | 'failed',
    detail?: string,
    actions?: ChannelAction[],
  ) => {
    const text = buildLarkStatusText({
      task,
      message,
      phase,
      detail,
      history: statusHistory,
    });
    if (statusMessageId) {
      const outbound = await adapter.updateMessage({
        messageId: statusMessageId,
        text,
        correlationId: task.taskId,
        ...(actions ? { actions } : {}),
      });
      if (outbound.status !== 'failed') {
        statusMessageId = outbound.messageId ?? statusMessageId;
      }
      return;
    }
    const outbound = await adapter.sendMessage({
      chatId: message.chatId,
      text,
      correlationId: task.taskId,
      ...(actions ? { actions } : {}),
    });
    if (outbound.status !== 'failed') {
      statusMessageId = outbound.messageId ?? undefined;
    }
  };

  await updateStatus('processing');

  const tools = createVercelDesktopTools(runtime, {
    onToolStart: async (_toolName, _activityId, title) => {
      statusHistory.push(`Running: ${title}`);
      await updateStatus('tool_running', title);
    },
    onToolFinish: async (toolName, _activityId, title, output) => {
      const summary = summarizeText(output.summary, 180) ?? output.summary;
      statusHistory.push(`${output.success ? 'Completed' : 'Failed'} ${toolName}: ${summary}`);
      await updateStatus('tool_done', `${title}: ${summary}`);
    },
  });

  const contextMessages = conversationMemoryStore.getContextMessages(conversationKey).map((entry) => ({
    role: entry.role,
    content: entry.content,
  })) as ModelMessage[];
  const currentAttachments = (message.attachedFiles ?? []) as AttachedFileRef[];
  let inputMessages = contextMessages;
  if (currentAttachments.length > 0) {
    const visionParts = await buildVisionContent({
      userMessage: message.text,
      attachedFiles: currentAttachments,
      companyId: runtime.companyId,
      requesterUserId: runtime.userId,
      requesterAiRole: runtime.requesterAiRole,
    });
    inputMessages = [
      ...contextMessages,
      { role: 'user', content: visionParts as ModelMessage['content'] },
    ];
  } else if (message.text.trim()) {
    inputMessages = [
      ...contextMessages,
      { role: 'user', content: message.text },
    ];
  }
  const resolvedModel = await resolveVercelLanguageModel(runtime.mode);

  try {
    const result = await generateText({
      model: resolvedModel.model,
      system: buildSystemPrompt({ message, runtime }),
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
      : result.text.trim();

    if (pendingApproval) {
      statusHistory.push(`Approval required: ${pendingApproval.kind}`);
      await updateStatus(
        'approval',
        pendingApproval.kind === 'tool_action'
          ? summarizeText(pendingApproval.summary, 220) ?? finalText
          : finalText,
        buildLarkApprovalActions(pendingApproval),
      );
    } else {
      statusHistory.push('Completed request.');
      await updateStatus('processed', summarizeText(finalText, 180) ?? undefined, []);
    }

    if (!pendingApproval) {
      await adapter.sendMessage({
        chatId: message.chatId,
        text: finalText,
        correlationId: task.taskId,
      });
      conversationMemoryStore.addAssistantMessage(conversationKey, task.taskId, finalText);
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
        node: pendingApproval ? 'control.requested' : 'synthesis.complete',
        stepHistory: task.plan,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Vercel Lark runtime failed.';
    statusHistory.push(`Failed: ${errorMessage}`);
    await updateStatus('failed', summarizeText(errorMessage, 180) ?? errorMessage, []);
    throw error;
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
