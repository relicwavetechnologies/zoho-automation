import { createTool } from '@mastra/core/tools';
import { randomUUID } from 'crypto';
import { z } from 'zod';

import { channelIdentityRepository } from '../../../channels/channel-identity.repository';
import { larkUserAuthLinkRepository } from '../../../channels/lark/lark-user-auth-link.repository';
import { TOOL_REGISTRY_MAP } from '../../../tools/tool-registry';
import { emitActivityEvent } from './activity-bus';

const TOOL_ID = 'lark-people-read';

const normalize = (value?: string | null): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

export const larkPeopleReadTool = createTool({
  id: TOOL_ID,
  description: 'List and search synced Lark people by name, email, open ID, user ID, or role.',
  inputSchema: z.object({
    query: z.string().optional().describe('Optional case-insensitive search across display name, email, open ID, user ID, and role.'),
    includeRoles: z.boolean().optional().default(true),
    pageSize: z.number().int().min(1).max(200).optional().default(50),
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
        label: 'Reading Lark people',
        icon: 'users',
      });
    }

    try {
      const companyId = requestContext?.get('companyId') as string | undefined;
      if (!companyId) {
        return { answer: 'Lark people read failed: no company context is available.' };
      }

      const linkedUser = requestContext?.get('userId')
        ? await larkUserAuthLinkRepository.findActiveByUser(requestContext.get('userId') as string, companyId)
        : null;
      const currentOpenId = normalize(requestContext?.get('larkOpenId') as string | undefined) ?? normalize(linkedUser?.larkOpenId);

      const rows = await channelIdentityRepository.listByCompany(companyId, 'lark');
      const query = inputData.query?.trim().toLowerCase();
      const items = rows
        .map((row) => ({
          channelIdentityId: row.id,
          displayName: normalize(row.displayName),
          email: normalize(row.email),
          externalUserId: row.externalUserId,
          larkOpenId: normalize(row.larkOpenId),
          larkUserId: normalize(row.larkUserId),
          aiRole: normalize(row.aiRole),
          isCurrentUser: Boolean(currentOpenId && (row.larkOpenId === currentOpenId || row.externalUserId === currentOpenId)),
        }))
        .filter((row) => {
          if (!query) {
            return true;
          }
          return [
            row.displayName,
            row.email,
            row.externalUserId,
            row.larkOpenId,
            row.larkUserId,
            row.aiRole,
          ].some((value) => value?.toLowerCase().includes(query));
        })
        .sort((a, b) => {
          if (a.isCurrentUser !== b.isCurrentUser) {
            return a.isCurrentUser ? -1 : 1;
          }
          return (a.displayName ?? a.email ?? a.externalUserId)
            .localeCompare(b.displayName ?? b.email ?? b.externalUserId);
        })
        .slice(0, inputData.pageSize);

      const lines = items.slice(0, 12).map((person, index) => {
        const label = person.displayName ?? person.email ?? person.externalUserId;
        const me = person.isCurrentUser ? ' (me)' : '';
        const role = inputData.includeRoles && person.aiRole ? ` [${person.aiRole}]` : '';
        return `${index + 1}. ${label}${me}${role} (${person.larkOpenId ?? person.externalUserId})`;
      });
      const answer = items.length > 0
        ? `Found ${items.length} Lark teammate(s).\n\n${lines.join('\n')}`
        : 'No Lark teammates matched the request.';

      if (requestId) {
        emitActivityEvent(requestId, 'activity_done', {
          id: callId,
          name: TOOL_ID,
          label: 'Read Lark people',
          icon: 'users',
          externalRef: items[0]?.larkOpenId ?? items[0]?.externalUserId,
          resultSummary: answer,
        });
      }

      return {
        answer,
        items,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown_error';
      if (requestId) {
        emitActivityEvent(requestId, 'activity_done', {
          id: callId,
          name: TOOL_ID,
          label: 'Lark people read failed',
          icon: 'x-circle',
          resultSummary: message,
        });
      }
      return { answer: `Lark people read failed: ${message}` };
    }
  },
});
