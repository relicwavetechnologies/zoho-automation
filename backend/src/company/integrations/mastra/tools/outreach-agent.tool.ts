import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { randomUUID } from 'crypto';

import { outreachSpecialistAgent } from '../agents/outreach-specialist.agent';
import { buildMastraAgentRunOptions } from '../mastra-model-control';
import { TOOL_REGISTRY_MAP } from '../../../tools/tool-registry';
import { emitActivityEvent } from './activity-bus';

const TOOL_ID = 'outreach-agent';

export const outreachAgentTool = createTool({
  id: TOOL_ID,
  description:
    'Delegate to the outreach specialist agent for publisher discovery and SEO inventory filtering queries.',
  inputSchema: z.object({
    query: z.string().describe('The outreach query to answer'),
  }),
  execute: async (inputData, context) => {
    const requestContext = context?.requestContext;
    const allowedToolIds = requestContext?.get('allowedToolIds') as string[] | undefined;
    if (allowedToolIds !== undefined && !allowedToolIds.includes(TOOL_ID)) {
      const name = TOOL_REGISTRY_MAP.get(TOOL_ID)?.name ?? TOOL_ID;
      return { answer: `Access to "${name}" is not permitted for your role. Please contact your admin.` };
    }

    const requestId = requestContext?.get('requestId') as string | undefined;
    const callId = randomUUID();
    if (requestId) {
      emitActivityEvent(requestId, 'activity', {
        id: callId,
        name: TOOL_ID,
        label: 'Searching Outreach publishers',
        icon: 'bar-chart-2',
      });
    }

    const runOptions = await buildMastraAgentRunOptions('mastra.outreach', { requestContext });
    const result = await outreachSpecialistAgent.generate(
      [{ role: 'user', content: inputData.query }],
      runOptions as any,
    );

    if (requestId) {
      emitActivityEvent(requestId, 'activity_done', {
        id: callId,
        name: TOOL_ID,
        label: 'Searched Outreach publishers',
        icon: 'bar-chart-2',
        resultSummary: result.text,
      });
    }
    return { answer: result.text };
  },
});
