import type { Response } from 'express';
import { RequestContext } from '@mastra/core/di';

import { desktopThreadsService } from '../desktop-threads/desktop-threads.service';
import type { MemberSessionDTO } from '../member-auth/member-auth.service';
import {
  buildBootstrapPrompt,
  inferBootstrapFallback,
  listSkillMetadata,
  parseControllerProfile,
  runControllerRuntime,
  applyLocalObservation,
  type ControllerRuntimeHooks,
  type ControllerRuntimeState,
  type WorkerObservation,
} from '../../company/orchestration/controller-runtime';
import { getRequiredSkillTools } from '../../company/orchestration/controller-runtime/skill-tool-requirements';
import {
  registerActivityBus,
  unregisterActivityBus,
  type ActivityPayload,
} from '../../company/integrations/mastra/tools/activity-bus';
import { conversationMemoryStore } from '../../company/state/conversation/conversation-memory.store';
import { checkpointRepository } from '../../company/state/checkpoint';
import { executionService } from '../../company/observability';
import { toolPermissionService } from '../../company/tools/tool-permission.service';
import { aiModelControlService } from '../../company/ai-models';
import { aiTokenUsageService } from '../../company/ai-usage/ai-token-usage.service';
import { openAiOrchestrationModels } from '../../company/orchestration/langchain';
import { estimateTokens } from '../../utils/token-estimator';
import { logger } from '../../utils/logger';
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
import type { EngineTerminalState } from './orchestrator.types';
import { InferenceEngine } from './inference-engine';
import {
  actionResultToObservation,
  buildDesktopLocalAction,
  DESKTOP_WORKER_CAPABILITIES,
  executeDesktopWorker,
} from './desktop-controller-workers';
import { PresentationAdapter } from './presentation-adapter';

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
type ProgressEvent =
  | { type: 'bootstrap'; complexity: string; skillQuery?: string }
  | { type: 'skill_loaded'; skillId: string }
  | { type: 'worker_dispatched'; workerKey: string; actionKind: string }
  | { type: 'worker_result'; workerKey: string; actionKind: string; success: boolean; summary: string }
  | { type: 'decision'; decision: string; workerKey?: string; actionKind?: string }
  | { type: 'complete'; reply: string }
  | { type: 'ask_user'; question: string }
  | { type: 'fail'; reason: string };

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

