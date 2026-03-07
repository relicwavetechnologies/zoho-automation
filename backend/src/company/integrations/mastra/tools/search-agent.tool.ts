import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { searchAgent } from '../agents/search.agent';
import { buildMastraAgentRunOptions } from '../mastra-model-control';
import { TOOL_REGISTRY_MAP } from '../../../tools/tool-registry';

const TOOL_ID = 'search-agent';

export const searchAgentTool = createTool({
  id: TOOL_ID,
  description:
    'Delegate to the web research agent for Serper-backed search plus exact-site page context extraction.',
  inputSchema: z.object({
    query: z.string().describe('The search query'),
  }),
  execute: async (inputData, context) => {
    const requestContext = context?.requestContext;
    const allowedToolIds = requestContext?.get('allowedToolIds') as string[] | undefined;
    if (allowedToolIds !== undefined && !allowedToolIds.includes(TOOL_ID)) {
      const name = TOOL_REGISTRY_MAP.get(TOOL_ID)?.name ?? TOOL_ID;
      return { answer: `Access to "${name}" is not permitted for your role. Please contact your admin.` };
    }

    const runOptions = await buildMastraAgentRunOptions('mastra.search', { requestContext });
    const result = await searchAgent.generate(
      [{ role: 'user', content: inputData.query }],
      runOptions as any,
    );
    return { answer: result.text };
  },
});
