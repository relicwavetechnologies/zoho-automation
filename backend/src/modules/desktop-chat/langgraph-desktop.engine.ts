import type { Response } from 'express';
import { RequestContext } from '@mastra/core/di';

import { desktopThreadsService } from '../desktop-threads/desktop-threads.service';
import type { MemberSessionDTO } from '../member-auth/member-auth.service';
import {
  buildObjectivePrompt,
  inferObjectiveFallback,
  parseObjectiveContract,
  runControllerRuntime,
  applyLocalObservation,
  type ControllerRuntimeHooks,
  type ControllerRuntimeState,
} from '../../company/orchestration/controller-runtime';
import {
  registerActivityBus,
  unregisterActivityBus,
  type ActivityPayload,
} from '../../company/integrations/mastra/tools/activity-bus';
import { personalVectorMemoryService } from '../../company/integrations/vector/personal-vector-memory.service';
import { conversationMemoryStore } from '../../company/state/conversation/conversation-memory.store';
import { checkpointRepository } from '../../company/state/checkpoint';
import { executionService } from '../../company/observability';
import { toolPermissionService } from '../../company/tools/tool-permission.service';
import { aiModelControlService } from '../../company/ai-models';
import { aiTokenUsageService } from '../../company/ai-usage/ai-token-usage.service';
import { openAiOrchestrationModels } from '../../company/orchestration/langchain';
import { logger } from '../../utils/logger';
import { estimateTokens } from '../../utils/token-estimator';
import {
  completeExecutionPlan,
  failExecutionPlan,
  type ExecutionPlan,
  type ExecutionPlanOwner,
} from './desktop-plan';
import type {
  ActionResultPayload,
  AttachedFileRef,
  ComposerMode,
  DesktopAction,
  DesktopEngine,
  DesktopWorkspace,
} from './desktop-controller.types';
import {
  actionResultToObservation,
  buildDesktopLocalAction,
  DESKTOP_WORKER_CAPABILITIES,
  executeDesktopWorker,
} from './desktop-controller-workers';

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
type ThinkingBlock = { type: 'thinking'; text?: string; durationMs?: number };
type ContentBlock = ToolBlock | TextBlock | ThinkingBlock;

type StreamInput = {
  session: MemberSessionDTO;
  threadId: string;
  message: string;
  attachedFiles: AttachedFileRef[];
  mode: ComposerMode;
  executionId: string;
  workspace?: DesktopWorkspace;
  res: Response;
};

type ActInput = {
  session: MemberSessionDTO;
  threadId: string;
  message?: string;
  workspace: DesktopWorkspace;
  actionResult?: ActionResultPayload;
  mode: ComposerMode;
  executionId: string;
};

type StreamActInput = ActInput & {
  res: Response;
};

type GraphResult =
  | { kind: 'action'; action: DesktopAction; plan: ExecutionPlan | null; observations: Array<{ citations: Array<{ id: string; title: string; url?: string }> }> }
  | { kind: 'answer'; text: string; plan: ExecutionPlan | null; observations: Array<{ citations: Array<{ id: string; title: string; url?: string }> }> };

type PersistedRuntimeState = ControllerRuntimeState<DesktopAction>;

const HISTORY_LIMIT = 16;
const PERSONAL_CONTEXT_LIMIT = 4;

const summarizeText = (value: string | null | undefined, limit = 280): string | null => {
  if (!value) return null;
  const compact = value.replace(/\s+/g, ' ').trim();
  if (!compact) return null;
  return compact.length > limit ? `${compact.slice(0, limit - 3).trimEnd()}...` : compact;
};

const buildConversationRefsContext = (conversationKey: string): string => {
  const latestDoc = conversationMemoryStore.getLatestLarkDoc(conversationKey);
  const latestEvent = conversationMemoryStore.getLatestLarkCalendarEvent(conversationKey);
  const latestTask = conversationMemoryStore.getLatestLarkTask(conversationKey);
  const lines: string[] = [];

  if (latestTask) {
    lines.push(`Latest Lark task: ${latestTask.summary ?? latestTask.taskId} [taskId=${latestTask.taskId}]`);
  }
  if (latestDoc) {
    lines.push(`Latest Lark doc: ${latestDoc.title} [documentId=${latestDoc.documentId}]`);
  }
  if (latestEvent) {
    lines.push(`Latest Lark calendar event: ${latestEvent.summary ?? latestEvent.eventId} [eventId=${latestEvent.eventId}]`);
  }

  return lines.length > 0
    ? ['--- Conversation refs ---', ...lines, '--- End refs ---'].join('\n')
    : '';
};

