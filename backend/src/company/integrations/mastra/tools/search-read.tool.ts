import { randomUUID } from 'crypto';

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { agentRegistry } from '../../../agents';
import { TOOL_REGISTRY_MAP } from '../../../tools/tool-registry';

const TOOL_ID = 'search-read';

export const searchReadTool = createTool({
  id: TOOL_ID,
  description:
    'Search the web via Serper, then fetch the top result pages to extract exact page context and snippets.',
  inputSchema: z.object({
    query: z.string().min(1).describe('The web search query'),
    exactDomain: z.string().optional().describe('Optional domain to focus with a second exact-site search'),
  }),
  execute: async (inputData, context) => {
    const requestContext = context?.requestContext;
    const allowedToolIds = requestContext?.get('allowedToolIds') as string[] | undefined;
    if (allowedToolIds !== undefined && !allowedToolIds.includes(TOOL_ID)) {
      const name = TOOL_REGISTRY_MAP.get(TOOL_ID)?.name ?? TOOL_ID;
      return { answer: `Access to "${name}" is not permitted for your role. Please contact your admin.` };
    }

    const result = await agentRegistry.invoke({
      taskId: `mastra_tool_${randomUUID()}`,
      agentKey: 'search-read',
      objective: inputData.query,
      constraints: ['mastra-tool'],
      contextPacket: {
        companyId: requestContext?.get('companyId'),
        larkTenantKey: requestContext?.get('larkTenantKey'),
        requestId: requestContext?.get('requestId'),
        exactDomain: inputData.exactDomain,
      },
      correlationId: randomUUID(),
    });

    if (result.status === 'failed') {
      return { answer: result.message, error: result.error };
    }

    return {
      answer: result.result?.answer ?? result.message,
      query: result.result?.query,
      exactDomain: result.result?.exactDomain,
      focusedSiteSearch: result.result?.focusedSiteSearch,
      items: result.result?.items,
      sourceRefs: result.result?.sourceRefs,
    };
  },
});
