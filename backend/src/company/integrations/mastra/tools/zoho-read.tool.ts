import { randomUUID } from 'crypto';

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { agentRegistry } from '../../../agents';
import { TOOL_REGISTRY_MAP } from '../../../tools/tool-registry';
import { emitActivityEvent } from './activity-bus';
import { logger } from '../../../../utils/logger';

const TOOL_ID = 'read-zoho-records';

export const zohoReadTool = createTool({
  id: TOOL_ID,
  description:
    'Get formatted Zoho CRM data — deals, contacts, tickets, leads. ' +
    'Supports risk analysis, CRM health reports, pipeline summaries, and next-action recommendations. ' +
    'Returns a structured natural-language answer with source references.',
  inputSchema: z.object({
    objective: z
      .string()
      .describe('The CRM question or objective, e.g. "Show top 3 deals at risk" or "Find contact John Doe"'),
  }),
  execute: async (inputData, context) => {
    const requestContext = context?.requestContext;
    const taskId = requestContext?.get('taskId');
    const messageId = requestContext?.get('messageId');
    const requestId = requestContext?.get('requestId');
    const companyId = requestContext?.get('companyId');
    const allowedToolIds = requestContext?.get('allowedToolIds') as string[] | undefined;
    if (allowedToolIds !== undefined && !allowedToolIds.includes(TOOL_ID)) {
      const name = TOOL_REGISTRY_MAP.get(TOOL_ID)?.name ?? TOOL_ID;
      return { answer: null, sourceRefs: [], error: `Access to "${name}" is not permitted for your role. Please contact your admin.` };
    }

    const callId = randomUUID();
    if (requestId) {
      emitActivityEvent(requestId as string, 'activity', {
        id: callId,
        name: TOOL_ID,
        label: 'Reading Zoho records',
        icon: 'search',
      });
    }

    logger.info('zoho.tool.read.start', {
      toolId: TOOL_ID,
      taskId,
      messageId,
      requestId,
      companyId,
      objectivePreview: inputData.objective.slice(0, 200),
    });

    const contextPacket: Record<string, unknown> = {
      companyId,
      larkTenantKey: requestContext?.get('larkTenantKey'),
      userId: requestContext?.get('userId'),
      channelIdentityId: requestContext?.get('channelIdentityId'),
      requesterEmail: requestContext?.get('requesterEmail'),
      chatId: requestContext?.get('chatId'),
    };

    const result = await agentRegistry.invoke({
      taskId: `mastra_tool_${randomUUID()}`,
      agentKey: 'zoho-read',
      objective: inputData.objective,
      correlationId: randomUUID(),
      constraints: ['mastra-tool'],
      contextPacket,
    });

    const failureCode =
      typeof result.error?.classifiedReason === 'string' ? result.error.classifiedReason : undefined;
    const rateLimited = failureCode === 'rate_limited' || result.message.toLowerCase().includes('rate limit');

    const finishMeta = {
      toolId: TOOL_ID,
      taskId,
      messageId,
      requestId,
      companyId,
      status: result.status,
      failureCode: failureCode ?? null,
      sourceRefCount: Array.isArray(result.result?.['sourceRefs']) ? result.result['sourceRefs'].length : 0,
    };

    if (rateLimited) {
      logger.error('zoho.tool.read.rate_limited', finishMeta);
    } else {
      logger.info('zoho.tool.read.finish', finishMeta);
    }

    if (requestId) {
      emitActivityEvent(requestId as string, 'activity_done', {
        id: callId,
        name: TOOL_ID,
        label: result.status === 'success' ? 'Read Zoho records' : 'Failed to read Zoho records',
        icon: result.status === 'success' ? 'search' : 'x-circle',
        resultSummary: result.status === 'success' ? 'Records found' : 'Error',
      });
    }

    return {
      answer: result.status === 'success' ? result.message : null,
      sourceRefs: (result.result?.['sourceRefs'] as string[] | undefined) ?? [],
      error: result.status !== 'success' ? result.message : null,
    };
  },
});
