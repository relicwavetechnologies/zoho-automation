import { Agent } from '@mastra/core/agent';
import { createStep } from '@mastra/core/workflows';
import { z } from 'zod';

import {
  MASTRA_AGENT_TARGETS,
  resolveMastraLanguageModel,
  buildMastraAgentRunOptions,
  type MastraAgentTargetId,
} from '../mastra-model-control';
import { executionPlanSchema, taskSchema } from './planner.step';
import { registerActivityBus, unregisterActivityBus, type ActivityPayload } from '../tools/activity-bus';

const workflowAgentIdSchema = z.enum([
  'supervisorAgent',
  'zohoAgent',
  'outreachAgent',
  'searchAgent',
  'larkBaseAgent',
  'larkTaskAgent',
  'larkCalendarAgent',
  'larkMeetingAgent',
  'larkApprovalAgent',
  'larkDocAgent',
]);

const executionCompletedTaskSchema = z.object({
  taskId: z.string(),
  claimed: z.string(),
  isWriteOperation: z.boolean(),
  externalRef: z.string().optional(),
  ownerAgent: z.string(),
});

export const executionStepOutputSchema = z.object({
  finalAnswer: z.string(),
  completedTasks: z.array(executionCompletedTaskSchema),
  originalSuccessCriteria: z.array(z.object({
    taskId: z.string(),
    criteria: z.string(),
  })),
  executionPath: z.array(z.string()),
});

type WorkflowExecutionTask = z.infer<typeof taskSchema>;

const normalizeOwnerFromToolName = (toolName?: string | null): string | null => {
  const normalized = toolName?.trim().toLowerCase();
  if (!normalized) return null;

  if (normalized === 'zoho-agent' || normalized === 'read-zoho-records' || normalized === 'zoho-read' || normalized === 'zoho-search') {
    return 'zoho';
  }
  if (normalized === 'outreach-agent' || normalized === 'read-outreach-publishers') {
    return 'outreach';
  }
  if (normalized === 'search-agent' || normalized === 'search-read' || normalized === 'search-documents') {
    return 'search';
  }
  if (normalized === 'lark-doc-agent' || normalized === 'create-lark-doc' || normalized === 'edit-lark-doc') {
    return 'larkDoc';
  }
  if (normalized === 'lark-base-agent' || normalized === 'lark-base-read' || normalized === 'lark-base-write') {
    return 'larkBase';
  }
  if (normalized === 'lark-task-agent' || normalized === 'lark-task-read' || normalized === 'lark-task-write') {
    return 'larkTask';
  }
  if (normalized === 'lark-calendar-agent' || normalized === 'lark-calendar-read' || normalized === 'lark-calendar-write' || normalized === 'lark-calendar-list') {
    return 'larkCalendar';
  }
  if (normalized === 'lark-meeting-agent' || normalized === 'lark-meeting-read') {
    return 'larkMeeting';
  }
  if (normalized === 'lark-approval-agent' || normalized === 'lark-approval-read' || normalized === 'lark-approval-write') {
    return 'larkApproval';
  }
  return null;
};

const buildPlanContext = (plan: z.infer<typeof executionPlanSchema>): string => {
  const tasks = plan.tasks
    .map((task, index) => `${index + 1}. (${task.ownerAgent}) ${task.title}`)
    .join('\n');
  const successCriteria = plan.tasks
    .map((task) => `- ${task.successCriteria}`)
    .join('\n');

  return [
    '--- ACTIVE EXECUTION PLAN ---',
    `Goal: ${plan.goal}`,
    'Success criteria:',
    successCriteria,
    'Ordered tasks:',
    tasks,
    'Follow the ordered tasks. Do not claim completion before the matching work actually succeeds.',
    '--- END ACTIVE EXECUTION PLAN ---',
  ].join('\n');
};

const extractExternalRef = (payload: ActivityPayload): string | undefined => {
  if (payload.externalRef?.trim()) {
    return payload.externalRef.trim();
  }

  const summary = payload.resultSummary?.trim() ?? '';
  if (!summary) return undefined;

  try {
    const parsed = JSON.parse(summary) as {
      recordId?: string;
      campaignId?: string;
      docToken?: string;
      docUrl?: string;
    };
    const structuredRef = parsed.recordId ?? parsed.campaignId ?? parsed.docToken ?? parsed.docUrl;
    if (typeof structuredRef === 'string' && structuredRef.trim()) {
      return structuredRef.trim();
    }
  } catch {
    // Fall through to lightweight text extraction for backward compatibility.
  }

  const urlMatch = summary.match(/https?:\/\/[^\s)]+/i)?.[0];
  if (urlMatch) return urlMatch;

  const idMatch = summary.match(/\b([A-Za-z0-9_-]{8,})\b/)?.[1];
  return idMatch;
};

