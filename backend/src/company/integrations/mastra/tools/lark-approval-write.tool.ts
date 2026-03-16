import { createTool } from '@mastra/core/tools';
import { randomUUID } from 'crypto';
import { z } from 'zod';

import { larkApprovalsService } from '../../../channels/lark/lark-approvals.service';
import { LarkRuntimeClientError, type LarkCredentialMode } from '../../../channels/lark/lark-runtime-client';
import { larkOperationalConfigRepository } from '../../../channels/lark/lark-operational-config.repository';
import { TOOL_REGISTRY_MAP } from '../../../tools/tool-registry';
import { emitActivityEvent } from './activity-bus';

const TOOL_ID = 'lark-approval-write';

export const larkApprovalWriteTool = createTool({
  id: TOOL_ID,
  description: 'Create a Lark approval instance. Uses the company default approval code when configured.',
  inputSchema: z.object({
    approvalCode: z.string().optional().describe('Optional approval code. Falls back to company default when configured.'),
    form: z.string().optional().describe('Approval form JSON string required by the target template unless a raw body is provided.'),
    formValues: z.record(z.unknown()).optional().describe('Optional structured approval form object. It will be JSON-stringified into `form` when provided.'),
    userId: z.string().optional().describe('Optional applicant user ID'),
    openId: z.string().optional().describe('Optional applicant open ID'),
    departmentId: z.string().optional().describe('Optional department ID'),
    nodeApproverUserIds: z.array(z.string().min(1)).optional().describe('Optional explicit approver user IDs'),
    body: z.record(z.unknown()).optional().describe('Optional raw approval payload override'),
  }),
  execute: async (inputData, context) => {
    const requestContext = context?.requestContext;
    const allowedToolIds = requestContext?.get('allowedToolIds') as string[] | undefined;
    if (allowedToolIds !== undefined && !allowedToolIds.includes(TOOL_ID) && !allowedToolIds.includes('lark-approval-agent')) {
      const name = TOOL_REGISTRY_MAP.get(TOOL_ID)?.name ?? TOOL_ID;
      return { answer: `Access to "${name}" is not permitted for your role. Please contact your admin.` };
    }

    const requestId = requestContext?.get('requestId') as string | undefined;
    const callId = randomUUID();
    if (requestId) {
      emitActivityEvent(requestId, 'activity', {
        id: callId,
        name: TOOL_ID,
        label: 'Creating Lark approval',
        icon: 'badge-check',
      });
    }

    try {
      const companyId = requestContext?.get('companyId') as string | undefined;
      const defaults = companyId ? await larkOperationalConfigRepository.findByCompanyId(companyId) : null;
      const approvalCode = inputData.approvalCode?.trim() || defaults?.defaultApprovalCode;
      if (!inputData.body && !approvalCode) {
        return {
          answer: 'Lark approval create failed: approvalCode is required. Set a company default approval code in Integrations or provide it explicitly.',
        };
      }
      if (!inputData.body && !inputData.form && !inputData.formValues) {
        return { answer: 'Lark approval create failed: form or formValues is required unless a raw body is provided.' };
      }

      const credentialMode: LarkCredentialMode =
        requestContext?.get('larkAuthMode') === 'user_linked' ? 'user_linked' : 'tenant';
      const body = inputData.body ?? {
        ...(approvalCode ? { approval_code: approvalCode } : {}),
        ...(inputData.form ? { form: inputData.form } : {}),
        ...(!inputData.form && inputData.formValues ? { form: JSON.stringify(inputData.formValues) } : {}),
        ...(inputData.userId ? { user_id: inputData.userId } : {}),
        ...(inputData.openId ? { open_id: inputData.openId } : {}),
        ...(inputData.departmentId ? { department_id: inputData.departmentId } : {}),
        ...(inputData.nodeApproverUserIds && inputData.nodeApproverUserIds.length > 0
          ? { node_approver_user_id_list: inputData.nodeApproverUserIds }
          : {}),
      };

      const instance = await larkApprovalsService.createInstance({
        body,
        companyId,
        larkTenantKey: requestContext?.get('larkTenantKey') as string | undefined,
        appUserId: requestContext?.get('userId') as string | undefined,
        credentialMode,
      });
      const answer = `Created Lark approval instance: ${instance.title ?? instance.instanceCode}`;

      if (requestId) {
        emitActivityEvent(requestId, 'activity_done', {
          id: callId,
          name: TOOL_ID,
          label: 'Created Lark approval',
          icon: 'badge-check',
          resultSummary: answer,
        });
      }

      return { answer, instance };
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
          label: 'Lark approval create failed',
          icon: 'x-circle',
          resultSummary: message,
        });
      }

      return { answer: `Lark approval create failed: ${message}` };
    }
  },
});