const buildPersistedConversationRefs = (conversationKey: string): Record<string, unknown> | null => {
  const latestDoc = conversationMemoryStore.getLatestLarkDoc(conversationKey);
  const latestEvent = conversationMemoryStore.getLatestLarkCalendarEvent(conversationKey);
  const latestTask = conversationMemoryStore.getLatestLarkTask(conversationKey);
  const refs = {
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
        ...(latestEvent.summary ? { summary: latestEvent.summary } : {}),
        ...(latestEvent.url ? { url: latestEvent.url } : {}),
      },
    } : {}),
    ...(latestTask ? {
      latestLarkTask: {
        taskId: latestTask.taskId,
        ...(latestTask.summary ? { summary: latestTask.summary } : {}),
        ...(latestTask.url ? { url: latestTask.url } : {}),
      },
    } : {}),
  };
  return Object.keys(refs).length > 0 ? refs : null;
};

const buildHistoryAwareMessage = (
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  personalContext: Array<{ role?: string; content: string }>,
  message: string,
  attachedFiles: AttachedFileRef[],
): string => {
  const sections: string[] = [];
  if (personalContext.length > 0) {
    sections.push(
      '--- Personal memory ---',
      ...personalContext.slice(0, PERSONAL_CONTEXT_LIMIT).map((item) => `${item.role === 'assistant' ? 'Assistant' : 'User'}: ${item.content}`),
      '--- End personal memory ---',
    );
  }

  if (history.length > 1) {
    sections.push(
      '--- Conversation history ---',
      ...history.slice(0, -1).map((item) => `${item.role}: ${item.content}`),
      '--- End history ---',
    );
  }

  if (attachedFiles.length > 0) {
    sections.push(
      '--- Attached files ---',
      ...attachedFiles.map((file) => `${file.fileName} [${file.mimeType}]`),
      '--- End attached files ---',
    );
  }

  sections.push(`Current user request: ${message}`);
  return sections.join('\n');
};

const buildRequestContext = async (input: {
  session: MemberSessionDTO;
  threadId: string;
  mode: ComposerMode;
  executionId: string;
  workspace?: DesktopWorkspace;
}): Promise<RequestContext<Record<string, unknown>>> => {
  const allowedToolIds = await toolPermissionService.getAllowedTools(
    input.session.companyId,
    input.session.aiRole ?? input.session.role,
  );

  const requestContext = new RequestContext<Record<string, unknown>>();
  requestContext.set('companyId', input.session.companyId);
  requestContext.set('userId', input.session.userId);
  requestContext.set('chatId', input.threadId);
  requestContext.set('taskId', input.executionId);
  requestContext.set('messageId', input.executionId);
  requestContext.set('requestId', input.executionId);
  requestContext.set('executionId', input.executionId);
  requestContext.set('channel', 'desktop');
  requestContext.set('requesterEmail', input.session.email ?? '');
  requestContext.set('requesterAiRole', input.session.aiRole ?? input.session.role);
  requestContext.set('allowedToolIds', allowedToolIds);
  requestContext.set('larkTenantKey', input.session.larkTenantKey ?? '');
  requestContext.set('larkOpenId', input.session.larkOpenId ?? '');
  requestContext.set('larkUserId', input.session.larkUserId ?? '');
  requestContext.set('larkAuthMode', input.session.authProvider === 'lark' ? 'user_linked' : 'tenant');
  if (input.workspace) {
    requestContext.set('workspaceName', input.workspace.name);
    requestContext.set('workspacePath', input.workspace.path);
  }
  return requestContext;
};

const loadConversationContext = async (input: {
  session: MemberSessionDTO;
  threadId: string;
  message: string;
  attachedFiles: AttachedFileRef[];
}): Promise<{ historyContext: string; conversationRefs: string }> => {
  const conversationKey = `desktop:${input.threadId}`;
  let history = conversationMemoryStore.getContextMessages(conversationKey, HISTORY_LIMIT);
  if (history.length <= 1) {
    try {
      const thread = await desktopThreadsService.getThread(input.threadId, input.session.userId);
      history = thread.messages
        .slice(-HISTORY_LIMIT)
        .map((message) => ({
          role: message.role === 'assistant' ? 'assistant' as const : 'user' as const,
          content: message.content,
        }));
    } catch {
      history = conversationMemoryStore.getContextMessages(conversationKey, HISTORY_LIMIT);
    }
  }

  let personalContext: Array<{ role?: string; content: string }> = [];
  try {
    personalContext = await personalVectorMemoryService.query({
      companyId: input.session.companyId,
      requesterUserId: input.session.userId,
      text: input.message,
      limit: PERSONAL_CONTEXT_LIMIT,
    });
  } catch (error) {
    logger.warn('desktop.controller.personal_memory.failed', {
      threadId: input.threadId,
      reason: error instanceof Error ? error.message : 'unknown_error',
    });
  }

  return {
    historyContext: buildHistoryAwareMessage(history, personalContext, input.message, input.attachedFiles),
    conversationRefs: buildConversationRefsContext(conversationKey),
  };
};

