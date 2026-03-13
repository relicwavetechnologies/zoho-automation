import { createTool } from '@mastra/core/tools';
import { randomUUID } from 'crypto';
import { z } from 'zod';

import { larkCalendarService } from '../../../channels/lark/lark-calendar.service';
import { LarkRuntimeClientError } from '../../../channels/lark/lark-runtime-client';
import { TOOL_REGISTRY_MAP } from '../../../tools/tool-registry';
import { emitActivityEvent } from './activity-bus';

const TOOL_ID = 'lark-calendar-list';

const buildAnswer = (
  items: Array<{ calendarId: string; summary?: string; description?: string }>,
): string => {
  if (items.length === 0) {
    return 'No Lark calendars are available for this account.';
  }

  const lines = items.slice(0, 10).map((item, index) => {
    const title = item.summary?.trim() || item.calendarId;
    const description = item.description?.trim() ? ` - ${item.description.trim()}` : '';
    return `${index + 1}. ${title} (${item.calendarId})${description}`;
  });

  return `Available Lark calendars:\n\n${lines.join('\n')}`;
};

export const larkCalendarListTool = createTool({
  id: TOOL_ID,
  description: 'List available Lark calendars for the current account so calendar names can be resolved to calendar IDs.',
  inputSchema: z.object({
    query: z.string().optional().describe('Optional case-insensitive calendar name filter'),
    pageSize: z.number().int().min(50).max(200).optional().default(50),
    pageToken: z.string().optional().describe('Optional page token for pagination'),
  }),
  execute: async (inputData, context) => {
    const requestContext = context?.requestContext;
    const allowedToolIds = requestContext?.get('allowedToolIds') as string[] | undefined;
    if (allowedToolIds !== undefined && !allowedToolIds.includes(TOOL_ID) && !allowedToolIds.includes('lark-calendar-agent')) {
      const name = TOOL_REGISTRY_MAP.get(TOOL_ID)?.name ?? TOOL_ID;
      return { answer: `Access to "${name}" is not permitted for your role. Please contact your admin.` };
    }

    const requestId = requestContext?.get('requestId') as string | undefined;
    const callId = randomUUID();
    if (requestId) {
      emitActivityEvent(requestId, 'activity', {
        id: callId,
        name: TOOL_ID,
        label: 'Listing Lark calendars',
        icon: 'calendar-days',
      });
    }

    try {
      const result = await larkCalendarService.listCalendars({
        pageSize: inputData.pageSize,
        pageToken: inputData.pageToken,
        companyId: requestContext?.get('companyId') as string | undefined,
        larkTenantKey: requestContext?.get('larkTenantKey') as string | undefined,
        appUserId: requestContext?.get('userId') as string | undefined,
        credentialMode: requestContext?.get('larkAuthMode') === 'user_linked' ? 'user_linked' : 'tenant',
      });

      const normalizedQuery = inputData.query?.trim().toLowerCase();
      const items = normalizedQuery
        ? result.items.filter((item) => {
          const haystack = `${item.summary ?? ''} ${item.description ?? ''} ${item.calendarId}`.toLowerCase();
          return haystack.includes(normalizedQuery);
        })
        : result.items;

      const answer = buildAnswer(items);
      if (requestId) {
        emitActivityEvent(requestId, 'activity_done', {
          id: callId,
          name: TOOL_ID,
          label: 'Listed Lark calendars',
          icon: 'calendar-days',
          resultSummary: answer,
        });
      }

      return {
        answer,
        items,
        pageToken: result.pageToken,
        hasMore: result.hasMore,
        total: items.length,
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
          label: 'Lark calendar listing failed',
          icon: 'x-circle',
          resultSummary: message,
        });
      }

      return { answer: `Lark calendar listing failed: ${message}` };
    }
  },
});