type StreamChannel = {
  sendEvent: (type: string, data: unknown) => void;
  contentBlocks: ContentBlock[];
  progressEvents: ProgressEvent[];
  setLatestState: (state: PersistedRuntimeState) => void;
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
  | { kind: 'action'; action: DesktopAction; plan: ExecutionPlan | null; observations: WorkerObservation[] }
  | {
    kind: 'answer';
    text: string;
    terminalState: EngineTerminalState['type'];
    plan: ExecutionPlan | null;
    observations: WorkerObservation[];
    profile: PersistedRuntimeState['profile'];
    state: PersistedRuntimeState;
  };

type PersistedRuntimeState = ControllerRuntimeState<DesktopAction>;
type PersistedObservation = Pick<WorkerObservation, 'ok' | 'workerKey' | 'actionKind' | 'summary' | 'entities' | 'facts' | 'artifacts' | 'citations' | 'blockingReason' | 'verificationHints'>;
type PersistedControllerProfile = PersistedRuntimeState['profile'];
type PersistedRuntimeSnapshot = PersistedRuntimeState;

const HISTORY_LIMIT = 16;
const presentationAdapter = new PresentationAdapter();
const inferenceEngine = new InferenceEngine();

const summarizeText = (value: string | null | undefined, limit = 280): string | null => {
  if (!value) return null;
  const compact = value.replace(/\s+/g, ' ').trim();
  if (!compact) return null;
  return compact.length > limit ? `${compact.slice(0, limit - 3).trimEnd()}...` : compact;
};

const truncateInline = (value: string, limit: number): string =>
  value.length > limit ? `${value.slice(0, Math.max(0, limit - 20)).trimEnd()} ...[truncated ${value.length - limit} chars]` : value;

const compactTracePrompt = (prompt: string): string => {
  const withoutWorkerCatalog = prompt.replace(
    /Available workers:\n\n[\s\S]*?\n\nAvailable skill metadata:/,
    'Available workers:\n\n[worker catalog omitted in trace]\n\nAvailable skill metadata:',
  );
  const withoutSkillCatalog = withoutWorkerCatalog.replace(
    /Available skill metadata:\n\n[\s\S]*?\n\nTask summary:/,
    'Available skill metadata:\n\n[skill catalog omitted in trace]\n\nTask summary:',
  );
  const withoutRecentWorkerResults = withoutSkillCatalog.replace(
    /Recent worker results:\n[\s\S]*?\n\nRecent observations:/,
    'Recent worker results:\n[recent worker results omitted in trace]\n\nRecent observations:',
  );
  const withoutRecentObservations = withoutRecentWorkerResults.replace(
    /Recent observations:\n[\s\S]*?\n\nAvailable worker capabilities:/,
    'Recent observations:\n[recent observations omitted in trace]\n\nAvailable worker capabilities:',
  );
  const withoutWorkerCapabilities = withoutRecentObservations.replace(
    /Available worker capabilities:\n[\s\S]*$/,
    'Available worker capabilities:\n[worker capabilities omitted in trace]',
  );
  const compactCodeBlocks = withoutWorkerCapabilities.replace(/```([\w-]*)\n([\s\S]*?)```/g, (_match, lang, body: string) => {
    const trimmed = body.trim();
    const truncated = truncateInline(trimmed, 400);
    return `\`\`\`${lang}\n${truncated}\n\`\`\``;
  });
  return truncateInline(compactCodeBlocks, 5000);
};

const compactTraceResponse = (raw: string | null): string | null => {
  if (!raw) return null;
  const jsonStart = raw.indexOf('{');
  if (jsonStart >= 0) {
    const jsonPortion = raw.slice(jsonStart).trim();
    return truncateInline(jsonPortion, 1600);
  }
  return truncateInline(raw, 1600);
};

const shouldLogFullDecisionTrace = (_executionId: string): boolean => true;

const summarizeWorkerResultForTrace = (summary: string): string =>
  truncateInline(summary.replace(/\s+/g, ' ').trim(), 220);

const emitProgressEvent = (stream: StreamChannel | undefined, event: ProgressEvent): void => {
  if (!stream) return;
  stream.progressEvents.push(event);
  stream.sendEvent('progress', event);
};

const findExactSkillMatch = (
  query: string | undefined,
  skills: ReturnType<typeof listSkillMetadata>,
): string | null => {
  if (!query) return null;
  const normalized = query.trim().toLowerCase();
  if (!normalized) return null;
  return skills.find((skill) => skill.id.toLowerCase() === normalized || skill.name.toLowerCase() === normalized)?.id ?? null;
};

const adaptTerminalText = (result: Extract<GraphResult, { kind: 'answer' }>, executionId: string): string =>
  presentationAdapter.adapt({
    executionId,
    terminal:
      result.terminalState === 'COMPLETE'
        ? { type: 'COMPLETE', reply: result.text }
        : result.terminalState === 'ASK_USER'
          ? { type: 'ASK_USER', question: result.text }
          : result.terminalState === 'FAIL'
            ? { type: 'FAIL', reason: result.text }
            : { type: 'UNKNOWN', reason: result.text },
  }).content;

const applyInferredInputsToProfile = (
  profile: PersistedControllerProfile,
  inferredInputs: Record<string, string | undefined>,
): PersistedControllerProfile => ({
  ...profile,
  missingInputs: profile.missingInputs.filter((key) => !inferredInputs[key]),
});

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
  observationContext: string,
  message: string,
  attachedFiles: AttachedFileRef[],
): string => {
  const sections: string[] = [];
  if (observationContext) {
    sections.push(observationContext);
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

const sanitizeObservationsForPersistence = (observations: WorkerObservation[]): PersistedObservation[] =>
  observations.map((observation) => ({
    ok: observation.ok,
    workerKey: observation.workerKey,
    actionKind: observation.actionKind,
    summary: observation.summary,
    entities: observation.entities,
    facts: observation.facts,
    artifacts: observation.artifacts,
    citations: observation.citations,
    blockingReason: observation.blockingReason,
    verificationHints: observation.verificationHints,
  }));

const buildObservationContext = (messages: Array<{ metadata?: Record<string, unknown> }>): string => {
  const observations: PersistedObservation[] = [];
  for (const message of messages) {
    const payload = message.metadata?.controllerObservations;
    if (!Array.isArray(payload)) continue;
    for (const item of payload) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      if (typeof record.summary !== 'string' || typeof record.workerKey !== 'string' || typeof record.actionKind !== 'string') continue;
      observations.push({
        ok: record.ok !== false,
        workerKey: record.workerKey,
        actionKind: record.actionKind as WorkerObservation['actionKind'],
        summary: record.summary,
        entities: Array.isArray(record.entities) ? record.entities as any[] : [],
        facts: Array.isArray(record.facts) ? record.facts.filter((value): value is string => typeof value === 'string').slice(0, 4) : [],
        artifacts: Array.isArray(record.artifacts) ? record.artifacts as any[] : [],
        citations: Array.isArray(record.citations) ? record.citations as any[] : [],
        blockingReason: typeof record.blockingReason === 'string' ? record.blockingReason : undefined,
        verificationHints: Array.isArray(record.verificationHints) ? record.verificationHints as any[] : [],
      });
    }
  }

  if (observations.length === 0) return '';

  const lines = observations.map((observation, index) => {
    const artifactTitles = observation.artifacts.map((artifact) => artifact.title ?? artifact.id).slice(0, 3).join(' | ');
    return [
      `${index + 1}. worker=${observation.workerKey} action=${observation.actionKind} ok=${String(observation.ok)}`,
      `summary: ${observation.summary}`,
      observation.facts.length > 0 ? `facts: ${observation.facts.join(' | ')}` : '',
      artifactTitles ? `artifacts: ${artifactTitles}` : '',
      observation.blockingReason ? `blocking: ${observation.blockingReason}` : '',
    ].filter(Boolean).join('\n');
  });

  return ['--- Prior structured observations ---', ...lines, '--- End prior structured observations ---'].join('\n');
};

const getLatestControllerProfile = (
  messages: Array<{ metadata?: Record<string, unknown> }>,
): PersistedControllerProfile | null => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const payload = messages[index]?.metadata?.controllerProfile;
    if (!payload || typeof payload !== 'object') continue;
    const record = payload as Record<string, unknown>;
    if (typeof record.summary !== 'string' || !record.summary.trim()) continue;
    return {
      summary: record.summary.trim(),
      complexity:
        record.complexity === 'ambient' || record.complexity === 'simple' || record.complexity === 'structured'
          ? record.complexity
          : 'structured',
      shouldUseSkills: record.shouldUseSkills === true,
      skillQuery: typeof record.skillQuery === 'string' && record.skillQuery.trim() ? record.skillQuery.trim() : undefined,
      deliverables: Array.isArray(record.deliverables)
        ? record.deliverables.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).slice(0, 8)
        : [],
      missingInputs: Array.isArray(record.missingInputs)
        ? record.missingInputs.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).slice(0, 8)
        : [],
      directReply: typeof record.directReply === 'string' && record.directReply.trim() ? record.directReply.trim() : undefined,
      notes: Array.isArray(record.notes)
        ? record.notes.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).slice(0, 8)
        : [],
    };
  }
  return null;
};

const buildProfileContext = (profile: PersistedControllerProfile | null): string => {
  if (!profile) return '';
  return [
    '--- Prior controller profile ---',
    `summary: ${profile.summary}`,
    `complexity: ${profile.complexity}`,
    `shouldUseSkills: ${String(profile.shouldUseSkills)}`,
    profile.skillQuery ? `skillQuery: ${profile.skillQuery}` : '',
    profile.deliverables.length > 0 ? `deliverables: ${profile.deliverables.join(' | ')}` : '',
    profile.missingInputs.length > 0 ? `previously missing inputs: ${profile.missingInputs.join(' | ')}` : '',
    profile.notes.length > 0 ? `notes: ${profile.notes.join(' | ')}` : '',
    '--- End prior controller profile ---',
  ].filter(Boolean).join('\n');
};

