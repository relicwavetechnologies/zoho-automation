import { randomUUID } from 'crypto';

import { generateObject } from 'ai';
import { z } from 'zod';

import config from '../../config';
import { HttpException } from '../../core/http-exception';
import {
  compileScheduledWorkflowDefinition,
  scheduledWorkflowCapabilitySummarySchema,
  scheduledWorkflowOutputConfigSchema,
  scheduledWorkflowScheduleConfigSchema,
  scheduledWorkflowSpecSchema,
  type ScheduledWorkflowCapabilitySummary,
  type ScheduledWorkflowOutputConfig,
  type ScheduledWorkflowScheduleConfig,
} from '../../company/scheduled-workflows/contracts';
import { validateScheduledWorkflowDefinition } from '../../company/scheduled-workflows/workflow-validator.service';
import { resolveChannelAdapter } from '../../company/channels/channel-adapter.registry';
import { larkUserAuthLinkRepository } from '../../company/channels/lark/lark-user-auth-link.repository';
import { resolveLarkPeople } from '../../company/orchestration/vercel/lark-helpers';
import { getSupportedToolActionGroups } from '../../company/tools/tool-action-groups';
import { toolPermissionService } from '../../company/tools/tool-permission.service';
import { TOOL_REGISTRY } from '../../company/tools/tool-registry';
import { resolveVercelLanguageModel } from '../../company/orchestration/vercel/model-factory';
import { vectorDocumentRepository } from '../../company/integrations/vector';
import { skillService } from '../../company/skills/skill.service';
import { prisma } from '../../utils/prisma';
import { logger } from '../../utils/logger';
import { departmentService } from '../../company/departments/department.service';
import { desktopThreadsService } from '../desktop-threads/desktop-threads.service';
import { memberAuthRepository } from '../member-auth/member-auth.repository';
import type { AttachedFileRef } from '../desktop-chat/file-vision.builder';
import type { MemberSessionDTO } from '../member-auth/member-auth.service';
import { executeAutomatedDesktopTurn } from '../desktop-chat/vercel-desktop.engine';
import { attachedFileSchema } from '../desktop-chat/desktop-chat.schemas';
import { formatScheduledSlot, getNextScheduledRunAt } from './desktop-workflows.schedule';
import { vercelOrchestrationEngine } from '../../company/orchestration/engine/vercel-orchestration.engine';
import type { NormalizedIncomingMessageDTO } from '../../company/contracts';

const WORKFLOW_NODE_KIND_VALUES = [
  'read',
  'search',
  'analyze',
  'transform',
  'createDraft',
  'updateSystem',
  'send',
  'notify',
  'requireApproval',
  'branch',
  'deliver',
] as const;
const WORKFLOW_ACTION_GROUP_VALUES = ['read', 'create', 'update', 'delete', 'send', 'execute'] as const;
const WORKFLOW_REQUIRED_INSTRUCTION_KINDS = new Set([
  'read',
  'search',
  'analyze',
  'transform',
  'createDraft',
  'updateSystem',
  'send',
  'notify',
  'requireApproval',
] as const);

const WORKFLOW_MODE_VALUES = [
  'file_backed_task_list',
  'research_digest',
  'system_update',
  'general',
] as const;
const WORKFLOW_SOURCE_KIND_VALUES = ['referenced_file', 'indexed_document', 'web', 'thread_context', 'none'] as const;
const WORKFLOW_UNIT_KIND_VALUES = ['rows', 'tasks', 'records', 'documents', 'single'] as const;
const WORKFLOW_ORDERING_VALUES = ['sequential', 'parallel'] as const;

const workflowIntentBlueprintSchema = z.object({
  primaryObjective: z.string().trim().min(1).max(500),
  workflowMode: z.enum(WORKFLOW_MODE_VALUES).optional(),
  sources: z.array(z.object({
    label: z.string().trim().min(1).max(160),
    kind: z.enum(WORKFLOW_SOURCE_KIND_VALUES).optional(),
    unitOfWork: z.enum(WORKFLOW_UNIT_KIND_VALUES).optional(),
    retrievalPreference: z.enum(['indexed_first', 'ocr_fallback', 'direct', 'none']).optional(),
    notes: z.string().trim().max(400).optional(),
  }).strict()).max(6).optional(),
  executionPolicy: z.object({
    ordering: z.enum(WORKFLOW_ORDERING_VALUES).optional(),
    routeEachItemByContent: z.boolean().optional(),
    includeApprovalBoundaries: z.boolean().optional(),
    produceCompletionReport: z.boolean().optional(),
  }).strict().optional(),
  outputPlan: z.object({
    finalDeliverable: z.string().trim().max(400).optional(),
    successCriteria: z.string().trim().max(600).optional(),
  }).strict().optional(),
  notificationPlan: z.object({
    channel: z.literal('lark_dm'),
    recipientQueries: z.array(z.string().trim().min(1).max(120)).min(1).max(10),
    messageTemplate: z.string().trim().min(1).max(2000),
  }).strict().optional(),
  stepInstructions: z.object({
    retrieval: z.string().trim().max(1600).optional(),
    extraction: z.string().trim().max(1600).optional(),
    execution: z.string().trim().max(2400).optional(),
    summary: z.string().trim().max(1600).optional(),
    delivery: z.string().trim().max(800).optional(),
  }).strict().optional(),
}).strict();

const generatedWorkflowCompilerOutputSchema = z.object({
  compilerNotes: z.string().trim().min(1).max(600),
  blueprint: workflowIntentBlueprintSchema,
}).strict();

const WORKFLOW_PLANNING_FIELD_VALUES = [
  'source',
  'schedule',
  'destination',
  'approval',
  'execution_order',
  'delivery',
  'other',
] as const;
const WORKFLOW_PLANNING_PHASE_VALUES = ['planning', 'ready', 'built'] as const;

const workflowPlanningQuestionOptionSchema = z.object({
  label: z.string().trim().min(1).max(80),
  value: z.string().trim().min(1).max(160),
  description: z.string().trim().max(180).optional(),
}).strict();

const workflowPlanningQuestionSchema = z.object({
  id: z.string().trim().min(1).max(80),
  field: z.enum(WORKFLOW_PLANNING_FIELD_VALUES),
  label: z.string().trim().min(1).max(80),
  question: z.string().trim().min(1).max(400),
  options: z.array(workflowPlanningQuestionOptionSchema).max(4).optional(),
}).strict();

const workflowPlanningStateSchema = z.object({
  version: z.literal('v1'),
  phase: z.enum(WORKFLOW_PLANNING_PHASE_VALUES),
  readyToBuild: z.boolean(),
  objective: z.string().trim().min(1).max(600),
  intentSummary: z.string().trim().min(1).max(1000),
  executionOrder: z.enum(WORKFLOW_ORDERING_VALUES).optional(),
  unitOfWork: z.enum([...WORKFLOW_UNIT_KIND_VALUES, 'general'] as const).optional(),
  sourceSummary: z.string().trim().max(2000).optional(),
  outputSummary: z.string().trim().max(600).optional(),
  approvalSummary: z.string().trim().max(400).optional(),
  planningFindings: z.array(z.string().trim().min(1).max(500)).max(8).optional(),
  suggestedToolFamilies: z.array(z.string().trim().min(1).max(80)).max(10).optional(),
  openQuestions: z.array(workflowPlanningQuestionSchema).max(4).default([]),
}).strict();

const workflowPlanningDraftUpdateSchema = z.object({
  schedule: scheduledWorkflowScheduleConfigSchema.optional(),
  scheduleEnabled: z.boolean().optional(),
}).strict();

const generatedWorkflowPlanningTurnSchema = z.object({
  assistantResponse: z.string().trim().min(1).max(4000),
  planningState: workflowPlanningStateSchema,
  draftUpdate: workflowPlanningDraftUpdateSchema.optional(),
}).strict();

const workflowAuthorMessageMetadataSchema = z.object({
  attachedFileContext: z.string().trim().max(2000).optional(),
  attachedFiles: z.array(attachedFileSchema).max(12).optional(),
  planningState: workflowPlanningStateSchema.optional(),
  clarificationQuestions: z.array(workflowPlanningQuestionSchema).max(4).optional(),
  draftUpdate: workflowPlanningDraftUpdateSchema.optional(),
  model: z.object({
    provider: z.string().trim().min(1).max(80),
    modelId: z.string().trim().min(1).max(160),
  }).strict().optional(),
  compilerNotes: z.string().trim().max(1200).optional(),
}).strict();

export type DesktopWorkflowCompilerInput = {
  name: string;
  userIntent: string;
  schedule: ScheduledWorkflowScheduleConfig;
  outputConfig: ScheduledWorkflowOutputConfig;
  attachedFiles?: AttachedFileRef[];
};

export type DesktopWorkflowPublishInput = {
  workflowId?: string | null;
  name: string;
  userIntent: string;
  aiDraft?: string | null;
  schedule: ScheduledWorkflowScheduleConfig;
  scheduleEnabled?: boolean;
  outputConfig: ScheduledWorkflowOutputConfig;
  workflowSpec: z.infer<typeof scheduledWorkflowSpecSchema>;
  compiledPrompt: string;
  capabilitySummary?: ScheduledWorkflowCapabilitySummary;
  departmentId?: string | null;
  originChatId?: string | null;
};

type StoredWorkflowStatus = 'draft' | 'published' | 'active' | 'scheduled_active' | 'paused' | 'archived';
type WorkflowPresentationStatus = 'draft' | 'published' | 'scheduled_active' | 'paused' | 'archived';
type WorkflowAuthorMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  referenceContext?: string | null;
  planningState?: z.infer<typeof workflowPlanningStateSchema> | null;
  clarificationQuestions?: z.infer<typeof workflowPlanningQuestionSchema>[];
};

const WORKFLOW_HISTORY_WINDOW = 3;
const WORKFLOW_PLANNING_HISTORY_WINDOW = 6;
const DEFAULT_WORKFLOW_NAME = 'Untitled workflow';
const WORKFLOW_REFERENCE_PREVIEW_MAX_CHARS = 400;
const WORKFLOW_REFERENCE_PREVIEW_CHUNKS = 2;
const WORKFLOW_REFERENCE_CONTEXT_TOTAL_MAX_CHARS = 1600;
const WORKFLOW_AI_DRAFT_CONTEXT_MAX_CHARS = 1600;
const WORKFLOW_COMPILE_TIMEOUT_MS = 30000;
const WORKFLOW_PLANNING_TIMEOUT_MS = 15000;
const LARK_INTENT_SOURCE_MARKER = '[source:lark_intent]';

const readString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

const readStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim())
    : [];

const readRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

const truncateText = (value: string, maxChars: number): string =>
  value.length > maxChars ? `${value.slice(0, maxChars - 3)}...` : value;

const sanitizeIdentifier = (value: string, fallback: string): string => {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return normalized || fallback;
};

const LARK_WEEKDAY_BY_NUMBER = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;

const buildLarkIntentWorkflowDescription = (userIntent: string): string =>
  `${LARK_INTENT_SOURCE_MARKER} ${truncateText(userIntent.trim(), 900)}`;

const isLarkIntentWorkflowSpec = (workflowSpec: z.infer<typeof scheduledWorkflowSpecSchema>): boolean =>
  workflowSpec.description?.includes(LARK_INTENT_SOURCE_MARKER) ?? false;

const toWeeklyScheduleDay = (dayOfWeek: number): (typeof LARK_WEEKDAY_BY_NUMBER)[number] =>
  LARK_WEEKDAY_BY_NUMBER[dayOfWeek] ?? 'MO';

const looksLikeLarkDmIntent = (value: string): boolean =>
  includesAny(value, [
    'lark dm',
    'direct message',
    'send dm',
    'dm me',
    'message me',
    'message him',
    'message her',
    'message them',
    'ping me',
    'ping him',
    'ping her',
    'ping them',
  ]);

const extractHeuristicNotificationPlan = (
  userIntent: string,
): z.infer<NonNullable<typeof workflowIntentBlueprintSchema.shape.notificationPlan>> | undefined => {
  if (!looksLikeLarkDmIntent(userIntent) || !includesAny(userIntent, ['send', 'dm', 'message', 'ping'])) {
    return undefined;
  }

  const recipientSection = userIntent.match(/\b(?:to|for)\s+(.+)$/i)?.[1];
  const recipientQueries = (recipientSection
    ? recipientSection
      .split(/\s*(?:,| and )\s*/i)
      .map((entry) => entry.trim())
      .filter(Boolean)
    : [])
    .slice(0, 10);
  const messageTemplate = userIntent.match(/\bsend\s+(.+?)\s+(?:to|for|in)\b/i)?.[1]?.trim()
    || 'Scheduled Lark direct message.';

  return {
    channel: 'lark_dm',
    recipientQueries: recipientQueries.length > 0 ? recipientQueries : ['me'],
    messageTemplate,
  };
};

const titleFromIdentifier = (value: string): string =>
  value
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase()) || 'Workflow step';

const normalizeWorkflowNodeKind = (value: string | undefined): (typeof WORKFLOW_NODE_KIND_VALUES)[number] =>
  WORKFLOW_NODE_KIND_VALUES.includes((value ?? '') as (typeof WORKFLOW_NODE_KIND_VALUES)[number])
    ? (value as (typeof WORKFLOW_NODE_KIND_VALUES)[number])
    : 'analyze';

const looksLikeReferenceRetrieval = (value: string | undefined): boolean => {
  const text = (value ?? '').toLowerCase();
  if (!text) return false;
  return ['csv', 'file', 'document', 'sheet', 'spreadsheet', 'assignment', 'read ', 'load ', 'fetch ']
    .some((needle) => text.includes(needle));
};

const buildReferenceRetrievalInstructions = (referenceContext: string): string => [
  'Retrieve and read the referenced files or images before downstream work.',
  'First use contextSearch to retrieve indexed company documents and prior grounded context.',
  'If chunk retrieval is unavailable or insufficient, fall back to document-ocr-read for exact extraction.',
  'Use the retrieved file contents as grounding context for all later steps.',
  '',
  'Referenced context:',
  referenceContext.trim(),
].join('\n');

const buildScheduleSummary = (schedule: ScheduledWorkflowScheduleConfig): string => {
  if (schedule.type === 'hourly') {
    return `Every ${schedule.intervalHours} hour${schedule.intervalHours === 1 ? '' : 's'} at minute ${String(schedule.minute).padStart(2, '0')} (${schedule.timezone})`;
  }
  if (schedule.type === 'daily') {
    return `Daily at ${String(schedule.time.hour).padStart(2, '0')}:${String(schedule.time.minute).padStart(2, '0')} (${schedule.timezone})`;
  }
  if (schedule.type === 'weekly') {
    return `Weekly on ${schedule.daysOfWeek.join(', ')} at ${String(schedule.time.hour).padStart(2, '0')}:${String(schedule.time.minute).padStart(2, '0')} (${schedule.timezone})`;
  }
  if (schedule.type === 'monthly') {
    return `Monthly on day ${schedule.dayOfMonth} at ${String(schedule.time.hour).padStart(2, '0')}:${String(schedule.time.minute).padStart(2, '0')} (${schedule.timezone})`;
  }
  return `One time at ${schedule.runAt} (${schedule.timezone})`;
};

const deriveWorkflowName = (seed: string | null | undefined): string => {
  const trimmed = seed?.trim();
  if (!trimmed) return DEFAULT_WORKFLOW_NAME;
  const compact = trimmed.replace(/\s+/g, ' ').trim();
  return compact.length <= 56 ? compact : `${compact.slice(0, 53).trimEnd()}...`;
};

const buildDestinationSummary = (outputConfig: ScheduledWorkflowOutputConfig): string =>
  outputConfig.destinations
    .map((destination) => {
      if (destination.kind === 'desktop_inbox') return `${destination.id}: desktop inbox`;
      if (destination.kind === 'desktop_thread') return `${destination.id}: desktop thread (${destination.threadId})`;
      if (destination.kind === 'lark_current_chat') return `${destination.id}: current lark chat`;
      if (destination.kind === 'lark_self_dm') return `${destination.id}: requester personal lark dm (${destination.openId})`;
      return `${destination.id}: lark chat (${destination.chatId})`;
    })
    .join('\n');

const resolveLarkDestinationTarget = (
  destination: Extract<ScheduledWorkflowOutputConfig['destinations'][number], { kind: 'lark_chat' | 'lark_current_chat' | 'lark_self_dm' }>,
  originChatId?: string | null,
): { targetId: string | null; error: string | null } => {
  if (destination.kind === 'lark_current_chat') {
    return {
      targetId: originChatId ?? null,
      error: originChatId ? null : 'originChatId missing',
    };
  }
  if (destination.kind === 'lark_self_dm') {
    return {
      targetId: readString(destination.openId) ?? null,
      error: readString(destination.openId) ? null : 'requester larkOpenId missing',
    };
  }
  return {
    targetId: destination.chatId,
    error: readString(destination.chatId) ? null : 'chatId missing',
  };
};

const buildToolFamilyGuide = (allowedToolIds: string[]): string =>
  Object.entries(
    TOOL_REGISTRY
      .filter((tool) => allowedToolIds.includes(tool.id))
      .reduce<Record<string, string[]>>((acc, tool) => {
        const actionGroups = getSupportedToolActionGroups(tool.id).join('/');
        const entry = `${tool.id}(${actionGroups})`;
        acc[tool.category] = [...(acc[tool.category] ?? []), entry];
        return acc;
      }, {}),
  )
    .map(([category, entries]) => `- ${category}: ${entries.join(', ')}`)
    .join('\n');

const buildPlanningToolGuide = (allowedToolIds: string[]): string => {
  const lines: string[] = [];
  if (allowedToolIds.includes('context-search')) {
    lines.push('- context-search: unified retrieval for indexed docs, prior conversations, Lark contacts, Zoho context, web research, and skills.');
  }
  if (allowedToolIds.includes('document-ocr-read')) {
    lines.push('- document-ocr-read: read the actual uploaded file directly when exact extraction or OCR is needed.');
  }
  return lines.join('\n');
};

const buildPlanningStateSummary = (
  state: z.infer<typeof workflowPlanningStateSchema> | null | undefined,
): string => {
  if (!state) return '';

  const lines = [
    `Objective: ${state.objective}`,
    `Intent summary: ${state.intentSummary}`,
  ];
  if (state.executionOrder) lines.push(`Execution order: ${state.executionOrder}`);
  if (state.unitOfWork) lines.push(`Unit of work: ${state.unitOfWork}`);
  if (state.sourceSummary) lines.push(`Source plan: ${state.sourceSummary}`);
  if (state.outputSummary) lines.push(`Output plan: ${state.outputSummary}`);
  if (state.approvalSummary) lines.push(`Approval handling: ${state.approvalSummary}`);
  if (state.planningFindings?.length) {
    lines.push('Planning findings:');
    state.planningFindings.forEach((finding) => lines.push(`- ${finding}`));
  }
  if (state.openQuestions.length > 0) {
    lines.push('Open questions:');
    state.openQuestions.forEach((question) => lines.push(`- ${question.label}: ${question.question}`));
  }
  return lines.join('\n');
};

