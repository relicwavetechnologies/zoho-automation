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
  schedule: ScheduledWorkflowScheduleConfig;
  outputConfig: ScheduledWorkflowOutputConfig;
  workflowSpec: z.infer<typeof scheduledWorkflowSpecSchema>;
  compiledPrompt: string;
  capabilitySummary?: ScheduledWorkflowCapabilitySummary;
  departmentId?: string | null;
};

const buildScheduleSummary = (schedule: ScheduledWorkflowScheduleConfig): string => {
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

const readPrismaErrorCode = (error: unknown): string | null =>
  error && typeof error === 'object' && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : null;

const isScheduledWorkflowTableMissing = (error: unknown): boolean =>
  readPrismaErrorCode(error) === 'P2021'
  && error instanceof Error
  && error.message.includes('ScheduledWorkflow');

const isDatabaseUnavailable = (error: unknown): boolean => readPrismaErrorCode(error) === 'P1001';

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

const buildExecutionPrompt = (input: {
  workflowName: string;
  compiledPrompt: string;
  scheduledFor: Date;
  schedule: ScheduledWorkflowScheduleConfig;
  outputConfig: ScheduledWorkflowOutputConfig;
}): string => [
  input.compiledPrompt.trim(),
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

  async compile(
    session: MemberSessionDTO,
    input: DesktopWorkflowCompilerInput,
  ): Promise<{
    workflowSpec: z.infer<typeof scheduledWorkflowSpecSchema>;
    compiledPrompt: string;
    compilerNotes: string;
    capabilitySummary: ReturnType<typeof compileScheduledWorkflowDefinition>['capabilitySummary'];
    model: { provider: string; modelId: string };
  }> {
    if (!(config.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)) {
      throw new HttpException(503, 'Gemini is not configured on the backend');
    }

    const requesterAiRole = session.aiRole ?? session.role;
    const allowedToolIds = await toolPermissionService.getAllowedTools(session.companyId, requesterAiRole);
    if (allowedToolIds.length === 0) {
      throw new HttpException(403, 'No tools are available for workflow compilation');
    }

    const resolvedModel = await resolveVercelLanguageModel('high');
    const prompt = buildCompilerPrompt({
      workflowName: input.name,
      userIntent: input.userIntent,
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
        workflowSpec: buildFallbackWorkflowSpec({
          workflowName: input.name,
          userIntent: input.userIntent,
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
      userIntent: input.userIntent,
      workflowSpec,
      schedule: input.schedule,
      outputConfig: input.outputConfig,
    });

    return {
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

  async publish(
    session: MemberSessionDTO,
    input: DesktopWorkflowPublishInput,
  ): Promise<{
    workflowId: string;
    status: 'active';
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
    const nextRunAt = getNextScheduledRunAt(input.schedule, new Date());
    if (!nextRunAt) {
      throw new HttpException(400, 'This workflow has no future run time to publish.');
    }

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
      const thread = await desktopThreadsService.findOrCreateNamedThread(
        session.userId,
        session.companyId,
        destination.label ?? destination.threadId,
        resolvedDepartment?.id ?? null,
      );
      return {
        ...destination,
        threadId: thread.id,
        label: destination.label ?? thread.title ?? destination.threadId,
      };
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
          status: 'active',
          userIntent: input.userIntent,
          workflowSpecJson: workflowSpec,
          compiledPrompt: input.compiledPrompt.trim(),
          capabilitySummaryJson: capabilitySummary,
          timezone: input.schedule.timezone,
          scheduleType: input.schedule.type,
          scheduleConfigJson: input.schedule,
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
          status: 'active',
          userIntent: input.userIntent,
          workflowSpecJson: workflowSpec,
          compiledPrompt: input.compiledPrompt.trim(),
          capabilitySummaryJson: capabilitySummary,
          timezone: input.schedule.timezone,
          scheduleType: input.schedule.type,
          scheduleConfigJson: input.schedule,
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
      status: 'active',
      nextRunAt: workflow.nextRunAt ? workflow.nextRunAt.toISOString() : null,
      publishedAt: workflow.publishedAt?.toISOString() ?? new Date().toISOString(),
      primaryThreadId: primaryThread.id,
      primaryThreadTitle: primaryThread.title ?? null,
      capabilitySummary,
    };
  }

  async runNow(session: MemberSessionDTO, workflowId: string): Promise<{
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
      },
    });
    if (!workflow) {
      throw new HttpException(404, 'Workflow not found');
    }

    const result = await this.executeWorkflow(workflow.id, new Date(), 'manual');
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
    status: 'draft' | 'active' | 'paused' | 'archived';
    userIntent: string;
    workflowSpec: z.infer<typeof scheduledWorkflowSpecSchema>;
    compiledPrompt: string;
    capabilitySummary: ScheduledWorkflowCapabilitySummary;
    schedule: ScheduledWorkflowScheduleConfig;
    outputConfig: ScheduledWorkflowOutputConfig;
    publishedAt: string | null;
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
    });

    return rows.map((row) => {
      const parsed = parseWorkflowRow(row);
      return {
        id: row.id,
        name: row.name,
        status: row.status,
        userIntent: row.userIntent,
        workflowSpec: parsed.workflowSpec,
        compiledPrompt: row.compiledPrompt,
        capabilitySummary: parsed.capabilitySummary,
        schedule: parsed.schedule,
        outputConfig: parsed.outputConfig,
        publishedAt: row.publishedAt?.toISOString() ?? null,
        nextRunAt: row.nextRunAt?.toISOString() ?? null,
        updatedAt: row.updatedAt.toISOString(),
      };
    });
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
          status: 'active',
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
            status: 'active',
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
