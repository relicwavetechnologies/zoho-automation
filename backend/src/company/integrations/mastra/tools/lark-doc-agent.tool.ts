import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { larkDocSpecialistAgent } from '../agents/lark-doc-specialist.agent';
import { buildMastraAgentRunOptions } from '../mastra-model-control';
import { TOOL_REGISTRY_MAP } from '../../../tools/tool-registry';

const TOOL_ID = 'lark-doc-agent';

export const larkDocAgentTool = createTool({
  id: TOOL_ID,
  description:
    'Delegate to the Lark Docs specialist for document creation and markdown export into Lark Docs.',
  inputSchema: z.object({
    query: z.string().describe('The user request for the document to create'),
  }),
  execute: async (inputData, context) => {
    const requestContext = context?.requestContext;
    const allowedToolIds = requestContext?.get('allowedToolIds') as string[] | undefined;
    if (allowedToolIds !== undefined && !allowedToolIds.includes(TOOL_ID)) {
      const name = TOOL_REGISTRY_MAP.get(TOOL_ID)?.name ?? TOOL_ID;
      return { answer: `Access to "${name}" is not permitted for your role. Please contact your admin.` };
    }

    const runOptions = await buildMastraAgentRunOptions('mastra.lark-doc', { requestContext });
    const result = await larkDocSpecialistAgent.generate(
      [{ role: 'user', content: inputData.query }],
      runOptions as any,
    );
    return { answer: result.text };
  },
});