const projectionOwnerForOutput = (output: PersistedRuntimeState['objective']['requestedOutputs'][number]): ExecutionPlanOwner => {
  switch (output.kind) {
    case 'research_answer':
      return 'search';
    case 'remote_artifact':
      return 'repo';
    case 'workspace_mutation':
      return 'workspace';
    case 'terminal_result':
      return 'terminal';
    case 'remote_entity':
      if (output.metadata?.domains && Array.isArray(output.metadata.domains)) {
        const domains = output.metadata.domains as string[];
        if (domains.includes('zoho')) return 'zoho';
        if (domains.includes('lark')) return 'larkTask';
      }
      return 'search';
    case 'direct_reply':
      return 'supervisor';
  }
};

const projectExecutionPlan = (state: PersistedRuntimeState): ExecutionPlan | null => {
  if (state.objective.planVisibility === 'hidden' && state.objective.requestedOutputs.every((output) => output.kind === 'direct_reply')) {
    return null;
  }

  const now = new Date().toISOString();
  const tasks: ExecutionPlan['tasks'] = state.objective.requestedOutputs.map((output, index) => {
    const verification = state.verifications.find((item) => item.outputId === output.id);
    const satisfied = verification?.status === 'satisfied';
    const ownerAgent = projectionOwnerForOutput(output);
    const hasObservation = state.observations.some((observation) =>
      observation.workerKey === ownerAgent
      || (ownerAgent === 'repo' && observation.workerKey === 'repo')
      || (ownerAgent === 'workspace' && observation.workerKey === 'workspace')
      || (ownerAgent === 'terminal' && observation.workerKey === 'terminal'));
    const status: ExecutionPlan['tasks'][number]['status'] = satisfied
      ? 'done'
      : state.pendingLocalAction && (ownerAgent === 'workspace' || ownerAgent === 'terminal')
        ? 'blocked'
        : hasObservation || index === 0
          ? 'running'
          : 'pending';
    return {
      id: `${state.executionId}:${output.id}`,
      title: output.description,
      ownerAgent,
      status,
      ...(verification ? { resultSummary: verification.detail.slice(0, 500) } : {}),
    };
  });

  const finalSupervisorSatisfied = state.verifications.every((item) => item.status === 'satisfied');
  tasks.push({
    id: `${state.executionId}:supervisor`,
    title: 'Respond with the verified result',
    ownerAgent: 'supervisor',
    status: finalSupervisorSatisfied ? 'done' : tasks.every((task) => task.status === 'done') ? 'running' : 'pending',
  });

  return {
    id: state.executionId,
    goal: state.objective.objectiveSummary,
    successCriteria: state.objective.successCriteria.length > 0
      ? state.objective.successCriteria
      : state.objective.requestedOutputs.map((output) => output.description).slice(0, 4),
    status: finalSupervisorSatisfied ? 'completed' : tasks.some((task) => task.status === 'failed') ? 'failed' : 'running',
    createdAt: now,
    updatedAt: now,
    tasks,
  };
};

const collectCitations = (state: PersistedRuntimeState): Array<{ id: string; title: string; url?: string }> =>
  state.observations.flatMap((observation) => observation.citations);

const summarizeWorkerInvocation = (invocation: {
  workerKey: string;
  actionKind: string;
  input: Record<string, unknown>;
}): string => {
  if (invocation.workerKey === 'repo') {
    if (invocation.actionKind === 'DISCOVER_CANDIDATES') {
      const query = typeof invocation.input.query === 'string' ? invocation.input.query : 'the requested repositories';
      const targetFileName = typeof invocation.input.targetFileName === 'string' ? invocation.input.targetFileName : '';
      return targetFileName
        ? `Discovering repository candidates for "${query}" with target file "${targetFileName}"`
        : `Discovering repository candidates for "${query}"`;
    }
    if (invocation.actionKind === 'INSPECT_CANDIDATE') {
      const repoRef = typeof invocation.input.repoRef === 'string' ? invocation.input.repoRef : 'candidate repository';
      const target = typeof invocation.input.targetFilePath === 'string'
        ? invocation.input.targetFilePath
        : typeof invocation.input.targetFileName === 'string'
          ? invocation.input.targetFileName
          : 'target file';
      return `Inspecting ${repoRef} for ${target}`;
    }
    if (invocation.actionKind === 'RETRIEVE_ARTIFACT') {
      const repoRef = typeof invocation.input.repoRef === 'string' ? invocation.input.repoRef : 'repository';
      const target = typeof invocation.input.filePath === 'string'
        ? invocation.input.filePath
        : typeof invocation.input.targetFilePath === 'string'
          ? invocation.input.targetFilePath
          : typeof invocation.input.targetFileName === 'string'
            ? invocation.input.targetFileName
            : 'artifact';
      return `Retrieving ${target} from ${repoRef}`;
    }
  }

  if (invocation.actionKind === 'QUERY_REMOTE_SYSTEM') {
    const query = typeof invocation.input.query === 'string' ? invocation.input.query : 'the user request';
    if (invocation.workerKey === 'search') {
      return `Searching for "${query}"`;
    }
    return `Querying ${invocation.workerKey} for "${query}"`;
  }

  return `${invocation.actionKind} via ${invocation.workerKey}`;
};

