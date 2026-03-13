import { createTool } from '@mastra/core/tools';
import { randomUUID } from 'crypto';
import { z } from 'zod';

import { larkApprovalsService } from '../../../channels/lark/lark-approvals.service';
import { LarkRuntimeClientError, type LarkCredentialMode } from '../../../channels/lark/lark-runtime-client';
import { larkOperationalConfigRepository } from '../../../channels/lark/lark-operational-config.repository';
import { TOOL_REGISTRY_MAP } from '../../../tools/tool-registry';
import { emitActivityEvent } from './activity-bus';

const TOOL_ID = 'lark-approval-read';

const buildAnswer = (items: Array<{ instanceCode: string; title?: string; status?: string }>): string => {
  if (items.length === 0) {
    return 'No Lark approval instances matched the request.';
  }

  const lines = items.slice(0, 5).map((item, index) =>
    `${index + 1}. ${item.title ?? item.instanceCode}${item.status ? ` [${item.status}]` : ''}`);

  return `Found ${items.length} Lark approval instance(s).\n\n${lines.join('\n')}`;
};

export const larkApprovalReadTool = createTool({
  id: TOOL_ID,
  description: 'List or fetch Lark approval instances. Falls back to the company default approval code when configured.',
  inputSchema: z.object({
    action: z.enum(['list', 'get']),
    instanceCode: z.string().optional().describe('Required for get'),
    approvalCode: z.string().optional().describe('Optional approval code. Falls back to company default when configured.'),
    status: z.string().optional().describe('Optional approval status filter when listing'),
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

    if (inputData.action === 'get' && !inputData.instanceCode) {
      return { answer: 'Lark approval read failed: instanceCode is required for get.' };
    }

    const requestId = requestContext?.get('requestId') as string | undefined;
    const callId = randomUUID();
    if (requestId) {
      emitActivityEvent(requestId, 'activity', {
        id: callId,
        name: TOOL_ID,
        label: 'Reading Lark approvals',
        icon: 'badge-check',
      });
    }

    try {
      const companyId = requestContext?.get('companyId') as string | undefined;
      const defaults = companyId ? await larkOperationalConfigRepository.findByCompanyId(companyId) : null;
      const credentialMode: LarkCredentialMode =
        requestContext?.get('larkAuthMode') === 'user_linked' ? 'user_linked' : 'tenant';
      const authInput = {
        companyId,
        larkTenantKey: requestContext?.get('larkTenantKey') as string | undefined,
        appUserId: requestContext?.get('userId') as string | undefined,
        credentialMode,
      };

      if (inputData.action === 'get') {
        const instance = await larkApprovalsService.getInstance({
          ...authInput,
          instanceCode: inputData.instanceCode as string,
        });
        const answer = `Fetched Lark approval instance: ${instance.title ?? instance.instanceCode}`;
        if (requestId) {
          emitActivityEvent(requestId, 'activity_done', {
            id: callId,
            name: TOOL_ID,
            label: 'Fetched Lark approval',
            icon: 'badge-check',
            resultSummary: answer,
          });
        }
        return { answer, instance };
      }

      const approvalCode = inputData.approvalCode?.trim() || defaults?.defaultApprovalCode;
      const result = await larkApprovalsService.listInstances({
        ...authInput,
        approvalCode,
        status: inputData.status,
        pageSize: inputData.pageSize,
        pageToken: inputData.pageToken,
      });
      const answer = buildAnswer(result.items);
      if (requestId) {
        emitActivityEvent(requestId, 'activity_done', {
          id: callId,
          name: TOOL_ID,
          label: 'Read Lark approvals',
          icon: 'badge-check',
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
          label: 'Lark approval read failed',
          icon: 'x-circle',
          resultSummary: message,
        });
      }

      return { answer: `Lark approval read failed: ${message}` };
    }
  },
});
