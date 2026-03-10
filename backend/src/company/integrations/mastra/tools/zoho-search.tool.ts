import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { randomUUID } from 'crypto';

import { companyContextResolver, zohoRetrievalService } from '../../../agents/support';
import { COMPANY_CONTROL_KEYS, isCompanyControlEnabled } from '../../../support/runtime-controls';
import { TOOL_REGISTRY_MAP } from '../../../tools/tool-registry';
import { emitActivityEvent } from './activity-bus';

const TOOL_ID = 'search-zoho-context';

export const zohoSearchTool = createTool({
  id: TOOL_ID,
  description:
    'Search indexed Zoho CRM records (deals, contacts, tickets) from the vector database. ' +
    'Use when you need to find relevant CRM context for a query.',
  inputSchema: z.object({
    query: z.string().describe('The search query to find relevant CRM records'),
    limit: z.number().optional().default(5).describe('Max records to return'),
  }),
  execute: async (inputData, context) => {
    const requestContext = context?.requestContext;
    const allowedToolIds = requestContext?.get('allowedToolIds') as string[] | undefined;
    if (allowedToolIds !== undefined && !allowedToolIds.includes(TOOL_ID)) {
      const name = TOOL_REGISTRY_MAP.get(TOOL_ID)?.name ?? TOOL_ID;
      return { error: `Access to "${name}" is not permitted for your role. Please contact your admin.`, records: [], count: 0 };
    }

    const requestId = requestContext?.get('requestId') as string | undefined;
    const callId = randomUUID();
    if (requestId) {
      emitActivityEvent(requestId, 'activity', {
        id: callId,
        name: TOOL_ID,
        label: 'Searching Zoho CRM',
        icon: 'search',
      });
    }

    const companyId = requestContext?.get('companyId') as string | undefined;
    const larkTenantKey = requestContext?.get('larkTenantKey') as string | undefined;
    const requesterEmail = requestContext?.get('requesterEmail') as string | undefined;
    const channelIdentityId = requestContext?.get('channelIdentityId') as string | undefined;
    const requesterUserId = channelIdentityId || (requestContext?.get('userId') as string | undefined);

    const resolved = await companyContextResolver.resolveCompanyId({ companyId, larkTenantKey });
    const strictUserScopeEnabled = await isCompanyControlEnabled({
      controlKey: COMPANY_CONTROL_KEYS.zohoUserScopedReadStrictEnabled,
      companyId: resolved,
      defaultValue: true,
    });
    if (strictUserScopeEnabled && (!requesterEmail || !requesterEmail.trim())) {
      if (requestId) {
        emitActivityEvent(requestId, 'activity_done', {
          id: callId,
          name: TOOL_ID,
          label: 'Search failed',
          icon: 'x-circle',
          resultSummary: 'Missing email scope',
        });
      }
      return {
        error: 'User-scoped Zoho access is enabled, but requester email is missing for this request.',
        records: [],
        count: 0,
        companyId: resolved,
      };
    }
    const matches = await zohoRetrievalService.query({
      companyId: resolved,
      requesterUserId,
      requesterEmail,
      strictUserScopeEnabled,
      text: inputData.query,
      limit: inputData.limit ?? 5,
    });

    if (requestId) {
      emitActivityEvent(requestId, 'activity_done', {
        id: callId,
        name: TOOL_ID,
        label: 'Searched Zoho CRM',
        icon: 'search',
        resultSummary: `Found ${matches.length} matching records`,
      });
    }

    return {
      records: matches.map((match) => ({
        type: match.sourceType,
        id: match.sourceId,
        score: match.score,
        data: match.payload,
      })),
      count: matches.length,
      companyId: resolved,
    };
  },
});
