import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { zohoSpecialistAgent } from '../agents/zoho-specialist.agent';
import { buildMastraAgentRunOptions } from '../mastra-model-control';
import { TOOL_REGISTRY_MAP } from '../../../tools/tool-registry';

const TOOL_ID = 'zoho-agent';

export const zohoAgentTool = createTool({
  id: TOOL_ID,
  description:
    'Delegate to the Zoho CRM specialist agent for any CRM data queries: ' +
    'deals, contacts, tickets, pipeline risk, health reports, next-action recommendations. ' +
    'Always use this for Zoho-specific questions.',
  inputSchema: z.object({
    query: z.string().describe('The CRM question to answer'),
  }),
  execute: async (inputData, context) => {
    const requestContext = context?.requestContext;
    const allowedToolIds = requestContext?.get('allowedToolIds') as string[] | undefined;
    if (allowedToolIds !== undefined && !allowedToolIds.includes(TOOL_ID)) {
      const name = TOOL_REGISTRY_MAP.get(TOOL_ID)?.name ?? TOOL_ID;
      return { answer: `Access to "${name}" is not permitted for your role. Please contact your admin.` };
    }

    const runOptions = await buildMastraAgentRunOptions('mastra.zoho-specialist', { requestContext });
    const result = await zohoSpecialistAgent.generate(
      [{ role: 'user', content: inputData.query }],
      runOptions as any,
    );
    return { answer: result.text };
  },
});