const summarizeWorkflowSpec = (spec: z.infer<typeof scheduledWorkflowSpecSchema> | null | undefined): string => {
  if (!spec) return '';
  return spec.nodes
    .slice(0, 12)
    .map((node, index) => {
      const parts = [`${index + 1}. [${node.kind}] ${node.title}`];
      if (node.capability) {
        parts.push(`capability=${node.capability.toolId}.${node.capability.actionGroup}`);
      }
      if (node.destinationIds?.length) {
        parts.push(`destinations=${node.destinationIds.join(',')}`);
      }
      return parts.join(' ');
    })
    .join('\n');
};

const summarizeAiDraft = (draft: string | null | undefined): string =>
  draft?.trim() ? truncateText(draft.trim(), WORKFLOW_AI_DRAFT_CONTEXT_MAX_CHARS) : '';

const looksLikeTaskListIntent = (userIntent: string, referenceContext?: string | null): boolean => {
  const joined = `${userIntent}\n${referenceContext ?? ''}`.toLowerCase();
  return [
    'csv',
    'spreadsheet',
    'assignment',
    'task',
    'tasks',
    'row',
    'rows',
    'one by one',
    'sequential',
    'sequentially',
    'data rows',
  ].some((needle) => joined.includes(needle));
};

const likelyNeedsWriteExecution = (value: string): boolean =>
  includesAny(value, [
    'create',
    'update',
    'send',
    'submit',
    'schedule',
    'book',
    'draft',
    'write',
    'post',
    'assign',
    'execute',
    'complete',
    'do all these tasks',
  ]);

const userDisallowsClarifyingQuestions = (value: string): boolean =>
  includesAny(value, [
    'no questions',
    'dont ask questions',
    "don't ask questions",
    'without questions',
    'no follow up questions',
    'no clarifying questions',
    'just build it',
    'build it directly',
  ]);

const userExplicitlyRequestsWorkflowBuild = (value: string): boolean =>
  includesAny(value, [
    'build the workflow',
    'build workflow',
    'build it',
    'proceed building',
    'proceed with build',
    'proceed',
    'go ahead and build',
    'go ahead',
    'now build',
    'okay build',
    'ok build',
    'yes build',
    'yes build it',
    'yes go ahead',
    'yes proceed',
    'looks good build',
    'you can proceed updating',
    'you can proceed building',
    'you can proceed updating or building',
    'proceed updating the workflow',
    'proceed with the workflow',
    'finalize the workflow',
    'compile the workflow',
  ]);

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const buildCompilerPrompt = (input: {
  workflowName: string;
  userIntent: string;
  schedule: ScheduledWorkflowScheduleConfig;
  outputConfig: ScheduledWorkflowOutputConfig;
  allowedToolIds: string[];
  referenceContext?: string | null;
  planningStateSummary?: string | null;
}): string => {
  const allowedDestinationIds = input.outputConfig.destinations.map((destination) => destination.id).join(', ');

  return [
    'You are a workflow intent compiler.',
    'Do not return workflow JSON directly. Return a compact execution blueprint that another deterministic compiler will turn into the final workflow graph.',
    'Your job is to infer the real operating recipe behind the user brief.',
    'Focus on: source retrieval, unit of work, execution policy, reporting, and delivery.',
    'Prefer explicit operational instructions over paraphrases.',
    'If referenced files exist, explain how runtime should retrieve them first.',
    'For referenced files, prefer contextSearch first for indexed retrieval and history recall.',
    'Use document-ocr-read only as fallback when exact extraction is required or chunk retrieval is insufficient.',
    'For CSV or task-table jobs, describe the units of work as rows/tasks and the execution policy as sequential unless the user clearly asks for parallelism.',
    'If work items imply writes or sends, tell runtime to route each item to the appropriate approved tool family based on item content and to honor approvals when required.',
    'If the workflow must send Lark direct messages, populate notificationPlan with channel=lark_dm, the intended recipientQueries, and the exact messageTemplate to send. Recipient queries may include "me".',
    'For Lark-authored workflows, treat the requester personal Lark DM as the default delivery destination unless the user explicitly asks for a shared chat or another target.',
    'Only deliver to these destination ids: ' + allowedDestinationIds,
    'Keep compilerNotes short and practical.',
    '',
    `Workflow name: ${input.workflowName}`,
    `User intent: ${input.userIntent}`,
    input.planningStateSummary?.trim() ? ['Resolved planning state:', input.planningStateSummary.trim(), ''].join('\n') : '',
    input.referenceContext?.trim() ? ['Referenced files:', input.referenceContext.trim(), ''].join('\n') : '',
    `Schedule: ${buildScheduleSummary(input.schedule)}`,
    'Allowed destinations:',
    buildDestinationSummary(input.outputConfig),
    '',
    'Allowed tool families:',
    buildToolFamilyGuide(input.allowedToolIds),
    '',
    'Blueprint requirements:',
    '- primaryObjective: the actual job to complete',
    '- workflowMode: choose the closest mode',
    '- sources: list the main source artifacts and the unit of work',
    '- executionPolicy: state ordering, per-item routing, approval sensitivity, and completion reporting',
    '- outputPlan: describe the final deliverable and success criteria',
    '- notificationPlan: only when the workflow should send Lark DMs; include recipientQueries and messageTemplate',
    '- stepInstructions: write concrete instructions for retrieval, extraction, execution, summary, and delivery',
  ].join('\n');
};

const buildAuthoringPrompt = (input: {
  workflowName: string;
  latestIntent: string;
  schedule: ScheduledWorkflowScheduleConfig;
  outputConfig: ScheduledWorkflowOutputConfig;
  allowedToolIds: string[];
  history: WorkflowAuthorMessage[];
  currentAiDraft?: string | null;
  currentWorkflowSpec?: z.infer<typeof scheduledWorkflowSpecSchema> | null;
  latestReferenceContext?: string | null;
}): string => {
  const transcript = input.history
    .slice(-WORKFLOW_HISTORY_WINDOW)
    .map((message) => {
      const lines = [`${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content}`];
      if (message.referenceContext?.trim()) {
        lines.push('Referenced files:');
        lines.push(message.referenceContext.trim());
      }
      return lines.join('\n');
    })
    .join('\n');

  return [
    'You are refining a reusable workflow from an iterative authoring conversation.',
    'Return a refreshed execution blueprint, not direct workflow JSON.',
    'Preserve the underlying job unless the latest user instruction clearly changes it.',
    'Carry forward source context, units of work, execution policy, and delivery expectations from the current workflow unless the user changes them.',
    'For referenced files, the blueprint must explicitly explain retrieval and extraction before downstream execution.',
    'Prefer contextSearch first for indexed company retrieval, then document-ocr-read as fallback for exact extraction.',
    'For CSV or task-table workflows, keep the unit of work as rows/tasks and keep execution sequential unless the user says otherwise.',
    'Do not regress a file-backed operational workflow into generic analyze-only instructions.',
    'If the workflow should message teammates on Lark, preserve the notification plan with concrete recipient queries and a concrete message template.',
    'For Lark-authored workflows, keep delivery private by default: the requester personal Lark DM stays the default unless the user explicitly changes it.',
    '',
    `Workflow name: ${input.workflowName}`,
    `Latest user brief: ${input.latestIntent}`,
    input.latestReferenceContext?.trim() ? ['Latest referenced files:', input.latestReferenceContext.trim(), ''].join('\n') : '',
    `Schedule: ${buildScheduleSummary(input.schedule)}`,
    'Allowed destinations:',
    buildDestinationSummary(input.outputConfig),
    '',
    'Allowed tool families:',
    buildToolFamilyGuide(input.allowedToolIds),
    '',
    input.currentAiDraft?.trim()
      ? ['Current reusable prompt summary:', summarizeAiDraft(input.currentAiDraft), ''].join('\n')
      : '',
    input.currentWorkflowSpec
      ? ['Current workflow summary:', summarizeWorkflowSpec(input.currentWorkflowSpec), ''].join('\n')
      : '',
    'Recent authoring conversation:',
    transcript || 'User: Create a new workflow draft.',
  ].filter(Boolean).join('\n');
};

const buildPlanningPrompt = (input: {
  workflowName: string;
  latestIntent: string;
  schedule: ScheduledWorkflowScheduleConfig;
  outputConfig: ScheduledWorkflowOutputConfig;
  history: WorkflowAuthorMessage[];
  currentPlanningState?: z.infer<typeof workflowPlanningStateSchema> | null;
  currentAiDraft?: string | null;
  currentWorkflowSpec?: z.infer<typeof scheduledWorkflowSpecSchema> | null;
  latestReferenceContext?: string | null;
  allowedPlanningToolIds: string[];
  planningSkillContext?: string | null;
}): string => {
  const transcript = input.history
    .slice(-WORKFLOW_PLANNING_HISTORY_WINDOW)
    .map((message) => {
      const lines = [`${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content}`];
      if (message.referenceContext?.trim()) {
        lines.push('Referenced files:');
        lines.push(message.referenceContext.trim());
      }
      if (message.clarificationQuestions?.length) {
        lines.push('Clarifications asked:');
        message.clarificationQuestions.forEach((question) => {
          lines.push(`- ${question.label}: ${question.question}`);
        });
      }
      return lines.join('\n');
    })
    .join('\n\n');

  return [
    'You are the planning assistant for a workflow builder.',
    'Stay in planning mode. Decide whether you should ask concise clarifying questions or whether the workflow is ready to build.',
    'Do not return workflow JSON.',
    'Ask clarifying questions only when missing information would materially change the workflow graph or execution behavior.',
    input.latestIntent && userDisallowsClarifyingQuestions(input.latestIntent)
      ? 'The user explicitly does not want clarifying questions. Default missing details when reasonable and build if it is safe to do so.'
      : '',
    'Even when the plan is ready, do not assume you should build immediately unless the user explicitly asks you to proceed/build/finalize.',
    'Use defaults for schedule and destination when the existing workflow already has them.',
    'For a new workflow authored from Lark, the default destination is the requester personal Lark DM unless the user explicitly asks for the current chat, a shared chat, or another destination.',
    'If the workflow destination would change from an existing saved destination, say that change plainly before asking to save.',
    'For referenced files or company docs, internal company document retrieval comes first: use indexed docs first, then OCR/direct uploaded-file read if needed.',
    'Do not suggest Google Drive, workspace inspection, repo access, or local filesystem discovery as the first path for uploaded/company files.',
    'When the request is complete enough, mark readyToBuild=true and summarize the final execution plan clearly, then wait for explicit user approval to build.',
    'Keep assistantResponse concise but useful.',
    '',
    `Workflow name: ${input.workflowName}`,
    `Latest user message: ${input.latestIntent}`,
    `Current schedule: ${buildScheduleSummary(input.schedule)}`,
    'Current destinations:',
    buildDestinationSummary(input.outputConfig),
    '',
    'Planning tools you may assume exist:',
    buildPlanningToolGuide(input.allowedPlanningToolIds) || '- No planning tools available.',
    '',
    input.latestReferenceContext?.trim() ? ['Referenced file context:', input.latestReferenceContext.trim(), ''].join('\n') : '',
    input.planningSkillContext?.trim() ? ['Relevant skills:', input.planningSkillContext.trim(), ''].join('\n') : '',
    input.currentPlanningState
      ? ['Current planning state:', buildPlanningStateSummary(input.currentPlanningState), ''].join('\n')
      : '',
    input.currentAiDraft?.trim()
      ? ['Current reusable prompt summary:', summarizeAiDraft(input.currentAiDraft), ''].join('\n')
      : '',
    input.currentWorkflowSpec
      ? ['Current workflow summary:', summarizeWorkflowSpec(input.currentWorkflowSpec), ''].join('\n')
      : '',
    'Recent planning transcript:',
    transcript || 'User: Create a new workflow draft.',
    '',
    'Return:',
    '- assistantResponse: the next assistant message to show in the planning chat',
    '- planningState: objective, intent summary, source plan, output plan, ordering, findings, open questions, and readyToBuild',
    '- draftUpdate.schedule only when the user explicitly changed scheduling or timing for this draft.',
    '- For weekly schedules use weekday codes: MO, TU, WE, TH, FR, SA, SU.',
    '- If you ask questions, keep them to at most 3 and prefer structured options for execution order, approvals, destination, or source confirmation.',
  ].filter(Boolean).join('\n');
};

const includesAny = (value: string, needles: string[]): boolean => {
  const lowered = value.toLowerCase();
  return needles.some((needle) => lowered.includes(needle));
};

const buildClarificationQuestion = (
  question: z.infer<typeof workflowPlanningQuestionSchema>,
): z.infer<typeof workflowPlanningQuestionSchema> => question;

const normalizePlanningState = (
  state: z.infer<typeof workflowPlanningStateSchema>,
  phaseOverride?: (typeof WORKFLOW_PLANNING_PHASE_VALUES)[number],
): z.infer<typeof workflowPlanningStateSchema> => {
  const readyToBuild = state.readyToBuild && state.openQuestions.length === 0;
  return workflowPlanningStateSchema.parse({
    ...state,
    objective: truncateText(state.objective, 600),
    intentSummary: truncateText(state.intentSummary, 1000),
    sourceSummary: state.sourceSummary ? truncateText(state.sourceSummary, 2000) : undefined,
    outputSummary: state.outputSummary ? truncateText(state.outputSummary, 600) : undefined,
    approvalSummary: state.approvalSummary ? truncateText(state.approvalSummary, 400) : undefined,
    planningFindings: state.planningFindings?.map((finding) => truncateText(finding, 500)).slice(0, 8),
    suggestedToolFamilies: state.suggestedToolFamilies?.map((tool) => truncateText(tool, 80)).slice(0, 10),
    openQuestions: state.openQuestions.slice(0, 4).map((question) => ({
      ...question,
      label: truncateText(question.label, 80),
      question: truncateText(question.question, 400),
      options: question.options?.slice(0, 4).map((option) => ({
        ...option,
        label: truncateText(option.label, 80),
        value: truncateText(option.value, 160),
        description: option.description ? truncateText(option.description, 180) : undefined,
      })),
    })),
    phase: phaseOverride ?? (readyToBuild ? 'ready' : 'planning'),
    readyToBuild,
  });
};

const buildHeuristicPlanningTurn = (input: {
  latestIntent: string;
  schedule: ScheduledWorkflowScheduleConfig;
  outputConfig: ScheduledWorkflowOutputConfig;
  referenceContext?: string | null;
  previousPlanningState?: z.infer<typeof workflowPlanningStateSchema> | null;
  planningFindings?: string[];
  suggestedToolFamilies?: string[];
}): z.infer<typeof generatedWorkflowPlanningTurnSchema> => {
  const latestIntent = input.latestIntent.trim();
  const previousState = input.previousPlanningState ?? null;
  const asksForRefineOnly = /^(try again|refine|refine this|improve this|update this)$/i.test(latestIntent);
  const objective = asksForRefineOnly && previousState?.objective
    ? previousState.objective
    : latestIntent;
  const fileBackedTaskList = looksLikeTaskListIntent(objective, input.referenceContext);
  const needsWriteExecution = likelyNeedsWriteExecution(objective);
  const mentionsFileButNoContext = !input.referenceContext?.trim()
    && includesAny(objective, ['file', 'csv', 'sheet', 'spreadsheet', 'assignment', 'document', 'upload']);
  const disallowQuestions = userDisallowsClarifyingQuestions(latestIntent);

  const openQuestions: z.infer<typeof workflowPlanningQuestionSchema>[] = [];
  if (mentionsFileButNoContext && !disallowQuestions) {
    openQuestions.push(buildClarificationQuestion({
      id: 'source_confirmation',
      field: 'source',
      label: 'Source file',
      question: 'Which uploaded or company document should this workflow use as the source of truth?',
    }));
  }
  if (asksForRefineOnly && !previousState && !disallowQuestions) {
    openQuestions.push(buildClarificationQuestion({
      id: 'refinement_goal',
      field: 'other',
      label: 'Refinement goal',
      question: 'What should change in the workflow logic or output?',
    }));
  }

  const readyToBuild = openQuestions.length === 0;
  const planningState = normalizePlanningState({
    version: 'v1',
    phase: readyToBuild ? 'ready' : 'planning',
    readyToBuild,
    objective,
    intentSummary: fileBackedTaskList
      ? 'Use the referenced file as the source of truth, extract rows/tasks, execute them in order, and deliver a completion summary.'
      : objective,
    executionOrder: 'sequential',
    unitOfWork: fileBackedTaskList ? 'rows' : 'general',
    sourceSummary: input.referenceContext?.trim()
      ? 'Use referenced uploaded/company files. Retrieve with contextSearch first, then OCR/direct file read only if exact extraction is needed.'
      : undefined,
    outputSummary: input.outputConfig.destinations.length > 0
      ? `Deliver to ${input.outputConfig.destinations.map((destination) => destination.label ?? destination.id).join(', ')}.`
      : 'Deliver to the default desktop destination.',
    approvalSummary: needsWriteExecution
      ? 'Respect approval boundaries for any write, send, or execute actions.'
      : 'Proceed read-first and respect approvals if runtime requires them.',
    planningFindings: input.planningFindings?.slice(0, 8),
    suggestedToolFamilies: input.suggestedToolFamilies?.slice(0, 10),
    openQuestions,
  });

  const assistantResponse = readyToBuild
    ? fileBackedTaskList
      ? 'I have enough context to build this workflow. It will retrieve the referenced file first, extract the task rows, execute them sequentially, and produce a completion report. Tell me to proceed when you want me to build it.'
      : 'I have enough context to build the workflow. Tell me to proceed when you want me to build it.'
    : [
      'I need one more detail before I build the workflow:',
      ...openQuestions.map((question) => `- ${question.question}`),
    ].join('\n');

  return {
    assistantResponse,
    planningState,
  };
};

const pickSearchCapability = (allowedToolIds: string[]) => {
  if (allowedToolIds.includes('context-search')) {
    return {
      toolId: 'context-search',
      actionGroup: 'read' as const,
      operation: 'context.search.latest',
    };
  }
  return undefined;
};

const pickReferenceRetrievalCapability = (allowedToolIds: string[]) => {
  if (allowedToolIds.includes('context-search')) {
    return {
      toolId: 'context-search',
      actionGroup: 'read' as const,
      operation: 'context.search.reference_context',
    };
  }
  if (allowedToolIds.includes('document-ocr-read')) {
    return {
      toolId: 'document-ocr-read',
      actionGroup: 'read' as const,
      operation: 'document.ocr.reference_context',
    };
  }
  if (allowedToolIds.includes('share_chat_vectors')) {
    return {
      toolId: 'share_chat_vectors',
      actionGroup: 'execute' as const,
      operation: 'share_chat_vectors.reference_context',
    };
  }
  return undefined;
};

