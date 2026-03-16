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
import { resolveLarkTaskAssignees } from './lark-task-assignees';
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

const isUserLinkedMode = (credentialMode: LarkCredentialMode): boolean => credentialMode === 'user_linked';

const extractConfirmedAssigneeIds = (raw: Record<string, unknown>): string[] => {
  const candidateArrays = [
    raw.members,
    raw.assignees,
    raw.member_list,
  ].filter(Array.isArray) as Array<Array<Record<string, unknown>>>;

  const ids = candidateArrays.flatMap((items) => items
    .map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return null;
      }
      const directId = item.id;
      const userId = item.user_id;
      const openId = item.open_id;
      const memberId = item.member_id;
      return [directId, userId, openId, memberId].find((value) => typeof value === 'string' && value.trim().length > 0) ?? null;
    })
    .filter((value): value is string => Boolean(value)));

  return Array.from(new Set(ids));
};

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
    startTs: z.string().optional().describe('Optional start timestamp or ISO string'),
    dueTs: z.string().optional().describe('Optional due timestamp or ISO string'),
    completed: z.boolean().optional().describe('Optional completed state'),
    repeatRule: z.record(z.unknown()).optional().describe('Optional repeat rule payload'),
    customFields: z.array(z.record(z.unknown())).optional().describe('Optional typed custom fields payload'),
    extra: z.record(z.unknown()).optional().describe('Optional extra metadata payload'),
    isMilestone: z.boolean().optional().describe('Optional milestone flag'),
    mode: z.number().int().optional().describe('Optional task mode when supported by Lark'),
    assigneeIds: z.array(z.string().min(1)).optional().describe('Optional Lark assignee IDs'),
    assigneeNames: z.array(z.string().min(1)).optional().describe('Optional teammate names, emails, or Lark IDs to assign on task creation.'),
    assignToMe: z.boolean().optional().describe('When true, assign the created task to the current linked Lark user.'),
    body: z.record(z.unknown()).optional().describe('Optional raw task payload override'),
  }),
  execute: async (inputData, context) => {
    const requestContext = context?.requestContext;
    const allowedToolIds = requestContext?.get('allowedToolIds') as string[] | undefined;
    if (allowedToolIds !== undefined && !allowedToolIds.includes(TOOL_ID) && !allowedToolIds.includes('lark-task-agent')) {
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
      const tenantAuthInput = {
        ...authInput,
        credentialMode: 'tenant' as LarkCredentialMode,
      };
      const withTenantFallback = async <T>(fn: (auth: typeof authInput) => Promise<T>): Promise<T> => {
        try {
          return await fn(authInput);
        } catch (error) {
          if (!isUserLinkedMode(credentialMode) || !(error instanceof LarkRuntimeClientError)) {
            throw error;
          }
          return fn(tenantAuthInput);
        }
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
        const lookup = await withTenantFallback((auth) => larkTasksService.listTasks({
          pageSize: 100,
          tasklistId,
          ...auth,
        }));
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
      const resolvedAssignees = (inputData.assignToMe || (inputData.assigneeNames?.length ?? 0) > 0)
        ? await resolveLarkTaskAssignees({
          companyId: companyId ?? '',
          appUserId: requestContext?.get('userId') as string | undefined,
          requestLarkOpenId: requestContext?.get('larkOpenId') as string | undefined,
          assigneeNames: inputData.assigneeNames,
          assignToMe: inputData.assignToMe,
        })
        : null;
      if (resolvedAssignees?.unresolved.length) {
        return {
          answer: `Lark task write failed: no assignable teammate matched ${resolvedAssignees.unresolved.map((value) => `"${value}"`).join(', ')}.`,
        };
      }
      if (resolvedAssignees?.ambiguous.length) {
        const first = resolvedAssignees.ambiguous[0];
        const options = first.matches
          .map((person) => person.displayName ?? person.email ?? person.externalUserId)
          .join(', ');
        return {
          answer: `Lark task write failed: "${first.query}" matched multiple teammates (${options}). Please be more specific.`,
        };
      }
      const resolvedMembers = resolvedAssignees?.people.map((person) => ({
        id: person.larkOpenId ?? person.externalUserId,
        role: 'assignee',
        type: 'user',
      }));
      if (inputData.action === 'update' && (resolvedMembers?.length || (inputData.assigneeIds?.length ?? 0) > 0)) {
        return {
          answer: 'Lark task write failed: assignee changes for an existing task are not supported by the current task update route. Create the task with assignees, or provide a raw API path once we add the dedicated member endpoint.',
        };
      }
      const baseBody = inputData.body ?? {
        ...(tasklistId ? { tasklist_id: tasklistId } : {}),
        ...(inputData.summary ? { summary: inputData.summary } : {}),
        ...(inputData.description ? { description: inputData.description } : {}),
        ...(inputData.startTs ? { start: { timestamp: normalizeLarkTimestamp(inputData.startTs, requestTimeZone) } } : {}),
        ...(inputData.dueTs ? { due: { timestamp: normalizeLarkTimestamp(inputData.dueTs, requestTimeZone) } } : {}),
        ...(inputData.completed !== undefined ? { completed_at: toCompletedAt(inputData.completed) } : {}),
        ...(inputData.repeatRule ? { repeat_rule: inputData.repeatRule } : {}),
        ...(inputData.customFields ? { custom_fields: inputData.customFields } : {}),
        ...(inputData.extra ? { extra: inputData.extra } : {}),
        ...(inputData.isMilestone !== undefined ? { is_milestone: inputData.isMilestone } : {}),
        ...(inputData.mode !== undefined ? { mode: inputData.mode } : {}),
        ...(resolvedMembers && resolvedMembers.length > 0 ? { members: resolvedMembers } : {}),
        ...(resolvedMembers?.length ? {} : inputData.assigneeIds && inputData.assigneeIds.length > 0 ? { assignee_ids: inputData.assigneeIds } : {}),
      };
      const mergedBody = inputData.body && resolvedMembers?.length
        ? {
          ...inputData.body,
          ...(inputData.action === 'create' && !(inputData.body as Record<string, unknown>).members ? { members: resolvedMembers } : {}),
        }
        : baseBody;
      const normalizedUpdate = inputData.action === 'update'
        ? normalizeUpdateTaskPayload(mergedBody)
        : null;
      const body = inputData.action === 'update'
        ? {
          task: normalizedUpdate?.task ?? {},
          update_fields: normalizedUpdate?.updateFields ?? [],
        }
        : mergedBody;
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
          ? await withTenantFallback((auth) => larkTasksService.updateTask({
            body,
            ...auth,
            taskGuid: resolvedTaskGuid as string,
          }))
          : null;

      if (inputData.action === 'delete') {
        await withTenantFallback((auth) => larkTasksService.deleteTask({
          taskGuid: resolvedTaskGuid as string,
          ...auth,
        }));
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
      const requestedAssigneeLabels = resolvedAssignees?.people.map((person) =>
        person.displayName ?? person.email ?? person.externalUserId,
      ) ?? [];
      const requestedAssigneeIds = resolvedAssignees?.people.map((person) =>
        person.larkOpenId ?? person.externalUserId,
      ) ?? [];
      const confirmedAssigneeIds = task ? extractConfirmedAssigneeIds(task.raw) : [];
      const assignmentConfirmed = requestedAssigneeIds.length === 0
        || requestedAssigneeIds.every((id) => confirmedAssigneeIds.includes(id));
      const assigneeSummary = requestedAssigneeLabels.length > 0
        ? requestedAssigneeLabels.join(', ')
        : null;
      const answer = inputData.action === 'create'
        ? requestedAssigneeLabels.length > 0
          ? assignmentConfirmed
            ? `Created Lark task: ${label}, assigned to ${assigneeSummary}.`
            : `Created Lark task: ${label}, but Lark did not confirm assignment to ${assigneeSummary}.`
          : `Created Lark task: ${label}`
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