const summarizeDecisionLabel = (decision: {
  decision: string;
  invocation?: { workerKey: string; actionKind: string; input: Record<string, unknown> };
  actionKind?: string;
  localAction?: DesktopAction;
  question?: string;
  reply?: string;
  reason?: string;
}): string => {
  if (decision.decision === 'CALL_WORKER' && decision.invocation) {
    return summarizeWorkerInvocation(decision.invocation);
  }
  if (decision.decision === 'REQUEST_LOCAL_ACTION') {
    const action = decision.localAction;
    if (action?.kind === 'write_file') return `Requesting workspace write for ${action.path}`;
    if (action?.kind === 'run_command') return `Requesting terminal command: ${action.command}`;
    if (action?.kind === 'read_file') return `Requesting file read: ${action.path}`;
    if (action?.kind === 'mkdir') return `Requesting folder creation: ${action.path}`;
    if (action?.kind === 'delete_path') return `Requesting delete: ${action.path}`;
    return `Requesting ${decision.actionKind?.toLowerCase() ?? 'local action'}`;
  }
  if (decision.decision === 'ASK_USER') return decision.question ?? 'Asking the user for clarification';
  if (decision.decision === 'COMPLETE') return 'Preparing verified final response';
  return decision.reason ?? 'Failing with a precise reason';
};

const summarizeVerificationState = (state: PersistedRuntimeState): string => {
  const satisfied = state.verifications.filter((item) => item.status === 'satisfied').length;
  const pending = state.verifications.filter((item) => item.status !== 'satisfied').length;
  return pending > 0
    ? `${satisfied} outputs verified, ${pending} still pending`
    : `All ${satisfied} requested outputs are verified`;
};

const summarizeLocalAction = (action: DesktopAction): string => {
  if (action.kind === 'write_file') return `Awaiting approval to write ${action.path}`;
  if (action.kind === 'run_command') return `Awaiting approval to run: ${action.command}`;
  if (action.kind === 'read_file') return `Reading ${action.path}`;
  if (action.kind === 'list_files') return `Listing files${action.path ? ` in ${action.path}` : ''}`;
  if (action.kind === 'mkdir') return `Awaiting approval to create ${action.path}`;
  return `Awaiting approval to delete ${action.path}`;
};