const buildFallbackWorkflowSpec = (input: {
  workflowName: string;
  userIntent: string;
  outputConfig: ScheduledWorkflowOutputConfig;
  allowedToolIds: string[];
  referenceContext?: string | null;
}): z.infer<typeof scheduledWorkflowSpecSchema> => {
  const wantsWebResearch = includesAny(input.userIntent, ['latest', 'news', 'updates', 'search', 'research', 'web']);
  const wantsDraftArtifact = includesAny(input.userIntent, ['summary', 'digest', 'report', 'brief', 'draft', 'document', 'doc']);
  const fileBackedTaskList = looksLikeTaskListIntent(input.userIntent, input.referenceContext);

  const readCapability = wantsWebResearch ? pickSearchCapability(input.allowedToolIds) : undefined;
  const referenceCapability = input.referenceContext?.trim() ? pickReferenceRetrievalCapability(input.allowedToolIds) : undefined;
  const nodes: z.infer<typeof scheduledWorkflowSpecSchema>['nodes'] = [];
  const edges: z.infer<typeof scheduledWorkflowSpecSchema>['edges'] = [];

  if (referenceCapability) {
    nodes.push({
      id: 'load_referenced_inputs',
      kind: 'read',
      title: 'Load referenced files and inputs',
      instructions: buildReferenceRetrievalInstructions(input.referenceContext!.trim()),
      outputKey: 'referenced_inputs',
      expectedOutput: 'The extracted contents or grounded context from the referenced files and images.',
      capability: referenceCapability,
    });
  }

  if (fileBackedTaskList) {
    nodes.push({
      id: 'extract_and_structure_work_items',
      kind: 'transform',
      title: 'Extract and structure work items',
      instructions: 'Parse the referenced source into structured work items. Treat each row/task as a distinct unit of work and preserve the original order.',
      inputs: referenceCapability ? ['load_referenced_inputs'] : [],
      outputKey: 'work_items',
      expectedOutput: 'A structured ordered list of work items ready for execution.',
    });
    nodes.push({
      id: 'execute_work_items_sequentially',
      kind: 'updateSystem',
      title: 'Execute work items sequentially',
      instructions: 'Process the structured work items one by one. For each item, determine the appropriate approved tool family from the item content, perform the required action, and record the outcome before proceeding to the next item.',
      inputs: ['extract_and_structure_work_items'],
      outputKey: 'execution_results',
      expectedOutput: 'Per-item execution results with completed, blocked, failed, or skipped status.',
    });
    nodes.push({
      id: 'summarize_results',
      kind: 'createDraft',
      title: 'Summarize execution results',
      instructions: 'Produce a completion report that summarizes completed work items, blockers, failures, and follow-up actions.',
      inputs: ['execute_work_items_sequentially'],
      outputKey: 'completion_report',
      expectedOutput: 'A concise completion report ready for final delivery.',
    });
  } else
  if (readCapability) {
    nodes.push({
      id: 'gather_context',
      kind: 'read',
      title: 'Gather source context',
      instructions: input.userIntent,
      inputs: referenceCapability ? ['load_referenced_inputs'] : [],
      outputKey: 'source_context',
      expectedOutput: 'Relevant source material and extracted facts for the scheduled task.',
      capability: readCapability,
    });
  }

  nodes.push({
    id: 'analyze_findings',
    kind: 'analyze',
    title: 'Analyze and structure findings',
    instructions: `Analyze the gathered inputs for this workflow intent and extract the most relevant output.\n\nIntent: ${input.userIntent}`,
    inputs: readCapability ? ['gather_context'] : referenceCapability ? ['load_referenced_inputs'] : [],
    outputKey: 'analysis',
    expectedOutput: 'A concise, structured result that directly satisfies the workflow intent.',
  });

  if (wantsDraftArtifact) {
    nodes.push({
      id: 'prepare_output',
      kind: 'createDraft',
      title: 'Prepare final draft',
      instructions: 'Convert the analysis into a polished final deliverable suitable for the configured destinations.',
      inputs: ['analyze_findings'],
      outputKey: 'final_draft',
      expectedOutput: 'A clean final message or document-ready summary.',
    });
  }

  nodes.push({
    id: 'deliver_result',
    kind: 'deliver',
    title: 'Deliver result to destination',
    instructions: 'Deliver the final result to the configured destinations.',
    inputs: [fileBackedTaskList ? 'summarize_results' : wantsDraftArtifact ? 'prepare_output' : 'analyze_findings'],
    destinationIds: input.outputConfig.defaultDestinationIds.length > 0
      ? input.outputConfig.defaultDestinationIds
      : input.outputConfig.destinations.map((destination) => destination.id),
  });

  const orderedIds = nodes.map((node) => node.id);
  for (let index = 0; index < orderedIds.length - 1; index += 1) {
    edges.push({
      sourceId: orderedIds[index],
      targetId: orderedIds[index + 1],
      condition: 'always',
    });
  }

  return scheduledWorkflowSpecSchema.parse({
    version: 'v1',
    name: input.workflowName,
    description: `Fallback compiled workflow for: ${input.userIntent}`,
    nodes,
    edges,
  });
};

const summarizeResult = (text: string, limit = 600): string =>
  text.length > limit ? `${text.slice(0, limit - 3)}...` : text;

const buildBlankWorkflowSpec = (name: string): z.infer<typeof scheduledWorkflowSpecSchema> => ({
  version: 'v1',
  name,
  description: 'Draft workflow. Describe the job in the workflow builder to generate a real execution map.',
  nodes: [
    {
      id: 'draft_intake',
      kind: 'analyze',
      title: 'Draft intake',
      instructions: 'Waiting for the workflow author to describe the job.',
      expectedOutput: 'A generated workflow map after the next AI compile.',
    },
  ],
  edges: [],
});

const readPrismaErrorCode = (error: unknown): string | null =>
  error && typeof error === 'object' && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : null;

const isScheduledWorkflowTableMissing = (error: unknown): boolean =>
  readPrismaErrorCode(error) === 'P2021'
  && error instanceof Error
  && error.message.includes('ScheduledWorkflow');

const isDatabaseUnavailable = (error: unknown): boolean => {
  const prismaCode = readPrismaErrorCode(error);
  if (prismaCode === 'P1001' || prismaCode === 'P2024') {
    return true;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message.includes('connection pool')
    || error.message.includes('Timed out fetching a new connection from the connection pool')
    || error.message.includes("Can't reach database server");
};

const DUE_PROCESSOR_POLL_INTERVAL_MS = config.DESKTOP_WORKFLOW_DUE_PROCESSOR_POLL_INTERVAL_MS;

const toWorkflowMessages = (
  rows: Array<{ id: string; role: string; content: string; createdAt: Date; metadata?: unknown }>,
): WorkflowAuthorMessage[] =>
  rows.map((row) => ({
    ...(workflowAuthorMessageMetadataSchema.safeParse(readRecord(row.metadata) ?? {}).success
      ? (() => {
        const metadata = workflowAuthorMessageMetadataSchema.parse(readRecord(row.metadata) ?? {});
        return {
          planningState: metadata.planningState ?? null,
          clarificationQuestions: metadata.clarificationQuestions ?? [],
        };
      })()
      : {
        planningState: null,
        clarificationQuestions: [],
      }),
    id: row.id,
    role: row.role === 'assistant' ? 'assistant' : 'user',
    content: row.content,
    createdAt: row.createdAt.toISOString(),
    referenceContext: readString(readRecord(row.metadata)?.attachedFileContext) ?? null,
  }));

const findLatestReferenceContext = (
  rows: Array<{ metadata?: unknown }>,
): string | null => {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const value = readString(readRecord(rows[index]?.metadata)?.attachedFileContext);
    if (value) return value;
  }
  return null;
};

const findLatestPlanningState = (
  rows: Array<{ metadata?: unknown }>,
): z.infer<typeof workflowPlanningStateSchema> | null => {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const metadata = workflowAuthorMessageMetadataSchema.safeParse(readRecord(rows[index]?.metadata) ?? {});
    if (metadata.success && metadata.data.planningState) {
      return metadata.data.planningState;
    }
  }
  return null;
};

const findLatestAttachedFiles = (
  rows: Array<{ metadata?: unknown }>,
): AttachedFileRef[] => {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const metadata = readRecord(rows[index]?.metadata);
    const attachedFiles = metadata?.attachedFiles;
    if (!Array.isArray(attachedFiles)) continue;
    const parsed = attachedFiles.flatMap((entry) => {
      const result = attachedFileSchema.safeParse(entry);
      return result.success ? [result.data] : [];
    });
    if (parsed.length > 0) {
      return parsed;
    }
  }
  return [];
};

const buildWorkflowReferenceContext = async (input: {
  companyId: string;
  requesterUserId: string;
  requesterAiRole?: string | null;
  attachedFiles: AttachedFileRef[];
}): Promise<string | null> => {
  const seen = new Set<string>();
  const uniqueFiles = input.attachedFiles.filter((file) => {
    if (!file.fileAssetId || seen.has(file.fileAssetId)) return false;
    seen.add(file.fileAssetId);
    return true;
  });
  if (uniqueFiles.length === 0) return null;

  const isSuperRole = ['SUPER_ADMIN', 'COMPANY_ADMIN'].includes(input.requesterAiRole ?? '');

  const summaries = await Promise.all(uniqueFiles.map(async (file) => {
    const asset = await prisma.fileAsset.findFirst({
      where: {
        id: file.fileAssetId,
        companyId: input.companyId,
      },
      select: {
        fileName: true,
        mimeType: true,
        ingestionStatus: true,
        ingestionError: true,
        uploaderUserId: true,
      },
    });

    if (!asset) {
      return `- ${file.fileName} [${file.mimeType}]: selected reference could not be found.`;
    }

    const policy = await prisma.fileAccessPolicy.findFirst({
      where: {
        fileAssetId: file.fileAssetId,
        companyId: input.companyId,
        aiRole: input.requesterAiRole ?? 'MEMBER',
        canRead: true,
      },
      select: { id: true },
    });

    const isOwner = asset.uploaderUserId === input.requesterUserId;
    if (!policy && !isSuperRole && !isOwner) {
      return `- ${asset.fileName} [${asset.mimeType}]: selected, but not readable in the current role context.`;
    }

    if (asset.ingestionStatus !== 'done') {
      return `- ${asset.fileName} [${asset.mimeType}]: selected, but indexing is ${asset.ingestionStatus}${asset.ingestionError ? ` (${asset.ingestionError})` : ''}.`;
    }

    const documents = await vectorDocumentRepository.findByFileAsset({
      companyId: input.companyId,
      fileAssetId: file.fileAssetId,
    });

    const preview = documents
      .slice(0, WORKFLOW_REFERENCE_PREVIEW_CHUNKS)
      .map((doc) => {
        const payload = (doc.payload ?? {}) as Record<string, unknown>;
        return readString(payload._chunk) ?? readString(payload.text) ?? readString(payload.summary) ?? '';
      })
      .filter(Boolean)
      .join('\n');

    if (preview) {
      const compactPreview = preview.length > WORKFLOW_REFERENCE_PREVIEW_MAX_CHARS
        ? `${preview.slice(0, WORKFLOW_REFERENCE_PREVIEW_MAX_CHARS - 3)}...`
        : preview;
      return `- ${asset.fileName} [${asset.mimeType}]:\n${compactPreview}`;
    }

    if (asset.mimeType.startsWith('image/')) {
      return `- ${asset.fileName} [${asset.mimeType}]: image reference selected. No extracted preview was available, so use the user's instruction plus the image filename/type as context.`;
    }

    return `- ${asset.fileName} [${asset.mimeType}]: selected, but no indexed preview text was available.`;
  }));

  const combined = summaries.filter(Boolean).join('\n');
  return combined.length > WORKFLOW_REFERENCE_CONTEXT_TOTAL_MAX_CHARS
    ? `${combined.slice(0, WORKFLOW_REFERENCE_CONTEXT_TOTAL_MAX_CHARS - 3)}...`
    : combined;
};

const buildPlanningSkillContext = async (input: {
  companyId: string;
  departmentId?: string | null;
  latestIntent: string;
  referenceContext?: string | null;
}): Promise<{ text: string | null; suggestedToolFamilies: string[] }> => {
  const query = [input.latestIntent, input.referenceContext ?? '']
    .filter(Boolean)
    .join('\n')
    .trim();
  if (!query || !includesAny(query, ['workflow', 'task', 'schedule', 'scheduling', 'recurring', 'calendar', 'invoice', 'estimate', 'meeting', 'lark', 'zoho', 'google', 'approval', 'send', 'create', 'update'])) {
    return { text: null, suggestedToolFamilies: [] };
  }

  const skills = await skillService.searchVisibleSkills({
    companyId: input.companyId,
    departmentId: input.departmentId ?? undefined,
    query,
    limit: 3,
  });

  if (skills.length === 0) {
    return { text: null, suggestedToolFamilies: [] };
  }

  const text = skills
    .slice(0, 2)
    .map((skill) => `- ${skill.name}: ${truncateText(skill.summary, 180)}`)
    .join('\n');

  const suggestedToolFamilies = skills.flatMap((skill) => {
    const joined = `${skill.name} ${skill.summary} ${skill.tags.join(' ')}`.toLowerCase();
    const families: string[] = [];
    if (joined.includes('zoho')) families.push('zoho');
    if (joined.includes('books')) families.push('booksRead', 'booksWrite');
    if (joined.includes('lark')) families.push('larkTask', 'larkCalendar', 'larkDoc', 'larkApproval');
    if (joined.includes('google')) families.push('googleDrive', 'googleCalendar', 'googleMail');
    if (joined.includes('search')) families.push('contextSearch');
    return families;
  }).filter((value, index, array) => array.indexOf(value) === index);

  return { text, suggestedToolFamilies };
};

const buildHeuristicBlueprint = (input: {
  userIntent: string;
  referenceContext?: string | null;
}): z.infer<typeof workflowIntentBlueprintSchema> => {
  const fileBackedTaskList = looksLikeTaskListIntent(input.userIntent, input.referenceContext);
  const needsWriteExecution = likelyNeedsWriteExecution(input.userIntent);

  return {
    primaryObjective: input.userIntent,
    workflowMode: fileBackedTaskList ? 'file_backed_task_list' : needsWriteExecution ? 'system_update' : 'general',
    ...(input.referenceContext?.trim()
      ? {
        sources: [{
          label: 'Referenced files and uploaded inputs',
          kind: 'referenced_file',
          unitOfWork: fileBackedTaskList ? 'rows' : 'documents',
          retrievalPreference: 'indexed_first',
          notes: 'Use referenced files as the source of truth for downstream execution.',
        }],
      }
      : {}),
    executionPolicy: {
      ordering: fileBackedTaskList ? 'sequential' : 'sequential',
      routeEachItemByContent: fileBackedTaskList || needsWriteExecution,
      includeApprovalBoundaries: needsWriteExecution,
      produceCompletionReport: true,
    },
    outputPlan: {
      finalDeliverable: fileBackedTaskList
        ? 'A completion report with per-task outcomes, blockers, and follow-up notes.'
        : 'A concrete final result that satisfies the workflow objective.',
      successCriteria: fileBackedTaskList
        ? 'All work items are processed in order and the final report reflects completed, blocked, and failed items.'
        : 'The workflow completes its intended task and delivers a concise result.',
    },
    ...(extractHeuristicNotificationPlan(input.userIntent)
      ? { notificationPlan: extractHeuristicNotificationPlan(input.userIntent) }
      : {}),
    stepInstructions: {
      retrieval: input.referenceContext?.trim()
        ? buildReferenceRetrievalInstructions(input.referenceContext.trim())
        : undefined,
      extraction: fileBackedTaskList
        ? 'Parse the referenced file into structured work items. Treat each row/task as an individual unit of work and preserve the original ordering.'
        : 'Extract the most relevant structured source facts needed for downstream execution.',
      execution: fileBackedTaskList
        ? 'Process the structured work items sequentially, one by one. For each item, determine the appropriate approved tool family from the item content, gather any additional required context, execute the task, and record the outcome before moving to the next item.'
        : 'Carry out the required workflow steps using approved tool families only. If the task requires write or send actions, honor approval requirements before proceeding.',
      summary: fileBackedTaskList
        ? 'Summarize completed, blocked, failed, and skipped items with brief reasons and any next actions.'
        : 'Summarize the completed work and any limitations or follow-up items.',
      delivery: 'Deliver the final result to the configured destination without changing the workflow objective.',
    },
  };
};

const buildReusableWorkflowBrief = (input: {
  userIntent: string;
  blueprint: z.infer<typeof workflowIntentBlueprintSchema>;
  referenceContext?: string | null;
}): string => {
  const sections: string[] = [
    `Workflow objective: ${input.blueprint.primaryObjective || input.userIntent}`,
  ];

  const sourceNotes = input.blueprint.sources?.map((source) => {
    const pieces = [source.label];
    if (source.kind) pieces.push(`kind=${source.kind}`);
    if (source.unitOfWork) pieces.push(`unit=${source.unitOfWork}`);
    if (source.retrievalPreference) pieces.push(`retrieval=${source.retrievalPreference}`);
    return `- ${pieces.join(' | ')}`;
  }) ?? [];
  if (input.referenceContext?.trim()) {
    sections.push(
      '',
      'Source handling:',
      '- Retrieve referenced files with contextSearch first.',
      '- If chunk retrieval is missing, weak, or insufficient for exact wording, use document-ocr-read as the fallback retrieval path.',
      '- Treat the extracted file contents as the source of truth for downstream execution.',
      ...sourceNotes,
      '',
      'Referenced context summary:',
      input.referenceContext.trim(),
    );
  } else if (sourceNotes.length > 0) {
    sections.push('', 'Source handling:', ...sourceNotes);
  }

  const ordering = input.blueprint.executionPolicy?.ordering ?? 'sequential';
  const routeEachItem = input.blueprint.executionPolicy?.routeEachItemByContent ?? false;
  const produceReport = input.blueprint.executionPolicy?.produceCompletionReport ?? true;
  sections.push(
    '',
    'Execution policy:',
    `- Work through the workflow ${ordering === 'parallel' ? 'in parallel where safe' : 'sequentially, one step at a time'}.`,
    routeEachItem
      ? '- Route each work item to the most appropriate approved tool family based on the item content instead of guessing a single static tool path.'
      : '- Use the approved workflow steps directly without inventing additional phases.',
    input.blueprint.executionPolicy?.includeApprovalBoundaries
      ? '- If a step requires create/update/send/execute behavior, stop for approval whenever the runtime requires it.'
      : '- Respect approval requirements if the runtime requests them.',
  );

  const stepInstructions = input.blueprint.stepInstructions;
  if (stepInstructions?.extraction || stepInstructions?.execution || stepInstructions?.summary) {
    sections.push('', 'Step guidance:');
    if (stepInstructions.extraction) sections.push(`- Extract/structure: ${stepInstructions.extraction}`);
    if (stepInstructions.execution) sections.push(`- Execute: ${stepInstructions.execution}`);
    if (stepInstructions.summary) sections.push(`- Summarize: ${stepInstructions.summary}`);
    if (stepInstructions.delivery) sections.push(`- Deliver: ${stepInstructions.delivery}`);
  }

  if (produceReport || input.blueprint.outputPlan?.finalDeliverable) {
    sections.push(
      '',
      'Final output:',
      `- ${input.blueprint.outputPlan?.finalDeliverable ?? 'Produce a concise completion report with outcomes and blockers.'}`,
      ...(input.blueprint.outputPlan?.successCriteria ? [`- Success criteria: ${input.blueprint.outputPlan.successCriteria}`] : []),
    );
  }

  if (input.blueprint.notificationPlan) {
    sections.push(
      '',
      'Lark notifications:',
      `- Send Lark DMs to: ${input.blueprint.notificationPlan.recipientQueries.join(', ')}`,
      `- Message template: ${input.blueprint.notificationPlan.messageTemplate}`,
    );
  }

  return sections.join('\n');
};

