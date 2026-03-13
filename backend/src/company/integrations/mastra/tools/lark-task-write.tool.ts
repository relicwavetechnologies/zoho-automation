import { createTool } from '@mastra/core/tools';
import { randomUUID } from 'crypto';
import { z } from 'zod';

import { larkTasksService } from '../../../channels/lark/lark-tasks.service';
import { LarkRuntimeClientError, type LarkCredentialMode } from '../../../channels/lark/lark-runtime-client';
import { larkOperationalConfigRepository } from '../../../channels/lark/lark-operational-config.repository';
import { TOOL_REGISTRY_MAP } from '../../../tools/tool-registry';
import { emitActivityEvent } from './activity-bus';

const TOOL_ID = 'lark-task-write';

export const larkTaskWriteTool = createTool({
  id: TOOL_ID,
  description: 'Create or update a Lark Task using friendly fields with optional raw body overrides.',
  inputSchema: z.object({
    action: z.enum(['create', 'update']),
    taskId: z.string().optional().describe('Required for updates'),
    tasklistId: z.string().optional().describe('Optional tasklist ID. Falls back to company default when configured.'),
    summary: z.string().optional().describe('Task title or summary'),
    description: z.string().optional().describe('Optional task description'),
    dueTs: z.string().optional().describe('Optional due timestamp or ISO string'),
    completed: z.boolean().optional().describe('Optional completed state'),
    assigneeIds: z.array(z.string().min(1)).optional().describe('Optional Lark assignee IDs'),
    body: z.record(z.unknown()).optional().describe('Optional raw task payload override'),
  }),
  execute: async (inputData, context) => {
    const requestContext = context?.requestContext;
    const allowedToolIds = requestContext?.get('allowedToolIds') as string[] | undefined;
    if (allowedToolIds !== undefined && !allowedToolIds.includes(TOOL_ID)) {
      const name = TOOL_REGISTRY_MAP.get(TOOL_ID)?.name ?? TOOL_ID;
      return { answer: `Access to "${name}" is not permitted for your role. Please contact your admin.` };
    }

    if (inputData.action === 'update' && !inputData.taskId) {
      return { answer: 'Lark task update failed: taskId is required for updates.' };
    }

    const requestId = requestContext?.get('requestId') as string | undefined;
    const callId = randomUUID();
    if (requestId) {
      emitActivityEvent(requestId, 'activity', {
        id: callId,
        name: TOOL_ID,
        label: inputData.action === 'create' ? 'Creating Lark task' : 'Updating Lark task',
        icon: 'check-square',
      });
    }

    try {
      const companyId = requestContext?.get('companyId') as string | undefined;
      const defaults = companyId ? await larkOperationalConfigRepository.findByCompanyId(companyId) : null;
      const tasklistId = inputData.tasklistId?.trim() || defaults?.defaultTasklistId;
      const credentialMode: LarkCredentialMode =
        requestContext?.get('larkAuthMode') === 'user_linked' ? 'user_linked' : 'tenant';
      const body = inputData.body ?? {
        ...(tasklistId ? { tasklist_id: tasklistId } : {}),
        ...(inputData.summary ? { summary: inputData.summary } : {}),
        ...(inputData.description ? { description: inputData.description } : {}),
        ...(inputData.dueTs ? { due: { timestamp: inputData.dueTs } } : {}),
        ...(inputData.completed !== undefined ? { completed: inputData.completed } : {}),
        ...(inputData.assigneeIds && inputData.assigneeIds.length > 0 ? { assignee_ids: inputData.assigneeIds } : {}),
      };
      if (inputData.action === 'create' && !inputData.body && !inputData.summary) {
        return { answer: 'Lark task create failed: summary is required unless a raw body is provided.' };
      }
      const commonInput = {
        body,
        companyId,
        larkTenantKey: requestContext?.get('larkTenantKey') as string | undefined,
        appUserId: requestContext?.get('userId') as string | undefined,
        credentialMode,
      };

      const task = inputData.action === 'create'
        ? await larkTasksService.createTask(commonInput)
        : await larkTasksService.updateTask({
          ...commonInput,
          taskId: inputData.taskId as string,
        });

      const label = task.summary ?? task.taskId;
      const answer = inputData.action === 'create'
        ? `Created Lark task: ${label}`
        : `Updated Lark task: ${label}`;

      if (requestId) {
        emitActivityEvent(requestId, 'activity_done', {
          id: callId,
          name: TOOL_ID,
          label: inputData.action === 'create' ? 'Created Lark task' : 'Updated Lark task',
          icon: 'check-square',
          resultSummary: answer,
        });
      }

      return {
        answer,
        task,
      };
    } catch (error) {
      const message = error instanceof LarkRuntimeClientError
        ? error.message
        : error instanceof Error
          ? error.message
          : 'unknown_error';

      if (requestId) {
        emitActivityEvent(requestId, 'activity_done', {
          id: callId,
          name: TOOL_ID,
          label: 'Lark task write failed',
          icon: 'x-circle',
          resultSummary: message,
        });
      }

      return { answer: `Lark task write failed: ${message}` };
    }
  },
});
