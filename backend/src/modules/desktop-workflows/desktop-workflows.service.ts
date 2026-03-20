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
import { resolveChannelAdapter } from '../../company/channels/channel-adapter.registry';
import { larkUserAuthLinkRepository } from '../../company/channels/lark/lark-user-auth-link.repository';
import { getSupportedToolActionGroups } from '../../company/tools/tool-action-groups';
import { toolPermissionService } from '../../company/tools/tool-permission.service';
import { TOOL_REGISTRY } from '../../company/tools/tool-registry';
import { resolveVercelLanguageModel } from '../../company/orchestration/vercel/model-factory';
import { prisma } from '../../utils/prisma';
import { logger } from '../../utils/logger';
import { departmentService } from '../../company/departments/department.service';
import { desktopThreadsService } from '../desktop-threads/desktop-threads.service';
import { memberAuthRepository } from '../member-auth/member-auth.repository';
import type { MemberSessionDTO } from '../member-auth/member-auth.service';
import { executeAutomatedDesktopTurn } from '../desktop-chat/vercel-desktop.engine';
import { formatScheduledSlot, getNextScheduledRunAt } from './desktop-workflows.schedule';

const generatedWorkflowCompilerOutputSchema = z.object({
  compilerNotes: z.string().trim().min(1).max(600),
  aiDraft: z.string().trim().min(1).max(12000),
  workflowSpec: scheduledWorkflowSpecSchema,
}).strict();

export type DesktopWorkflowCompilerInput = {
  name: string;
  userIntent: string;
  schedule: ScheduledWorkflowScheduleConfig;
  outputConfig: ScheduledWorkflowOutputConfig;
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
};

type StoredWorkflowStatus = 'draft' | 'published' | 'active' | 'scheduled_active' | 'paused' | 'archived';
type WorkflowPresentationStatus = 'draft' | 'published' | 'scheduled_active' | 'paused' | 'archived';
type WorkflowAuthorMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
};

const WORKFLOW_HISTORY_WINDOW = 8;
const DEFAULT_WORKFLOW_NAME = 'Untitled workflow';

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
      return `${destination.id}: lark chat (${destination.chatId})`;
    })
    .join('\n');

const buildToolCatalog = (allowedToolIds: string[]): string =>
  TOOL_REGISTRY
    .filter((tool) => allowedToolIds.includes(tool.id))
    .map((tool) => {
      const actionGroups = getSupportedToolActionGroups(tool.id).join(', ');
      return [
        `- ${tool.id}`,
        `  Name: ${tool.name}`,
        `  Category: ${tool.category}`,
        `  Action groups: ${actionGroups}`,
        `  Description: ${tool.description}`,
      ].join('\n');
    })
    .join('\n');