const isLarkMessageNode = (node: z.infer<typeof scheduledWorkflowSpecSchema>['nodes'][number]): boolean =>
  node.capability?.toolId === 'lark-message-write'
  && node.capability?.actionGroup === 'send'
  && node.capability?.operation === 'sendDm';

const formatLarkRecipientLabel = (person: {
  displayName?: string;
  email?: string;
  externalUserId?: string;
  larkOpenId?: string;
}): string => {
  const openId = person.larkOpenId ?? person.externalUserId ?? 'unknown';
  return `${person.displayName ?? person.email ?? person.externalUserId ?? openId} (${openId})`;
};

const bindWorkflowLarkRecipients = async (input: {
  session: MemberSessionDTO;
  workflowSpec: z.infer<typeof scheduledWorkflowSpecSchema>;
}): Promise<z.infer<typeof scheduledWorkflowSpecSchema>> => {
  const nextNodes = await Promise.all(input.workflowSpec.nodes.map(async (node) => {
    if (!isLarkMessageNode(node)) {
      return node;
    }

    const toolArguments = readRecord(node.toolArguments) ?? {};
    const recipientQueries = readStringArray(toolArguments.recipientQueries);
    const existingRecipientOpenIds = readStringArray(toolArguments.recipientOpenIds);
    const messageTemplate = readString(toolArguments.messageTemplate) ?? readString(node.instructions);

    if (recipientQueries.length === 0 && existingRecipientOpenIds.length === 0) {
      throw new HttpException(400, `Workflow step "${node.title}" is missing Lark recipients.`);
    }
    if (!messageTemplate) {
      throw new HttpException(400, `Workflow step "${node.title}" is missing a Lark DM message template.`);
    }

    const resolved = recipientQueries.length > 0
      ? await resolveLarkPeople({
        companyId: input.session.companyId,
        appUserId: input.session.userId,
        requestLarkOpenId: input.session.larkOpenId,
        assigneeNames: recipientQueries,
      })
      : { people: [], unresolved: [], ambiguous: [] };
    if (resolved.unresolved.length > 0) {
      throw new HttpException(
        400,
        `Workflow step "${node.title}" has unresolved Lark recipients: ${resolved.unresolved.join(', ')}.`,
      );
    }
    if (resolved.ambiguous.length > 0) {
      const ambiguous = resolved.ambiguous
        .map((entry) => `${entry.query} -> ${entry.matches.map((person) => formatLarkRecipientLabel(person)).join(', ')}`)
        .join('; ');
      throw new HttpException(
        400,
        `Workflow step "${node.title}" has ambiguous Lark recipients: ${ambiguous}.`,
      );
    }

    const recipientOpenIds = Array.from(new Set([
      ...existingRecipientOpenIds,
      ...resolved.people.map((person) => person.larkOpenId ?? person.externalUserId).filter((value): value is string => Boolean(value)),
    ]));
    const personByOpenId = new Map(resolved.people.map((person) => [
      person.larkOpenId ?? person.externalUserId,
      person,
    ]));
    const recipientLabels = recipientOpenIds.map((openId) => {
      const person = personByOpenId.get(openId);
      return person ? formatLarkRecipientLabel(person) : openId;
    });

    return {
      ...node,
      toolArguments: {
        ...toolArguments,
        recipientQueries,
        recipientOpenIds,
        recipientLabels,
        messageTemplate,
        skipConfirmation: true,
      },
    };
  }));

  return scheduledWorkflowSpecSchema.parse({
    ...input.workflowSpec,
    nodes: nextNodes,
  });
};

const summarizeWorkflowLarkRecipients = (
  workflowSpec: z.infer<typeof scheduledWorkflowSpecSchema>,
): string[] => workflowSpec.nodes.flatMap((node) => {
  if (!isLarkMessageNode(node)) {
    return [];
  }
  const toolArguments = readRecord(node.toolArguments) ?? {};
  const labels = readStringArray(toolArguments.recipientLabels);
  return labels.length > 0 ? [`${node.title}: ${labels.join(', ')}`] : [];
});

const assembleWorkflowSpecFromBlueprint = (input: {
  blueprint: z.infer<typeof workflowIntentBlueprintSchema>;
  workflowName: string;
  userIntent: string;
  outputConfig: ScheduledWorkflowOutputConfig;
  allowedToolIds: string[];
  referenceContext?: string | null;
}): z.infer<typeof scheduledWorkflowSpecSchema> => {
  const allowedDestinationIds = input.outputConfig.defaultDestinationIds.length > 0
    ? input.outputConfig.defaultDestinationIds
    : input.outputConfig.destinations.map((destination) => destination.id);
  const nodes: z.infer<typeof scheduledWorkflowSpecSchema>['nodes'] = [];
  const edges: z.infer<typeof scheduledWorkflowSpecSchema>['edges'] = [];
  const fileBackedTaskList =
    Boolean(input.referenceContext?.trim())
    && (
      input.blueprint.workflowMode === 'file_backed_task_list'
      || looksLikeTaskListIntent(input.userIntent, input.referenceContext)
      || input.blueprint.sources?.some((source) => source.unitOfWork === 'rows' || source.unitOfWork === 'tasks')
    );
  const referenceCapability = input.referenceContext?.trim()
    ? pickReferenceRetrievalCapability(input.allowedToolIds)
    : undefined;
  const executionNeedsWrites =
    likelyNeedsWriteExecution(input.userIntent)
    || input.blueprint.workflowMode === 'system_update'
    || Boolean(input.blueprint.executionPolicy?.routeEachItemByContent);

  const addNode = (node: z.infer<typeof scheduledWorkflowSpecSchema>['nodes'][number]) => {
    nodes.push(node);
    if (nodes.length > 1) {
      edges.push({
        sourceId: nodes[nodes.length - 2]!.id,
        targetId: node.id,
        condition: 'always',
      });
    }
  };

  if (input.referenceContext?.trim() && referenceCapability) {
    addNode({
      id: 'load_referenced_inputs',
      kind: 'read',
      title: 'Load referenced files and inputs',
      instructions: input.blueprint.stepInstructions?.retrieval?.trim()
        ? truncateText(input.blueprint.stepInstructions.retrieval.trim(), 4000)
        : buildReferenceRetrievalInstructions(input.referenceContext.trim()),
      outputKey: 'referenced_inputs',
      expectedOutput: 'Grounded source content from the referenced files and images.',
      capability: referenceCapability,
    });
  }

  if (fileBackedTaskList) {
    addNode({
      id: 'extract_and_structure_work_items',
      kind: 'transform',
      title: 'Extract and structure work items',
      instructions: truncateText(
        input.blueprint.stepInstructions?.extraction?.trim()
          || 'Parse the referenced source into structured work items. Treat rows/tasks as the units of work, preserve the original ordering, and keep the extracted structure available for execution.',
        4000,
      ),
      inputs: nodes.length > 0 ? [nodes[nodes.length - 1]!.id] : [],
      outputKey: 'work_items',
      expectedOutput: 'A structured ordered list of work items with the information needed to execute each item.',
    });
    addNode({
      id: 'execute_work_items_sequentially',
      kind: executionNeedsWrites ? 'updateSystem' : 'analyze',
      title: 'Execute work items sequentially',
      instructions: truncateText(
        input.blueprint.stepInstructions?.execution?.trim()
          || 'Process the structured work items one by one in order. For each item, infer the correct approved tool family from the item content, gather any missing required context, execute the task, and record the outcome before moving to the next item.',
        4000,
      ),
      inputs: [nodes[nodes.length - 1]!.id],
      outputKey: 'execution_results',
      expectedOutput: 'Per-item execution results including completed, blocked, failed, and skipped statuses.',
    });
    if (input.blueprint.executionPolicy?.includeApprovalBoundaries && executionNeedsWrites) {
      addNode({
        id: 'summarize_results',
        kind: 'createDraft',
        title: 'Summarize execution results',
        instructions: truncateText(
          input.blueprint.stepInstructions?.summary?.trim()
            || 'Summarize the per-item execution results, highlight blockers, and prepare a concise completion report.',
          4000,
        ),
        inputs: [nodes[nodes.length - 1]!.id],
        outputKey: 'completion_report',
        expectedOutput: 'A concise completion report with per-item outcomes and follow-up notes.',
      });
    } else {
      addNode({
        id: 'summarize_results',
        kind: 'createDraft',
        title: 'Summarize execution results',
        instructions: truncateText(
          input.blueprint.stepInstructions?.summary?.trim()
            || 'Summarize the per-item execution results, highlight blockers, and prepare a concise completion report.',
          4000,
        ),
        inputs: [nodes[nodes.length - 1]!.id],
        outputKey: 'completion_report',
        expectedOutput: 'A concise completion report with per-item outcomes and follow-up notes.',
      });
    }
  } else {
    addNode({
      id: 'analyze_goal',
      kind: 'analyze',
      title: 'Analyze workflow goal',
      instructions: truncateText(
        input.blueprint.stepInstructions?.extraction?.trim()
          || `Analyze the workflow objective and derive the concrete work plan needed to satisfy: ${input.userIntent}`,
        4000,
      ),
      inputs: nodes.length > 0 ? [nodes[nodes.length - 1]!.id] : [],
      outputKey: 'analysis',
      expectedOutput: 'A structured understanding of the work required to complete the workflow objective.',
    });
    addNode({
      id: executionNeedsWrites ? 'execute_workflow' : 'prepare_result',
      kind: executionNeedsWrites ? 'updateSystem' : 'createDraft',
      title: executionNeedsWrites ? 'Execute workflow actions' : 'Prepare workflow result',
      instructions: truncateText(
        input.blueprint.stepInstructions?.execution?.trim()
          || (executionNeedsWrites
            ? 'Carry out the required workflow actions using approved tools only. Respect approval requirements before any write-capable action.'
            : 'Prepare the workflow result using the gathered context and the approved workflow steps.'),
        4000,
      ),
      inputs: [nodes[nodes.length - 1]!.id],
      outputKey: executionNeedsWrites ? 'execution_results' : 'final_result',
      expectedOutput: executionNeedsWrites
        ? 'Concrete results from the required workflow actions.'
        : 'A concrete final result that satisfies the workflow objective.',
    });
    addNode({
      id: 'summarize_results',
      kind: 'createDraft',
      title: 'Summarize results',
      instructions: truncateText(
        input.blueprint.stepInstructions?.summary?.trim()
          || 'Summarize the completed work, key outputs, and any limitations or follow-up actions.',
        4000,
      ),
      inputs: [nodes[nodes.length - 1]!.id],
      outputKey: 'completion_report',
      expectedOutput: 'A concise summary suitable for final delivery.',
    });
  }

  if (input.blueprint.notificationPlan?.channel === 'lark_dm') {
    addNode({
      id: 'send_lark_dms',
      kind: 'send',
      title: 'Send Lark direct messages',
      instructions: truncateText(
        `Send the prepared Lark direct message to the saved recipients. Message template: ${input.blueprint.notificationPlan.messageTemplate}`,
        4000,
      ),
      inputs: [nodes[nodes.length - 1]!.id],
      outputKey: 'lark_dm_results',
      expectedOutput: 'A direct-message delivery result for each saved Lark recipient.',
      capability: {
        toolId: 'lark-message-write',
        actionGroup: 'send',
        operation: 'sendDm',
      },
      toolArguments: {
        recipientQueries: input.blueprint.notificationPlan.recipientQueries,
        messageTemplate: input.blueprint.notificationPlan.messageTemplate,
        skipConfirmation: true,
      },
    });
  }

  addNode({
    id: 'deliver_result',
    kind: 'deliver',
    title: 'Deliver result',
    instructions: truncateText(
      input.blueprint.stepInstructions?.delivery?.trim()
        || 'Deliver the final result to the configured destination.',
      4000,
    ),
    inputs: [nodes[nodes.length - 1]!.id],
    destinationIds: allowedDestinationIds,
  });

  return scheduledWorkflowSpecSchema.parse({
    version: 'v1',
    name: input.workflowName,
    description: truncateText(
      input.blueprint.outputPlan?.successCriteria
        || input.blueprint.primaryObjective
        || `Workflow for: ${input.userIntent}`,
      1000,
    ),
    nodes,
    edges,
  });
};

const buildApprovalGrant = (
  session: MemberSessionDTO,
  capabilitySummary: ScheduledWorkflowCapabilitySummary,
  workflowSpec?: z.infer<typeof scheduledWorkflowSpecSchema>,
): Record<string, unknown> => ({
  version: 'v1',
  approvedByUserId: session.userId,
  approvedAt: new Date().toISOString(),
  capabilityFingerprint: capabilitySummary.capabilityFingerprint,
  reviewedCapabilities: capabilitySummary.requiredTools.map((toolId) => ({
    toolId,
    actionGroups: capabilitySummary.requiredActionGroupsByTool[toolId] ?? [],
    operations: capabilitySummary.operationsByTool[toolId] ?? [],
  })),
  approvedDestinationIds: capabilitySummary.expectedDestinationIds,
  ...(workflowSpec
    ? (() => {
      const recipientSummary = summarizeWorkflowLarkRecipients(workflowSpec);
      return recipientSummary.length > 0
        ? { notes: `Approved Lark DM recipients: ${recipientSummary.join(' | ')}` }
        : {};
    })()
    : {}),
});

const parseWorkflowRow = (row: {
  workflowSpecJson: unknown;
  scheduleConfigJson: unknown;
  outputConfigJson: unknown;
  capabilitySummaryJson: unknown;
}) => ({
  workflowSpec: scheduledWorkflowSpecSchema.parse(row.workflowSpecJson),
  schedule: scheduledWorkflowScheduleConfigSchema.parse(row.scheduleConfigJson),
  outputConfig: scheduledWorkflowOutputConfigSchema.parse(row.outputConfigJson),
  capabilitySummary: scheduledWorkflowCapabilitySummarySchema.parse(row.capabilitySummaryJson),
});

const normalizeWorkflowStatus = (row: {
  status: StoredWorkflowStatus;
  scheduleEnabled?: boolean | null;
}): WorkflowPresentationStatus => {
  if (row.status === 'active') return 'scheduled_active';
  if (row.status === 'scheduled_active') return 'scheduled_active';
  if (row.status === 'published') return 'published';
  if (row.status === 'paused') return 'paused';
  if (row.status === 'archived') return 'archived';
  if (row.scheduleEnabled) return 'scheduled_active';
  return 'draft';
};

const buildExecutionPrompt = (input: {
  workflowName: string;
  compiledPrompt: string;
  scheduledFor: Date;
  schedule: ScheduledWorkflowScheduleConfig;
  outputConfig: ScheduledWorkflowOutputConfig;
  overrideText?: string | null;
  hasAttachedSourceArtifacts?: boolean;
}): string => [
  input.compiledPrompt.trim(),
  ...(input.overrideText?.trim()
    ? ['', 'Run-specific override from the workflow owner:', input.overrideText.trim()]
    : []),
  '',
  'Execution request:',
  `- Run this workflow now for the scheduled slot ${formatScheduledSlot(input.scheduledFor, input.schedule.timezone)}.`,
  '- Produce the final deliverable directly in the assistant response.',
  '- Do not ask follow-up questions.',
  '- Continue execution until one of these is true: the workflow is actually complete, an approval is required, a real hard block prevents progress, or a runtime guardrail stops the loop.',
  '- Do not stop after only summarizing a plan, listing tasks, or saying you will proceed later.',
  ...(input.hasAttachedSourceArtifacts
    ? [
      '- This workflow has referenced uploaded/company source files. Use internal company document retrieval first.',
      '- Do not inspect Google Drive, the local workspace, local filesystem, or repo sources for those uploaded/company files unless internal document retrieval and OCR both fail or the user explicitly asked for those other sources.',
    ]
    : []),
  '- If a read-only tool succeeds but returns partial, degraded, empty, or unavailable context, continue with the best possible digest and include a short limitations note.',
  '- Only treat the workflow as blocked when there is a true hard stop: a pending approval action, a required write action that cannot proceed, or a primary required source fails with no usable substitute.',
  '- Missing secondary enrichment context is not a block by itself.',
  `- Approved destinations for automatic delivery after generation: ${input.outputConfig.destinations.map((destination) => destination.id).join(', ')}`,
].join('\n');

const reconcileWorkflowSpecDestinations = (
  workflowSpec: z.infer<typeof scheduledWorkflowSpecSchema>,
  outputConfig: ScheduledWorkflowOutputConfig,
): z.infer<typeof scheduledWorkflowSpecSchema> => {
  const allowedDestinationIds = new Set(outputConfig.destinations.map((destination) => destination.id));
  const fallbackDestinationIds = outputConfig.defaultDestinationIds.length > 0
    ? outputConfig.defaultDestinationIds.filter((destinationId) => allowedDestinationIds.has(destinationId))
    : outputConfig.destinations.map((destination) => destination.id);

  return {
    ...workflowSpec,
    nodes: workflowSpec.nodes.map((node) => {
      if (node.kind !== 'deliver') {
        return node;
      }

      const validDestinationIds = (node.destinationIds ?? []).filter((destinationId) => allowedDestinationIds.has(destinationId));
      return {
        ...node,
        destinationIds: validDestinationIds.length > 0 ? validDestinationIds : fallbackDestinationIds,
      };
    }),
  };
};