class LangGraphDesktopChatEngine {
  async stream(input: StreamInput): Promise<void> {
    const sendEvent = (type: string, data: unknown): void => {
      input.res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
    };

    input.res.setHeader('Content-Type', 'text/event-stream');
    input.res.setHeader('Cache-Control', 'no-cache');
    input.res.setHeader('Connection', 'keep-alive');
    input.res.setHeader('X-Accel-Buffering', 'no');

    const contentBlocks: ContentBlock[] = [];
    const conversationKey = `desktop:${input.threadId}`;

    const onActivity = (payload: ActivityPayload) => {
      contentBlocks.push({
        type: 'tool',
        id: payload.id,
        name: payload.name,
        label: payload.label,
        icon: payload.icon,
        status: 'running',
      });
      sendEvent('activity', payload);
    };

    const onActivityDone = (payload: ActivityPayload) => {
      const block = contentBlocks.find((candidate): candidate is ToolBlock => candidate.type === 'tool' && candidate.id === payload.id);
      if (block) {
        block.status = /failed|error|not permitted/i.test((payload.resultSummary ?? '').toLowerCase()) ? 'failed' : 'done';
        block.resultSummary = payload.resultSummary;
        block.externalRef = payload.externalRef;
      }
      sendEvent('activity_done', payload);
    };

    registerActivityBus(input.executionId, (type, payload) => {
      if (type === 'activity') onActivity(payload);
      if (type === 'activity_done') onActivityDone(payload);
    });

    try {
      const userMessage = await desktopThreadsService.addMessage(
        input.threadId,
        input.session.userId,
        'user',
        input.message,
        input.attachedFiles.length > 0 ? { attachedFiles: input.attachedFiles } : undefined,
      );
      conversationMemoryStore.addUserMessage(conversationKey, userMessage.id, input.message);
      personalVectorMemoryService.storeChatTurn({
        companyId: input.session.companyId,
        requesterUserId: input.session.userId,
        conversationKey,
        sourceId: `desktop-user-${userMessage.id}`,
        role: 'user',
        text: input.message,
        channel: 'desktop',
        chatId: input.threadId,
      }).catch(() => undefined);

      await executionService.startRun({
        id: input.executionId,
        companyId: input.session.companyId,
        userId: input.session.userId,
        channel: 'desktop',
        entrypoint: 'desktop_send',
        requestId: input.executionId,
        threadId: input.threadId,
        chatId: input.threadId,
        messageId: userMessage.id,
        mode: input.mode,
        agentTarget: 'langgraph.supervisor',
        latestSummary: summarizeText(input.message) ?? input.message,
      });

      sendEvent('thinking', 'Thinking...');
      contentBlocks.push({ type: 'thinking' });

      const result = await this.runSharedRuntime({
        session: input.session,
        threadId: input.threadId,
        message: input.message,
        attachedFiles: input.attachedFiles,
        mode: input.mode,
        executionId: input.executionId,
        workspace: input.workspace,
        stream: { sendEvent, contentBlocks },
      });

      if (result.kind === 'action') {
        sendEvent('action', {
          kind: 'action',
          action: result.action,
          plan: result.plan,
          executionId: input.executionId,
        });
        input.res.end();
        return;
      }

      if (result.plan) {
        sendEvent('plan', completeExecutionPlan(result.plan, result.text));
      }

      contentBlocks.push({ type: 'text', content: result.text });
      sendEvent('text', result.text);

      const metadata: Record<string, unknown> = {
        contentBlocks,
        executionId: input.executionId,
        engineUsed: 'langgraph' as DesktopEngine,
        ...(result.plan ? { plan: completeExecutionPlan(result.plan, result.text) } : {}),
        ...(result.observations.length > 0 ? { citations: result.observations.flatMap((observation) => observation.citations) } : {}),
      };
      const refs = buildPersistedConversationRefs(conversationKey);
      if (refs) {
        metadata.conversationRefs = refs;
      }

      const persisted = await desktopThreadsService.addMessage(
        input.threadId,
        input.session.userId,
        'assistant',
        result.text,
        metadata,
      );
      conversationMemoryStore.addAssistantMessage(conversationKey, persisted.id, result.text);
      personalVectorMemoryService.storeChatTurn({
        companyId: input.session.companyId,
        requesterUserId: input.session.userId,
        conversationKey,
        sourceId: `desktop-assistant-${persisted.id}`,
        role: 'assistant',
        text: result.text,
        channel: 'desktop',
        chatId: input.threadId,
      }).catch(() => undefined);
      sendEvent('done', { message: persisted });
      await executionService.completeRun({
        executionId: input.executionId,
        latestSummary: summarizeText(result.text) ?? result.text,
      });

      const resolvedModel = await aiModelControlService.resolveTarget('langgraph.supervisor');
      await aiTokenUsageService.record({
        userId: input.session.userId,
        companyId: input.session.companyId,
        agentTarget: 'langgraph.supervisor',
        modelId: resolvedModel.effectiveModelId,
        provider: resolvedModel.effectiveProvider,
        channel: 'desktop',
        threadId: input.threadId,
        estimatedInputTokens: estimateTokens(input.message),
        estimatedOutputTokens: estimateTokens(result.text),
        mode: input.mode,
        wasCompacted: false,
      }).catch(() => undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Desktop controller failed';
      sendEvent('error', message);
      await executionService.failRun({
        executionId: input.executionId,
        latestSummary: summarizeText(message) ?? message,
        errorCode: 'desktop_langgraph_failed',
        errorMessage: message,
      }).catch(() => undefined);
    } finally {
      unregisterActivityBus(input.executionId);
      input.res.end();
    }
  }

  async streamAct(input: StreamActInput): Promise<void> {
    const sendEvent = (type: string, data: unknown): void => {
      input.res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
    };

    input.res.setHeader('Content-Type', 'text/event-stream');
    input.res.setHeader('Cache-Control', 'no-cache');
    input.res.setHeader('Connection', 'keep-alive');
    input.res.setHeader('X-Accel-Buffering', 'no');

    const conversationKey = `desktop:${input.threadId}`;
    const onActivity = (payload: ActivityPayload) => {
      sendEvent('activity', payload);
    };
    const onActivityDone = (payload: ActivityPayload) => {
      sendEvent('activity_done', payload);
    };

    registerActivityBus(input.executionId, (type, payload) => {
      if (type === 'activity') onActivity(payload);
      if (type === 'activity_done') onActivityDone(payload);
    });

    try {
      if (input.message && !input.actionResult) {
        const userMessage = await desktopThreadsService.addMessage(
          input.threadId,
          input.session.userId,
          'user',
          input.message,
        );
        conversationMemoryStore.addUserMessage(conversationKey, userMessage.id, input.message);
        personalVectorMemoryService.storeChatTurn({
          companyId: input.session.companyId,
          requesterUserId: input.session.userId,
          conversationKey,
          sourceId: `desktop-user-${userMessage.id}`,
          role: 'user',
          text: input.message,
          channel: 'desktop',
          chatId: input.threadId,
        }).catch(() => undefined);
      }

      await executionService.startRun({
        id: input.executionId,
        companyId: input.session.companyId,
        userId: input.session.userId,
        channel: 'desktop',
        entrypoint: 'desktop_act',
        requestId: input.executionId,
        threadId: input.threadId,
        chatId: input.threadId,
        messageId: input.executionId,
        mode: input.mode,
        agentTarget: 'langgraph.supervisor',
        latestSummary: summarizeText(input.message ?? input.actionResult?.summary) ?? input.executionId,
      });

      sendEvent('thinking', 'Thinking...');

      const result = await this.runSharedRuntime({
        session: input.session,
        threadId: input.threadId,
        message: input.message ?? '',
        attachedFiles: [],
        mode: input.mode,
        executionId: input.executionId,
        workspace: input.workspace,
        actionResult: input.actionResult,
        stream: { sendEvent, contentBlocks: [] },
      });

      if (result.kind === 'action') {
        sendEvent('action', {
          kind: 'action',
          action: result.action,
          plan: result.plan,
          executionId: input.executionId,
        });
        input.res.end();
        return;
      }

      if (result.plan) {
        sendEvent('plan', completeExecutionPlan(result.plan, result.text));
      }
      sendEvent('text', result.text);

      const metadata: Record<string, unknown> = {
        executionId: input.executionId,
        engineUsed: 'langgraph' as DesktopEngine,
        ...(result.plan ? { plan: completeExecutionPlan(result.plan, result.text) } : {}),
        ...(result.observations.length > 0 ? { citations: result.observations.flatMap((observation) => observation.citations) } : {}),
      };
      const refs = buildPersistedConversationRefs(conversationKey);
      if (refs) {
        metadata.conversationRefs = refs;
      }

      const message = await desktopThreadsService.addMessage(
        input.threadId,
        input.session.userId,
        'assistant',
        result.text,
        metadata,
      );
      conversationMemoryStore.addAssistantMessage(conversationKey, message.id, result.text);
      personalVectorMemoryService.storeChatTurn({
        companyId: input.session.companyId,
        requesterUserId: input.session.userId,
        conversationKey,
        sourceId: `desktop-assistant-${message.id}`,
        role: 'assistant',
        text: result.text,
        channel: 'desktop',
        chatId: input.threadId,
      }).catch(() => undefined);

      sendEvent('done', { message });
      await executionService.completeRun({
        executionId: input.executionId,
        latestSummary: summarizeText(result.text) ?? result.text,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Desktop controller failed';
      sendEvent('error', message);
      await executionService.failRun({
        executionId: input.executionId,
        latestSummary: summarizeText(message) ?? message,
        errorCode: 'desktop_langgraph_act_failed',
        errorMessage: message,
      }).catch(() => undefined);
    } finally {
      unregisterActivityBus(input.executionId);
      input.res.end();
    }
  }

  async act(input: ActInput): Promise<
    { kind: 'action'; action: DesktopAction; plan?: ExecutionPlan | null; executionId: string }
    | { kind: 'answer'; message: Awaited<ReturnType<typeof desktopThreadsService.addMessage>>; plan?: ExecutionPlan | null; executionId: string }
  > {
    const conversationKey = `desktop:${input.threadId}`;
    if (input.message && !input.actionResult) {
      const userMessage = await desktopThreadsService.addMessage(
        input.threadId,
        input.session.userId,
        'user',
        input.message,
      );
      conversationMemoryStore.addUserMessage(conversationKey, userMessage.id, input.message);
      personalVectorMemoryService.storeChatTurn({
        companyId: input.session.companyId,
        requesterUserId: input.session.userId,
        conversationKey,
        sourceId: `desktop-user-${userMessage.id}`,
        role: 'user',
        text: input.message,
        channel: 'desktop',
        chatId: input.threadId,
      }).catch(() => undefined);
    }

    await executionService.startRun({
      id: input.executionId,
      companyId: input.session.companyId,
      userId: input.session.userId,
      channel: 'desktop',
      entrypoint: 'desktop_act',
      requestId: input.executionId,
      threadId: input.threadId,
      chatId: input.threadId,
      messageId: input.executionId,
      mode: input.mode,
      agentTarget: 'langgraph.supervisor',
      latestSummary: summarizeText(input.message ?? input.actionResult?.summary) ?? input.executionId,
    });

    const result = await this.runSharedRuntime({
      session: input.session,
      threadId: input.threadId,
      message: input.message ?? '',
      attachedFiles: [],
      mode: input.mode,
      executionId: input.executionId,
      workspace: input.workspace,
      actionResult: input.actionResult,
    });

    if (result.kind === 'action') {
      return {
        kind: 'action',
        action: result.action,
        plan: result.plan,
        executionId: input.executionId,
      };
    }

    const metadata: Record<string, unknown> = {
      executionId: input.executionId,
      engineUsed: 'langgraph' as DesktopEngine,
      ...(result.plan ? { plan: completeExecutionPlan(result.plan, result.text) } : {}),
      ...(result.observations.length > 0 ? { citations: result.observations.flatMap((observation) => observation.citations) } : {}),
    };
    const refs = buildPersistedConversationRefs(conversationKey);
    if (refs) {
      metadata.conversationRefs = refs;
    }

    const message = await desktopThreadsService.addMessage(
      input.threadId,
      input.session.userId,
      'assistant',
      result.text,
      metadata,
    );
    conversationMemoryStore.addAssistantMessage(conversationKey, message.id, result.text);
    personalVectorMemoryService.storeChatTurn({
      companyId: input.session.companyId,
      requesterUserId: input.session.userId,
      conversationKey,
      sourceId: `desktop-assistant-${message.id}`,
      role: 'assistant',
      text: result.text,
      channel: 'desktop',
      chatId: input.threadId,
    }).catch(() => undefined);
    await executionService.completeRun({
      executionId: input.executionId,
      latestSummary: summarizeText(result.text) ?? result.text,
    });
    return {
      kind: 'answer',
      message,
      plan: result.plan,
      executionId: input.executionId,
    };
  }

  private async runSharedRuntime(input: {
    session: MemberSessionDTO;
    threadId: string;
    message: string;
    attachedFiles: AttachedFileRef[];
    mode: ComposerMode;
    executionId: string;
    workspace?: DesktopWorkspace;
    actionResult?: ActionResultPayload;
    stream?: { sendEvent: (type: string, data: unknown) => void; contentBlocks: ContentBlock[] };
  }): Promise<GraphResult> {
    const requestContext = await buildRequestContext({
      session: input.session,
      threadId: input.threadId,
      mode: input.mode,
      executionId: input.executionId,
      workspace: input.workspace,
    });

    const restoredCheckpoint = await checkpointRepository.getLatest(input.executionId);
    const restoredState = restoredCheckpoint?.state && typeof restoredCheckpoint.state === 'object'
      ? restoredCheckpoint.state as PersistedRuntimeState
      : null;

    let initialState: PersistedRuntimeState;
    const restoredMessage = typeof restoredState?.userRequest === 'string' ? restoredState.userRequest : '';
    const message = input.message.trim() || restoredMessage;

    if (restoredState) {
      initialState = restoredState;
    } else {
      const controllerContext = await loadConversationContext({
        session: input.session,
        threadId: input.threadId,
        message,
        attachedFiles: input.attachedFiles,
      });
      const fallbackObjective = inferObjectiveFallback(message, Boolean(input.workspace));
      const rawObjective = await openAiOrchestrationModels.invokeSupervisor(buildObjectivePrompt({
        message,
        workspaceLabel: input.workspace ? `${input.workspace.name} at ${input.workspace.path}` : null,
        contextBlock: [controllerContext.historyContext, controllerContext.conversationRefs].filter(Boolean).join('\n\n'),
        workers: DESKTOP_WORKER_CAPABILITIES,
      }));
      const objective = parseObjectiveContract(rawObjective, fallbackObjective);
      initialState = {
        executionId: input.executionId,
        userRequest: message,
        objective,
        observations: [],
        progressLedger: [],
        verifications: [],
        stepCount: 0,
        lifecyclePhase: 'running',
        localActionHistory: [],
      };
    }

    if (input.actionResult) {
      initialState = applyLocalObservation(initialState, actionResultToObservation(input.actionResult));
      initialState.pendingLocalAction = undefined;
      initialState.lifecyclePhase = 'running';
      if (input.stream) {
        const activityId = `${input.executionId}-local-action-resume-${initialState.stepCount}`;
        input.stream.sendEvent('activity', {
          id: activityId,
          name: 'controller.local_action.resume',
          label: 'Resuming after local action',
          icon: 'play',
        });
        input.stream.sendEvent('activity_done', {
          id: activityId,
          name: 'controller.local_action.resume',
          label: 'Resuming after local action',
          icon: input.actionResult.ok ? 'play' : 'x-circle',
          resultSummary: input.actionResult.summary,
        });
      }
    }

    const hooks: ControllerRuntimeHooks<DesktopAction, ExecutionPlan> = {
      projectPlan: (state) => projectExecutionPlan(state),
      onObjective: async (state, plan) => {
        if (input.stream) {
          input.stream.sendEvent('activity', {
            id: `${input.executionId}-objective`,
            name: 'controller.objective',
            label: 'Built objective contract',
            icon: 'sparkles',
          });
          input.stream.sendEvent('activity_done', {
            id: `${input.executionId}-objective`,
            name: 'controller.objective',
            label: 'Built objective contract',
            icon: 'sparkles',
            resultSummary: state.objective.objectiveSummary,
          });
          if (plan) {
            input.stream.sendEvent('plan', plan);
          }
        }
      },
      onDecision: async (state, decision, plan) => {
        if (!input.stream) return;
        const summary = summarizeDecisionLabel(decision as any);
        input.stream.sendEvent('activity', {
          id: `${input.executionId}-decision-${state.stepCount + 1}`,
          name: 'controller.decide',
          label: `Controller chose ${decision.decision.toLowerCase()}`,
          icon: 'workflow',
        });
        input.stream.sendEvent('activity_done', {
          id: `${input.executionId}-decision-${state.stepCount + 1}`,
          name: 'controller.decide',
          label: `Controller chose ${decision.decision.toLowerCase()}`,
          icon: 'workflow',
          resultSummary: summary,
        });
        if (plan) {
          input.stream.sendEvent('plan', plan);
        }
      },
      onWorkerStart: async (_state, invocation) => {
        if (!input.stream) return;
        const activityId = `${input.executionId}-worker-${_state.stepCount + 1}`;
        input.stream.sendEvent('activity', {
          id: activityId,
          name: 'controller.dispatch',
          label: summarizeWorkerInvocation(invocation),
          icon: 'workflow',
        });
      },
      onWorkerResult: async (state, invocation, observation, plan) => {
        if (!input.stream) return;
        const activityId = `${input.executionId}-worker-${state.stepCount}`;
        input.stream.sendEvent('activity_done', {
          id: activityId,
          name: 'controller.dispatch',
          label: summarizeWorkerInvocation(invocation),
          icon: observation.ok ? 'workflow' : 'x-circle',
          resultSummary: observation.summary,
        });
        if (plan) {
          input.stream.sendEvent('plan', plan);
        }
      },
      onLocalActionRequest: async (state, decision, plan) => {
        if (!input.stream) return;
        const activityId = `${input.executionId}-local-action-request-${state.stepCount}`;
        input.stream.sendEvent('activity', {
          id: activityId,
          name: 'controller.local_action.pause',
          label: 'Pausing for local action',
          icon: 'pause-circle',
        });
        input.stream.sendEvent('activity_done', {
          id: activityId,
          name: 'controller.local_action.pause',
          label: 'Pausing for local action',
          icon: 'pause-circle',
          resultSummary: summarizeLocalAction(decision.localAction),
        });
        if (plan) {
          input.stream.sendEvent('plan', plan);
        }
      },
      onVerification: async (state, plan) => {
        if (!input.stream) return;
        const activityId = `${input.executionId}-verify-${state.stepCount}`;
        input.stream.sendEvent('activity', {
          id: activityId,
          name: 'controller.verify',
          label: 'Verifying outputs',
          icon: 'check-check',
        });
        input.stream.sendEvent('activity_done', {
          id: activityId,
          name: 'controller.verify',
          label: 'Verifying outputs',
          icon: 'check-check',
          resultSummary: summarizeVerificationState(state),
        });
        if (plan) {
          input.stream.sendEvent('plan', plan);
        }
      },
      onCheckpoint: async (node, state, extra) => {
        await checkpointRepository.save(input.executionId, `desktop.${node}`, {
          ...state,
          trace: { requestId: input.executionId },
          ...(extra ? { extra } : {}),
        });
      },
    };

    const runtimeResult = await runControllerRuntime({
      initialState,
      workers: DESKTOP_WORKER_CAPABILITIES,
      invokeController: async (prompt) => {
        if (input.stream && !input.stream.contentBlocks.some((block) => block.type === 'thinking')) {
          input.stream.sendEvent('thinking', 'Thinking...');
          input.stream.contentBlocks.push({ type: 'thinking' });
        }
        return openAiOrchestrationModels.invokeSupervisor(prompt);
      },
      executeWorker: (invocation) => executeDesktopWorker({ invocation, requestContext }),
      buildLocalAction: (state, kind) => {
        if (!input.workspace) return null;
        return buildDesktopLocalAction(state, kind);
      },
      hooks,
    });

    const plan = projectExecutionPlan(runtimeResult.state);

    if (runtimeResult.kind === 'action') {
      return {
        kind: 'action',
        action: runtimeResult.action,
        plan,
        observations: runtimeResult.state.observations,
      };
    }

    const finalPlan = plan
      ? runtimeResult.text === runtimeResult.state.objective.directReply || runtimeResult.state.verifications.every((item) => item.status === 'satisfied')
        ? completeExecutionPlan(plan, runtimeResult.text)
        : failExecutionPlan(plan, runtimeResult.text)
      : null;

    return {
      kind: 'answer',
      text: runtimeResult.text,
      plan: finalPlan,
      observations: runtimeResult.state.observations,
    };
  }
}

export const langGraphDesktopChatEngine = new LangGraphDesktopChatEngine();
