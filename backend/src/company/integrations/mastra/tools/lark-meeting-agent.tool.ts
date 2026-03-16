import { createTool } from '@mastra/core/tools';
import { randomUUID } from 'crypto';
import { z } from 'zod';

import { larkMeetingSpecialistAgent } from '../agents/lark-meeting-specialist.agent';
import { buildMastraAgentRunOptions } from '../mastra-model-control';
import { larkOperationalResultSchema } from '../schemas/specialist-results.schema';
import { TOOL_REGISTRY_MAP } from '../../../tools/tool-registry';
import { emitActivityEvent } from './activity-bus';
import { normalizeLarkOperationalResult } from './specialist-result-helpers';

const TOOL_ID = 'lark-meeting-agent';
const DATE_ONLY_PATTERN = /\b(\d{4}-\d{2}-\d{2})\b/;

export const larkMeetingAgentTool = createTool({
  id: TOOL_ID,
  description: 'Delegate to the Lark meetings specialist for meeting lookup and minute retrieval.',
  inputSchema: z.object({
    query: z.string().describe('The Lark meeting or minute task to perform'),
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
        label: 'Working on Lark meetings',
        icon: 'video',
      });
    }

    const dateMatch = inputData.query.match(DATE_ONLY_PATTERN)?.[1];
    if (dateMatch && /\bmeetings?\b/i.test(inputData.query) && !/\bminute\b/i.test(inputData.query)) {
      const directResult = normalizeLarkOperationalResult(
        'Lark meeting read failed: date-only meeting discovery is not supported by the VC meetings API without a meeting number or meeting ID. Use Lark Calendar for day-based discovery, or provide a specific meeting identifier.',
      );

      if (requestId) {
        emitActivityEvent(requestId, 'activity_done', {
          id: callId,
          name: TOOL_ID,
          label: 'Reviewed Lark meetings',
          icon: 'video',
          resultSummary: directResult.summary,
        });
      }

      return directResult;
    }

    const runOptions = await buildMastraAgentRunOptions('mastra.lark-doc', { requestContext });
    const result = await larkMeetingSpecialistAgent.generate(
      [{ role: 'user', content: inputData.query }],
      runOptions as any,
    );

    const normalized = normalizeLarkOperationalResult(result.text);
    if (requestId) {
      emitActivityEvent(requestId, 'activity_done', {
        id: callId,
        name: TOOL_ID,
        label: normalized.success ? 'Reviewed Lark meetings' : 'Lark meeting flow failed',
        icon: normalized.success ? 'video' : 'x-circle',
        resultSummary: normalized.summary,
      });
    }

    return normalized;
  },
});