class DesktopWorkflowsService {
  private dueProcessorTimer: NodeJS.Timeout | null = null;

  private dueProcessorRunning = false;

  private dueProcessorSuspendedReason: string | null = null;

  private async getAllowedWorkflowTools(session: MemberSessionDTO): Promise<string[]> {
    const requesterAiRole = session.aiRole ?? session.role;
    const allowedToolIds = await toolPermissionService.getAllowedTools(session.companyId, requesterAiRole);
    if (allowedToolIds.length === 0) {
      throw new HttpException(403, 'No tools are available for workflow compilation');
    }
    return allowedToolIds;
  }

  private async advancePlanningSession(input: {
    session: MemberSessionDTO;
    workflowName: string;
    latestIntent: string;
    schedule: ScheduledWorkflowScheduleConfig;
    outputConfig: ScheduledWorkflowOutputConfig;
    history: WorkflowAuthorMessage[];
    currentPlanningState?: z.infer<typeof workflowPlanningStateSchema> | null;
    currentAiDraft?: string | null;
    currentWorkflowSpec?: z.infer<typeof scheduledWorkflowSpecSchema> | null;
    latestReferenceContext?: string | null;
  }): Promise<{
    assistantResponse: string;
    planningState: z.infer<typeof workflowPlanningStateSchema>;
    draftUpdate?: z.infer<typeof workflowPlanningDraftUpdateSchema>;
    model: { provider: string; modelId: string } | null;
  }> {
    if (!(config.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)) {
      const heuristic = buildHeuristicPlanningTurn({
        latestIntent: input.latestIntent,
        schedule: input.schedule,
        outputConfig: input.outputConfig,
        referenceContext: input.latestReferenceContext,
        previousPlanningState: input.currentPlanningState,
      });
      return {
        assistantResponse: heuristic.assistantResponse,
        planningState: heuristic.planningState,
        draftUpdate: undefined,
        model: null,
      };
    }

    const allowedToolIds = await this.getAllowedWorkflowTools(input.session);
    const allowedPlanningToolIds = allowedToolIds.filter((toolId) => [
      'context-search',
      'document-ocr-read',
      'share_chat_vectors',
    ].includes(toolId));
    const planningSkillContext = await buildPlanningSkillContext({
      companyId: input.session.companyId,
      departmentId: input.session.resolvedDepartmentId ?? undefined,
      latestIntent: input.latestIntent,
      referenceContext: input.latestReferenceContext,
    });

    const resolvedModel = await resolveVercelLanguageModel('fast');
    const prompt = buildPlanningPrompt({
      workflowName: input.workflowName,
      latestIntent: input.latestIntent,
      schedule: input.schedule,
      outputConfig: input.outputConfig,
      history: input.history,
      currentPlanningState: input.currentPlanningState,
      currentAiDraft: input.currentAiDraft,
      currentWorkflowSpec: input.currentWorkflowSpec,
      latestReferenceContext: input.latestReferenceContext,
      allowedPlanningToolIds,
      planningSkillContext: planningSkillContext.text,
    });

    try {
      const result = await withTimeout(
        generateObject({
          model: resolvedModel.model,
          schema: generatedWorkflowPlanningTurnSchema,
          schemaName: 'workflow_planning_turn',
          schemaDescription: 'A planning assistant response for workflow authoring with readiness and clarifications.',
          prompt,
          temperature: 0,
          maxRetries: 0,
          providerOptions: {
            google: {
              thinkingConfig: {
                includeThoughts: false,
                thinkingLevel: 'minimal',
              },
            },
          },
        }),
        WORKFLOW_PLANNING_TIMEOUT_MS,
        `workflow planning timed out after ${WORKFLOW_PLANNING_TIMEOUT_MS}ms`,
      );

      return {
        assistantResponse: result.object.assistantResponse,
        planningState: normalizePlanningState({
          ...result.object.planningState,
          planningFindings: [
            ...(result.object.planningState.planningFindings ?? []),
            ...(planningSkillContext.text ? planningSkillContext.text.split('\n').map((line) => line.replace(/^- /, '').trim()).filter(Boolean) : []),
          ].slice(0, 8),
          suggestedToolFamilies: [
            ...(result.object.planningState.suggestedToolFamilies ?? []),
            ...planningSkillContext.suggestedToolFamilies,
          ].filter((value, index, array) => array.indexOf(value) === index).slice(0, 10),
        }),
        draftUpdate: result.object.draftUpdate,
        model: {
          provider: resolvedModel.effectiveProvider,
          modelId: resolvedModel.effectiveModelId,
        },
      };
    } catch (error) {
      logger.warn('desktop.workflow.plan.fallback', {
        error: error instanceof Error ? error.message : 'unknown_error',
        workflowName: input.workflowName,
      });
      const heuristic = buildHeuristicPlanningTurn({
        latestIntent: input.latestIntent,
        schedule: input.schedule,
        outputConfig: input.outputConfig,
        referenceContext: input.latestReferenceContext,
        previousPlanningState: input.currentPlanningState,
        planningFindings: planningSkillContext.text
          ? planningSkillContext.text.split('\n').map((line) => line.replace(/^- /, '').trim()).filter(Boolean)
          : [],
        suggestedToolFamilies: planningSkillContext.suggestedToolFamilies,
      });
      return {
        assistantResponse: heuristic.assistantResponse,
        planningState: heuristic.planningState,
        draftUpdate: undefined,
        model: {
          provider: resolvedModel.effectiveProvider,
          modelId: resolvedModel.effectiveModelId,
        },
      };
    }
  }

  private async compileArtifacts(input: {
    session: MemberSessionDTO;
    name: string;
    latestIntent: string;
    schedule: ScheduledWorkflowScheduleConfig;
    outputConfig: ScheduledWorkflowOutputConfig;
    history?: WorkflowAuthorMessage[];
    currentAiDraft?: string | null;
    currentWorkflowSpec?: z.infer<typeof scheduledWorkflowSpecSchema> | null;
    latestReferenceContext?: string | null;
    planningState?: z.infer<typeof workflowPlanningStateSchema> | null;
  }): Promise<{
    aiDraft: string;
    workflowSpec: z.infer<typeof scheduledWorkflowSpecSchema>;
    compiledPrompt: string;
    compilerNotes: string;
    capabilitySummary: ReturnType<typeof compileScheduledWorkflowDefinition>['capabilitySummary'];
    model: { provider: string; modelId: string };
  }> {
    if (!(config.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)) {
      throw new HttpException(503, 'Gemini is not configured on the backend');
    }

    const compileStartedAt = Date.now();
    const allowedToolIds = await this.getAllowedWorkflowTools(input.session);
    const resolvedModel = await resolveVercelLanguageModel('fast');
    const prompt = input.history && input.history.length > 0
      && !input.planningState
      ? buildAuthoringPrompt({
        workflowName: input.name,
        latestIntent: input.latestIntent,
        schedule: input.schedule,
        outputConfig: input.outputConfig,
        allowedToolIds,
        history: input.history,
        currentAiDraft: input.currentAiDraft,
        currentWorkflowSpec: input.currentWorkflowSpec,
        latestReferenceContext: input.latestReferenceContext,
      })
      : buildCompilerPrompt({
        workflowName: input.name,
        userIntent: input.latestIntent,
        schedule: input.schedule,
        outputConfig: input.outputConfig,
        allowedToolIds,
        referenceContext: input.latestReferenceContext,
        planningStateSummary: buildPlanningStateSummary(input.planningState),
      });
    logger.info('desktop.workflow.compile.start', {
      workflowName: input.name,
      effectiveModelId: resolvedModel.effectiveModelId,
      provider: resolvedModel.effectiveProvider,
      historyCount: input.history?.length ?? 0,
      allowedToolCount: allowedToolIds.length,
      promptLength: prompt.length,
      hasReferenceContext: Boolean(input.latestReferenceContext?.trim()),
      referenceContextLength: input.latestReferenceContext?.length ?? 0,
    });

    let generated: z.infer<typeof generatedWorkflowCompilerOutputSchema>;
    let usedFallback = false;
    try {
      const result = await withTimeout(
        generateObject({
          model: resolvedModel.model,
          schema: generatedWorkflowCompilerOutputSchema,
          schemaName: 'scheduled_workflow_execution_blueprint',
          schemaDescription: 'A compact execution blueprint for building a scheduled workflow.',
          prompt,
          temperature: 0,
          maxRetries: 0,
          providerOptions: {
            google: {
              thinkingConfig: {
                includeThoughts: false,
                thinkingLevel: 'minimal',
              },
            },
          },
        }),
        WORKFLOW_COMPILE_TIMEOUT_MS,
        `workflow compile timed out after ${WORKFLOW_COMPILE_TIMEOUT_MS}ms`,
      );
      generated = result.object;
    } catch (error) {
      logger.warn('desktop.workflow.compile.fallback', {
        error: error instanceof Error ? error.message : 'unknown_error',
        workflowName: input.name,
      });
      usedFallback = true;
      const fallbackBlueprint = buildHeuristicBlueprint({
        userIntent: input.latestIntent,
        referenceContext: input.latestReferenceContext,
      });
      generated = {
        compilerNotes: 'Compiled with deterministic fallback because the execution blueprint response was incomplete or invalid.',
        blueprint: fallbackBlueprint,
      };
    }

    let workflowSpec: z.infer<typeof scheduledWorkflowSpecSchema>;
    let blueprint = generated.blueprint;
    try {
      workflowSpec = assembleWorkflowSpecFromBlueprint({
        blueprint,
        workflowName: input.name,
        userIntent: input.latestIntent,
        outputConfig: input.outputConfig,
        allowedToolIds,
        referenceContext: input.latestReferenceContext,
      });
    } catch (error) {
      logger.warn('desktop.workflow.compile.normalize_fallback', {
        error: error instanceof Error ? error.message : 'unknown_error',
        workflowName: input.name,
      });
      usedFallback = true;
      blueprint = buildHeuristicBlueprint({
        userIntent: input.latestIntent,
        referenceContext: input.latestReferenceContext,
      });
      workflowSpec = buildFallbackWorkflowSpec({
        workflowName: input.name,
        userIntent: input.latestIntent,
        outputConfig: input.outputConfig,
        allowedToolIds,
        referenceContext: input.latestReferenceContext,
      });
    }

    workflowSpec = await bindWorkflowLarkRecipients({
      session: input.session,
      workflowSpec,
    });

    const aiDraft = buildReusableWorkflowBrief({
      userIntent: input.latestIntent,
      blueprint,
      referenceContext: input.latestReferenceContext,
    });

    const { compiledPrompt, capabilitySummary } = compileScheduledWorkflowDefinition({
      userIntent: input.latestIntent,
      workflowSpec,
      schedule: input.schedule,
      outputConfig: input.outputConfig,
    });

    const durationMs = Date.now() - compileStartedAt;
    logger.info('desktop.workflow.compile.completed', {
      workflowName: input.name,
      effectiveModelId: resolvedModel.effectiveModelId,
      usedFallback,
      durationMs,
    });

    return {
      aiDraft,
      workflowSpec,
      compiledPrompt,
      compilerNotes: usedFallback
        ? `${generated.compilerNotes} Re-run compile after tightening the brief if you want a richer graph.`
        : generated.compilerNotes,
      capabilitySummary,
      model: {
        provider: resolvedModel.effectiveProvider,
        modelId: resolvedModel.effectiveModelId,
      },
    };
  }

  private serializeWorkflow(row: {
    id: string;
    name: string;
    status: StoredWorkflowStatus;
    userIntent: string;
    aiDraft: string | null;
    workflowSpecJson: unknown;
    compiledPrompt: string;
    capabilitySummaryJson: unknown;
    scheduleConfigJson: unknown;
    scheduleEnabled: boolean;
    outputConfigJson: unknown;
    publishedAt: Date | null;
    nextRunAt: Date | null;
    lastRunAt: Date | null;
    departmentId: string | null;
    originChatId: string | null;
    updatedAt: Date;
    messages?: Array<{ id: string; role: string; content: string; createdAt: Date; metadata?: unknown }>;
  }) {
    const parsed = parseWorkflowRow(row);
    const planningState = findLatestPlanningState(row.messages ?? []) ?? normalizePlanningState({
      version: 'v1',
      phase: row.compiledPrompt.trim() ? 'built' : 'planning',
      readyToBuild: Boolean(row.compiledPrompt.trim()),
      objective: row.userIntent?.trim() || row.name,
      intentSummary: row.aiDraft?.trim()
        ? summarizeAiDraft(row.aiDraft)
        : row.userIntent?.trim() || 'Describe the job to start planning this workflow.',
      executionOrder: 'sequential',
      outputSummary: 'Deliver to the workflow destination after execution.',
      openQuestions: [],
    }, row.compiledPrompt.trim() ? 'built' : 'planning');
    return {
      id: row.id,
      name: row.name,
      status: normalizeWorkflowStatus(row),
      userIntent: row.userIntent,
      aiDraft: row.aiDraft ?? null,
      workflowSpec: parsed.workflowSpec,
      compiledPrompt: row.compiledPrompt,
      capabilitySummary: parsed.capabilitySummary,
      schedule: parsed.schedule,
      scheduleEnabled: row.scheduleEnabled,
      outputConfig: parsed.outputConfig,
      publishedAt: row.publishedAt?.toISOString() ?? null,
      nextRunAt: row.nextRunAt?.toISOString() ?? null,
      lastRunAt: row.lastRunAt?.toISOString() ?? null,
      departmentId: row.departmentId ?? null,
      originChatId: row.originChatId ?? null,
      ownershipScope: 'personal' as const,
      updatedAt: row.updatedAt.toISOString(),
      planningState,
      messages: toWorkflowMessages(row.messages ?? []),
    };
  }

  async compile(
    session: MemberSessionDTO,
    input: DesktopWorkflowCompilerInput,
  ): Promise<{
    aiDraft: string;
    workflowSpec: z.infer<typeof scheduledWorkflowSpecSchema>;
    compiledPrompt: string;
    compilerNotes: string;
    capabilitySummary: ReturnType<typeof compileScheduledWorkflowDefinition>['capabilitySummary'];
    model: { provider: string; modelId: string };
  }> {
    return this.compileArtifacts({
      session,
      name: input.name,
      latestIntent: input.userIntent,
      schedule: input.schedule,
      outputConfig: input.outputConfig,
      latestReferenceContext: await buildWorkflowReferenceContext({
        companyId: session.companyId,
        requesterUserId: session.userId,
        requesterAiRole: session.aiRole ?? session.role,
        attachedFiles: input.attachedFiles ?? [],
      }),
    });
  }

