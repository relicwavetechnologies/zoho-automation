import { createTool } from '@mastra/core/tools';
import { randomUUID } from 'crypto';
import { z } from 'zod';

import { larkTasksService } from '../../../channels/lark/lark-tasks.service';
import { LarkRuntimeClientError, type LarkCredentialMode } from '../../../channels/lark/lark-runtime-client';
import { larkOperationalConfigRepository } from '../../../channels/lark/lark-operational-config.repository';
import { conversationMemoryStore } from '../../../state/conversation';
import { TOOL_REGISTRY_MAP } from '../../../tools/tool-registry';
import { emitActivityEvent } from './activity-bus';
import { buildConversationKey } from './conversation-key';
import { normalizeLarkTimestamp } from './lark-time';

const TOOL_ID = 'lark-task-write';
const SUPPORTED_TASK_UPDATE_FIELDS = new Set([
  'custom_complete',
  'mode',
  'is_milestone',
  'description',
  'extra',
  'start',
  'due',
  'completed_at',
  'summary',
  'repeat_rule',
  'custom_fields',
]);

const deriveUpdateFields = (body: Record<string, unknown>): string[] => {
  const nestedTask = body.task;
  if (nestedTask && typeof nestedTask === 'object' && !Array.isArray(nestedTask)) {
    return Object.keys(nestedTask as Record<string, unknown>);
  }
  const keys = Object.keys(body).filter((key) => key !== 'tasklist_id' && key !== 'update_fields');
  return keys;
};

const toCompletedAt = (completed: boolean): string => (completed ? String(Date.now()) : '0');

const normalizeUpdateTaskPayload = (body: Record<string, unknown>): {
  task: Record<string, unknown>;
  updateFields: string[];
} => {
  const rawTask = body.task && typeof body.task === 'object' && !Array.isArray(body.task)
    ? (body.task as Record<string, unknown>)
    : Object.fromEntries(
      Object.entries(body).filter(([key]) => key !== 'update_fields' && key !== 'tasklist_id'),
    );

  const normalizedTask: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(rawTask)) {
    if (key === 'completed') {
      if (typeof value === 'boolean') {
        normalizedTask.completed_at = toCompletedAt(value);
      }
      continue;
    }
    if (SUPPORTED_TASK_UPDATE_FIELDS.has(key)) {
      normalizedTask[key] = value;
    }
  }

  const rawUpdateFields = Array.isArray(body.update_fields)
    ? body.update_fields.filter((value): value is string => typeof value === 'string')
    : deriveUpdateFields(rawTask);
  const updateFields = Array.from(new Set(
    rawUpdateFields.map((value) => value === 'completed' ? 'completed_at' : value)
      .filter((value) => SUPPORTED_TASK_UPDATE_FIELDS.has(value)),
  ));

  return {
    task: normalizedTask,
    updateFields,
  };
};

