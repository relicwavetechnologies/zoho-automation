import { createTool } from '@mastra/core/tools';
import { randomUUID } from 'crypto';
import { z } from 'zod';

import { larkCalendarService } from '../../../channels/lark/lark-calendar.service';
import { LarkRuntimeClientError, type LarkCredentialMode } from '../../../channels/lark/lark-runtime-client';
import { larkOperationalConfigRepository } from '../../../channels/lark/lark-operational-config.repository';
import { conversationMemoryStore } from '../../../state/conversation';
import { TOOL_REGISTRY_MAP } from '../../../tools/tool-registry';
import { emitActivityEvent } from './activity-bus';
import { buildConversationKey } from './conversation-key';
import { normalizeLarkTimestamp } from './lark-time';

const TOOL_ID = 'lark-calendar-write';

const buildCalendarChoiceAnswer = (
  items: Array<{ calendarId: string; summary?: string; description?: string; type?: string }>,
): string => {
  if (items.length === 0) {
    return 'Lark calendar write failed: no default calendar is configured, no primary calendar could be resolved, and no accessible calendars were found.';
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

export const larkCalendarWriteTool = createTool({
  id: TOOL_ID,
  description: 'Create, update, or delete a Lark calendar event with friendly fields or an explicit raw body.',
  inputSchema: z.object({
    action: z.enum(['create', 'update', 'delete']),
    calendarId: z.string().optional().describe('Optional calendar ID. Falls back to company default when configured.'),
    eventId: z.string().optional().describe('Optional explicit event ID. Falls back to the latest event from this conversation for updates.'),
    summary: z.string().optional().describe('Event title'),
    description: z.string().optional().describe('Optional event description'),
    startTime: z.string().optional().describe('Event start timestamp or ISO string'),
    endTime: z.string().optional().describe('Event end timestamp or ISO string'),
    location: z.record(z.unknown()).optional().describe('Optional event location payload'),
    recurrence: z.record(z.unknown()).optional().describe('Optional recurrence rule payload'),
    reminders: z.array(z.record(z.unknown())).optional().describe('Optional reminders payload'),
    visibility: z.string().optional().describe('Optional visibility value'),
    freeBusyStatus: z.string().optional().describe('Optional free/busy status'),
    color: z.number().int().optional().describe('Optional calendar color index'),
    meetingSettings: z.record(z.unknown()).optional().describe('Optional meeting settings payload'),
    attendees: z.array(z.record(z.unknown())).optional().describe('Optional attendee payload list'),
    body: z.record(z.unknown()).optional().describe('Optional raw event payload override'),
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
        label:
          inputData.action === 'create'
            ? 'Creating Lark calendar event'
            : inputData.action === 'update'
              ? 'Updating Lark calendar event'
              : 'Deleting Lark calendar event',
        icon: 'calendar-plus',
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
              answer: 'Lark calendar write failed: no default calendar is configured, and both primary-calendar resolution and calendar listing failed. Please provide a calendar ID explicitly.',
            };
          }
        }
      }

      const conversationKey = buildConversationKey(requestContext as any);
      const latestEvent = conversationKey ? conversationMemoryStore.getLatestLarkCalendarEvent(conversationKey) : null;
      const resolvedEventId = inputData.eventId?.trim() || latestEvent?.eventId;
      if ((inputData.action === 'update' || inputData.action === 'delete') && !resolvedEventId) {
        return {
          answer: `Lark calendar ${inputData.action} failed: no current event was found in this conversation. Read or create the event first, or provide an event ID.`,
        };
      }
      if (!calendarId && latestEvent?.calendarId) {
        calendarId = latestEvent.calendarId;
      }

      if (inputData.action === 'create' && !inputData.body && (!inputData.summary || !inputData.startTime || !inputData.endTime)) {
        return { answer: 'Lark calendar create failed: summary, startTime, and endTime are required unless a raw body is provided.' };
      }

      const requestTimeZone = (requestContext?.get('timeZone') as string | undefined)?.trim() || 'UTC';
      const startTimestamp = normalizeLarkTimestamp(inputData.startTime, requestTimeZone);
      const endTimestamp = normalizeLarkTimestamp(inputData.endTime, requestTimeZone);
      const credentialMode: LarkCredentialMode =
        requestContext?.get('larkAuthMode') === 'user_linked' ? 'user_linked' : 'tenant';
      const body = inputData.body ?? {
        ...(inputData.summary ? { summary: inputData.summary } : {}),
        ...(inputData.description ? { description: inputData.description } : {}),
        ...(startTimestamp ? { start_time: { timestamp: startTimestamp } } : {}),
        ...(endTimestamp ? { end_time: { timestamp: endTimestamp } } : {}),
        ...(inputData.location ? { location: inputData.location } : {}),
        ...(inputData.recurrence ? { recurrence: inputData.recurrence } : {}),
        ...(inputData.reminders ? { reminders: inputData.reminders } : {}),
        ...(inputData.visibility ? { visibility: inputData.visibility } : {}),
        ...(inputData.freeBusyStatus ? { free_busy_status: inputData.freeBusyStatus } : {}),
        ...(inputData.color !== undefined ? { color: inputData.color } : {}),
        ...(inputData.meetingSettings ? { meeting_settings: inputData.meetingSettings } : {}),
        ...(inputData.attendees ? { attendees: inputData.attendees } : {}),
      };

      const commonInput = {
        calendarId,
        body,
        companyId,
        larkTenantKey: requestContext?.get('larkTenantKey') as string | undefined,
        appUserId: requestContext?.get('userId') as string | undefined,
        credentialMode,
      };

      const event = inputData.action === 'create'
        ? await larkCalendarService.createEvent(commonInput)
        : inputData.action === 'update'
          ? await larkCalendarService.updateEvent({
            ...commonInput,
            eventId: resolvedEventId as string,
          })
          : null;

      if (inputData.action === 'delete') {
        await larkCalendarService.deleteEvent({
          calendarId,
          eventId: resolvedEventId as string,
          companyId,
          larkTenantKey: requestContext?.get('larkTenantKey') as string | undefined,
          appUserId: requestContext?.get('userId') as string | undefined,
          credentialMode,
        });
        const answer = `Deleted Lark calendar event: ${latestEvent?.summary || resolvedEventId}`;
        if (requestId) {
          emitActivityEvent(requestId, 'activity_done', {
            id: callId,
            name: TOOL_ID,
            label: 'Deleted Lark calendar event',
            icon: 'calendar-plus',
            externalRef: resolvedEventId as string,
            resultSummary: answer,
          });
        }
        return { answer, deletedEventId: resolvedEventId as string };
      }

      if (!event) {
        return { answer: 'Lark calendar write failed: no event payload was returned.' };
      }

      if (conversationKey) {
        conversationMemoryStore.addLarkCalendarEvent(conversationKey, {
          eventId: event.eventId,
          calendarId,
          summary: event.summary ?? inputData.summary,
          startTime: event.startTime ?? startTimestamp,
          endTime: event.endTime ?? endTimestamp,
          url: event.url,
        });
      }

      const label = event.summary ?? event.eventId;
      const answer = inputData.action === 'create'
        ? `Created Lark calendar event: ${label}`
        : `Updated Lark calendar event: ${label}`;

      if (requestId) {
        emitActivityEvent(requestId, 'activity_done', {
          id: callId,
          name: TOOL_ID,
          label: inputData.action === 'create' ? 'Created Lark calendar event' : 'Updated Lark calendar event',
          icon: 'calendar-plus',
          externalRef: event.eventId,
          resultSummary: answer,
        });
      }

      return { answer, event };
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
          label: 'Lark calendar write failed',
          icon: 'x-circle',
          resultSummary: message,
        });
      }

      return { answer: `Lark calendar write failed: ${message}` };
    }
  },
});