  async createDraft(
    session: MemberSessionDTO,
    input?: { name?: string | null; departmentId?: string | null; originChatId?: string | null },
  ) {
    const name = deriveWorkflowName(input?.name);
    const schedule: ScheduledWorkflowScheduleConfig = {
      type: 'weekly',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata',
      daysOfWeek: ['MO'],
      time: { hour: 9, minute: 0 },
    };
    const outputConfig: ScheduledWorkflowOutputConfig = {
      version: 'v1',
      destinations: [{ id: 'desktop_inbox', kind: 'desktop_inbox', label: 'Desktop inbox' }],
      defaultDestinationIds: ['desktop_inbox'],
    };
    const blankSpec = buildBlankWorkflowSpec(name);
    const { capabilitySummary } = compileScheduledWorkflowDefinition({
      userIntent: 'Draft workflow pending author input.',
      workflowSpec: blankSpec,
      schedule,
      outputConfig,
    });
    const workflow = await prisma.scheduledWorkflow.create({
      data: {
        companyId: session.companyId,
        departmentId: input?.departmentId ?? null,
        createdByUserId: session.userId,
        name,
        status: 'draft',
        userIntent: '',
        aiDraft: null,
        workflowSpecJson: blankSpec,
        compiledPrompt: '',
        capabilitySummaryJson: capabilitySummary,
        timezone: schedule.timezone,
        scheduleType: schedule.type,
        scheduleConfigJson: schedule,
        scheduleEnabled: false,
        outputConfigJson: outputConfig,
        originChatId: input?.originChatId ?? null,
      },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    return this.serializeWorkflow(workflow);
  }

  async get(session: MemberSessionDTO, workflowId: string) {
    const workflow = await prisma.scheduledWorkflow.findFirst({
      where: {
        id: workflowId,
        companyId: session.companyId,
        createdByUserId: session.userId,
        status: { not: 'archived' },
      },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!workflow) {
      throw new HttpException(404, 'Workflow not found');
    }
    return this.serializeWorkflow(workflow);
  }

  async author(session: MemberSessionDTO, workflowId: string, message: string, attachedFiles: AttachedFileRef[] = []) {
    const workflow = await prisma.scheduledWorkflow.findFirst({
      where: {
        id: workflowId,
        companyId: session.companyId,
        createdByUserId: session.userId,
        status: { not: 'archived' },
      },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!workflow) {
      throw new HttpException(404, 'Workflow not found');
    }

    const attachedFileContext = await buildWorkflowReferenceContext({
      companyId: session.companyId,
      requesterUserId: session.userId,
      requesterAiRole: session.aiRole ?? session.role,
      attachedFiles,
    });
    const effectiveReferenceContext = attachedFileContext ?? findLatestReferenceContext(workflow.messages);

    const parsed = parseWorkflowRow(workflow);
    const currentPlanningState = findLatestPlanningState(workflow.messages);
    const createdUserMessage = await prisma.scheduledWorkflowMessage.create({
      data: {
        workflowId,
        role: 'user',
        content: message.trim(),
        ...(attachedFiles.length > 0 || attachedFileContext
          ? {
            metadata: {
              attachedFiles,
              ...(attachedFileContext ? { attachedFileContext } : {}),
            },
          }
          : {}),
      },
    });

    const history = toWorkflowMessages([
      ...workflow.messages,
      createdUserMessage,
    ]);

    const planningTurn = await this.advancePlanningSession({
      session,
      workflowName: workflow.name === DEFAULT_WORKFLOW_NAME ? deriveWorkflowName(message) : workflow.name,
      latestIntent: message.trim(),
      schedule: parsed.schedule,
      outputConfig: parsed.outputConfig,
      history,
      currentPlanningState,
      currentAiDraft: workflow.aiDraft,
      currentWorkflowSpec: parsed.workflowSpec,
      latestReferenceContext: effectiveReferenceContext,
    });

    const nextWorkflowName = workflow.name === DEFAULT_WORKFLOW_NAME
      ? deriveWorkflowName(planningTurn.planningState.objective || message)
      : workflow.name;
    const nextSchedule = planningTurn.draftUpdate?.schedule ?? parsed.schedule;
    const shouldBuildWorkflow = planningTurn.planningState.readyToBuild
      && userExplicitlyRequestsWorkflowBuild(message.trim());

    if (!shouldBuildWorkflow) {
      const updatedWorkflow = await prisma.$transaction(async (tx) => {
        await tx.scheduledWorkflowMessage.create({
          data: {
            workflowId,
            role: 'assistant',
            content: planningTurn.assistantResponse,
            metadata: {
              planningState: planningTurn.planningState,
              clarificationQuestions: planningTurn.planningState.openQuestions,
              ...(planningTurn.draftUpdate ? { draftUpdate: planningTurn.draftUpdate } : {}),
              ...(planningTurn.model ? { model: planningTurn.model } : {}),
            },
          },
        });

        return tx.scheduledWorkflow.update({
          where: { id: workflowId },
          data: {
            name: nextWorkflowName,
            userIntent: planningTurn.planningState.objective,
            timezone: nextSchedule.timezone,
            scheduleType: nextSchedule.type,
            scheduleConfigJson: nextSchedule,
            ...(typeof planningTurn.draftUpdate?.scheduleEnabled === 'boolean'
              ? { scheduleEnabled: planningTurn.draftUpdate.scheduleEnabled }
              : {}),
            updatedAt: new Date(),
          },
          include: {
            messages: {
              orderBy: { createdAt: 'asc' },
            },
          },
        });
      });

      return {
        ...this.serializeWorkflow(updatedWorkflow),
        model: planningTurn.model ?? undefined,
      };
    }

    const compiled = await this.compileArtifacts({
      session,
      name: nextWorkflowName,
      latestIntent: planningTurn.planningState.objective,
      schedule: nextSchedule,
      outputConfig: parsed.outputConfig,
      currentAiDraft: workflow.aiDraft,
      currentWorkflowSpec: parsed.workflowSpec,
      latestReferenceContext: effectiveReferenceContext,
      planningState: planningTurn.planningState,
    });

    const builtPlanningState = normalizePlanningState({
      ...planningTurn.planningState,
      phase: 'built',
      readyToBuild: true,
      intentSummary: compiled.aiDraft.trim() || planningTurn.planningState.intentSummary,
      openQuestions: [],
    }, 'built');
    const assistantSummary = summarizeResult(
      `${planningTurn.assistantResponse}\n\n${compiled.compilerNotes || compiled.aiDraft}`,
      1200,
    );
    const updatedWorkflow = await prisma.$transaction(async (tx) => {
      await tx.scheduledWorkflowMessage.create({
        data: {
          workflowId,
          role: 'assistant',
          content: assistantSummary,
          metadata: {
            planningState: builtPlanningState,
            clarificationQuestions: [],
            ...(planningTurn.draftUpdate ? { draftUpdate: planningTurn.draftUpdate } : {}),
            model: compiled.model,
            compilerNotes: compiled.compilerNotes,
          },
        },
      });

      return tx.scheduledWorkflow.update({
        where: { id: workflowId },
        data: {
          name: nextWorkflowName,
          userIntent: builtPlanningState.objective,
          aiDraft: compiled.aiDraft,
          workflowSpecJson: compiled.workflowSpec,
          compiledPrompt: compiled.compiledPrompt,
          capabilitySummaryJson: compiled.capabilitySummary,
          timezone: nextSchedule.timezone,
          scheduleType: nextSchedule.type,
          scheduleConfigJson: nextSchedule,
          ...(typeof planningTurn.draftUpdate?.scheduleEnabled === 'boolean'
            ? { scheduleEnabled: planningTurn.draftUpdate.scheduleEnabled }
            : {}),
          updatedAt: new Date(),
        },
        include: {
          messages: {
            orderBy: { createdAt: 'asc' },
          },
        },
      });
    });

    return {
      ...this.serializeWorkflow(updatedWorkflow),
      compilerNotes: compiled.compilerNotes,
      model: compiled.model,
    };
  }

  async update(
    session: MemberSessionDTO,
    workflowId: string,
    input: {
      name?: string;
      userIntent?: string;
      aiDraft?: string | null;
      workflowSpec?: z.infer<typeof scheduledWorkflowSpecSchema>;
      schedule?: ScheduledWorkflowScheduleConfig;
      outputConfig?: ScheduledWorkflowOutputConfig;
      departmentId?: string | null;
      originChatId?: string | null;
    },
  ) {
    const workflow = await prisma.scheduledWorkflow.findFirst({
      where: {
        id: workflowId,
        companyId: session.companyId,
        createdByUserId: session.userId,
        status: { not: 'archived' },
      },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!workflow) {
      throw new HttpException(404, 'Workflow not found');
    }

    const parsed = parseWorkflowRow(workflow);
    const nextName = input.name ? deriveWorkflowName(input.name) : workflow.name;
    const nextIntent = input.userIntent ?? workflow.userIntent;
    const compileIntent = nextIntent.trim() || 'Draft workflow pending author input.';
    const nextSchedule = input.schedule ?? parsed.schedule;
    const nextOutputConfig = input.outputConfig ?? parsed.outputConfig;
    const nextWorkflowSpec = await bindWorkflowLarkRecipients({
      session,
      workflowSpec: input.workflowSpec
      ? reconcileWorkflowSpecDestinations(
        scheduledWorkflowSpecSchema.parse({ ...input.workflowSpec, name: nextName }),
        nextOutputConfig,
      )
      : parsed.workflowSpec,
    });
    const nextCompiled = compileScheduledWorkflowDefinition({
      userIntent: compileIntent,
      workflowSpec: nextWorkflowSpec,
      schedule: nextSchedule,
      outputConfig: nextOutputConfig,
    });
    const scheduleEnabled = workflow.scheduleEnabled;
    const nextRunAt = scheduleEnabled ? getNextScheduledRunAt(nextSchedule, new Date()) : workflow.nextRunAt;
    if (scheduleEnabled && !nextRunAt) {
      throw new HttpException(400, 'This workflow has no future run time after the schedule change.');
    }

    const updated = await prisma.scheduledWorkflow.update({
      where: { id: workflowId },
      data: {
        ...(input.departmentId !== undefined ? { departmentId: input.departmentId } : {}),
        ...(input.originChatId !== undefined ? { originChatId: input.originChatId } : {}),
        name: nextName,
        userIntent: nextIntent,
        aiDraft: input.aiDraft !== undefined ? input.aiDraft : workflow.aiDraft,
        workflowSpecJson: nextWorkflowSpec,
        compiledPrompt: nextCompiled.compiledPrompt,
        capabilitySummaryJson: nextCompiled.capabilitySummary,
        timezone: nextSchedule.timezone,
        scheduleType: nextSchedule.type,
        scheduleConfigJson: nextSchedule,
        outputConfigJson: nextOutputConfig,
        nextRunAt,
      },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    return this.serializeWorkflow(updated);
  }

  async publish(
    session: MemberSessionDTO,
    input: DesktopWorkflowPublishInput,
  ): Promise<{
    workflowId: string;
    status: 'published' | 'scheduled_active';
    scheduleEnabled: boolean;
    nextRunAt: string | null;
    publishedAt: string;
    primaryThreadId: string;
    primaryThreadTitle: string | null;
    capabilitySummary: ScheduledWorkflowCapabilitySummary;
    originChatId: string | null;
  }> {
    if (input.workflowId) {
      const existing = await prisma.scheduledWorkflow.findFirst({
        where: {
          id: input.workflowId,
          companyId: session.companyId,
          createdByUserId: session.userId,
        },
        select: { id: true },
      });
      if (!existing) {
        throw new HttpException(404, 'Published workflow not found');
      }
    }

    const normalizedOutputConfig = scheduledWorkflowOutputConfigSchema.parse(input.outputConfig);
    const usesCurrentLarkChat = normalizedOutputConfig.destinations.some(
      (destination) => destination.kind === 'lark_current_chat',
    );
    const usesSelfLarkDm = normalizedOutputConfig.destinations.some(
      (destination) => destination.kind === 'lark_self_dm',
    );
    if (normalizedOutputConfig.destinations.length === 0) {
      throw new HttpException(400, 'Scheduled workflows need at least one delivery destination.');
    }
    if (usesCurrentLarkChat && !readString(input.originChatId)) {
      throw new HttpException(
        400,
        'Saving a workflow for the current Lark chat requires the originating chat id.',
      );
    }
    if (
      usesSelfLarkDm
      && normalizedOutputConfig.destinations.some(
        (destination) => destination.kind === 'lark_self_dm' && !readString(destination.openId),
      )
    ) {
      throw new HttpException(
        400,
        'Saving a workflow for the requester personal Lark DM requires the requester Lark open id.',
      );
    }
    const workflowSpec = await bindWorkflowLarkRecipients({
      session,
      workflowSpec: reconcileWorkflowSpecDestinations(scheduledWorkflowSpecSchema.parse({
      ...input.workflowSpec,
      name: input.name,
    }), normalizedOutputConfig),
    });
    const { capabilitySummary, compiledPrompt } = compileScheduledWorkflowDefinition({
      userIntent: input.userIntent,
      workflowSpec,
      schedule: input.schedule,
      outputConfig: normalizedOutputConfig,
    });
    const scheduleEnabled = input.scheduleEnabled ?? false;
    const nextRunAt = scheduleEnabled ? getNextScheduledRunAt(input.schedule, new Date()) : null;
    if (scheduleEnabled && !nextRunAt) {
      throw new HttpException(400, 'This workflow has no future run time to publish.');
    }
    const nextStatus: StoredWorkflowStatus = scheduleEnabled ? 'scheduled_active' : 'published';

    const departments = await departmentService.listUserDepartments(session.userId, session.companyId);
    const resolvedDepartment = input.departmentId
      ? departments.find((department) => department.id === input.departmentId) ?? null
      : null;
    if (input.departmentId && !resolvedDepartment) {
      throw new HttpException(403, 'You do not have access to the selected department.');
    }

    const normalizedDestinations = await Promise.all(normalizedOutputConfig.destinations.map(async (destination) => {
      if (destination.kind !== 'desktop_thread') {
        return destination;
      }
      return this.normalizeDesktopThreadDestination({
        destination,
        userId: session.userId,
        companyId: session.companyId,
        departmentId: resolvedDepartment?.id ?? null,
      });
    }));
    const outputConfig = scheduledWorkflowOutputConfigSchema.parse({
      ...normalizedOutputConfig,
      destinations: normalizedDestinations,
    });
    const validation = validateScheduledWorkflowDefinition({
      userIntent: input.userIntent,
      workflowSpec,
      schedule: input.schedule,
      outputConfig,
      originChatId: input.originChatId ?? null,
    });
    if (!validation.valid) {
      throw new HttpException(
        400,
        validation.errors.map((entry) => entry.humanReadable).slice(0, 4).join(' '),
      );
    }

    const primaryThread = await this.resolvePrimaryExecutionThread({
      workflowName: input.name,
      outputConfig,
      userId: session.userId,
      companyId: session.companyId,
      departmentId: resolvedDepartment?.id ?? null,
    });

    const workflow = input.workflowId
      ? await prisma.scheduledWorkflow.update({
        where: { id: input.workflowId },
        data: {
          departmentId: resolvedDepartment?.id ?? null,
          originChatId: input.originChatId ?? null,
          name: input.name,
          status: nextStatus,
          userIntent: input.userIntent,
          aiDraft: input.aiDraft?.trim() || null,
          workflowSpecJson: workflowSpec,
          compiledPrompt: compiledPrompt.trim(),
          capabilitySummaryJson: capabilitySummary,
          timezone: input.schedule.timezone,
          scheduleType: input.schedule.type,
          scheduleConfigJson: input.schedule,
          scheduleEnabled,
          nextRunAt,
          outputConfigJson: outputConfig,
          approvalGrantJson: buildApprovalGrant(session, capabilitySummary, workflowSpec),
          publishedAt: new Date(),
          archivedAt: null,
          pausedAt: null,
          claimToken: null,
          claimedAt: null,
        },
        select: {
          id: true,
          publishedAt: true,
          nextRunAt: true,
        },
      })
      : await prisma.scheduledWorkflow.create({
        data: {
          companyId: session.companyId,
          departmentId: resolvedDepartment?.id ?? null,
          createdByUserId: session.userId,
          originChatId: input.originChatId ?? null,
          name: input.name,
          status: nextStatus,
          userIntent: input.userIntent,
          aiDraft: input.aiDraft?.trim() || null,
          workflowSpecJson: workflowSpec,
          compiledPrompt: compiledPrompt.trim(),
          capabilitySummaryJson: capabilitySummary,
          timezone: input.schedule.timezone,
          scheduleType: input.schedule.type,
          scheduleConfigJson: input.schedule,
          scheduleEnabled,
          nextRunAt,
          outputConfigJson: outputConfig,
          approvalGrantJson: buildApprovalGrant(session, capabilitySummary, workflowSpec),
          publishedAt: new Date(),
        },
        select: {
          id: true,
          publishedAt: true,
          nextRunAt: true,
        },
      });

    return {
      workflowId: workflow.id,
      status: scheduleEnabled ? 'scheduled_active' : 'published',
      scheduleEnabled,
      nextRunAt: workflow.nextRunAt ? workflow.nextRunAt.toISOString() : null,
      publishedAt: workflow.publishedAt?.toISOString() ?? new Date().toISOString(),
      primaryThreadId: primaryThread.id,
      primaryThreadTitle: primaryThread.title ?? null,
      capabilitySummary,
      originChatId: input.originChatId ?? null,
    };
  }

  async createFromLarkIntent(input: {
    companyId: string;
    userId: string;
    userIntent: string;
    taskPrompt: string;
    schedule: {
      type: 'one_time' | 'daily' | 'weekly' | 'monthly';
      timezone: string;
      runAt?: string;
      hour?: number;
      minute?: number;
      dayOfWeek?: number;
      dayOfMonth?: number;
    };
    outputTarget: 'lark_current_chat' | 'lark_self_dm';
    originChatId: string;
    requesterOpenId: string;
    name?: string;
  }) {
    const session = await this.loadExecutionSession({
      workflowId: `lark_intent_${Date.now()}`,
      workflowName: input.name ?? input.userIntent,
      companyId: input.companyId,
      createdByUserId: input.userId,
      departmentId: null,
    });

    const workflowName = deriveWorkflowName(input.name ?? `Lark: ${input.userIntent}`);
    const normalizedSchedule: ScheduledWorkflowScheduleConfig =
      input.schedule.type === 'one_time'
        ? {
            type: 'one_time',
            timezone: input.schedule.timezone,
            runAt: readString(input.schedule.runAt) ?? new Date().toISOString(),
          }
        : input.schedule.type === 'daily'
          ? {
              type: 'daily',
              timezone: input.schedule.timezone,
              time: {
                hour: input.schedule.hour ?? 9,
                minute: input.schedule.minute ?? 0,
              },
            }
          : input.schedule.type === 'weekly'
            ? {
                type: 'weekly',
                timezone: input.schedule.timezone,
                daysOfWeek: [toWeeklyScheduleDay(input.schedule.dayOfWeek ?? 1)],
                time: {
                  hour: input.schedule.hour ?? 9,
                  minute: input.schedule.minute ?? 0,
                },
              }
            : {
                type: 'monthly',
                timezone: input.schedule.timezone,
                dayOfMonth: input.schedule.dayOfMonth ?? 1,
                time: {
                  hour: input.schedule.hour ?? 9,
                  minute: input.schedule.minute ?? 0,
                },
              };

    const outputConfig: ScheduledWorkflowOutputConfig = {
      version: 'v1',
      destinations: [
        input.outputTarget === 'lark_self_dm'
          ? {
              id: 'dest_1',
              kind: 'lark_self_dm',
              label: 'Requester personal DM',
              openId: input.requesterOpenId,
            }
          : {
              id: 'dest_1',
              kind: 'lark_current_chat',
              label: 'Current Lark chat',
            },
      ],
      defaultDestinationIds: ['dest_1'],
    };

    const workflowSpec = scheduledWorkflowSpecSchema.parse({
      version: 'v1',
      name: workflowName,
      description: buildLarkIntentWorkflowDescription(input.userIntent),
      nodes: [
        {
          id: 'analyze_1',
          kind: 'analyze',
          title: 'Execute scheduled task',
          instructions: input.taskPrompt.trim(),
          outputKey: 'result',
          expectedOutput: 'Completed result for delivery.',
        },
        {
          id: 'deliver_1',
          kind: 'deliver',
          title: 'Deliver result',
          destinationIds: ['dest_1'],
          inputs: ['analyze_1'],
        },
      ],
      edges: [
        {
          sourceId: 'analyze_1',
          targetId: 'deliver_1',
          condition: 'always',
        },
      ],
    });

    const published = await this.publish(session, {
      name: workflowName,
      userIntent: input.userIntent.trim(),
      aiDraft: input.taskPrompt.trim(),
      schedule: normalizedSchedule,
      scheduleEnabled: true,
      outputConfig,
      workflowSpec,
      compiledPrompt: input.taskPrompt.trim(),
      originChatId: input.originChatId,
    });

    return prisma.scheduledWorkflow.findUniqueOrThrow({
      where: { id: published.workflowId },
    });
  }

  async runNow(
    session: MemberSessionDTO,
    workflowId: string,
    overrideText?: string | null,
    progress?: (phase: string) => Promise<void>,
  ): Promise<{
    workflowId: string;
    runId: string;
    executionId: string | null;
    status: 'succeeded' | 'failed' | 'blocked';
    threadId: string;
    threadTitle: string | null;
    resultSummary: string | null;
    errorSummary: string | null;
  }> {
    const workflow = await prisma.scheduledWorkflow.findFirst({
      where: {
        id: workflowId,
        companyId: session.companyId,
        status: { not: 'archived' },
      },
    });
    if (!workflow) {
      throw new HttpException(404, 'Workflow not found');
    }

    const parsed = parseWorkflowRow(workflow);
    if (overrideText?.trim() && parsed.capabilitySummary.requiresPublishApproval) {
      throw new HttpException(403, 'Temporary overrides are blocked for workflows that can write, send, delete, or execute.');
    }

    const result = await this.executeWorkflow(
      workflow.id,
      new Date(),
      'manual',
      overrideText?.trim() || null,
      progress,
    );
    return {
      workflowId: workflow.id,
      runId: result.runId,
      executionId: result.executionId,
      status: result.status,
      threadId: result.threadId,
      threadTitle: result.threadTitle,
      resultSummary: result.resultSummary,
      errorSummary: result.errorSummary,
    };
  }

  async list(session: MemberSessionDTO): Promise<Array<{
    id: string;
    name: string;
    status: WorkflowPresentationStatus;
    userIntent: string;
    aiDraft: string | null;
    workflowSpec: z.infer<typeof scheduledWorkflowSpecSchema>;
    compiledPrompt: string;
    capabilitySummary: ScheduledWorkflowCapabilitySummary;
    schedule: ScheduledWorkflowScheduleConfig;
    scheduleEnabled: boolean;
    outputConfig: ScheduledWorkflowOutputConfig;
    publishedAt: string | null;
    nextRunAt: string | null;
    lastRunAt: string | null;
    departmentId: string | null;
    ownershipScope: 'personal';
    updatedAt: string;
    planningState: z.infer<typeof workflowPlanningStateSchema>;
    messages: WorkflowAuthorMessage[];
  }>> {
    const rows = await prisma.scheduledWorkflow.findMany({
      where: {
        companyId: session.companyId,
        createdByUserId: session.userId,
        status: { not: 'archived' },
      },
      orderBy: [
        { updatedAt: 'desc' },
        { createdAt: 'desc' },
      ],
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    return rows.map((row) => this.serializeWorkflow(row));
  }

  async listVisibleSummaries(session: MemberSessionDTO): Promise<Array<{
    id: string;
    name: string;
    status: WorkflowPresentationStatus;
    scheduleEnabled: boolean;
    nextRunAt: string | null;
    updatedAt: string;
  }>> {
    const rows = await prisma.scheduledWorkflow.findMany({
      where: {
        companyId: session.companyId,
        createdByUserId: session.userId,
        status: { not: 'archived' },
      },
      orderBy: [
        { updatedAt: 'desc' },
        { createdAt: 'desc' },
      ],
      select: {
        id: true,
        name: true,
        status: true,
        scheduleEnabled: true,
        nextRunAt: true,
        updatedAt: true,
      },
    });

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      status: normalizeWorkflowStatus(row),
      scheduleEnabled: row.scheduleEnabled,
      nextRunAt: row.nextRunAt?.toISOString() ?? null,
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  async resolveVisibleWorkflow(
    session: MemberSessionDTO,
    reference: string,
  ): Promise<
    | {
      status: 'resolved';
      workflow: {
        id: string;
        name: string;
        status: WorkflowPresentationStatus;
        scheduleEnabled: boolean;
        nextRunAt: string | null;
        updatedAt: string;
      };
    }
    | {
      status: 'ambiguous';
      candidates: Array<{
        id: string;
        name: string;
        status: WorkflowPresentationStatus;
        scheduleEnabled: boolean;
        nextRunAt: string | null;
        updatedAt: string;
      }>;
    }
    | { status: 'not_found' }
  > {
    const normalized = reference.trim();
    if (!normalized) {
      return { status: 'not_found' };
    }

    const all = await this.listVisibleSummaries(session);
    const normalizedLower = normalized.toLowerCase();
    const exactId = all.find((workflow) => workflow.id === normalized);
    if (exactId) {
      return { status: 'resolved', workflow: exactId };
    }

    const exactNameMatches = all.filter((workflow) => workflow.name.trim().toLowerCase() === normalizedLower);
    if (exactNameMatches.length === 1) {
      return { status: 'resolved', workflow: exactNameMatches[0] };
    }
    if (exactNameMatches.length > 1) {
      return { status: 'ambiguous', candidates: exactNameMatches.slice(0, 10) };
    }

    const containsMatches = all.filter((workflow) => workflow.name.trim().toLowerCase().includes(normalizedLower));
    if (containsMatches.length === 1) {
      return { status: 'resolved', workflow: containsMatches[0] };
    }
    if (containsMatches.length > 1) {
      return { status: 'ambiguous', candidates: containsMatches.slice(0, 10) };
    }

    return { status: 'not_found' };
  }

  async archive(session: MemberSessionDTO, workflowId: string): Promise<void> {
    const updated = await prisma.scheduledWorkflow.updateMany({
      where: {
        id: workflowId,
        companyId: session.companyId,
        createdByUserId: session.userId,
      },
      data: {
        status: 'archived',
        scheduleEnabled: false,
        archivedAt: new Date(),
        nextRunAt: null,
        claimToken: null,
        claimedAt: null,
      },
    });
    if (updated.count === 0) {
      throw new HttpException(404, 'Published workflow not found');
    }
  }

  async setScheduleState(
    session: MemberSessionDTO,
    workflowId: string,
    scheduleEnabled: boolean,
  ): Promise<{
    workflowId: string;
    status: 'published' | 'scheduled_active' | 'paused';
    scheduleEnabled: boolean;
    nextRunAt: string | null;
  }> {
    const workflow = await prisma.scheduledWorkflow.findFirst({
      where: {
        id: workflowId,
        companyId: session.companyId,
        createdByUserId: session.userId,
        status: { not: 'archived' },
      },
      select: {
        id: true,
        status: true,
        scheduleConfigJson: true,
      },
    });
    if (!workflow) {
      throw new HttpException(404, 'Workflow not found');
    }

    const schedule = scheduledWorkflowScheduleConfigSchema.parse(workflow.scheduleConfigJson);
    if (scheduleEnabled) {
      const nextRunAt = getNextScheduledRunAt(schedule, new Date());
      if (!nextRunAt) {
        throw new HttpException(400, 'This workflow has no future run time to activate.');
      }
      const updated = await prisma.scheduledWorkflow.update({
        where: { id: workflowId },
        data: {
          status: 'scheduled_active',
          scheduleEnabled: true,
          nextRunAt,
          pausedAt: null,
          archivedAt: null,
          claimToken: null,
          claimedAt: null,
        },
        select: { id: true, nextRunAt: true },
      });
      return {
        workflowId: updated.id,
        status: 'scheduled_active',
        scheduleEnabled: true,
        nextRunAt: updated.nextRunAt?.toISOString() ?? null,
      };
    }

    const updated = await prisma.scheduledWorkflow.update({
      where: { id: workflowId },
      data: {
        status: workflow.status === 'published' ? 'published' : 'paused',
        scheduleEnabled: false,
        nextRunAt: null,
        pausedAt: workflow.status === 'published' ? null : new Date(),
        claimToken: null,
        claimedAt: null,
      },
      select: { id: true, status: true },
    });
    return {
      workflowId: updated.id,
      status: normalizeWorkflowStatus({ status: updated.status as StoredWorkflowStatus, scheduleEnabled: false }) as 'published' | 'scheduled_active' | 'paused',
      scheduleEnabled: false,
      nextRunAt: null,
    };
  }

  startDueProcessor(): void {
    if (this.dueProcessorTimer) {
      return;
    }

    this.dueProcessorTimer = setInterval(() => {
      void this.processDueWorkflows().catch((error) => {
        this.handleDueProcessorFailure(error);
      });
    }, DUE_PROCESSOR_POLL_INTERVAL_MS);
  }

  stopDueProcessor(): void {
    if (this.dueProcessorTimer) {
      clearInterval(this.dueProcessorTimer);
      this.dueProcessorTimer = null;
    }
  }

  async processDueWorkflows(): Promise<void> {
    if (this.dueProcessorRunning || this.dueProcessorSuspendedReason) {
      return;
    }
    this.dueProcessorRunning = true;

    try {
      const now = new Date();
      const staleBefore = new Date(now.getTime() - 10 * 60 * 1000);
      const due = await prisma.scheduledWorkflow.findMany({
        where: {
          status: { in: ['active', 'scheduled_active'] },
          scheduleEnabled: true,
          nextRunAt: { lte: now },
          OR: [
            { claimedAt: null },
            { claimedAt: { lt: staleBefore } },
          ],
        },
        orderBy: { nextRunAt: 'asc' },
        take: 5,
        select: { id: true, nextRunAt: true },
      });

      for (const candidate of due) {
        const claimToken = randomUUID();
        const claimed = await prisma.scheduledWorkflow.updateMany({
          where: {
            id: candidate.id,
            status: { in: ['active', 'scheduled_active'] },
            scheduleEnabled: true,
            nextRunAt: candidate.nextRunAt,
            OR: [
              { claimedAt: null },
              { claimedAt: { lt: staleBefore } },
            ],
          },
          data: {
            claimToken,
            claimedAt: now,
          },
        });
        if (claimed.count === 0) {
          continue;
        }

        try {
          await this.executeWorkflow(candidate.id, candidate.nextRunAt ?? now, 'scheduled');
        } catch (error) {
          logger.error('desktop.workflow.run.failed', {
            workflowId: candidate.id,
            error: error instanceof Error ? error.message : 'unknown_error',
          });
        }
      }
    } finally {
      this.dueProcessorRunning = false;
    }
  }

  private handleDueProcessorFailure(error: unknown): void {
    if (isScheduledWorkflowTableMissing(error)) {
      this.dueProcessorSuspendedReason = 'scheduled_workflow_table_missing';
      logger.warn('desktop.workflow.scheduler.suspended', {
        reason: 'scheduled_workflow_table_missing',
        detail: 'Run prisma db push or the scheduled-workflow migration, then restart the backend.',
      });
      return;
    }

    if (isDatabaseUnavailable(error)) {
      this.dueProcessorSuspendedReason = 'database_unavailable';
      logger.warn('desktop.workflow.scheduler.suspended', {
        reason: 'database_unavailable',
        detail: 'The database is unreachable. Restore connectivity and restart the backend.',
      });
      return;
    }

    logger.error('desktop.workflow.scheduler.failed', {
      error: error instanceof Error ? error.message : 'unknown_error',
    });
  }

  private async loadExecutionSession(input: {
    workflowId: string;
    workflowName: string;
    companyId: string;
    createdByUserId: string | null;
    departmentId?: string | null;
  }): Promise<MemberSessionDTO> {
    if (!input.createdByUserId) {
      throw new HttpException(400, `Workflow "${input.workflowName}" is missing a creator account.`);
    }

    const [user, membership, departments, larkAuthLink] = await Promise.all([
      memberAuthRepository.findUserById(input.createdByUserId),
      memberAuthRepository.findActiveMembership(input.createdByUserId, input.companyId),
      departmentService.listUserDepartments(input.createdByUserId, input.companyId),
      larkUserAuthLinkRepository.findActiveByUser(input.createdByUserId, input.companyId),
    ]);
    if (!user || !membership) {
      throw new HttpException(400, `Workflow "${input.workflowName}" no longer has an active desktop member context.`);
    }

    const resolvedDepartment = input.departmentId
      ? departments.find((department) => department.id === input.departmentId) ?? null
      : departments.length === 1 ? departments[0] : null;

    const authProvider: MemberSessionDTO['authProvider'] = larkAuthLink ? 'lark' : 'password';

    logger.info('desktop.workflow.execution.session.loaded', {
      workflowId: input.workflowId,
      workflowName: input.workflowName,
      userId: user.id,
      companyId: input.companyId,
      authProvider,
      hasLinkedLarkAuth: Boolean(larkAuthLink),
    });

    return {
      userId: user.id,
      companyId: input.companyId,
      role: membership.role,
      aiRole: membership.role,
      sessionId: `scheduled:${input.workflowId}`,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      authProvider,
      name: user.name ?? undefined,
      email: user.email,
      larkTenantKey: larkAuthLink?.larkTenantKey,
      larkOpenId: larkAuthLink?.larkOpenId,
      larkUserId: larkAuthLink?.larkUserId,
      departments,
      resolvedDepartmentId: resolvedDepartment?.id,
      resolvedDepartmentName: resolvedDepartment?.name,
      resolvedDepartmentRoleSlug: resolvedDepartment?.roleSlug,
    };
  }

  private async resolvePrimaryExecutionThread(input: {
    workflowName: string;
    outputConfig: ScheduledWorkflowOutputConfig;
    userId: string;
    companyId: string;
    departmentId?: string | null;
  }) {
    const explicitThread = input.outputConfig.destinations.find((destination) => destination.kind === 'desktop_thread');
    if (explicitThread?.kind === 'desktop_thread') {
      const existing = await prisma.desktopThread.findFirst({
        where: {
          id: explicitThread.threadId,
          userId: input.userId,
          companyId: input.companyId,
        },
        include: {
          department: {
            select: {
              id: true,
              name: true,
              slug: true,
            },
          },
        },
      });
      if (existing) {
        return existing;
      }
      return desktopThreadsService.findOrCreateNamedThread(
        input.userId,
        input.companyId,
        explicitThread.label ?? explicitThread.threadId,
        input.departmentId ?? null,
      );
    }

    return desktopThreadsService.findOrCreateNamedThread(
      input.userId,
      input.companyId,
      input.workflowName,
      input.departmentId ?? null,
    );
  }

  private async normalizeDesktopThreadDestination(input: {
    destination: Extract<ScheduledWorkflowOutputConfig['destinations'][number], { kind: 'desktop_thread' }>;
    userId: string;
    companyId: string;
    departmentId?: string | null;
  }) {
    const existing = await prisma.desktopThread.findFirst({
      where: {
        id: input.destination.threadId,
        userId: input.userId,
        companyId: input.companyId,
      },
      select: {
        id: true,
        title: true,
      },
    });
    if (existing) {
      return {
        ...input.destination,
        threadId: existing.id,
        label: input.destination.label ?? existing.title ?? input.destination.threadId,
      };
    }

    const thread = await desktopThreadsService.findOrCreateNamedThread(
      input.userId,
      input.companyId,
      input.destination.label ?? input.destination.threadId,
      input.departmentId ?? null,
    );
    return {
      ...input.destination,
      threadId: thread.id,
      label: input.destination.label ?? thread.title ?? input.destination.threadId,
    };
  }

  private resolveDestinationIdsForNotification(outputConfig: ScheduledWorkflowOutputConfig): string[] {
    return outputConfig.defaultDestinationIds.length > 0
      ? outputConfig.defaultDestinationIds
      : outputConfig.destinations.map((destination) => destination.id);
  }

  private resolvePrimaryLarkDestination(input: {
    outputConfig: ScheduledWorkflowOutputConfig;
    originChatId?: string | null;
  }): {
    destination: Extract<ScheduledWorkflowOutputConfig['destinations'][number], { kind: 'lark_chat' | 'lark_current_chat' | 'lark_self_dm' }>;
    targetId: string;
  } {
    const preferredIds = new Set(this.resolveDestinationIdsForNotification(input.outputConfig));
    const larkDestination = input.outputConfig.destinations.find((destination) =>
      preferredIds.has(destination.id)
      && (destination.kind === 'lark_chat' || destination.kind === 'lark_current_chat' || destination.kind === 'lark_self_dm'))
      ?? input.outputConfig.destinations.find((destination) =>
        destination.kind === 'lark_chat' || destination.kind === 'lark_current_chat' || destination.kind === 'lark_self_dm');

    if (
      !larkDestination
      || (larkDestination.kind !== 'lark_chat'
        && larkDestination.kind !== 'lark_current_chat'
        && larkDestination.kind !== 'lark_self_dm')
    ) {
      throw new HttpException(400, 'Lark-intent workflows require a Lark destination.');
    }

    const { targetId, error } = resolveLarkDestinationTarget(larkDestination, input.originChatId ?? null);
    if (!targetId) {
      throw new HttpException(400, error ?? 'Unable to resolve Lark destination.');
    }

    return {
      destination: larkDestination,
      targetId,
    };
  }

  private async deliverTextToConfiguredDestinations(input: {
    workflowId: string;
    runId: string;
    session: MemberSessionDTO;
    workflowName: string;
    outputConfig: ScheduledWorkflowOutputConfig;
    text: string;
    destinationIds?: string[];
    originChatId?: string | null;
  }): Promise<Array<Record<string, unknown>>> {
    const requestedDestinationIds = new Set(
      (input.destinationIds && input.destinationIds.length > 0
        ? input.destinationIds
        : input.outputConfig.destinations.map((destination) => destination.id)),
    );
    const deliveries: Array<Record<string, unknown>> = [];
    for (const destination of input.outputConfig.destinations) {
      if (!requestedDestinationIds.has(destination.id)) {
        continue;
      }

      if (destination.kind === 'desktop_thread') {
        const duplicate = await desktopThreadsService.addMessage(
          destination.threadId,
          input.session.userId,
          'assistant',
          input.text,
          {
            workflowExecution: {
              workflowId: input.workflowId,
              workflowRunId: input.runId,
              notificationOnly: true,
            },
          },
        );
        deliveries.push({
          kind: 'desktop_thread',
          target: destination.label ?? destination.threadId,
          threadId: destination.threadId,
          messageId: duplicate.id,
          status: 'delivered',
        });
        continue;
      }

      if (destination.kind === 'desktop_inbox') {
        const inboxThread = await desktopThreadsService.findOrCreateNamedThread(
          input.session.userId,
          input.session.companyId,
          input.workflowName,
          input.session.resolvedDepartmentId ?? null,
        );
        const duplicate = await desktopThreadsService.addMessage(
          inboxThread.id,
          input.session.userId,
          'assistant',
          input.text,
          {
            workflowExecution: {
              workflowId: input.workflowId,
              workflowRunId: input.runId,
              notificationOnly: true,
            },
          },
        );
        deliveries.push({
          kind: 'desktop_inbox',
          target: inboxThread.title ?? inboxThread.id,
          threadId: inboxThread.id,
          messageId: duplicate.id,
          status: 'delivered',
        });
        continue;
      }

      const { targetId, error } = resolveLarkDestinationTarget(destination, input.originChatId ?? null);
      if (!targetId) {
        deliveries.push({
          kind: destination.kind,
          target: destination.label ?? destination.id,
          status: 'failed',
          error,
        });
        continue;
      }
      const adapter = resolveChannelAdapter('lark');
      const outbound = await adapter.sendMessage({
        chatId: targetId,
        text: input.text,
        correlationId: input.runId,
      });
      deliveries.push({
        kind: destination.kind,
        target: destination.label ?? targetId,
        chatId: targetId,
        status: outbound.status,
        messageId: outbound.messageId ?? null,
        error: outbound.error ?? null,
      });
    }
    return deliveries;
  }

  private buildWorkflowFailureNotification(input: {
    workflowName: string;
    ranAt: Date;
    errorSummary: string | null;
    nextRunAt: Date | null;
  }): string {
    return [
      `Scheduled workflow "${input.workflowName}" failed at ${input.ranAt.toISOString()}.`,
      `Reason: ${input.errorSummary?.trim() || 'Execution did not complete successfully.'}`,
      `Next scheduled run: ${input.nextRunAt ? input.nextRunAt.toISOString() : 'none'}`,
      'To fix or disable this workflow, reply here or open your workflow list.',
    ].join('\n');
  }

  private async notifyWorkflowRunOutcome(input: {
    workflowId: string;
    workflowName: string;
    runId: string;
    trigger: 'manual' | 'scheduled';
    status: 'succeeded' | 'failed' | 'blocked';
    session: MemberSessionDTO;
    outputConfig: ScheduledWorkflowOutputConfig;
    originChatId?: string | null;
    scheduledFor: Date;
    nextRunAt: Date | null;
    errorSummary: string | null;
  }): Promise<void> {
    if (input.trigger !== 'scheduled' || input.status === 'succeeded') {
      return;
    }
    const message = this.buildWorkflowFailureNotification({
      workflowName: input.workflowName,
      ranAt: input.scheduledFor,
      errorSummary: input.errorSummary,
      nextRunAt: input.nextRunAt,
    });
    try {
      await this.deliverTextToConfiguredDestinations({
        workflowId: input.workflowId,
        runId: input.runId,
        session: input.session,
        workflowName: input.workflowName,
        outputConfig: input.outputConfig,
        text: message,
        destinationIds: this.resolveDestinationIdsForNotification(input.outputConfig),
        originChatId: input.originChatId ?? null,
      });
    } catch (error) {
      logger.error('desktop.workflow.notify.failed', {
        workflowId: input.workflowId,
        workflowRunId: input.runId,
        status: input.status,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async deliverResult(input: {
    workflowId: string;
    runId: string;
    session: MemberSessionDTO;
    workflowName: string;
    outputConfig: ScheduledWorkflowOutputConfig;
    originChatId?: string | null;
    primaryThreadId: string;
    primaryThreadTitle: string | null;
    primaryMessageId: string;
    text: string;
  }): Promise<Array<Record<string, unknown>>> {
    const deliveries: Array<Record<string, unknown>> = [{
      kind: 'desktop_thread',
      target: input.primaryThreadTitle ?? input.primaryThreadId,
      threadId: input.primaryThreadId,
      messageId: input.primaryMessageId,
      status: 'delivered',
      primary: true,
    }];

    for (const destination of input.outputConfig.destinations) {
      if (destination.kind === 'desktop_thread') {
        if (destination.threadId === input.primaryThreadId) continue;
        const duplicate = await desktopThreadsService.addMessage(
          destination.threadId,
          input.session.userId,
          'assistant',
          input.text,
          {
            workflowExecution: {
              workflowId: input.workflowId,
              workflowRunId: input.runId,
              duplicateOfThreadId: input.primaryThreadId,
            },
          },
        );
        deliveries.push({
          kind: 'desktop_thread',
          target: destination.label ?? destination.threadId,
          threadId: destination.threadId,
          messageId: duplicate.id,
          status: 'delivered',
        });
        continue;
      }

      if (destination.kind === 'desktop_inbox') {
        const inboxThread = await desktopThreadsService.findOrCreateNamedThread(
          input.session.userId,
          input.session.companyId,
          input.workflowName,
          input.session.resolvedDepartmentId ?? null,
        );
        if (inboxThread.id === input.primaryThreadId) continue;
        const duplicate = await desktopThreadsService.addMessage(
          inboxThread.id,
          input.session.userId,
          'assistant',
          input.text,
          {
            workflowExecution: {
              workflowId: input.workflowId,
              workflowRunId: input.runId,
              duplicateOfThreadId: input.primaryThreadId,
            },
          },
        );
        deliveries.push({
          kind: 'desktop_inbox',
          target: inboxThread.title ?? inboxThread.id,
          threadId: inboxThread.id,
          messageId: duplicate.id,
          status: 'delivered',
        });
        continue;
      }

      const { targetId, error } = resolveLarkDestinationTarget(destination, input.originChatId ?? null);
      if (!targetId) {
        deliveries.push({
          kind: destination.kind,
          target: destination.label ?? destination.id,
          status: 'failed',
          messageId: null,
          error,
        });
        continue;
      }
      const adapter = resolveChannelAdapter('lark');
      const outbound = await adapter.sendMessage({
        chatId: targetId,
        text: input.text,
        correlationId: input.runId,
      });
      deliveries.push({
        kind: destination.kind,
        target: destination.label ?? targetId,
        chatId: targetId,
        status: outbound.status,
        messageId: outbound.messageId ?? null,
        error: outbound.error ?? null,
      });
    }

    return deliveries;
  }

  private async executeWorkflow(
    workflowId: string,
    scheduledFor: Date,
    trigger: 'manual' | 'scheduled',
    overrideText?: string | null,
    progress?: (phase: string) => Promise<void>,
  ): Promise<{
    runId: string;
    executionId: string | null;
    status: 'succeeded' | 'failed' | 'blocked';
    threadId: string;
    threadTitle: string | null;
    resultSummary: string | null;
    errorSummary: string | null;
  }> {
    const workflow = await prisma.scheduledWorkflow.findUnique({
      where: { id: workflowId },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!workflow) {
      throw new HttpException(404, 'Workflow not found');
    }

    logger.info('desktop.workflow.execute.start', {
      workflowId,
      workflowName: workflow.name,
      scheduledFor: scheduledFor.toISOString(),
      trigger,
      companyId: workflow.companyId,
      createdByUserId: workflow.createdByUserId,
      departmentId: workflow.departmentId,
      workflowStatus: workflow.status,
      nextRunAt: workflow.nextRunAt?.toISOString() ?? null,
    });

    const parsedWorkflow = parseWorkflowRow(workflow);
    const { schedule, outputConfig } = parsedWorkflow;
    const isLarkIntent = isLarkIntentWorkflowSpec(parsedWorkflow.workflowSpec);
    const session = await this.loadExecutionSession({
      workflowId: workflow.id,
      workflowName: workflow.name,
      companyId: workflow.companyId,
      createdByUserId: workflow.createdByUserId,
      departmentId: workflow.departmentId,
    });
    await progress?.(`Loaded workflow "${workflow.name}" and restored execution identity.`);
    const primaryThread = isLarkIntent
      ? {
          id: workflow.originChatId ?? `scheduled_lark_${workflow.id}`,
          title: 'Scheduled Lark delivery',
        }
      : await this.resolvePrimaryExecutionThread({
          workflowName: workflow.name,
          outputConfig,
          userId: session.userId,
          companyId: session.companyId,
          departmentId: workflow.departmentId,
        });
    await progress?.(
      isLarkIntent
        ? 'Resolved Lark delivery target for this scheduled workflow.'
        : `Resolved primary delivery thread: ${primaryThread.title ?? primaryThread.id}.`,
    );
    logger.info('desktop.workflow.execute.thread.resolved', {
      workflowId: workflow.id,
      workflowName: workflow.name,
      threadId: primaryThread.id,
      threadTitle: primaryThread.title ?? null,
      userId: session.userId,
      companyId: session.companyId,
    });

    const run = trigger === 'scheduled'
      ? await prisma.scheduledWorkflowRun.upsert({
        where: {
          workflowId_scheduledFor: {
            workflowId: workflow.id,
            scheduledFor,
          },
        },
        create: {
          workflowId: workflow.id,
          scheduledFor,
          status: 'running',
          startedAt: new Date(),
        },
        update: {
          status: 'running',
          startedAt: new Date(),
          finishedAt: null,
          errorSummary: null,
        },
      })
      : await prisma.scheduledWorkflowRun.create({
        data: {
          workflowId: workflow.id,
          scheduledFor,
          status: 'running',
          startedAt: new Date(),
        },
      });
    logger.info('desktop.workflow.execute.run.created', {
      workflowId: workflow.id,
      workflowRunId: run.id,
      scheduledFor: scheduledFor.toISOString(),
      trigger,
      runStatus: run.status,
    });
    await progress?.(`Created workflow run ${run.id}. Starting execution.`);

    const executionPrompt = buildExecutionPrompt({
      workflowName: workflow.name,
      compiledPrompt: workflow.compiledPrompt,
      scheduledFor,
      schedule,
      outputConfig,
      overrideText,
      hasAttachedSourceArtifacts: findLatestAttachedFiles(workflow.messages).length > 0,
    });
    logger.info('desktop.workflow.execute.prompt', {
      workflowId: workflow.id,
      workflowRunId: run.id,
      promptPreview: summarizeResult(executionPrompt, 1200),
    });
    await progress?.('Running the workflow runtime now.');

    try {
      const workflowAttachedFiles = findLatestAttachedFiles(workflow.messages);
      if (isLarkIntent) {
        const { destination, targetId } = this.resolvePrimaryLarkDestination({
          outputConfig,
          originChatId: workflow.originChatId ?? null,
        });
        const scheduledMessageId = `scheduled-${run.id}`;
        const scheduledTimestamp = new Date().toISOString();
        const scheduledChatType: NormalizedIncomingMessageDTO['chatType'] =
          destination.kind === 'lark_self_dm' ? 'p2p' : 'group';
        const normalizedMessage: NormalizedIncomingMessageDTO = {
          channel: 'lark',
          userId: session.larkOpenId ?? session.userId,
          chatId: targetId,
          chatType: scheduledChatType,
          messageId: scheduledMessageId,
          timestamp: scheduledTimestamp,
          text: executionPrompt,
          rawEvent: {
            source: 'scheduled_workflow',
            workflowId: workflow.id,
            workflowRunId: run.id,
            trigger,
          },
          trace: {
            requestId: `scheduled-wf-${workflow.id}-${Date.now()}`,
            eventId: `scheduled_evt_${run.id}`,
            receivedAt: scheduledTimestamp,
            larkTenantKey: session.larkTenantKey,
            larkOpenId: session.larkOpenId,
            larkUserId: session.larkUserId,
            companyId: workflow.companyId,
            linkedUserId: session.userId,
            requesterName: session.name,
            requesterEmail: session.email,
            ...(workflow.originChatId ? { referencedMessageId: workflow.originChatId } : {}),
            ...(destination.kind === 'lark_current_chat' ? { threadRootId: null, threadParentId: null } : {}),
          } as NormalizedIncomingMessageDTO['trace'],
        };

        const scheduledTask = await vercelOrchestrationEngine.buildTask(
          `scheduled-wf-${workflow.id}-${Date.now()}`,
          {
            ...normalizedMessage,
            trace: {
              ...normalizedMessage.trace,
              isScheduledRun: true,
              scheduledWorkflowId: workflow.id,
              scheduledWorkflowRunId: run.id,
            } as NormalizedIncomingMessageDTO['trace'],
          },
        );

        const execution = await vercelOrchestrationEngine.executeTask({
          task: scheduledTask,
          message: {
            ...normalizedMessage,
            trace: {
              ...normalizedMessage.trace,
              isScheduledRun: true,
              scheduledWorkflowId: workflow.id,
              scheduledWorkflowRunId: run.id,
            } as NormalizedIncomingMessageDTO['trace'],
          },
        });
        const executionSummary = summarizeResult(execution.latestSynthesis ?? 'Scheduled run completed.', 1200);
        const deliveredMessageId = execution.statusMessageId?.trim() || null;
        const nextRunAt = trigger === 'scheduled'
          ? getNextScheduledRunAt(schedule, new Date(scheduledFor.getTime() + 1000))
          : workflow.nextRunAt;
        const status: 'blocked' | 'succeeded' | 'failed' =
          execution.status === 'hitl'
            ? 'blocked'
            : execution.status === 'done'
              ? 'succeeded'
              : 'failed';

        await prisma.scheduledWorkflowRun.update({
          where: { id: run.id },
          data: {
            status,
            finishedAt: new Date(),
            resultSummary: status === 'succeeded' || status === 'blocked' ? executionSummary : null,
            errorSummary: status === 'failed' ? executionSummary : null,
            deliveryStatusJson: [{
              kind: destination.kind,
              chatId: targetId,
              messageId: deliveredMessageId,
              status: status === 'failed'
                ? 'failed'
                : deliveredMessageId
                  ? 'delivered'
                  : 'unknown',
            }],
          },
        });

        logger.info('desktop.workflow.execute.lark_intent.delivery', {
          workflowId: workflow.id,
          workflowRunId: run.id,
          targetId,
          destinationKind: destination.kind,
          executionStatus: execution.status,
          statusMessageId: deliveredMessageId,
        });

        await prisma.scheduledWorkflow.update({
          where: { id: workflow.id },
          data: {
            lastRunAt: new Date(),
            nextRunAt: trigger === 'scheduled' ? nextRunAt : workflow.nextRunAt,
            claimToken: null,
            claimedAt: null,
            ...(trigger === 'scheduled' && schedule.type === 'one_time' && !nextRunAt
              ? {
                  status: 'archived',
                  scheduleEnabled: false,
                  archivedAt: new Date(),
                }
              : {}),
          },
        });
        await this.notifyWorkflowRunOutcome({
          workflowId: workflow.id,
          workflowName: workflow.name,
          runId: run.id,
          trigger,
          status,
          session,
          outputConfig,
          originChatId: workflow.originChatId ?? null,
          scheduledFor,
          nextRunAt: trigger === 'scheduled' ? nextRunAt : workflow.nextRunAt,
          errorSummary: status === 'failed' ? executionSummary : null,
        });

        return {
          runId: run.id,
          executionId: null,
          status,
          threadId: primaryThread.id,
          threadTitle: primaryThread.title ?? null,
          resultSummary: status === 'failed' ? null : executionSummary,
          errorSummary: status === 'failed' ? executionSummary : null,
        };
      }

      const execution = await executeAutomatedDesktopTurn({
        session,
        threadId: primaryThread.id,
        prompt: executionPrompt,
        mode: 'high',
        attachedFiles: workflowAttachedFiles,
        metadata: {
          workflowId: workflow.id,
          workflowRunId: run.id,
          scheduledFor: scheduledFor.toISOString(),
          trigger,
        },
      });
      logger.info('desktop.workflow.execute.runtime.completed', {
        workflowId: workflow.id,
        workflowRunId: run.id,
        executionId: execution.executionId,
        pendingApproval: Boolean(execution.pendingApproval),
        assistantMessageId: execution.message.id,
        textPreview: summarizeResult(execution.text, 1200),
      });
      await progress?.(
        execution.pendingApproval
          ? 'Execution paused because an approval is required.'
          : execution.hadToolFailures
            ? 'Execution finished with tool failures. Preparing the final summary.'
            : 'Execution finished. Delivering the result now.',
      );

      const deliveries = await this.deliverResult({
        workflowId: workflow.id,
        runId: run.id,
        session,
        workflowName: workflow.name,
        outputConfig,
        originChatId: workflow.originChatId ?? null,
        primaryThreadId: primaryThread.id,
        primaryThreadTitle: primaryThread.title ?? null,
        primaryMessageId: execution.message.id,
        text: execution.text,
      });
      logger.info('desktop.workflow.execute.deliveries.completed', {
        workflowId: workflow.id,
        workflowRunId: run.id,
        deliveryCount: deliveries.length,
        deliveries,
      });
      await progress?.(`Delivered the workflow result to ${deliveries.length} destination${deliveries.length === 1 ? '' : 's'}.`);
      const nextRunAt = trigger === 'scheduled'
        ? getNextScheduledRunAt(schedule, new Date(scheduledFor.getTime() + 1000))
        : workflow.nextRunAt;
      const status: 'blocked' | 'succeeded' | 'failed' = execution.pendingApproval
        ? 'blocked'
        : execution.hadToolFailures
          ? 'failed'
          : 'succeeded';

      await prisma.scheduledWorkflowRun.update({
        where: { id: run.id },
        data: {
          status,
          executionRunId: execution.executionId,
          finishedAt: new Date(),
          resultSummary: summarizeResult(execution.text, 1200),
          errorSummary: execution.hadToolFailures ? summarizeResult(execution.failedToolSummaries.join('\n'), 1200) : null,
          deliveryStatusJson: deliveries,
        },
      });

      await prisma.scheduledWorkflow.update({
        where: { id: workflow.id },
        data: {
          lastRunAt: new Date(),
          nextRunAt: trigger === 'scheduled' ? nextRunAt : workflow.nextRunAt,
          claimToken: null,
          claimedAt: null,
          ...(trigger === 'scheduled' && schedule.type === 'one_time' && !nextRunAt
            ? {
              status: 'archived',
              scheduleEnabled: false,
              archivedAt: new Date(),
            }
            : {}),
        },
      });
      await this.notifyWorkflowRunOutcome({
        workflowId: workflow.id,
        workflowName: workflow.name,
        runId: run.id,
        trigger,
        status,
        session,
        outputConfig,
        originChatId: workflow.originChatId ?? null,
        scheduledFor,
        nextRunAt: trigger === 'scheduled' ? nextRunAt : workflow.nextRunAt,
        errorSummary: status === 'failed' ? summarizeResult(execution.failedToolSummaries.join('\n'), 1200) : null,
      });
      logger.info('desktop.workflow.execute.completed', {
        workflowId: workflow.id,
        workflowRunId: run.id,
        executionId: execution.executionId,
        status,
        threadId: primaryThread.id,
        threadTitle: primaryThread.title ?? null,
        nextRunAt: (trigger === 'scheduled' ? nextRunAt : workflow.nextRunAt)?.toISOString() ?? null,
        resultSummary: summarizeResult(execution.text, 1200),
      });

      return {
        runId: run.id,
        executionId: execution.executionId,
        status,
        threadId: primaryThread.id,
        threadTitle: primaryThread.title ?? null,
        resultSummary: summarizeResult(execution.text, 1200),
        errorSummary: null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Workflow execution failed';
      const nextRunAt = trigger === 'scheduled'
        ? getNextScheduledRunAt(schedule, new Date(scheduledFor.getTime() + 1000))
        : workflow.nextRunAt;
      logger.error('desktop.workflow.execute.failed', {
        workflowId: workflow.id,
        workflowRunId: run.id,
        scheduledFor: scheduledFor.toISOString(),
        trigger,
        threadId: primaryThread.id,
        threadTitle: primaryThread.title ?? null,
        nextRunAt: (trigger === 'scheduled' ? nextRunAt : workflow.nextRunAt)?.toISOString() ?? null,
        error: message,
      });

      await prisma.scheduledWorkflowRun.update({
        where: { id: run.id },
        data: {
          status: 'failed',
          finishedAt: new Date(),
          errorSummary: summarizeResult(message, 1200),
        },
      });

      await prisma.scheduledWorkflow.update({
        where: { id: workflow.id },
        data: {
          nextRunAt: trigger === 'scheduled' ? nextRunAt : workflow.nextRunAt,
          claimToken: null,
          claimedAt: null,
          ...(trigger === 'scheduled' && schedule.type === 'one_time' && !nextRunAt
            ? {
              status: 'archived',
              scheduleEnabled: false,
              archivedAt: new Date(),
            }
            : {}),
        },
      });
      await this.notifyWorkflowRunOutcome({
        workflowId: workflow.id,
        workflowName: workflow.name,
        runId: run.id,
        trigger,
        status: 'failed',
        session,
        outputConfig,
        originChatId: workflow.originChatId ?? null,
        scheduledFor,
        nextRunAt: trigger === 'scheduled' ? nextRunAt : workflow.nextRunAt,
        errorSummary: summarizeResult(message, 1200),
      });

      return {
        runId: run.id,
        executionId: null,
        status: 'failed',
        threadId: primaryThread.id,
        threadTitle: primaryThread.title ?? null,
        resultSummary: null,
        errorSummary: summarizeResult(message, 1200),
      };
    }
  }
}

export const desktopWorkflowsService = new DesktopWorkflowsService();