const buildCompilerPrompt = (input: {
  workflowName: string;
  userIntent: string;
  schedule: ScheduledWorkflowScheduleConfig;
  outputConfig: ScheduledWorkflowOutputConfig;
  allowedToolIds: string[];
}): string => {
  const allowedDestinationIds = input.outputConfig.destinations.map((destination) => destination.id).join(', ');

  return [
    'Compile the user brief into a scheduled workflow graph.',
    'Also write an aiDraft: a detailed reusable operating brief that can be edited and reused later.',
    'Return a workflowSpec that matches the schema exactly.',
    'Use only the listed tool ids and supported action groups.',
    'Prefer explicit, concrete workflow steps over vague generic summaries.',
    'If the brief asks for latest news, current updates, research, or web lookup, include a web search/read capability.',
    'If the brief asks to create or update a Lark doc, use the Lark doc tools when available.',
    'If the workflow creates, updates, deletes, sends, or executes anything, represent that as a write-capable node with the correct capability.',
    'End the workflow with a deliver node whenever destinations are available.',
    'Only deliver to these destination ids: ' + allowedDestinationIds,
    'Operation names must be short, machine-readable, and dot-delimited.',
    'Use node instructions to capture the real user intent, not generic filler.',
    '',
    `Workflow name: ${input.workflowName}`,
    `User intent: ${input.userIntent}`,
    `Schedule: ${buildScheduleSummary(input.schedule)}`,
    'Allowed destinations:',
    buildDestinationSummary(input.outputConfig),
    '',
    'Allowed tools:',
    buildToolCatalog(input.allowedToolIds),
    '',
    'Node kind guidance:',
    '- read/search: gather source data',
    '- analyze/transform: reason over gathered data',
    '- createDraft: prepare an internal artifact before delivery',
    '- updateSystem: create or modify external systems or documents',
    '- send/notify: message or post results',
    '- deliver: finalize to approved destinations',
    '- requireApproval: insert when write/execution steps need an approval boundary',
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
}): string => {
  const transcript = input.history
    .slice(-WORKFLOW_HISTORY_WINDOW)
    .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content}`)
    .join('\n');

  return [
    'You are refining a reusable workflow from an iterative authoring conversation.',
    'Use the recent authoring history plus the current workflow artifacts to produce the next full workflow draft.',
    'Return a full aiDraft and a full workflowSpec, not a patch.',
    'Preserve the underlying job unless the latest user instruction clearly changes it.',
    'Make the workflow concrete, operational, and structured around the available tools and action groups.',
    '',
    `Workflow name: ${input.workflowName}`,
    `Latest user brief: ${input.latestIntent}`,
    `Schedule: ${buildScheduleSummary(input.schedule)}`,
    'Allowed destinations:',
    buildDestinationSummary(input.outputConfig),
    '',
    'Allowed tools:',
    buildToolCatalog(input.allowedToolIds),
    '',
    input.currentAiDraft?.trim()
      ? ['Current reusable prompt:', input.currentAiDraft.trim(), ''].join('\n')
      : '',
    input.currentWorkflowSpec
      ? ['Current workflow JSON:', JSON.stringify(input.currentWorkflowSpec, null, 2), ''].join('\n')
      : '',
    'Recent authoring conversation:',
    transcript || 'User: Create a new workflow draft.',
  ].filter(Boolean).join('\n');
};

const includesAny = (value: string, needles: string[]): boolean => {
  const lowered = value.toLowerCase();
  return needles.some((needle) => lowered.includes(needle));
};

const pickSearchCapability = (allowedToolIds: string[]) => {
  if (allowedToolIds.includes('search-read')) {
    return {
      toolId: 'search-read',
      actionGroup: 'read' as const,
      operation: 'search.read.latest',
    };
  }
  if (allowedToolIds.includes('search-agent')) {
    return {
      toolId: 'search-agent',
      actionGroup: 'read' as const,
      operation: 'search.agent.research',
    };
  }
  if (allowedToolIds.includes('search-documents')) {
    return {
      toolId: 'search-documents',
      actionGroup: 'read' as const,
      operation: 'search.documents.context',
    };
  }
  return undefined;
};

const buildFallbackWorkflowSpec = (input: {
  workflowName: string;
  userIntent: string;
  outputConfig: ScheduledWorkflowOutputConfig;
  allowedToolIds: string[];
}): z.infer<typeof scheduledWorkflowSpecSchema> => {
  const wantsWebResearch = includesAny(input.userIntent, ['latest', 'news', 'updates', 'search', 'research', 'web']);
  const wantsDraftArtifact = includesAny(input.userIntent, ['summary', 'digest', 'report', 'brief', 'draft', 'document', 'doc']);

  const readCapability = wantsWebResearch ? pickSearchCapability(input.allowedToolIds) : undefined;
  const nodes: z.infer<typeof scheduledWorkflowSpecSchema>['nodes'] = [];
  const edges: z.infer<typeof scheduledWorkflowSpecSchema>['edges'] = [];

  if (readCapability) {
    nodes.push({
      id: 'gather_context',
      kind: 'read',
      title: 'Gather source context',
      instructions: input.userIntent,
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
    inputs: readCapability ? ['gather_context'] : [],
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
    inputs: [wantsDraftArtifact ? 'prepare_output' : 'analyze_findings'],
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

const isDatabaseUnavailable = (error: unknown): boolean => readPrismaErrorCode(error) === 'P1001';

const toWorkflowMessages = (
  rows: Array<{ id: string; role: string; content: string; createdAt: Date }>,
): WorkflowAuthorMessage[] =>
  rows.map((row) => ({
    id: row.id,
    role: row.role === 'assistant' ? 'assistant' : 'user',
    content: row.content,
    createdAt: row.createdAt.toISOString(),
  }));

const buildApprovalGrant = (
  session: MemberSessionDTO,
  capabilitySummary: ScheduledWorkflowCapabilitySummary,
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

  private async compileArtifacts(input: {
    session: MemberSessionDTO;
    name: string;
    latestIntent: string;
    schedule: ScheduledWorkflowScheduleConfig;
    outputConfig: ScheduledWorkflowOutputConfig;
    history?: WorkflowAuthorMessage[];
    currentAiDraft?: string | null;
    currentWorkflowSpec?: z.infer<typeof scheduledWorkflowSpecSchema> | null;
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

    const allowedToolIds = await this.getAllowedWorkflowTools(input.session);
    const resolvedModel = await resolveVercelLanguageModel('high');
    const prompt = input.history && input.history.length > 0
      ? buildAuthoringPrompt({
        workflowName: input.name,
        latestIntent: input.latestIntent,
        schedule: input.schedule,
        outputConfig: input.outputConfig,
        allowedToolIds,
        history: input.history,
        currentAiDraft: input.currentAiDraft,
        currentWorkflowSpec: input.currentWorkflowSpec,
      })
      : buildCompilerPrompt({
        workflowName: input.name,
        userIntent: input.latestIntent,
        schedule: input.schedule,
        outputConfig: input.outputConfig,
        allowedToolIds,
      });

    let generated: z.infer<typeof generatedWorkflowCompilerOutputSchema>;
    let usedFallback = false;
    try {
      const result = await generateObject({
        model: resolvedModel.model,
        schema: generatedWorkflowCompilerOutputSchema,
        schemaName: 'scheduled_workflow_compile_result',
        schemaDescription: 'A valid scheduled workflow graph and brief compiler note.',
        prompt,
        temperature: 0,
        providerOptions: {
          google: {
            thinkingConfig: {
              includeThoughts: true,
              thinkingLevel: resolvedModel.thinkingLevel,
            },
          },
        },
      });
      generated = result.object;
    } catch (error) {
      logger.warn('desktop.workflow.compile.fallback', {
        error: error instanceof Error ? error.message : 'unknown_error',
        workflowName: input.name,
      });
      usedFallback = true;
      generated = {
        compilerNotes: 'Compiled with deterministic fallback because the model response did not satisfy the strict workflow schema on the first pass.',
        aiDraft: [
          `Workflow objective: ${input.latestIntent}`,
          '',
          'Execution guidance:',
          '- Follow the structured workflow definition exactly.',
          '- Use only the approved tools and destinations.',
          '- Produce a concrete, concise final deliverable for the configured outputs.',
        ].join('\n'),
        workflowSpec: buildFallbackWorkflowSpec({
          workflowName: input.name,
          userIntent: input.latestIntent,
          outputConfig: input.outputConfig,
          allowedToolIds,
        }),
      };
    }

    const workflowSpec = scheduledWorkflowSpecSchema.parse({
      ...generated.workflowSpec,
      name: input.name,
    });

    const { compiledPrompt, capabilitySummary } = compileScheduledWorkflowDefinition({
      userIntent: input.latestIntent,
      workflowSpec,
      schedule: input.schedule,
      outputConfig: input.outputConfig,
    });

    return {
      aiDraft: generated.aiDraft,
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
    updatedAt: Date;
    messages?: Array<{ id: string; role: string; content: string; createdAt: Date }>;
  }) {
    const parsed = parseWorkflowRow(row);
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
      ownershipScope: 'personal' as const,
      updatedAt: row.updatedAt.toISOString(),
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
    });
  }

  async createDraft(
    session: MemberSessionDTO,
    input?: { name?: string | null; departmentId?: string | null },
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

  async author(session: MemberSessionDTO, workflowId: string, message: string) {
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
    const createdUserMessage = await prisma.scheduledWorkflowMessage.create({
      data: {
        workflowId,
        role: 'user',
        content: message.trim(),
      },
    });

    const history = toWorkflowMessages([
      ...workflow.messages,
      createdUserMessage,
    ]);

    const compiled = await this.compileArtifacts({
      session,
      name: workflow.name === DEFAULT_WORKFLOW_NAME ? deriveWorkflowName(message) : workflow.name,
      latestIntent: message.trim(),
      schedule: parsed.schedule,
      outputConfig: parsed.outputConfig,
      history,
      currentAiDraft: workflow.aiDraft,
      currentWorkflowSpec: parsed.workflowSpec,
    });

    const assistantSummary = summarizeResult(compiled.compilerNotes || compiled.aiDraft, 1200);
    const updatedWorkflow = await prisma.$transaction(async (tx) => {
      await tx.scheduledWorkflowMessage.create({
        data: {
          workflowId,
          role: 'assistant',
          content: assistantSummary,
          metadata: {
            model: compiled.model,
          },
        },
      });

      return tx.scheduledWorkflow.update({
        where: { id: workflowId },
        data: {
          name: workflow.name === DEFAULT_WORKFLOW_NAME ? deriveWorkflowName(message) : workflow.name,
          userIntent: message.trim(),
          aiDraft: compiled.aiDraft,
          workflowSpecJson: compiled.workflowSpec,
          compiledPrompt: compiled.compiledPrompt,
          capabilitySummaryJson: compiled.capabilitySummary,
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
    const nextSchedule = input.schedule ?? parsed.schedule;
    const nextOutputConfig = input.outputConfig ?? parsed.outputConfig;
    const nextWorkflowSpec = input.workflowSpec
      ? reconcileWorkflowSpecDestinations(
        scheduledWorkflowSpecSchema.parse({ ...input.workflowSpec, name: nextName }),
        nextOutputConfig,
      )
      : parsed.workflowSpec;
    const nextCompiled = compileScheduledWorkflowDefinition({
      userIntent: nextIntent,
      workflowSpec: nextWorkflowSpec,
      schedule: nextSchedule,
      outputConfig: nextOutputConfig,
    });

    const updated = await prisma.scheduledWorkflow.update({
      where: { id: workflowId },
      data: {
        ...(input.departmentId !== undefined ? { departmentId: input.departmentId } : {}),
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
    const workflowSpec = reconcileWorkflowSpecDestinations(scheduledWorkflowSpecSchema.parse({
      ...input.workflowSpec,
      name: input.name,
    }), normalizedOutputConfig);
    const { capabilitySummary } = compileScheduledWorkflowDefinition({
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
          name: input.name,
          status: nextStatus,
          userIntent: input.userIntent,
          aiDraft: input.aiDraft?.trim() || null,
          workflowSpecJson: workflowSpec,
          compiledPrompt: input.compiledPrompt.trim(),
          capabilitySummaryJson: capabilitySummary,
          timezone: input.schedule.timezone,
          scheduleType: input.schedule.type,
          scheduleConfigJson: input.schedule,
          scheduleEnabled,
          nextRunAt,
          outputConfigJson: outputConfig,
          approvalGrantJson: buildApprovalGrant(session, capabilitySummary),
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
          name: input.name,
          status: nextStatus,
          userIntent: input.userIntent,
          aiDraft: input.aiDraft?.trim() || null,
          workflowSpecJson: workflowSpec,
          compiledPrompt: input.compiledPrompt.trim(),
          capabilitySummaryJson: capabilitySummary,
          timezone: input.schedule.timezone,
          scheduleType: input.schedule.type,
          scheduleConfigJson: input.schedule,
          scheduleEnabled,
          nextRunAt,
          outputConfigJson: outputConfig,
          approvalGrantJson: buildApprovalGrant(session, capabilitySummary),
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
    };
  }

  async runNow(session: MemberSessionDTO, workflowId: string, overrideText?: string | null): Promise<{
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

    const result = await this.executeWorkflow(workflow.id, new Date(), 'manual', overrideText?.trim() || null);
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
    }, 30_000);
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

  private async deliverResult(input: {
    workflowId: string;
    runId: string;
    session: MemberSessionDTO;
    workflowName: string;
    outputConfig: ScheduledWorkflowOutputConfig;
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

      const adapter = resolveChannelAdapter('lark');
      const outbound = await adapter.sendMessage({
        chatId: destination.chatId,
        text: input.text,
        correlationId: input.runId,
      });
      deliveries.push({
        kind: 'lark_chat',
        target: destination.label ?? destination.chatId,
        chatId: destination.chatId,
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
  ): Promise<{
    runId: string;
    executionId: string | null;
    status: 'succeeded' | 'failed' | 'blocked';
    threadId: string;
    threadTitle: string | null;
    resultSummary: string | null;
    errorSummary: string | null;
  }> {
    const workflow = await prisma.scheduledWorkflow.findUnique({ where: { id: workflowId } });
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

    const { schedule, outputConfig } = parseWorkflowRow(workflow);
    const session = await this.loadExecutionSession({
      workflowId: workflow.id,
      workflowName: workflow.name,
      companyId: workflow.companyId,
      createdByUserId: workflow.createdByUserId,
      departmentId: workflow.departmentId,
    });
    const primaryThread = await this.resolvePrimaryExecutionThread({
      workflowName: workflow.name,
      outputConfig,
      userId: session.userId,
      companyId: session.companyId,
      departmentId: workflow.departmentId,
    });
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

    const executionPrompt = buildExecutionPrompt({
      workflowName: workflow.name,
      compiledPrompt: workflow.compiledPrompt,
      scheduledFor,
      schedule,
      outputConfig,
      overrideText,
    });
    logger.info('desktop.workflow.execute.prompt', {
      workflowId: workflow.id,
      workflowRunId: run.id,
      promptPreview: summarizeResult(executionPrompt, 1200),
    });

    try {
      const execution = await executeAutomatedDesktopTurn({
        session,
        threadId: primaryThread.id,
        prompt: executionPrompt,
        mode: 'high',
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

      const deliveries = await this.deliverResult({
        workflowId: workflow.id,
        runId: run.id,
        session,
        workflowName: workflow.name,
        outputConfig,
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