const findMatchingTask = (
  plan: z.infer<typeof executionPlanSchema>,
  payload: ActivityPayload,
  completedTaskIds: Set<string>,
): WorkflowExecutionTask | null => {
  if (payload.taskId) {
    const explicit = plan.tasks.find((task) => task.taskId === payload.taskId);
    if (explicit) {
      return explicit;
    }
  }

  const ownerAgent = normalizeOwnerFromToolName(payload.name);
  if (!ownerAgent) {
    return null;
  }

  return plan.tasks.find((task) => task.ownerAgent === ownerAgent && !completedTaskIds.has(task.taskId)) ?? null;
};

export const executionStep = createStep({
  id: 'execution-step',
  inputSchema: executionPlanSchema,
  outputSchema: executionStepOutputSchema,
  execute: async ({ inputData, getInitData, mastra, requestContext, outputWriter }) => {
    const initData = getInitData<{
      userObjective: string;
      plannerObjective?: string;
      requestContext: {
        userId: string;
        permissions: string[];
      };
      attachmentContent?: string;
      agentId?: z.infer<typeof workflowAgentIdSchema>;
      mode?: 'fast' | 'high' | 'xtreme';
      agentMessages?: Array<{ role: 'user'; content: string | Array<{ type: string; [k: string]: unknown }> }>;
    }>();

    const agentId = workflowAgentIdSchema.parse(initData.agentId ?? 'supervisorAgent');
    const mode = initData.mode ?? 'high';
    const agentTarget = MASTRA_AGENT_TARGETS[agentId as MastraAgentTargetId];
    const agent = mastra?.getAgent(agentId) as Agent | undefined;
    if (!agent) {
      throw new Error(`Workflow execution agent "${agentId}" is not registered.`);
    }

    const agentPrompt = [
      buildPlanContext(inputData),
      initData.userObjective,
    ].filter(Boolean).join('\n\n');

    const runOptions = await buildMastraAgentRunOptions(agentTarget, { requestContext }, mode);
    const dynamicModel = await resolveMastraLanguageModel(agentTarget, mode);

    const completedTaskIds = new Set<string>();
    const completedTasks: Array<z.infer<typeof executionCompletedTaskSchema>> = [];
    const requestId = requestContext?.get('requestId') as string | undefined;

    if (requestContext && inputData.tasks[0]?.taskId) {
      requestContext.set('activePlanTaskId', inputData.tasks[0].taskId);
    }

    const activityListener = (_type: 'activity' | 'activity_done', payload: ActivityPayload) => {
      if (_type !== 'activity_done' || payload.name === 'planner-agent') {
        return;
      }

      const matchingTask = findMatchingTask(inputData, payload, completedTaskIds);
      if (!matchingTask) {
        return;
      }

      completedTaskIds.add(matchingTask.taskId);
      completedTasks.push({
        taskId: matchingTask.taskId,
        claimed: payload.resultSummary?.trim() || payload.label,
        isWriteOperation: matchingTask.isWriteOperation,
        externalRef: extractExternalRef(payload),
        ownerAgent: matchingTask.ownerAgent,
      });

      const nextTask = inputData.tasks.find((task) => !completedTaskIds.has(task.taskId));
      if (requestContext && nextTask?.taskId) {
        requestContext.set('activePlanTaskId', nextTask.taskId);
      }
    };

    if (requestId) {
      registerActivityBus(requestId, activityListener);
    }

    let finalAnswer = '';
    try {
      const streamInput = initData.agentMessages ?? [{ role: 'user', content: agentPrompt }];
      const streamResult = await agent.stream(
        streamInput as any,
        { ...(runOptions as any), model: dynamicModel },
      );

      for await (const chunk of streamResult.fullStream as AsyncIterable<any>) {
        if (chunk?.type === 'text-delta') {
          finalAnswer += typeof chunk.payload?.text === 'string'
            ? chunk.payload.text
            : typeof chunk.payload?.textDelta === 'string'
              ? chunk.payload.textDelta
              : '';
        }

        const chunkType = typeof chunk?.type === 'string' ? chunk.type : '';
        const shouldStreamChunk = chunkType !== 'text-start'
          && chunkType !== 'text-delta'
          && chunkType !== 'text-end';

        if (outputWriter && shouldStreamChunk) {
          await outputWriter(chunk);
        }
      }

      const fullOutput = await streamResult.getFullOutput();
      if (!finalAnswer.trim()) {
        finalAnswer = fullOutput.text?.trim() || '';
      }

      return {
        finalAnswer: finalAnswer.trim(),
        completedTasks,
        originalSuccessCriteria: inputData.tasks.map((task) => ({
          taskId: task.taskId,
          criteria: task.successCriteria,
        })),
        executionPath: ['planner-step', 'execution-step'],
      };
    } finally {
      if (requestId) {
        unregisterActivityBus(requestId, activityListener);
      }
    }
  },
});
