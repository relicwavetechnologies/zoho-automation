import { createTool } from '@mastra/core/tools';
import { randomUUID } from 'crypto';
import { z } from 'zod';

import { larkTasksService } from '../../../channels/lark/lark-tasks.service';
import { LarkRuntimeClientError } from '../../../channels/lark/lark-runtime-client';
import { larkOperationalConfigRepository } from '../../../channels/lark/lark-operational-config.repository';
import { TOOL_REGISTRY_MAP } from '../../../tools/tool-registry';
import { emitActivityEvent } from './activity-bus';

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

export const larkTaskReadTool = createTool({
  id: TOOL_ID,
  description: 'List Lark Tasks for the current tenant or a specific tasklist.',
  inputSchema: z.object({
    pageSize: z.number().int().min(1).max(50).optional().default(10),
    pageToken: z.string().optional(),
    tasklistId: z.string().optional().describe('Optional tasklist ID. Falls back to company default when configured.'),
    query: z.string().optional().describe('Optional text filter applied client-side to the returned tasks'),
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
        label: 'Reading Lark tasks',
        icon: 'check-square',
      });
    }

    try {
      const companyId = requestContext?.get('companyId') as string | undefined;
      const defaults = companyId ? await larkOperationalConfigRepository.findByCompanyId(companyId) : null;
      const result = await larkTasksService.listTasks({
        pageSize: inputData.pageSize,
        pageToken: inputData.pageToken,
        tasklistId: inputData.tasklistId?.trim() || defaults?.defaultTasklistId,
        companyId,
        larkTenantKey: requestContext?.get('larkTenantKey') as string | undefined,
        appUserId: requestContext?.get('userId') as string | undefined,
        credentialMode: requestContext?.get('larkAuthMode') === 'user_linked' ? 'user_linked' : 'tenant',
      });

      const normalizedQuery = inputData.query?.trim().toLowerCase();
      const filteredItems = normalizedQuery
        ? result.items.filter((item) => `${item.taskId} ${item.summary ?? ''}`.toLowerCase().includes(normalizedQuery))
        : result.items;

      const answer = buildAnswer(filteredItems);
      if (requestId) {
        emitActivityEvent(requestId, 'activity_done', {
          id: callId,
          name: TOOL_ID,
          label: 'Read Lark tasks',
          icon: 'check-square',
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
