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
import { listLarkTaskAssignablePeople } from './lark-task-assignees';

const TOOL_ID = 'lark-task-read';

const buildAnswer = (items: Array<{ taskId: string; summary?: string; status?: string; completed?: boolean }>): string => {
  if (items.length === 0) {
    return 'No Lark tasks matched the request.';
  }

  const lines = items.slice(0, 6).map((item, index) => {
    const status = item.status ?? (item.completed === true ? 'completed' : item.completed === false ? 'open' : 'unknown');
    return `${index + 1}. ${item.summary ?? item.taskId} [${status}]`;
  });

  return `Found ${items.length} Lark task(s).\n\n${lines.join('\n')}`;
};

const isUserLinkedMode = (credentialMode: LarkCredentialMode): boolean => credentialMode === 'user_linked';

export const larkTaskReadTool = createTool({
  id: TOOL_ID,
  description: 'List Lark Tasks, fetch a specific task, or return the current task from this conversation.',
  inputSchema: z.object({
    action: z.enum(['listTasks', 'getTask', 'currentTask', 'listTasklists', 'listAssignableUsers']).optional().default('listTasks'),
    pageSize: z.number().int().min(1).max(50).optional().default(10),
    pageToken: z.string().optional(),
    tasklistId: z.string().optional().describe('Optional tasklist ID. Falls back to company default when configured.'),
    taskId: z.string().optional().describe('Optional task reference. Accepts either the short task ID or the UUID-style task GUID.'),
    currentTask: z.boolean().optional().default(false).describe('When true, prefer the latest task from this conversation, then fall back to the most recently updated visible task.'),
    query: z.string().optional().describe('Optional text filter applied client-side to the returned tasks'),
    listAssignableUsers: z.boolean().optional().default(false).describe('When true, return synced Lark teammates who can be used as task assignees.'),
    assigneeQuery: z.string().optional().describe('Optional name, email, or Lark ID filter applied when listing assignable teammates.'),
    completed: z.boolean().optional().describe('Optional server-side completed filter when supported.'),
    creatorId: z.string().optional().describe('Optional creator user ID filter when supported.'),
    userId: z.string().optional().describe('Optional user ID filter when supported.'),
    openId: z.string().optional().describe('Optional open ID filter when supported.'),
    summary: z.string().optional().describe('Optional summary/title filter when supported.'),
    dueAfter: z.string().optional().describe('Optional lower due-time bound.'),
    dueBefore: z.string().optional().describe('Optional upper due-time bound.'),
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
        label: 'Reading Lark tasks',
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
      const effectiveAction = inputData.listAssignableUsers
        ? 'listAssignableUsers'
        : inputData.currentTask
          ? 'currentTask'
          : inputData.taskId?.trim()
            ? 'getTask'
            : inputData.action;

      if (effectiveAction === 'listAssignableUsers') {
        if (!companyId) {
          const answer = 'No company context is available for Lark assignee lookup.';
          if (requestId) {
            emitActivityEvent(requestId, 'activity_done', {
              id: callId,
              name: TOOL_ID,
              label: 'Lark assignee lookup failed',
              icon: 'x-circle',
              resultSummary: answer,
            });
          }
          return { answer };
        }

        const people = await listLarkTaskAssignablePeople({
          companyId,
          appUserId: requestContext?.get('userId') as string | undefined,
          requestLarkOpenId: requestContext?.get('larkOpenId') as string | undefined,
        });
        const normalizedQuery = inputData.assigneeQuery?.trim().toLowerCase();
        const filtered = normalizedQuery
          ? people.filter((person) =>
            [
              person.displayName,
              person.email,
              person.externalUserId,
              person.larkOpenId,
              person.larkUserId,
            ].some((value) => value?.toLowerCase().includes(normalizedQuery)))
          : people;
        const lines = filtered.slice(0, 12).map((person, index) => {
          const label = person.displayName ?? person.email ?? person.externalUserId;
          const suffix = person.isCurrentUser ? ' (me)' : '';
          return `${index + 1}. ${label}${suffix} [${person.larkOpenId ?? person.externalUserId}]`;
        });
        const answer = filtered.length > 0
          ? `Found ${filtered.length} assignable Lark teammate(s).\n\n${lines.join('\n')}`
          : 'No assignable Lark teammates matched the request.';
        if (requestId) {
          emitActivityEvent(requestId, 'activity_done', {
            id: callId,
            name: TOOL_ID,
            label: 'Read Lark assignees',
            icon: 'check-square',
            externalRef: filtered[0]?.larkOpenId ?? filtered[0]?.externalUserId,
            resultSummary: answer,
          });
        }
        return {
          answer,
          people: filtered,
        };
      }
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
          return null;
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

      if (effectiveAction === 'listTasklists') {
        const result = await withTenantFallback((auth) => larkTasksService.listTasklists({
          pageSize: inputData.pageSize,
          pageToken: inputData.pageToken,
          ...auth,
        }));
        const normalizedQuery = inputData.query?.trim().toLowerCase();
        const items = normalizedQuery
          ? result.items.filter((item) => `${item.tasklistId} ${item.title ?? ''}`.toLowerCase().includes(normalizedQuery))
          : result.items;
        const answer = items.length > 0
          ? `Found ${items.length} Lark tasklist(s).\n\n${items.slice(0, 8).map((item, index) => `${index + 1}. ${item.title ?? item.tasklistId}`).join('\n')}`
          : 'No Lark tasklists matched the request.';
        if (requestId) {
          emitActivityEvent(requestId, 'activity_done', {
            id: callId,
            name: TOOL_ID,
            label: 'Read Lark tasklists',
            icon: 'check-square',
            externalRef: items[0]?.tasklistId,
            resultSummary: answer,
          });
        }
        return {
          answer,
          items,
          pageToken: result.pageToken,
          hasMore: result.hasMore,
        };
      }

      if (effectiveAction === 'currentTask') {
        if (latestTask?.taskGuid) {
          const task = await withTenantFallback((auth) => larkTasksService.getTask({
            taskGuid: latestTask.taskGuid as string,
            ...auth,
          }));
          rememberTask(task);
          const answer = buildAnswer([task]);
          if (requestId) {
            emitActivityEvent(requestId, 'activity_done', {
              id: callId,
              name: TOOL_ID,
              label: 'Read current Lark task',
              icon: 'check-square',
              externalRef: task.taskGuid ?? task.taskId,
              resultSummary: answer,
            });
          }
          return { answer, task };
        }

        const latestVisible = await withTenantFallback((auth) => larkTasksService.listTasks({
          pageSize: 25,
          tasklistId,
          ...auth,
        }));
        const sorted = [...latestVisible.items].sort((a, b) => Number(b.updatedAt ?? '0') - Number(a.updatedAt ?? '0'));
        const currentTask = sorted[0];
        if (!currentTask) {
          const answer = 'No current Lark task was found.';
          if (requestId) {
            emitActivityEvent(requestId, 'activity_done', {
              id: callId,
              name: TOOL_ID,
              label: 'No current Lark task',
              icon: 'check-square',
              resultSummary: answer,
            });
          }
          return { answer, items: [], hasMore: false };
        }
        rememberTask(currentTask);
        const answer = buildAnswer([currentTask]);
        if (requestId) {
          emitActivityEvent(requestId, 'activity_done', {
            id: callId,
            name: TOOL_ID,
            label: 'Read current Lark task',
            icon: 'check-square',
            externalRef: currentTask.taskGuid ?? currentTask.taskId,
            resultSummary: answer,
          });
        }
        return { answer, task: currentTask };
      }

      if (effectiveAction === 'getTask' && inputData.taskId?.trim()) {
        const taskGuid = await resolveTaskGuid(inputData.taskId);
        if (!taskGuid) {
          const answer = `No Lark task matched "${inputData.taskId.trim()}".`;
          if (requestId) {
            emitActivityEvent(requestId, 'activity_done', {
              id: callId,
              name: TOOL_ID,
              label: 'Lark task not found',
              icon: 'x-circle',
              resultSummary: answer,
            });
          }
          return { answer, items: [], hasMore: false };
        }
        const task = await withTenantFallback((auth) => larkTasksService.getTask({
          taskGuid,
          ...auth,
        }));
        rememberTask(task);
        const answer = buildAnswer([task]);
        if (requestId) {
          emitActivityEvent(requestId, 'activity_done', {
            id: callId,
            name: TOOL_ID,
            label: 'Read Lark task',
            icon: 'check-square',
            externalRef: task.taskGuid ?? task.taskId,
            resultSummary: answer,
          });
        }
        return { answer, task };
      }

      const result = await withTenantFallback((auth) => larkTasksService.listTasks({
        pageSize: inputData.pageSize,
        pageToken: inputData.pageToken,
        tasklistId,
        creatorId: inputData.creatorId?.trim(),
        userId: inputData.userId?.trim(),
        openId: inputData.openId?.trim(),
        summary: inputData.summary?.trim(),
        completed: inputData.completed,
        dueAfter: inputData.dueAfter?.trim(),
        dueBefore: inputData.dueBefore?.trim(),
        ...auth,
      }));

      const normalizedQuery = inputData.query?.trim().toLowerCase();
      const filteredItems = normalizedQuery
        ? result.items.filter((item) => `${item.taskId} ${item.summary ?? ''}`.toLowerCase().includes(normalizedQuery))
        : result.items;

      for (const item of filteredItems) {
        rememberTask(item);
      }

      const answer = buildAnswer(filteredItems);
      if (requestId) {
        emitActivityEvent(requestId, 'activity_done', {
          id: callId,
          name: TOOL_ID,
          label: 'Read Lark tasks',
          icon: 'check-square',
          externalRef: filteredItems[0]?.taskGuid ?? filteredItems[0]?.taskId,
          resultSummary: answer,
        });
      }

      return {
        answer,
        items: filteredItems,
        pageToken: result.pageToken,
        hasMore: result.hasMore,
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
          label: 'Lark task read failed',
          icon: 'x-circle',
          resultSummary: message,
        });
      }

      return { answer: `Lark task read failed: ${message}` };
    }
  },
});