const buildAssistantMemoryContent = (
  text: string,
  observations: WorkerObservation[],
): string => {
  const summaries = observations
    .slice(-4)
    .map((observation) => `${observation.workerKey}: ${observation.summary}`)
    .filter(Boolean);
  if (summaries.length === 0) return text;
  return [
    text,
    'Controller evidence:',
    ...summaries,
  ].filter(Boolean).join('\n');
};

const persistAssistantTurn = async (input: {
  threadId: string;
  userId: string;
  conversationKey: string;
  text: string;
  executionId: string;
  contentBlocks: ContentBlock[];
  progressEvents: ProgressEvent[];
  plan?: ExecutionPlan | null;
  observations?: WorkerObservation[];
  profile?: PersistedControllerProfile;
  state?: PersistedRuntimeState | null;
}) => {
  const metadata: Record<string, unknown> = {
    contentBlocks: input.contentBlocks,
    progressEvents: input.progressEvents,
    executionId: input.executionId,
    engineUsed: 'langgraph' as DesktopEngine,
    ...(input.plan ? { plan: input.plan } : {}),
    ...(input.observations && input.observations.length > 0
      ? {
        citations: input.observations.flatMap((observation) => observation.citations),
        controllerObservations: sanitizeObservationsForPersistence(input.observations),
      }
      : {}),
    ...(input.profile ? { controllerProfile: input.profile } : {}),
    ...(input.state ? { controllerStateSnapshot: sanitizeRuntimeStateForPersistence(input.state) } : {}),
  };
  const refs = buildPersistedConversationRefs(input.conversationKey);
  if (refs) {
    metadata.conversationRefs = refs;
  }

  const message = await desktopThreadsService.addMessage(
    input.threadId,
    input.userId,
    'assistant',
    input.text,
    metadata,
  );
  conversationMemoryStore.addAssistantMessage(
    input.conversationKey,
    message.id,
    buildAssistantMemoryContent(input.text, input.observations ?? []),
  );
  return message;
};

const sanitizeRuntimeStateForPersistence = (state: PersistedRuntimeState): PersistedRuntimeSnapshot => ({
  executionId: state.executionId,
  userRequest: state.userRequest,
  profile: state.profile,
  bootstrap: state.bootstrap,
  inferredInputs: state.inferredInputs,
  readinessConfirmed: state.readinessConfirmed,
  todoList: state.todoList ?? null,
  observations: state.observations,
  workerResults: state.workerResults,
  progressLedger: state.progressLedger,
  verifications: state.verifications,
  stepCount: state.stepCount,
  hopCount: state.hopCount,
  retryCount: state.retryCount,
  lifecyclePhase: state.lifecyclePhase,
  pendingSkillId: state.pendingSkillId,
  resolvedSkillId: state.resolvedSkillId,
  loadedSkillContent: state.loadedSkillContent,
  availableSkills: state.availableSkills,
  lastAction: state.lastAction,
  lastContractViolation: state.lastContractViolation,
  localActionHistory: state.localActionHistory,
  pendingLocalAction: state.pendingLocalAction,
});

const getLatestRuntimeSnapshot = (
  messages: Array<{ metadata?: Record<string, unknown> }>,
): PersistedRuntimeSnapshot | null => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const payload = messages[index]?.metadata?.controllerStateSnapshot;
    if (!payload || typeof payload !== 'object') continue;
    const record = payload as Record<string, unknown>;
    if (typeof record.userRequest !== 'string' || !record.userRequest.trim()) continue;
    if (!record.profile || typeof record.profile !== 'object') continue;
    if (!Array.isArray(record.observations)) continue;
    if (!Array.isArray(record.progressLedger)) continue;
    if (!Array.isArray(record.verifications)) continue;
    return record as PersistedRuntimeSnapshot;
  }
  return null;
};

const buildBootstrapFallback = (input: {
  message: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  latestProfile: PersistedControllerProfile | null;
}): PersistedControllerProfile => {
  const base = inferBootstrapFallback(input.message);
  const previousAssistant = [...input.history].reverse().find((item) => item.role === 'assistant');
  const looksLikeFollowup = input.message.trim().length > 0
    && input.message.trim().length <= 160
    && previousAssistant?.content.includes('?');
  if (!looksLikeFollowup || !input.latestProfile) {
    return base;
  }
  return {
    ...base,
    summary: input.latestProfile.summary,
    complexity: input.latestProfile.complexity === 'ambient' ? 'structured' : input.latestProfile.complexity,
    shouldUseSkills: input.latestProfile.shouldUseSkills,
    skillQuery: input.latestProfile.skillQuery ?? base.skillQuery,
    deliverables: input.latestProfile.deliverables.length > 0 ? input.latestProfile.deliverables : base.deliverables,
    missingInputs: [],
    notes: input.latestProfile.notes.length > 0 ? input.latestProfile.notes : base.notes,
  };
};

const shouldContinueFromSnapshot = (input: {
  message: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  snapshot: PersistedRuntimeSnapshot | null;
}): boolean => {
  if (!input.snapshot) return false;
  const trimmed = input.message.trim();
  if (!trimmed) return false;
  if (/^(continue|go on|carry on|proceed|resume)\b/i.test(trimmed)) return true;
  const previousAssistant = [...input.history].reverse().find((item) => item.role === 'assistant');
  return trimmed.length <= 200 && Boolean(previousAssistant?.content.includes('?'));
};

