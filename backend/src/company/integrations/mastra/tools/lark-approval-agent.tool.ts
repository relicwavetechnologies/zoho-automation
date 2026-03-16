import { createTool } from '@mastra/core/tools';
import { randomUUID } from 'crypto';
import { z } from 'zod';

import { larkApprovalSpecialistAgent } from '../agents/lark-approval-specialist.agent';
import { buildMastraAgentRunOptions } from '../mastra-model-control';
import { larkOperationalResultSchema } from '../schemas/specialist-results.schema';
import { TOOL_REGISTRY_MAP } from '../../../tools/tool-registry';
import { emitActivityEvent } from './activity-bus';
import { normalizeLarkOperationalResult } from './specialist-result-helpers';

const TOOL_ID = 'lark-approval-agent';

export const larkApprovalAgentTool = createTool({
  id: TOOL_ID,
  description: 'Delegate to the Lark approval specialist for approval instance creation and status lookup.',
  inputSchema: z.object({
    query: z.string().describe('The Lark approval task to perform'),
  }),
  outputSchema: larkOperationalResultSchema,
  execute: async (inputData, context) => {
    const requestContext = context?.requestContext;
    const allowedToolIds = requestContext?.get('allowedToolIds') as string[] | undefined;
    if (allowedToolIds !== undefined && !allowedToolIds.includes(TOOL_ID)) {
      const name = TOOL_REGISTRY_MAP.get(TOOL_ID)?.name ?? TOOL_ID;
      return normalizeLarkOperationalResult(`Access to "${name}" is not permitted for your role. Please contact your admin.`);
    }

    const requestId = requestContext?.get('requestId') as string | undefined;
    const callId = randomUUID();
    if (requestId) {
      emitActivityEvent(requestId, 'activity', {
        id: callId,
        name: TOOL_ID,
        label: 'Working on Lark approvals',
        icon: 'badge-check',
      });
    }

    const runOptions = await buildMastraAgentRunOptions('mastra.lark-doc', { requestContext });
    const result = await larkApprovalSpecialistAgent.generate(
      [{ role: 'user', content: inputData.query }],
      runOptions as any,
    );

    const normalized = normalizeLarkOperationalResult(result.text);
    if (requestId) {
      emitActivityEvent(requestId, 'activity_done', {
        id: callId,
        name: TOOL_ID,
        label: normalized.success ? 'Updated Lark approvals' : 'Lark approval flow failed',
        icon: normalized.success ? 'badge-check' : 'x-circle',
        resultSummary: normalized.summary,
      });
    }

    return normalized;
  },
});
