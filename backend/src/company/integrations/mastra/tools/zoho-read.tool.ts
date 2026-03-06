import { randomUUID } from 'crypto';

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { agentRegistry } from '../../../agents';
import { TOOL_REGISTRY_MAP } from '../../../tools/tool-registry';

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
    const allowedToolIds = requestContext?.get('allowedToolIds') as string[] | undefined;
    if (allowedToolIds !== undefined && !allowedToolIds.includes(TOOL_ID)) {
      const name = TOOL_REGISTRY_MAP.get(TOOL_ID)?.name ?? TOOL_ID;
      return { answer: null, sourceRefs: [], error: `Access to "${name}" is not permitted for your role. Please contact your admin.` };
    }

    const contextPacket: Record<string, unknown> = {
      companyId: requestContext?.get('companyId'),
      larkTenantKey: requestContext?.get('larkTenantKey'),
      userId: requestContext?.get('userId'),
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

    return {
      answer: result.status === 'success' ? result.message : null,
      sourceRefs: (result.result?.['sourceRefs'] as string[] | undefined) ?? [],
      error: result.status !== 'success' ? result.message : null,
    };
  },
});
