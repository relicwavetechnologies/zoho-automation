import { createTool } from '@mastra/core/tools';
import { randomUUID } from 'crypto';
import { z } from 'zod';

import { larkTaskSpecialistAgent } from '../agents/lark-task-specialist.agent';
import { buildMastraAgentRunOptions } from '../mastra-model-control';
import { TOOL_REGISTRY_MAP } from '../../../tools/tool-registry';
import { emitActivityEvent } from './activity-bus';
import { larkOperationalResultSchema } from '../schemas/specialist-results.schema';
import { larkTaskWriteTool } from './lark-task-write.tool';
import {
  parseDirectCreateTaskIntent,
  parseDirectReassignTaskIntent,
  parseDirectTaskStatusIntent,
} from './lark-task-agent-intent';
import { normalizeLarkOperationalResult } from './specialist-result-helpers';

const TOOL_ID = 'lark-task-agent';

export const larkTaskAgentTool = createTool({
  id: TOOL_ID,
  description: 'Delegate to the Lark Tasks specialist for task listing, creation, and updates.',
  inputSchema: z.object({
    query: z.string().describe('The Lark task work to perform'),
  }),
  outputSchema: larkOperationalResultSchema,
  execute: async (inputData, context) => {
    const requestContext = context?.requestContext;
    const allowedToolIds = requestContext?.get('allowedToolIds') as string[] | undefined;
    if (allowedToolIds !== undefined && !allowedToolIds.includes(TOOL_ID)) {
      const name = TOOL_REGISTRY_MAP.get(TOOL_ID)?.name ?? TOOL_ID;
      return normalizeLarkOperationalResult(`Access to "${name}" is not permitted for your role. Please contact your admin.`);
    }

    const requestId = requestContext?.get('requestId') as string | undefined;
    const callId = randomUUID();
    if (requestId) {
      emitActivityEvent(requestId, 'activity', {
        id: callId,
        name: TOOL_ID,
        label: 'Working on Lark Tasks',
        icon: 'check-square',
      });
    }

    const directCreateIntent = parseDirectCreateTaskIntent(inputData.query);
    if (directCreateIntent) {
      const executeWriteTool = larkTaskWriteTool.execute as ((input: Record<string, unknown>, context: unknown) => Promise<{ answer?: string }>) | undefined;
      const directResult = executeWriteTool
        ? await executeWriteTool({
        action: 'create',
        summary: directCreateIntent.summary,
        ...(directCreateIntent.assigneeNames.length > 0 ? { assigneeNames: directCreateIntent.assigneeNames } : {}),
        ...(directCreateIntent.assignToMe ? { assignToMe: true } : {}),
      }, context as any)
        : { answer: 'Lark task write failed: direct create path is unavailable.' };
      const directAnswer = typeof directResult?.answer === 'string'
        ? directResult.answer
        : 'Lark task write failed: direct create path returned no answer.';
      const normalized = normalizeLarkOperationalResult(directAnswer);

      if (requestId) {
        emitActivityEvent(requestId, 'activity_done', {
          id: callId,
          name: TOOL_ID,
          label: normalized.success ? 'Updated Lark Tasks' : 'Lark task flow failed',
          icon: normalized.success ? 'check-square' : 'x-circle',
          resultSummary: normalized.summary,
        });
      }

      return normalized;
    }

    const directReassignIntent = parseDirectReassignTaskIntent(inputData.query);
    if (directReassignIntent) {
      const executeWriteTool = larkTaskWriteTool.execute as ((input: Record<string, unknown>, context: unknown) => Promise<{ answer?: string }>) | undefined;
      const directResult = executeWriteTool
        ? await executeWriteTool({
          action: 'update',
          taskId: directReassignIntent.taskRef,
          ...(directReassignIntent.assigneeNames.length > 0 ? { assigneeNames: directReassignIntent.assigneeNames } : {}),
          ...(directReassignIntent.assignToMe ? { assignToMe: true } : {}),
        }, context as any)
        : { answer: 'Lark task write failed: direct reassign path is unavailable.' };
      const directAnswer = typeof directResult?.answer === 'string'
        ? directResult.answer
        : 'Lark task write failed: direct reassign path returned no answer.';
      const normalized = normalizeLarkOperationalResult(directAnswer);

      if (requestId) {
        emitActivityEvent(requestId, 'activity_done', {
          id: callId,
          name: TOOL_ID,
          label: normalized.success ? 'Updated Lark Tasks' : 'Lark task flow failed',
          icon: normalized.success ? 'check-square' : 'x-circle',
          resultSummary: normalized.summary,
        });
      }

      return normalized;
    }

    const directStatusIntent = parseDirectTaskStatusIntent(inputData.query);
    if (directStatusIntent) {
      const executeWriteTool = larkTaskWriteTool.execute as ((input: Record<string, unknown>, context: unknown) => Promise<{ answer?: string }>) | undefined;
      const directResult = executeWriteTool
        ? await executeWriteTool({
          action: 'update',
          ...(directStatusIntent.taskRef ? { taskId: directStatusIntent.taskRef } : {}),
          completed: directStatusIntent.completed,
        }, context as any)
        : { answer: 'Lark task write failed: direct status update path is unavailable.' };
      const directAnswer = typeof directResult?.answer === 'string'
        ? directResult.answer
        : 'Lark task write failed: direct status update path returned no answer.';
      const normalized = normalizeLarkOperationalResult(directAnswer);

      if (requestId) {
        emitActivityEvent(requestId, 'activity_done', {
          id: callId,
          name: TOOL_ID,
          label: normalized.success ? 'Updated Lark Tasks' : 'Lark task flow failed',
          icon: normalized.success ? 'check-square' : 'x-circle',
          resultSummary: normalized.summary,
        });
      }

      return normalized;
    }

    const runOptions = await buildMastraAgentRunOptions('mastra.lark-doc', { requestContext });
    const result = await larkTaskSpecialistAgent.generate(
      [{ role: 'user', content: inputData.query }],
      runOptions as any,
    );

    const normalized = normalizeLarkOperationalResult(result.text);
    if (requestId) {
      emitActivityEvent(requestId, 'activity_done', {
        id: callId,
        name: TOOL_ID,
        label: normalized.success ? 'Updated Lark Tasks' : 'Lark task flow failed',
        icon: normalized.success ? 'check-square' : 'x-circle',
        resultSummary: normalized.summary,
      });
    }

    return normalized;
  },
});
