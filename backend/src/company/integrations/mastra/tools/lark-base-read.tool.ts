import { createTool } from '@mastra/core/tools';
import { randomUUID } from 'crypto';
import { z } from 'zod';

import { larkBaseService } from '../../../channels/lark/lark-base.service';
import { LarkRuntimeClientError, type LarkCredentialMode } from '../../../channels/lark/lark-runtime-client';
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
    action: z.enum(['listApps', 'listTables', 'listViews', 'listFields', 'listRecords', 'getRecord']).optional().default('listRecords'),
    appToken: z.string().optional().describe('Optional Lark Base app token. Falls back to company default when configured.'),
    tableId: z.string().optional().describe('Optional Lark Base table ID. Falls back to company default when configured.'),
    viewId: z.string().optional().describe('Optional view ID to scope the listing'),
    recordId: z.string().optional().describe('Required for getRecord'),
    query: z.string().optional().describe('Optional text filter applied client-side to the returned records'),
    filter: z.string().optional().describe('Optional server-side filter string when supported by Lark'),
    sort: z.string().optional().describe('Optional server-side sort string when supported by Lark'),
    fieldNames: z.array(z.string().min(1)).optional().describe('Optional list of field names to include when listing records'),
    pageSize: z.number().int().min(1).max(50).optional().default(10),
    pageToken: z.string().optional().describe('Optional page token for pagination'),
  }),
  execute: async (inputData, context) => {
    const requestContext = context?.requestContext;
    const allowedToolIds = requestContext?.get('allowedToolIds') as string[] | undefined;
    if (allowedToolIds !== undefined && !allowedToolIds.includes(TOOL_ID) && !allowedToolIds.includes('lark-base-agent')) {
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
      const action = inputData.action;
      const appToken = inputData.appToken?.trim() || defaults?.defaultBaseAppToken;
      const tableId = inputData.tableId?.trim() || defaults?.defaultBaseTableId;
      const viewId = inputData.viewId?.trim() || defaults?.defaultBaseViewId;
      if (action === 'listApps') {
        const result = await larkBaseService.listApps({
          pageSize: inputData.pageSize,
          pageToken: inputData.pageToken,
          companyId,
          larkTenantKey: requestContext?.get('larkTenantKey') as string | undefined,
          appUserId: requestContext?.get('userId') as string | undefined,
          credentialMode: requestContext?.get('larkAuthMode') === 'user_linked' ? 'user_linked' : 'tenant',
        });
        const normalizedQuery = inputData.query?.trim().toLowerCase();
        const items = normalizedQuery
          ? result.items.filter((item) => `${item.appToken} ${item.name ?? ''}`.toLowerCase().includes(normalizedQuery))
          : result.items;
        const answer = items.length > 0
          ? `Found ${items.length} Lark Base app(s).\n\n${items.slice(0, 8).map((item, index) => `${index + 1}. ${item.name ?? item.appToken}`).join('\n')}`
          : 'No Lark Base apps matched the request.';
        if (requestId) {
          emitActivityEvent(requestId, 'activity_done', {
            id: callId,
            name: TOOL_ID,
            label: 'Read Lark Base apps',
            icon: 'table2',
            resultSummary: answer,
          });
        }
        return { answer, items, pageToken: result.pageToken, hasMore: result.hasMore };
      }

      if (!appToken) {
        return {
          answer: 'Lark Base read failed: appToken is required. Set company defaults in Integrations or provide it explicitly.',
        };
      }

      const credentialMode: LarkCredentialMode = requestContext?.get('larkAuthMode') === 'user_linked' ? 'user_linked' : 'tenant';
      const authInput = {
        companyId,
        larkTenantKey: requestContext?.get('larkTenantKey') as string | undefined,
        appUserId: requestContext?.get('userId') as string | undefined,
        credentialMode,
      };

      if (action === 'listTables') {
        const result = await larkBaseService.listTables({
          appToken: appToken as string,
          pageSize: inputData.pageSize,
          pageToken: inputData.pageToken,
          ...authInput,
        });
        const normalizedQuery = inputData.query?.trim().toLowerCase();
        const items = normalizedQuery
          ? result.items.filter((item) => `${item.tableId} ${item.name ?? ''}`.toLowerCase().includes(normalizedQuery))
          : result.items;
        const answer = items.length > 0
          ? `Found ${items.length} Lark Base table(s).\n\n${items.slice(0, 8).map((item, index) => `${index + 1}. ${item.name ?? item.tableId}`).join('\n')}`
          : 'No Lark Base tables matched the request.';
        if (requestId) {
          emitActivityEvent(requestId, 'activity_done', {
            id: callId,
            name: TOOL_ID,
            label: 'Read Lark Base tables',
            icon: 'table2',
            resultSummary: answer,
          });
        }
        return { answer, items, pageToken: result.pageToken, hasMore: result.hasMore };
      }

      if (!tableId) {
        return {
          answer: 'Lark Base read failed: tableId is required. Set company defaults in Integrations or provide it explicitly.',
        };
      }

      if (action === 'listViews') {
        const result = await larkBaseService.listViews({
          appToken: appToken as string,
          tableId: tableId as string,
          pageSize: inputData.pageSize,
          pageToken: inputData.pageToken,
          ...authInput,
        });
        const normalizedQuery = inputData.query?.trim().toLowerCase();
        const items = normalizedQuery
          ? result.items.filter((item) => `${item.viewId} ${item.name ?? ''} ${item.type ?? ''}`.toLowerCase().includes(normalizedQuery))
          : result.items;
        const answer = items.length > 0
          ? `Found ${items.length} Lark Base view(s).\n\n${items.slice(0, 8).map((item, index) => `${index + 1}. ${item.name ?? item.viewId}`).join('\n')}`
          : 'No Lark Base views matched the request.';
        if (requestId) {
          emitActivityEvent(requestId, 'activity_done', {
            id: callId,
            name: TOOL_ID,
            label: 'Read Lark Base views',
            icon: 'table2',
            resultSummary: answer,
          });
        }
        return { answer, items, pageToken: result.pageToken, hasMore: result.hasMore };
      }

      if (action === 'listFields') {
        const result = await larkBaseService.listFields({
          appToken: appToken as string,
          tableId: tableId as string,
          pageSize: inputData.pageSize,
          pageToken: inputData.pageToken,
          ...authInput,
        });
        const normalizedQuery = inputData.query?.trim().toLowerCase();
        const items = normalizedQuery
          ? result.items.filter((item) => `${item.fieldId} ${item.fieldName ?? ''}`.toLowerCase().includes(normalizedQuery))
          : result.items;
        const answer = items.length > 0
          ? `Found ${items.length} Lark Base field(s).\n\n${items.slice(0, 8).map((item, index) => `${index + 1}. ${item.fieldName ?? item.fieldId}`).join('\n')}`
          : 'No Lark Base fields matched the request.';
        if (requestId) {
          emitActivityEvent(requestId, 'activity_done', {
            id: callId,
            name: TOOL_ID,
            label: 'Read Lark Base fields',
            icon: 'table2',
            resultSummary: answer,
          });
        }
        return { answer, items, pageToken: result.pageToken, hasMore: result.hasMore };
      }

      if (action === 'getRecord') {
        if (!inputData.recordId?.trim()) {
          return { answer: 'Lark Base read failed: recordId is required for getRecord.' };
        }
        const record = await larkBaseService.getRecord({
          appToken: appToken as string,
          tableId: tableId as string,
          recordId: inputData.recordId.trim(),
          ...authInput,
        });
        const answer = buildAnswer([record]);
        if (requestId) {
          emitActivityEvent(requestId, 'activity_done', {
            id: callId,
            name: TOOL_ID,
            label: 'Read Lark Base record',
            icon: 'table2',
            externalRef: record.recordId,
            resultSummary: answer,
          });
        }
        return { answer, record };
      }

      const result = await larkBaseService.listRecords({
        appToken: appToken as string,
        tableId: tableId as string,
        viewId,
        pageSize: inputData.pageSize,
        pageToken: inputData.pageToken,
        fieldNames: inputData.fieldNames,
        sort: inputData.sort,
        filter: inputData.filter,
        ...authInput,
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
