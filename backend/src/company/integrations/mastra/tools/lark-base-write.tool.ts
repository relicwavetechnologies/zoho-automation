import { createTool } from '@mastra/core/tools';
import { randomUUID } from 'crypto';
import { z } from 'zod';

import { larkBaseService } from '../../../channels/lark/lark-base.service';
import { LarkRuntimeClientError, type LarkCredentialMode } from '../../../channels/lark/lark-runtime-client';
import { larkOperationalConfigRepository } from '../../../channels/lark/lark-operational-config.repository';
import { TOOL_REGISTRY_MAP } from '../../../tools/tool-registry';
import { emitActivityEvent } from './activity-bus';

const TOOL_ID = 'lark-base-write';

export const larkBaseWriteTool = createTool({
  id: TOOL_ID,
  description: 'Create or update a Lark Base record when the Base app token, table ID, and fields are known.',
  inputSchema: z.object({
    action: z.enum(['create', 'update']),
    appToken: z.string().optional().describe('Optional Lark Base app token. Falls back to company default when configured.'),
    tableId: z.string().optional().describe('Optional Lark Base table ID. Falls back to company default when configured.'),
    recordId: z.string().optional().describe('Required for updates'),
    fields: z.record(z.unknown()).describe('Field payload for the record'),
  }),
  execute: async (inputData, context) => {
    const requestContext = context?.requestContext;
    const allowedToolIds = requestContext?.get('allowedToolIds') as string[] | undefined;
    if (allowedToolIds !== undefined && !allowedToolIds.includes(TOOL_ID)) {
      const name = TOOL_REGISTRY_MAP.get(TOOL_ID)?.name ?? TOOL_ID;
      return { answer: `Access to "${name}" is not permitted for your role. Please contact your admin.` };
    }

    if (inputData.action === 'update' && !inputData.recordId) {
      return { answer: 'Lark Base update failed: recordId is required for updates.' };
    }

    const requestId = requestContext?.get('requestId') as string | undefined;
    const callId = randomUUID();
    if (requestId) {
      emitActivityEvent(requestId, 'activity', {
        id: callId,
        name: TOOL_ID,
        label: inputData.action === 'create' ? 'Creating Lark Base record' : 'Updating Lark Base record',
        icon: 'table2',
      });
    }

    try {
      const companyId = requestContext?.get('companyId') as string | undefined;
      const defaults = companyId ? await larkOperationalConfigRepository.findByCompanyId(companyId) : null;
      const appToken = inputData.appToken?.trim() || defaults?.defaultBaseAppToken;
      const tableId = inputData.tableId?.trim() || defaults?.defaultBaseTableId;
      if (!appToken || !tableId) {
        return {
          answer: 'Lark Base write failed: appToken and tableId are required. Set company defaults in Integrations or provide them explicitly.',
        };
      }

      const credentialMode: LarkCredentialMode =
        requestContext?.get('larkAuthMode') === 'user_linked' ? 'user_linked' : 'tenant';
      const commonInput = {
        appToken,
        tableId,
        fields: inputData.fields,
        companyId,
        larkTenantKey: requestContext?.get('larkTenantKey') as string | undefined,
        appUserId: requestContext?.get('userId') as string | undefined,
        credentialMode,
      };

      const record = inputData.action === 'create'
        ? await larkBaseService.createRecord(commonInput)
        : await larkBaseService.updateRecord({
          ...commonInput,
          recordId: inputData.recordId as string,
        });

      const answer = inputData.action === 'create'
        ? `Created Lark Base record: ${record.recordId}`
        : `Updated Lark Base record: ${record.recordId}`;

      if (requestId) {
        emitActivityEvent(requestId, 'activity_done', {
          id: callId,
          name: TOOL_ID,
          label: inputData.action === 'create' ? 'Created Lark Base record' : 'Updated Lark Base record',
          icon: 'table2',
          resultSummary: answer,
        });
      }

      return {
        answer,
        record,
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
          label: 'Lark Base write failed',
          icon: 'x-circle',
          resultSummary: message,
        });
      }

      return { answer: `Lark Base write failed: ${message}` };
    }
  },
});
