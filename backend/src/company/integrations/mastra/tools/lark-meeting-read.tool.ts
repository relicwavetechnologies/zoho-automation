import { createTool } from '@mastra/core/tools';
import { randomUUID } from 'crypto';
import { z } from 'zod';

import { larkMeetingsService } from '../../../channels/lark/lark-meetings.service';
import { larkMinutesService } from '../../../channels/lark/lark-minutes.service';
import { LarkRuntimeClientError, type LarkCredentialMode } from '../../../channels/lark/lark-runtime-client';
import { TOOL_REGISTRY_MAP } from '../../../tools/tool-registry';
import { emitActivityEvent } from './activity-bus';
import { normalizeLarkTimestamp } from './lark-time';

const TOOL_ID = 'lark-meeting-read';

const extractMeetingId = (value?: string): string | undefined => {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
    return trimmed || undefined;
  }
  try {
    const url = new URL(trimmed);
    return url.searchParams.get('meeting_id')?.trim() || undefined;
  } catch {
    return undefined;
  }
};
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const buildMeetingsAnswer = (items: Array<{ meetingId: string; topic?: string; startTime?: string }>): string => {
  if (items.length === 0) {
    return 'No Lark meetings matched the request.';
  }

  const lines = items.slice(0, 5).map((item, index) =>
    `${index + 1}. ${item.topic ?? item.meetingId}${item.startTime ? ` (${item.startTime})` : ''}`);

  return `Found ${items.length} Lark meeting(s).\n\n${lines.join('\n')}`;
};

const resolveMeetingTimeRange = (
  input: {
    startTime?: string;
    endTime?: string;
    timeZone: string;
  },
): { startTime?: string; endTime?: string } => {
  const start = input.startTime?.trim();
  const end = input.endTime?.trim();

  if (start && !end && DATE_ONLY_PATTERN.test(start)) {
    return {
      startTime: normalizeLarkTimestamp(`${start}T00:00:00`, input.timeZone),
      endTime: normalizeLarkTimestamp(`${start}T23:59:59`, input.timeZone),
    };
  }

  if (start && end && DATE_ONLY_PATTERN.test(start) && DATE_ONLY_PATTERN.test(end) && start === end) {
    return {
      startTime: normalizeLarkTimestamp(`${start}T00:00:00`, input.timeZone),
      endTime: normalizeLarkTimestamp(`${end}T23:59:59`, input.timeZone),
    };
  }

  return {
    startTime: normalizeLarkTimestamp(start, input.timeZone),
    endTime: normalizeLarkTimestamp(end, input.timeZone),
  };
};

export const larkMeetingReadTool = createTool({
  id: TOOL_ID,
  description: 'List Lark meetings, fetch one meeting by ID, or fetch a Lark minute by token or URL.',
  inputSchema: z.object({
    action: z.enum(['list', 'getMeeting', 'getMinute']),
    meetingId: z.string().optional().describe('Required for getMeeting'),
    meetingIdOrUrl: z.string().optional().describe('Optional meeting ID or meeting URL for getMeeting'),
    minuteTokenOrUrl: z.string().optional().describe('Required for getMinute'),
    startTime: z.string().optional().describe('Optional lower time bound for meeting list'),
    endTime: z.string().optional().describe('Optional upper time bound for meeting list'),
    query: z.string().optional().describe('Optional topic/status query applied client-side to listed meetings'),
    pageSize: z.number().int().min(1).max(50).optional().default(10),
    pageToken: z.string().optional().describe('Optional page token for pagination'),
  }),
  execute: async (inputData, context) => {
    const requestContext = context?.requestContext;
    const allowedToolIds = requestContext?.get('allowedToolIds') as string[] | undefined;
    if (allowedToolIds !== undefined && !allowedToolIds.includes(TOOL_ID) && !allowedToolIds.includes('lark-meeting-agent')) {
      const name = TOOL_REGISTRY_MAP.get(TOOL_ID)?.name ?? TOOL_ID;
      return { answer: `Access to "${name}" is not permitted for your role. Please contact your admin.` };
    }

    if (inputData.action === 'getMeeting' && !inputData.meetingId && !inputData.meetingIdOrUrl) {
      return { answer: 'Lark meeting read failed: meetingId is required for getMeeting.' };
    }
    if (inputData.action === 'getMinute' && !inputData.minuteTokenOrUrl) {
      return { answer: 'Lark meeting read failed: minuteTokenOrUrl is required for getMinute.' };
    }

    const requestId = requestContext?.get('requestId') as string | undefined;
    const callId = randomUUID();
    if (requestId) {
      emitActivityEvent(requestId, 'activity', {
        id: callId,
        name: TOOL_ID,
        label: 'Reading Lark meetings',
        icon: 'video',
      });
    }

    try {
      const credentialMode: LarkCredentialMode =
        requestContext?.get('larkAuthMode') === 'user_linked' ? 'user_linked' : 'tenant';
      const authInput = {
        companyId: requestContext?.get('companyId') as string | undefined,
        larkTenantKey: requestContext?.get('larkTenantKey') as string | undefined,
        appUserId: requestContext?.get('userId') as string | undefined,
        credentialMode,
      };

      if (inputData.action === 'list') {
        const requestTimeZone = (requestContext?.get('timeZone') as string | undefined)?.trim() || 'UTC';
        const range = resolveMeetingTimeRange({
          startTime: inputData.startTime,
          endTime: inputData.endTime,
          timeZone: requestTimeZone,
        });
        const result = await larkMeetingsService.listMeetings({
          ...authInput,
          pageSize: inputData.pageSize,
          pageToken: inputData.pageToken,
          startTime: range.startTime,
          endTime: range.endTime,
        });
        const normalizedQuery = inputData.query?.trim().toLowerCase();
        const items = normalizedQuery
          ? result.items.filter((item) => `${item.meetingId} ${item.topic ?? ''} ${item.status ?? ''}`.toLowerCase().includes(normalizedQuery))
          : result.items;
        const answer = buildMeetingsAnswer(items);
        if (requestId) {
          emitActivityEvent(requestId, 'activity_done', {
            id: callId,
            name: TOOL_ID,
            label: 'Read Lark meetings',
            icon: 'video',
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
      }

      if (inputData.action === 'getMeeting') {
        const resolvedMeetingId = extractMeetingId(inputData.meetingIdOrUrl) ?? inputData.meetingId;
        const meeting = await larkMeetingsService.getMeeting({
          ...authInput,
          meetingId: resolvedMeetingId as string,
        });
        const answer = `Fetched Lark meeting: ${meeting.topic ?? meeting.meetingId}`;
        if (requestId) {
          emitActivityEvent(requestId, 'activity_done', {
            id: callId,
            name: TOOL_ID,
            label: 'Fetched Lark meeting',
            icon: 'video',
            resultSummary: answer,
          });
        }
        return { answer, meeting };
      }

      const minute = await larkMinutesService.getMinute({
        ...authInput,
        minuteTokenOrUrl: inputData.minuteTokenOrUrl as string,
      });
      const answer = `Fetched Lark minute: ${minute.title ?? minute.minuteToken}`;
      if (requestId) {
        emitActivityEvent(requestId, 'activity_done', {
          id: callId,
          name: TOOL_ID,
          label: 'Fetched Lark minute',
          icon: 'video',
          resultSummary: answer,
        });
      }
      return { answer, minute };
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
          label: 'Lark meeting read failed',
          icon: 'x-circle',
          resultSummary: message,
        });
      }

      return { answer: `Lark meeting read failed: ${message}` };
    }
  },
});
