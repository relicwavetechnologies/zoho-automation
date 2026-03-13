import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { randomUUID } from 'crypto';

import { companyContextResolver, zohoRetrievalService } from '../../../agents/support';
import { COMPANY_CONTROL_KEYS, isCompanyControlEnabled } from '../../../support/runtime-controls';
import { TOOL_REGISTRY_MAP } from '../../../tools/tool-registry';
import { zohoRoleAccessService } from '../../../tools/zoho-role-access.service';
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

    try {
      const companyId = requestContext?.get('companyId') as string | undefined;
      const larkTenantKey = requestContext?.get('larkTenantKey') as string | undefined;
      const requesterEmail = requestContext?.get('requesterEmail') as string | undefined;
      const requesterAiRole = requestContext?.get('requesterAiRole') as string | undefined;
      const channelIdentityId = requestContext?.get('channelIdentityId') as string | undefined;
      const requesterUserId = channelIdentityId || (requestContext?.get('userId') as string | undefined);

      const resolved = await companyContextResolver.resolveCompanyId({ companyId, larkTenantKey });
      const strictUserScopeEnabled = await isCompanyControlEnabled({
        controlKey: COMPANY_CONTROL_KEYS.zohoUserScopedReadStrictEnabled,
        companyId: resolved,
        defaultValue: true,
      });
      const scopeMode =
        strictUserScopeEnabled
          ? await zohoRoleAccessService.resolveScopeMode(resolved, requesterAiRole)
          : 'company_scoped';
      if (scopeMode === 'email_scoped' && strictUserScopeEnabled && (!requesterEmail || !requesterEmail.trim())) {
        const reason = 'No records returned: your Zoho access requires a verified email scope for this request.';
        if (requestId) {
          emitActivityEvent(requestId, 'activity_done', {
            id: callId,
            name: TOOL_ID,
            label: 'Search failed',
            icon: 'x-circle',
            resultSummary: reason,
          });
        }
        return {
          error: reason,
          records: [],
          count: 0,
          companyId: resolved,
          scopeMode,
        };
      }
      const matches = await zohoRetrievalService.query({
        companyId: resolved,
        requesterUserId,
        requesterEmail,
        scopeMode,
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
          resultSummary:
            matches.length > 0
              ? `Found ${matches.length} matching records`
              : scopeMode === 'company_scoped'
                ? 'No company-scoped Zoho records matched this search.'
                : 'No email-scoped Zoho records matched this search.',
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
        scopeMode,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Zoho search failed.';
      if (requestId) {
        emitActivityEvent(requestId, 'activity_done', {
          id: callId,
          name: TOOL_ID,
          label: 'Search failed',
          icon: 'x-circle',
          resultSummary: reason,
        });
      }
      return {
        error: reason,
        records: [],
        count: 0,
        companyId: requestContext?.get('companyId') as string | undefined,
      };
    }
  },
});
