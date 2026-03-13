import { createTool } from '@mastra/core/tools';
import { randomUUID } from 'crypto';
import { z } from 'zod';

import { larkMeetingsService } from '../../../channels/lark/lark-meetings.service';
import { larkMinutesService } from '../../../channels/lark/lark-minutes.service';
import { LarkRuntimeClientError, type LarkCredentialMode } from '../../../channels/lark/lark-runtime-client';
import { TOOL_REGISTRY_MAP } from '../../../tools/tool-registry';
import { emitActivityEvent } from './activity-bus';

const TOOL_ID = 'lark-meeting-read';

const buildMeetingsAnswer = (items: Array<{ meetingId: string; topic?: string; startTime?: string }>): string => {
  if (items.length === 0) {
    return 'No Lark meetings matched the request.';
  }

  const lines = items.slice(0, 5).map((item, index) =>
    `${index + 1}. ${item.topic ?? item.meetingId}${item.startTime ? ` (${item.startTime})` : ''}`);

  return `Found ${items.length} Lark meeting(s).\n\n${lines.join('\n')}`;
};

export const larkMeetingReadTool = createTool({
  id: TOOL_ID,
  description: 'List Lark meetings, fetch one meeting by ID, or fetch a Lark minute by token or URL.',
  inputSchema: z.object({
    action: z.enum(['list', 'getMeeting', 'getMinute']),
    meetingId: z.string().optional().describe('Required for getMeeting'),
    minuteTokenOrUrl: z.string().optional().describe('Required for getMinute'),
    startTime: z.string().optional().describe('Optional lower time bound for meeting list'),
    endTime: z.string().optional().describe('Optional upper time bound for meeting list'),
    pageSize: z.number().int().min(1).max(50).optional().default(10),
    pageToken: z.string().optional().describe('Optional page token for pagination'),
  }),
  execute: async (inputData, context) => {
    const requestContext = context?.requestContext;
    const allowedToolIds = requestContext?.get('allowedToolIds') as string[] | undefined;
    if (allowedToolIds !== undefined && !allowedToolIds.includes(TOOL_ID)) {
      const name = TOOL_REGISTRY_MAP.get(TOOL_ID)?.name ?? TOOL_ID;
      return { answer: `Access to "${name}" is not permitted for your role. Please contact your admin.` };
    }

    if (inputData.action === 'getMeeting' && !inputData.meetingId) {
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
        const result = await larkMeetingsService.listMeetings({
          ...authInput,
          pageSize: inputData.pageSize,
          pageToken: inputData.pageToken,
          startTime: inputData.startTime,
          endTime: inputData.endTime,
        });
        const answer = buildMeetingsAnswer(result.items);
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
          items: result.items,
          pageToken: result.pageToken,
          hasMore: result.hasMore,
          total: result.items.length,
        };
      }

      if (inputData.action === 'getMeeting') {
        const meeting = await larkMeetingsService.getMeeting({
          ...authInput,
          meetingId: inputData.meetingId as string,
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