const buildContinuationState = (input: {
  executionId: string;
  snapshot: PersistedRuntimeSnapshot;
  followupMessage: string;
}): PersistedRuntimeState => ({
  ...(() => {
    const nextInferredInputs = input.snapshot.inferredInputs ?? {};
    const nextProfile = applyInferredInputsToProfile({
      ...input.snapshot.profile,
      missingInputs: [],
      notes: [
        ...(input.snapshot.profile.notes ?? []),
        ...(input.followupMessage.trim() ? [`follow-up user input: ${input.followupMessage.trim()}`] : []),
      ].slice(-8),
    }, nextInferredInputs);
    return {
      profile: nextProfile,
      inferredInputs: nextInferredInputs,
      readinessConfirmed: true,
      todoList: input.snapshot.todoList ?? null,
    };
  })(),
  executionId: input.executionId,
  userRequest: input.followupMessage.trim()
    ? `${input.snapshot.userRequest}\n\nFollow-up user input: ${input.followupMessage.trim()}`
    : input.snapshot.userRequest,
  bootstrap: input.snapshot.bootstrap ?? input.snapshot.profile,
  observations: input.snapshot.observations,
  workerResults: input.snapshot.workerResults ?? [],
  progressLedger: input.snapshot.progressLedger,
  verifications: input.snapshot.verifications,
  stepCount: input.snapshot.stepCount,
  hopCount: input.snapshot.hopCount ?? 0,
  retryCount: 0,
  lifecyclePhase: 'running',
  pendingSkillId: input.snapshot.pendingSkillId ?? null,
  resolvedSkillId: input.snapshot.resolvedSkillId ?? null,
  loadedSkillContent: input.snapshot.loadedSkillContent ?? null,
  availableSkills: input.snapshot.availableSkills ?? [],
  lastAction: input.snapshot.lastAction ?? null,
  lastContractViolation: null,
  readinessConfirmed: input.snapshot.readinessConfirmed ?? true,
  todoList: input.snapshot.todoList ?? null,
  localActionHistory: input.snapshot.localActionHistory ?? [],
  pendingLocalAction: undefined,
});

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
}): Promise<{
  historyContext: string;
  conversationRefs: string;
  latestProfile: PersistedControllerProfile | null;
  latestSnapshot: PersistedRuntimeSnapshot | null;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
}> => {
  const conversationKey = `desktop:${input.threadId}`;
  let history = conversationMemoryStore.getContextMessages(conversationKey, HISTORY_LIMIT);
  let persistedMessages: Array<{ metadata?: Record<string, unknown> }> = [];
  try {
    const thread = await desktopThreadsService.getThread(input.threadId, input.session.userId);
    persistedMessages = thread.messages
      .slice(-HISTORY_LIMIT)
      .map((message) => ({
        metadata: message.metadata && typeof message.metadata === 'object' ? message.metadata as Record<string, unknown> : undefined,
      }));
    if (history.length <= 1) {
      history = thread.messages
        .slice(-HISTORY_LIMIT)
        .map((message) => ({
          role: message.role === 'assistant' ? 'assistant' as const : 'user' as const,
          content: message.content,
        }));
    }
  } catch {
    history = conversationMemoryStore.getContextMessages(conversationKey, HISTORY_LIMIT);
  }
  const observationContext = buildObservationContext(persistedMessages);
  const profileContext = buildProfileContext(getLatestControllerProfile(persistedMessages));

  return {
    historyContext: buildHistoryAwareMessage(history, [profileContext, observationContext].filter(Boolean).join('\n\n'), input.message, input.attachedFiles),
    conversationRefs: buildConversationRefsContext(conversationKey),
    latestProfile: getLatestControllerProfile(persistedMessages),
    history,
    latestSnapshot: getLatestRuntimeSnapshot(persistedMessages),
  };
};

const projectExecutionPlan = (state: PersistedRuntimeState): ExecutionPlan | null => {
  if (state.profile.complexity === 'ambient') {
    return null;
  }

  const now = new Date().toISOString();
  const tasks: ExecutionPlan['tasks'] = [];
  if (state.profile.shouldUseSkills) {
    const hasSkillMeta = state.observations.some((observation) => observation.artifacts.some((artifact) => artifact.type === 'skill_metadata'));
    const hasSkillDoc = state.observations.some((observation) => observation.artifacts.some((artifact) => artifact.type === 'skill_document'));
    tasks.push({
      id: `${state.executionId}:skills`,
      title: 'Inspect relevant skill guidance',
      ownerAgent: 'supervisor',
      status: hasSkillDoc ? 'done' : hasSkillMeta ? 'running' : 'pending',
    });
  }
  if (state.profile.missingInputs.length > 0) {
    tasks.push({
      id: `${state.executionId}:inputs`,
      title: `Collect missing input: ${state.profile.missingInputs[0]}`,
      ownerAgent: 'supervisor',
      status: 'blocked',
    });
  }
  const workDone = state.observations.some((observation) => observation.ok && observation.workerKey !== 'skills');
  const latestWorker = [...state.observations].reverse().find((observation) => observation.workerKey !== 'skills');
  for (const [index, deliverable] of state.profile.deliverables.entries()) {
    tasks.push({
      id: `${state.executionId}:deliverable:${index}`,
      title: deliverable,
      ownerAgent: (latestWorker?.workerKey as ExecutionPlanOwner | undefined) ?? 'supervisor',
      status: workDone ? 'done' : state.pendingLocalAction ? 'blocked' : 'running',
    });
  }

  const finalSupervisorSatisfied = state.verifications.every((item) => item.status === 'satisfied');
  tasks.push({
    id: `${state.executionId}:supervisor`,
    title: 'Respond with the verified result',
    ownerAgent: 'supervisor',
    status: finalSupervisorSatisfied ? 'done' : tasks.every((task) => task.status === 'done') ? 'running' : 'pending',
  });

  return {
    id: state.executionId,
    goal: state.profile.summary,
    successCriteria: state.profile.deliverables.length > 0
      ? state.profile.deliverables.slice(0, 4)
      : ['Complete the user request'],
    status: finalSupervisorSatisfied ? 'completed' : tasks.some((task) => task.status === 'failed') ? 'failed' : 'running',
    createdAt: now,
    updatedAt: now,
    tasks,
  };
};