export const larkTaskWriteTool = createTool({
  id: TOOL_ID,
  description: 'Create or update a Lark Task using friendly fields with optional raw body overrides.',
  inputSchema: z.object({
    action: z.enum(['create', 'update', 'delete']),
    taskId: z.string().optional().describe('Optional task reference for updates or deletes. Accepts either the short task ID or the UUID-style task GUID. Falls back to the current task in this conversation.'),
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
      const authInput = {
        companyId,
        larkTenantKey: requestContext?.get('larkTenantKey') as string | undefined,
        appUserId: requestContext?.get('userId') as string | undefined,
        credentialMode,
      };
      const conversationKey = buildConversationKey(requestContext as any);
      const latestTask = conversationKey ? conversationMemoryStore.getLatestLarkTask(conversationKey) : null;
      const rememberTask = (task: { taskId: string; taskGuid?: string; summary?: string; status?: string; url?: string }) => {
        if (!conversationKey) {
          return;
        }
        conversationMemoryStore.addLarkTask(conversationKey, task);
      };
      const resolveTaskGuid = async (taskRef?: string): Promise<string | null> => {
        const trimmed = taskRef?.trim();
        if (!trimmed) {
          return latestTask?.taskGuid ?? null;
        }
        if (/^[0-9a-f]{8}-/i.test(trimmed)) {
          return trimmed;
        }
        if (latestTask && (latestTask.taskId === trimmed || latestTask.taskGuid === trimmed)) {
          return latestTask.taskGuid ?? null;
        }
        const lookup = await larkTasksService.listTasks({
          pageSize: 100,
          tasklistId,
          ...authInput,
        });
        const match = lookup.items.find((item) =>
          item.taskId === trimmed
          || item.taskGuid === trimmed
          || `${item.summary ?? ''}`.trim().toLowerCase() === trimmed.toLowerCase());
        if (match) {
          rememberTask(match);
        }
        return match?.taskGuid ?? null;
      };
      const requestTimeZone = (requestContext?.get('timeZone') as string | undefined)?.trim() || 'UTC';
      const baseBody = inputData.body ?? {
        ...(tasklistId ? { tasklist_id: tasklistId } : {}),
        ...(inputData.summary ? { summary: inputData.summary } : {}),
        ...(inputData.description ? { description: inputData.description } : {}),
        ...(inputData.dueTs ? { due: { timestamp: normalizeLarkTimestamp(inputData.dueTs, requestTimeZone) } } : {}),
        ...(inputData.completed !== undefined ? { completed_at: toCompletedAt(inputData.completed) } : {}),
        ...(inputData.assigneeIds && inputData.assigneeIds.length > 0 ? { assignee_ids: inputData.assigneeIds } : {}),
      };
      const normalizedUpdate = inputData.action === 'update'
        ? normalizeUpdateTaskPayload(baseBody)
        : null;
      const body = inputData.action === 'update'
        ? {
          task: normalizedUpdate?.task ?? {},
          update_fields: normalizedUpdate?.updateFields ?? [],
        }
        : baseBody;
      if (inputData.action === 'create' && !inputData.body && !inputData.summary) {
        return { answer: 'Lark task create failed: summary is required unless a raw body is provided.' };
      }
      if (inputData.action === 'update' && (!normalizedUpdate || normalizedUpdate.updateFields.length === 0)) {
        return { answer: 'Lark task update failed: at least one field to update is required.' };
      }
      const resolvedTaskGuid = inputData.action === 'create' ? null : await resolveTaskGuid(inputData.taskId);
      if ((inputData.action === 'update' || inputData.action === 'delete') && !resolvedTaskGuid) {
        return {
          answer: 'Lark task write failed: no current task was found in this conversation. Read or create the task first, or provide a task ID.',
        };
      }
      const commonInput = { body, ...authInput };

      const task = inputData.action === 'create'
        ? await larkTasksService.createTask(commonInput)
        : inputData.action === 'update'
          ? await larkTasksService.updateTask({
            ...commonInput,
            taskGuid: resolvedTaskGuid as string,
          })
          : null;

      if (inputData.action === 'delete') {
        await larkTasksService.deleteTask({
          taskGuid: resolvedTaskGuid as string,
          ...authInput,
        });
        const answer = `Deleted Lark task: ${inputData.taskId?.trim() || latestTask?.summary || latestTask?.taskId || resolvedTaskGuid}`;
        if (requestId) {
          emitActivityEvent(requestId, 'activity_done', {
            id: callId,
            name: TOOL_ID,
            label: 'Deleted Lark task',
            icon: 'check-square',
            externalRef: resolvedTaskGuid as string,
            resultSummary: answer,
          });
        }
        return { answer, deletedTaskGuid: resolvedTaskGuid as string };
      }

      if (task) {
        rememberTask(task);
      }

      const label = task?.summary ?? task?.taskId ?? resolvedTaskGuid ?? 'task';
      const answer = inputData.action === 'create'
        ? `Created Lark task: ${label}`
        : `Updated Lark task: ${label}`;

      if (requestId) {
        emitActivityEvent(requestId, 'activity_done', {
          id: callId,
          name: TOOL_ID,
          label: inputData.action === 'create' ? 'Created Lark task' : 'Updated Lark task',
          icon: 'check-square',
          externalRef: task?.taskGuid ?? task?.taskId ?? resolvedTaskGuid ?? undefined,
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
