import { createTool } from '@mastra/core/tools';
import { randomUUID } from 'crypto';
import { z } from 'zod';

import { larkBaseService } from '../../../channels/lark/lark-base.service';
import { LarkRuntimeClientError } from '../../../channels/lark/lark-runtime-client';
import { larkOperationalConfigRepository } from '../../../channels/lark/lark-operational-config.repository';
import { TOOL_REGISTRY_MAP } from '../../../tools/tool-registry';
import { emitActivityEvent } from './activity-bus';

const TOOL_ID = 'lark-base-read';

const buildAnswer = (items: Array<{ recordId: string; fields: Record<string, unknown> }>): string => {
  if (items.length === 0) {
    return 'No Lark Base records matched the request.';
  }

  const lines = items.slice(0, 5).map((item, index) => {
    const preview = Object.entries(item.fields)
      .slice(0, 3)
      .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
      .join(' | ');
    return `${index + 1}. ${item.recordId}${preview ? ` - ${preview}` : ''}`;
  });

  return `Found ${items.length} Lark Base record(s).\n\n${lines.join('\n')}`;
};

export const larkBaseReadTool = createTool({
  id: TOOL_ID,
  description: 'List records from a Lark Base table when the app token and table ID are known.',
  inputSchema: z.object({
    appToken: z.string().optional().describe('Optional Lark Base app token. Falls back to company default when configured.'),
    tableId: z.string().optional().describe('Optional Lark Base table ID. Falls back to company default when configured.'),
    viewId: z.string().optional().describe('Optional view ID to scope the listing'),
    query: z.string().optional().describe('Optional text filter applied client-side to the returned records'),
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

    const requestId = requestContext?.get('requestId') as string | undefined;
    const callId = randomUUID();
    if (requestId) {
      emitActivityEvent(requestId, 'activity', {
        id: callId,
        name: TOOL_ID,
        label: 'Reading Lark Base',
        icon: 'table2',
      });
    }

    try {
      const companyId = requestContext?.get('companyId') as string | undefined;
      const defaults = companyId ? await larkOperationalConfigRepository.findByCompanyId(companyId) : null;
      const appToken = inputData.appToken?.trim() || defaults?.defaultBaseAppToken;
      const tableId = inputData.tableId?.trim() || defaults?.defaultBaseTableId;
      const viewId = inputData.viewId?.trim() || defaults?.defaultBaseViewId;
      if (!appToken || !tableId) {
        return {
          answer: 'Lark Base read failed: appToken and tableId are required. Set company defaults in Integrations or provide them explicitly.',
        };
      }

      const result = await larkBaseService.listRecords({
        appToken,
        tableId,
        viewId,
        pageSize: inputData.pageSize,
        pageToken: inputData.pageToken,
        companyId,
        larkTenantKey: requestContext?.get('larkTenantKey') as string | undefined,
        appUserId: requestContext?.get('userId') as string | undefined,
        credentialMode: requestContext?.get('larkAuthMode') === 'user_linked' ? 'user_linked' : 'tenant',
      });

      const normalizedQuery = inputData.query?.trim().toLowerCase();
      const filteredItems = normalizedQuery
        ? result.items.filter((item) => {
          const haystack = `${item.recordId} ${JSON.stringify(item.fields)}`.toLowerCase();
          return haystack.includes(normalizedQuery);
        })
        : result.items;

      const answer = buildAnswer(filteredItems);
      if (requestId) {
        emitActivityEvent(requestId, 'activity_done', {
          id: callId,
          name: TOOL_ID,
          label: 'Read Lark Base',
          icon: 'table2',
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
          label: 'Lark Base read failed',
          icon: 'x-circle',
          resultSummary: message,
        });
      }

      return { answer: `Lark Base read failed: ${message}` };
    }
  },
});