const summarizeWorkerInvocation = (invocation: {
  workerKey: string;
  actionKind: string;
  input: Record<string, unknown>;
}): string => {
  if (invocation.workerKey === 'skills') {
    if (invocation.actionKind === 'DISCOVER_CANDIDATES') {
      const query = typeof invocation.input.query === 'string' ? invocation.input.query : 'the current task';
      return `Inspecting skill metadata for "${query}"`;
    }
    if (invocation.actionKind === 'RETRIEVE_ARTIFACT') {
      const skillId = typeof invocation.input.id === 'string' ? invocation.input.id : 'selected skill';
      return `Loading SKILL.md for ${skillId}`;
    }
  }

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
  const requiredTools = getRequiredSkillTools(state.loadedSkillContent);
  const attempted = new Set(
    (state.workerResults ?? [])
      .filter((result) => result.workerKey !== 'skills')
      .map((result) => result.workerKey),
  );
  const pendingRequired = requiredTools.filter((tool: string) => !attempted.has(tool));
  if (pendingRequired.length > 0) {
    return `${satisfied} of ${state.verifications.length} checks satisfied, required tools pending: ${pendingRequired.join(', ')}`;
  }
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
    let streamClosed = false
    const markStreamClosed = (): void => {
      streamClosed = true
    }
    input.res.on('close', markStreamClosed)
    input.res.on('finish', markStreamClosed)
    input.res.on('error', markStreamClosed)
    const sendEvent = (type: string, data: unknown): void => {
      if (streamClosed || input.res.writableEnded || input.res.destroyed) {
        logger.error('desktop.flow.stream.write.closed', {
          file: 'backend/src/modules/desktop-chat/langgraph-desktop.engine.ts',
          method: 'stream',
          executionId: input.executionId,
          threadId: input.threadId,
          eventType: type,
        }, { always: true })
        return
      }
      try {
        input.res.write(`data: ${JSON.stringify({ type, data })}\n\n`)
        if ('flush' in input.res && typeof (input.res as Response & { flush?: () => void }).flush === 'function') {
          (input.res as Response & { flush?: () => void }).flush?.()
        }
      } catch (error) {
        streamClosed = true
        logger.error('desktop.flow.stream.write.error', {
          file: 'backend/src/modules/desktop-chat/langgraph-desktop.engine.ts',
          method: 'stream',
          executionId: input.executionId,
          threadId: input.threadId,
          eventType: type,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        }, { always: true })
      }
    };

    input.res.setHeader('Content-Type', 'text/event-stream');
    input.res.setHeader('Cache-Control', 'no-cache');
    input.res.setHeader('Connection', 'keep-alive');
    input.res.setHeader('X-Accel-Buffering', 'no');
    input.res.flushHeaders?.();

    const contentBlocks: ContentBlock[] = [];
    const progressEvents: ProgressEvent[] = [];
    const conversationKey = `desktop:${input.threadId}`;
    let latestState: PersistedRuntimeState | null = null;

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
      logger.info('desktop.flow.stream.enter', {
        file: 'backend/src/modules/desktop-chat/langgraph-desktop.engine.ts',
        method: 'stream',
        threadId: input.threadId,
        executionId: input.executionId,
        mode: input.mode,
      }, { always: true });
      const userMessage = await desktopThreadsService.addMessage(
        input.threadId,
        input.session.userId,
        'user',
        input.message,
        input.attachedFiles.length > 0 ? { attachedFiles: input.attachedFiles } : undefined,
      );
      conversationMemoryStore.addUserMessage(conversationKey, userMessage.id, input.message);

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
        stream: {
          sendEvent,
          contentBlocks,
          progressEvents,
          setLatestState: (state) => {
            latestState = state;
          },
        },
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

      const finalText = adaptTerminalText(result, input.executionId);
      emitProgressEvent(
        {
          sendEvent,
          contentBlocks,
          progressEvents,
          setLatestState: () => undefined,
        },
        result.terminalState === 'COMPLETE'
          ? { type: 'complete', reply: finalText }
          : result.terminalState === 'ASK_USER'
            ? { type: 'ask_user', question: finalText }
            : { type: 'fail', reason: finalText },
      );

      if (result.plan) {
        sendEvent('plan', result.plan);
      }

      contentBlocks.push({ type: 'text', content: finalText });
      sendEvent('text', finalText);
      const persisted = await persistAssistantTurn({
        threadId: input.threadId,
        userId: input.session.userId,
        conversationKey,
        text: finalText,
        executionId: input.executionId,
        contentBlocks,
        progressEvents,
        plan: result.plan ?? null,
        observations: result.observations,
        profile: result.profile,
        state: result.state,
      });
      sendEvent('done', { message: persisted });
      await executionService.completeRun({
        executionId: input.executionId,
        latestSummary: summarizeText(finalText) ?? finalText,
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
        estimatedOutputTokens: estimateTokens(finalText),
        mode: input.mode,
        wasCompacted: false,
      }).catch(() => undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Desktop controller failed';
      logger.error('desktop.flow.stream.uncaught', {
        file: 'backend/src/modules/desktop-chat/langgraph-desktop.engine.ts',
        method: 'stream',
        executionId: input.executionId,
        threadId: input.threadId,
        error: message,
        stack: error instanceof Error ? error.stack : undefined,
      }, { always: true });
      const friendly = presentationAdapter.adapt({
        executionId: input.executionId,
        terminal: { type: 'UNKNOWN', reason: message },
      }).content;
      emitProgressEvent(
        {
          sendEvent,
          contentBlocks,
          progressEvents,
          setLatestState: () => undefined,
        },
        { type: 'fail', reason: friendly },
      );
      contentBlocks.push({ type: 'text', content: friendly });
      sendEvent('text', friendly);
      const persistedState = latestState as PersistedRuntimeState | null;
      const persisted = await persistAssistantTurn({
        threadId: input.threadId,
        userId: input.session.userId,
        conversationKey,
        text: friendly,
        executionId: input.executionId,
        contentBlocks,
        progressEvents,
        state: persistedState,
        profile: persistedState?.profile,
        observations: persistedState?.observations ?? [],
      }).catch(() => null);
      if (persisted) {
        sendEvent('done', { message: persisted });
      }
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
    let streamClosed = false
    const markStreamClosed = (): void => {
      streamClosed = true
    }
    input.res.on('close', markStreamClosed)
    input.res.on('finish', markStreamClosed)
    input.res.on('error', markStreamClosed)
    const sendEvent = (type: string, data: unknown): void => {
      if (streamClosed || input.res.writableEnded || input.res.destroyed) {
        logger.error('desktop.flow.stream.write.closed', {
          file: 'backend/src/modules/desktop-chat/langgraph-desktop.engine.ts',
          method: 'streamAct',
          executionId: input.executionId,
          threadId: input.threadId,
          eventType: type,
        }, { always: true })
        return
      }
      try {
        input.res.write(`data: ${JSON.stringify({ type, data })}\n\n`)
        if ('flush' in input.res && typeof (input.res as Response & { flush?: () => void }).flush === 'function') {
          (input.res as Response & { flush?: () => void }).flush?.()
        }
      } catch (error) {
        streamClosed = true
        logger.error('desktop.flow.stream.write.error', {
          file: 'backend/src/modules/desktop-chat/langgraph-desktop.engine.ts',
          method: 'streamAct',
          executionId: input.executionId,
          threadId: input.threadId,
          eventType: type,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        }, { always: true })
      }
    };

    input.res.setHeader('Content-Type', 'text/event-stream');
    input.res.setHeader('Cache-Control', 'no-cache');
    input.res.setHeader('Connection', 'keep-alive');
    input.res.setHeader('X-Accel-Buffering', 'no');
    input.res.flushHeaders?.();

    const contentBlocks: ContentBlock[] = [];
    const progressEvents: ProgressEvent[] = [];
    const conversationKey = `desktop:${input.threadId}`;
    let latestState: PersistedRuntimeState | null = null;
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
      logger.info('desktop.flow.stream_act.enter', {
        file: 'backend/src/modules/desktop-chat/langgraph-desktop.engine.ts',
        method: 'streamAct',
        threadId: input.threadId,
        executionId: input.executionId,
        mode: input.mode,
        hasActionResult: Boolean(input.actionResult),
      }, { always: true });
      if (input.message && !input.actionResult) {
        const userMessage = await desktopThreadsService.addMessage(
          input.threadId,
          input.session.userId,
          'user',
          input.message,
        );
        conversationMemoryStore.addUserMessage(conversationKey, userMessage.id, input.message);
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
      contentBlocks.push({ type: 'thinking' });

      const result = await this.runSharedRuntime({
        session: input.session,
        threadId: input.threadId,
        message: input.message ?? '',
        attachedFiles: [],
        mode: input.mode,
        executionId: input.executionId,
        workspace: input.workspace,
        actionResult: input.actionResult,
        stream: {
          sendEvent,
          contentBlocks,
          progressEvents,
          setLatestState: (state) => {
            latestState = state;
          },
        },
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

      const finalText = adaptTerminalText(result, input.executionId);
      emitProgressEvent(
        {
          sendEvent,
          contentBlocks,
          progressEvents,
          setLatestState: () => undefined,
        },
        result.terminalState === 'COMPLETE'
          ? { type: 'complete', reply: finalText }
          : result.terminalState === 'ASK_USER'
            ? { type: 'ask_user', question: finalText }
            : { type: 'fail', reason: finalText },
      );

      if (result.plan) {
        sendEvent('plan', result.plan);
      }
      contentBlocks.push({ type: 'text', content: finalText });
      sendEvent('text', finalText);
      const message = await persistAssistantTurn({
        threadId: input.threadId,
        userId: input.session.userId,
        conversationKey,
        text: finalText,
        executionId: input.executionId,
        contentBlocks,
        progressEvents,
        plan: result.plan ?? null,
        observations: result.observations,
        profile: result.profile,
        state: result.state,
      });
      sendEvent('done', { message });
      await executionService.completeRun({
        executionId: input.executionId,
        latestSummary: summarizeText(finalText) ?? finalText,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Desktop controller failed';
      logger.error('desktop.flow.stream_act.uncaught', {
        file: 'backend/src/modules/desktop-chat/langgraph-desktop.engine.ts',
        method: 'streamAct',
        executionId: input.executionId,
        threadId: input.threadId,
        error: message,
        stack: error instanceof Error ? error.stack : undefined,
      }, { always: true });
      const friendly = presentationAdapter.adapt({
        executionId: input.executionId,
        terminal: { type: 'UNKNOWN', reason: message },
      }).content;
      emitProgressEvent(
        {
          sendEvent,
          contentBlocks,
          progressEvents,
          setLatestState: () => undefined,
        },
        { type: 'fail', reason: friendly },
      );
      contentBlocks.push({ type: 'text', content: friendly });
      sendEvent('text', friendly);
      const persistedState = latestState as PersistedRuntimeState | null;
      const persisted = await persistAssistantTurn({
        threadId: input.threadId,
        userId: input.session.userId,
        conversationKey,
        text: friendly,
        executionId: input.executionId,
        contentBlocks,
        progressEvents,
        state: persistedState,
        profile: persistedState?.profile,
        observations: persistedState?.observations ?? [],
      }).catch(() => null);
      if (persisted) {
        sendEvent('done', { message: persisted });
      }
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

    const finalText = adaptTerminalText(result, input.executionId);

    const metadata: Record<string, unknown> = {
      contentBlocks: result.observations.map((observation, index) => ({
        type: 'tool' as const,
        id: `${input.executionId}-observation-${index}`,
        name: observation.workerKey,
        label: observation.summary,
        icon: 'workflow',
        status: observation.ok ? 'done' as const : 'failed' as const,
        resultSummary: observation.summary,
      })),
      executionId: input.executionId,
      engineUsed: 'langgraph' as DesktopEngine,
      ...(result.plan ? { plan: completeExecutionPlan(result.plan, finalText) } : {}),
      ...(result.observations.length > 0 ? { citations: result.observations.flatMap((observation) => observation.citations) } : {}),
      controllerProfile: result.profile,
      controllerObservations: sanitizeObservationsForPersistence(result.observations),
      controllerStateSnapshot: sanitizeRuntimeStateForPersistence(result.state),
    };
    const refs = buildPersistedConversationRefs(conversationKey);
    if (refs) {
      metadata.conversationRefs = refs;
    }

    const message = await desktopThreadsService.addMessage(
      input.threadId,
      input.session.userId,
      'assistant',
      finalText,
      metadata,
    );
    conversationMemoryStore.addAssistantMessage(
      conversationKey,
      message.id,
      buildAssistantMemoryContent(finalText, result.observations),
    );
    await executionService.completeRun({
      executionId: input.executionId,
      latestSummary: summarizeText(finalText) ?? finalText,
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
    stream?: StreamChannel;
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
      if (shouldContinueFromSnapshot({
        message,
        history: controllerContext.history,
        snapshot: controllerContext.latestSnapshot,
      }) && controllerContext.latestSnapshot) {
        logger.info('desktop.flow.continuation.restore', {
          file: 'backend/src/modules/desktop-chat/langgraph-desktop.engine.ts',
          executionId: input.executionId,
          previousExecutionId: controllerContext.latestSnapshot.executionId,
          threadId: input.threadId,
        }, { always: true });
        initialState = buildContinuationState({
          executionId: input.executionId,
          snapshot: controllerContext.latestSnapshot,
          followupMessage: message,
        });
      } else {
      const skillCatalog = listSkillMetadata();
      const fallbackProfile = buildBootstrapFallback({
        message,
        history: controllerContext.history,
        latestProfile: controllerContext.latestProfile,
      });
      const rawProfile = await openAiOrchestrationModels.invokeSupervisor(buildBootstrapPrompt({
        message,
        contextBlock: [controllerContext.historyContext, controllerContext.conversationRefs].filter(Boolean).join('\n\n'),
        workers: DESKTOP_WORKER_CAPABILITIES,
        skills: skillCatalog,
      }));
      logger.info('llm.context.bootstrap', {
        file: 'backend/src/modules/desktop-chat/langgraph-desktop.engine.ts',
        executionId: input.executionId,
        threadId: input.threadId,
        prompt: compactTracePrompt(buildBootstrapPrompt({
          message,
          contextBlock: [controllerContext.historyContext, controllerContext.conversationRefs].filter(Boolean).join('\n\n'),
          workers: DESKTOP_WORKER_CAPABILITIES,
          skills: skillCatalog,
        })),
      }, { always: true });
      logger.info('llm.response.bootstrap', {
        file: 'backend/src/modules/desktop-chat/langgraph-desktop.engine.ts',
        executionId: input.executionId,
        raw: compactTraceResponse(rawProfile),
      }, { always: true });
      const profile = parseControllerProfile(rawProfile, fallbackProfile);
      const exactSkillId = findExactSkillMatch(profile.skillQuery, skillCatalog);
      const inferredInputs = exactSkillId
        ? inferenceEngine.infer(exactSkillId, message, profile)
        : {};
      const profileWithInference = applyInferredInputsToProfile(profile, inferredInputs);
      initialState = {
        executionId: input.executionId,
        userRequest: message,
        profile: profileWithInference,
        bootstrap: profile,
        inferredInputs,
        readinessConfirmed: false,
        todoList: null,
        observations: [],
        workerResults: [],
        progressLedger: [],
        verifications: [],
        stepCount: 0,
        hopCount: 0,
        retryCount: 0,
        lifecyclePhase: 'running',
        pendingSkillId: exactSkillId,
        resolvedSkillId: exactSkillId,
        loadedSkillContent: null,
        availableSkills: skillCatalog,
        lastAction: null,
        lastContractViolation: null,
        localActionHistory: [],
      };
      }
    }

    if (input.actionResult) {
      initialState = applyLocalObservation(initialState, actionResultToObservation(input.actionResult));
      initialState.pendingLocalAction = undefined;
      initialState.lifecyclePhase = 'running';
      input.stream?.setLatestState(sanitizeRuntimeStateForPersistence(initialState));
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
      onBootstrap: async (state, plan) => {
        input.stream?.setLatestState(sanitizeRuntimeStateForPersistence(state));
        if (input.stream) {
          emitProgressEvent(input.stream, {
            type: 'bootstrap',
            complexity: state.profile.complexity,
            ...(state.profile.skillQuery ? { skillQuery: state.profile.skillQuery } : {}),
          });
          input.stream.sendEvent('activity', {
            id: `${input.executionId}-bootstrap`,
            name: 'controller.bootstrap',
            label: 'Built controller profile',
            icon: 'sparkles',
          });
          input.stream.sendEvent('activity_done', {
            id: `${input.executionId}-bootstrap`,
            name: 'controller.bootstrap',
            label: 'Built controller profile',
            icon: 'sparkles',
            resultSummary: state.profile.summary,
          });
          if (plan) {
            input.stream.sendEvent('plan', plan);
          }
        }
      },
      onDecision: async (state, decision, plan) => {
        input.stream?.setLatestState(sanitizeRuntimeStateForPersistence(state));
        if (!input.stream) return;
        emitProgressEvent(
          input.stream,
          decision.decision === 'CALL_WORKER'
            ? {
              type: 'decision',
              decision: decision.decision,
              workerKey: decision.invocation.workerKey,
              actionKind: decision.invocation.actionKind,
            }
            : { type: 'decision', decision: decision.decision },
        );
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
        input.stream?.setLatestState(sanitizeRuntimeStateForPersistence(_state));
        if (!input.stream) return;
        emitProgressEvent(input.stream, {
          type: 'worker_dispatched',
          workerKey: invocation.workerKey,
          actionKind: invocation.actionKind,
        });
        const activityId = `${input.executionId}-worker-${_state.stepCount + 1}`;
        input.stream.sendEvent('activity', {
          id: activityId,
          name: 'controller.dispatch',
          label: summarizeWorkerInvocation(invocation),
          icon: 'workflow',
        });
      },
      onWorkerResult: async (state, invocation, observation, plan) => {
        input.stream?.setLatestState(sanitizeRuntimeStateForPersistence(state));
        if (!input.stream) return;
        if (invocation.workerKey === 'skills' && invocation.actionKind === 'RETRIEVE_ARTIFACT' && observation.ok) {
          const skillId = typeof invocation.input.id === 'string' ? invocation.input.id : state.resolvedSkillId ?? 'unknown-skill';
          emitProgressEvent(input.stream, { type: 'skill_loaded', skillId });
        }
        emitProgressEvent(input.stream, {
          type: 'worker_result',
          workerKey: invocation.workerKey,
          actionKind: invocation.actionKind,
          success: observation.ok,
          summary: summarizeWorkerResultForTrace(observation.summary),
        });
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
        input.stream?.setLatestState(sanitizeRuntimeStateForPersistence(state));
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
        input.stream?.setLatestState(sanitizeRuntimeStateForPersistence(state));
        if (!input.stream) return;
        const activityId = `${input.executionId}-verify-${state.stepCount}`;
          input.stream.sendEvent('activity', {
            id: activityId,
            name: 'controller.verify',
            label: 'Checking progress',
            icon: 'check-check',
          });
          input.stream.sendEvent('activity_done', {
            id: activityId,
            name: 'controller.verify',
            label: 'Checking progress',
            icon: 'check-check',
            resultSummary: summarizeVerificationState(state),
          });
        if (plan) {
          input.stream.sendEvent('plan', plan);
        }
      },
      onCheckpoint: async (node, state, extra) => {
        try {
          await checkpointRepository.save(input.executionId, `desktop.${node}`, {
            ...state,
            trace: { requestId: input.executionId },
            ...(input.stream
              ? {
                streamTrace: {
                  progressEvents: input.stream.progressEvents.slice(-50),
                  contentBlocks: input.stream.contentBlocks.slice(-50),
                },
              }
              : {}),
            ...(extra ? { extra } : {}),
          });
        } catch (error) {
          logger.error('desktop.flow.checkpoint.error', {
            file: 'backend/src/modules/desktop-chat/langgraph-desktop.engine.ts',
            executionId: input.executionId,
            threadId: input.threadId,
            node,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          }, { always: true });
        }
      },
    };

    let decisionPromptIndex = 0;

    const runtimeResult = await runControllerRuntime({
      initialState,
      workers: DESKTOP_WORKER_CAPABILITIES,
      skills: listSkillMetadata(),
      invokeController: async (prompt) => {
        decisionPromptIndex += 1;
        if (process.env.DEBUG_PROMPT === '1') {
          require('fs').writeFileSync(`/tmp/decision-prompt-${decisionPromptIndex}.txt`, prompt, 'utf8');
        }
        logger.info('llm.context.decision', {
          file: 'backend/src/modules/desktop-chat/langgraph-desktop.engine.ts',
          executionId: input.executionId,
          prompt: compactTracePrompt(prompt),
        }, { always: true });
        if (shouldLogFullDecisionTrace(input.executionId)) {
          logger.info('debug.llm.context.decision.full', {
            file: 'backend/src/modules/desktop-chat/langgraph-desktop.engine.ts',
            executionId: input.executionId,
            prompt,
          }, { always: true });
        }
        if (input.stream && !input.stream.contentBlocks.some((block) => block.type === 'thinking')) {
          input.stream.sendEvent('thinking', 'Thinking...');
          input.stream.contentBlocks.push({ type: 'thinking' });
        }
        const raw = await openAiOrchestrationModels.invokeSupervisor(prompt);
        logger.info('llm.response.decision', {
          file: 'backend/src/modules/desktop-chat/langgraph-desktop.engine.ts',
          executionId: input.executionId,
          raw: compactTraceResponse(raw),
        }, { always: true });
        if (shouldLogFullDecisionTrace(input.executionId)) {
          logger.info('debug.llm.response.decision.full', {
            file: 'backend/src/modules/desktop-chat/langgraph-desktop.engine.ts',
            executionId: input.executionId,
            raw,
          }, { always: true });
          try {
            await checkpointRepository.save(input.executionId, 'desktop.debug.decision.llm', {
              trace: { requestId: input.executionId },
              executionId: input.executionId,
              threadId: input.threadId,
              prompt,
              raw,
            });
          } catch (error) {
            logger.error('desktop.flow.checkpoint.error', {
              file: 'backend/src/modules/desktop-chat/langgraph-desktop.engine.ts',
              executionId: input.executionId,
              threadId: input.threadId,
              node: 'desktop.debug.decision.llm',
              error: error instanceof Error ? error.message : String(error),
              stack: error instanceof Error ? error.stack : undefined,
            }, { always: true });
          }
        }
        return raw;
      },
      executeWorker: (invocation) => executeDesktopWorker({ invocation, requestContext }),
      buildLocalAction: (state, kind) => {
        if (!input.workspace) return null;
        return buildDesktopLocalAction(state, kind);
      },
      hooks,
    });

    input.stream?.setLatestState(sanitizeRuntimeStateForPersistence(runtimeResult.state));

    const plan = projectExecutionPlan(runtimeResult.state);

    if (runtimeResult.kind === 'action') {
      return {
        kind: 'action',
        action: runtimeResult.action,
        plan,
        observations: runtimeResult.state.observations,
      };
    }

    if (!runtimeResult.state.terminalEventEmitted) {
      logger.error('desktop.flow.no_terminal_state', {
        file: 'backend/src/modules/desktop-chat/langgraph-desktop.engine.ts',
        executionId: input.executionId,
        threadId: input.threadId,
      }, { always: true });
      return {
        kind: 'answer',
        text: 'The workflow ended without producing a result. Please try again.',
        terminalState: 'FAIL',
        plan: plan ? failExecutionPlan(plan, 'The workflow ended without producing a result. Please try again.') : null,
        observations: runtimeResult.state.observations,
        profile: runtimeResult.state.profile,
        state: {
          ...runtimeResult.state,
          terminalEventEmitted: true,
        },
      };
    }

    const finalPlan = plan
      ? runtimeResult.state.verifications.every((item) => item.status === 'satisfied')
        ? completeExecutionPlan(plan, runtimeResult.text)
        : failExecutionPlan(plan, runtimeResult.text)
      : null;

    return {
      kind: 'answer',
      text: runtimeResult.text,
      terminalState: runtimeResult.terminalState,
      plan: finalPlan,
      observations: runtimeResult.state.observations,
      profile: runtimeResult.state.profile,
      state: runtimeResult.state,
    };
  }
}

export const langGraphDesktopChatEngine = new LangGraphDesktopChatEngine();
