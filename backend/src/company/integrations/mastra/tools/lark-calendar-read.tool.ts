import { createTool } from '@mastra/core/tools';
import { randomUUID } from 'crypto';
import { z } from 'zod';

import { larkCalendarService } from '../../../channels/lark/lark-calendar.service';
import { LarkRuntimeClientError } from '../../../channels/lark/lark-runtime-client';
import { larkOperationalConfigRepository } from '../../../channels/lark/lark-operational-config.repository';
import { conversationMemoryStore } from '../../../state/conversation';
import { TOOL_REGISTRY_MAP } from '../../../tools/tool-registry';
import { emitActivityEvent } from './activity-bus';
import { buildConversationKey } from './conversation-key';
import { normalizeLarkTimestamp } from './lark-time';

const TOOL_ID = 'lark-calendar-read';

const buildAnswer = (
  items: Array<{ eventId: string; summary?: string; startTime?: string; endTime?: string }>,
): string => {
  if (items.length === 0) {
    return 'No Lark calendar events matched the request.';
  }

  const lines = items.slice(0, 5).map((item, index) =>
    `${index + 1}. ${item.summary ?? item.eventId}${item.startTime ? ` (${item.startTime}${item.endTime ? ` → ${item.endTime}` : ''})` : ''}`);

  return `Found ${items.length} Lark calendar event(s).\n\n${lines.join('\n')}`;
};

const buildCalendarChoiceAnswer = (
  items: Array<{ calendarId: string; summary?: string; description?: string; type?: string }>,
): string => {
  if (items.length === 0) {
    return 'Lark calendar read failed: no default calendar is configured, no primary calendar could be resolved, and no accessible calendars were found.';
  }

  const lines = items.slice(0, 8).map((item, index) => {
    const title = item.summary?.trim() || item.calendarId;
    const typeLabel = item.type ? ` [${item.type}]` : '';
    const description = item.description?.trim() ? ` - ${item.description.trim()}` : '';
    return `${index + 1}. ${title}${typeLabel}${description}`;
  });

  return [
    'No default Lark calendar is configured.',
    'Available calendars:',
    ...lines,
    'Ask the user which calendar name to use.',
  ].join('\n');
};

export const larkCalendarReadTool = createTool({
  id: TOOL_ID,
  description: 'List events from a Lark Calendar. Falls back to the company default calendar when configured.',
  inputSchema: z.object({
    calendarId: z.string().optional().describe('Optional calendar ID. Falls back to company default when configured.'),
    query: z.string().optional().describe('Optional text filter applied client-side to returned events'),
    startTime: z.string().optional().describe('Optional lower time bound'),
    endTime: z.string().optional().describe('Optional upper time bound'),
    pageSize: z.number().int().min(50).max(200).optional().default(50),
    pageToken: z.string().optional().describe('Optional page token for pagination'),
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
        label: 'Reading Lark calendar',
        icon: 'calendar-days',
      });
    }

    try {
      const companyId = requestContext?.get('companyId') as string | undefined;
      const defaults = companyId ? await larkOperationalConfigRepository.findByCompanyId(companyId) : null;
      let calendarId = inputData.calendarId?.trim() || defaults?.defaultCalendarId;
      if (!calendarId) {
        try {
          const primaryCalendar = await larkCalendarService.getPrimaryCalendar({
            companyId,
            larkTenantKey: requestContext?.get('larkTenantKey') as string | undefined,
            appUserId: requestContext?.get('userId') as string | undefined,
            credentialMode: requestContext?.get('larkAuthMode') === 'user_linked' ? 'user_linked' : 'tenant',
          });
          calendarId = primaryCalendar.calendarId;
        } catch {
          try {
            const calendars = await larkCalendarService.listCalendars({
              companyId,
              larkTenantKey: requestContext?.get('larkTenantKey') as string | undefined,
              appUserId: requestContext?.get('userId') as string | undefined,
              credentialMode: requestContext?.get('larkAuthMode') === 'user_linked' ? 'user_linked' : 'tenant',
              pageSize: 50,
            });
            return {
              answer: buildCalendarChoiceAnswer(calendars.items.map((item) => ({
                calendarId: item.calendarId,
                summary: item.summary,
                description: item.description,
                type: (item.raw.type as string | undefined),
              }))),
              calendars: calendars.items,
            };
          } catch {
            return {
              answer: 'Lark calendar read failed: no default calendar is configured, and both primary-calendar resolution and calendar listing failed. Please provide a calendar ID explicitly.',
            };
          }
        }
      }

      const requestTimeZone = (requestContext?.get('timeZone') as string | undefined)?.trim() || 'UTC';
      const result = await larkCalendarService.listEvents({
        calendarId,
        pageSize: inputData.pageSize,
        pageToken: inputData.pageToken,
        startTime: normalizeLarkTimestamp(inputData.startTime, requestTimeZone),
        endTime: normalizeLarkTimestamp(inputData.endTime, requestTimeZone),
        companyId,
        larkTenantKey: requestContext?.get('larkTenantKey') as string | undefined,
        appUserId: requestContext?.get('userId') as string | undefined,
        credentialMode: requestContext?.get('larkAuthMode') === 'user_linked' ? 'user_linked' : 'tenant',
      });

      const normalizedQuery = inputData.query?.trim().toLowerCase();
      const filteredItems = normalizedQuery
        ? result.items.filter((item) => {
          const haystack = `${item.eventId} ${item.summary ?? ''} ${item.description ?? ''}`.toLowerCase();
          return haystack.includes(normalizedQuery);
        })
        : result.items;

      const conversationKey = buildConversationKey(requestContext as any);
      if (conversationKey) {
        for (const item of filteredItems) {
          conversationMemoryStore.addLarkCalendarEvent(conversationKey, {
            eventId: item.eventId,
            calendarId,
            summary: item.summary,
            startTime: item.startTime,
            endTime: item.endTime,
            url: item.url,
          });
        }
      }

      const answer = buildAnswer(filteredItems);
      if (requestId) {
        emitActivityEvent(requestId, 'activity_done', {
          id: callId,
          name: TOOL_ID,
          label: 'Read Lark calendar',
          icon: 'calendar-days',
          resultSummary: answer,
        });
      }

      return {
        answer,
        items: filteredItems,
        pageToken: result.pageToken,
        hasMore: result.hasMore,
        total: filteredItems.length,
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
          label: 'Lark calendar read failed',
          icon: 'x-circle',
          resultSummary: message,
        });
      }

      return { answer: `Lark calendar read failed: ${message}` };
    }
  },
});
