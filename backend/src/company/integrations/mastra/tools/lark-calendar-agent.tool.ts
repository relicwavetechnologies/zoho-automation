import { createTool } from '@mastra/core/tools';
import { randomUUID } from 'crypto';
import { z } from 'zod';

import { larkCalendarSpecialistAgent } from '../agents/lark-calendar-specialist.agent';
import { buildMastraAgentRunOptions } from '../mastra-model-control';
import { larkOperationalResultSchema } from '../schemas/specialist-results.schema';
import { TOOL_REGISTRY_MAP } from '../../../tools/tool-registry';
import { emitActivityEvent } from './activity-bus';
import { normalizeLarkOperationalResult } from './specialist-result-helpers';

const TOOL_ID = 'lark-calendar-agent';

const buildTemporalContext = (requestContext?: { get: (key: string) => unknown }): string => {
  const timeZone = (requestContext?.get('timeZone') as string | undefined)?.trim() || 'UTC';
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const today = formatter.format(now);
  return `Current date context: today is ${today} in timezone ${timeZone}. Interpret relative phrases like "today", "tomorrow", and "this week" using this date context.`;
};

export const larkCalendarAgentTool = createTool({
  id: TOOL_ID,
  description: 'Delegate to the Lark Calendar specialist for event scheduling and calendar lookups.',
  inputSchema: z.object({
    query: z.string().describe('The Lark calendar task to perform'),
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
        label: 'Working on Lark calendar',
        icon: 'calendar-days',
      });
    }

    const runOptions = await buildMastraAgentRunOptions('mastra.lark-doc', { requestContext });
    const temporalContext = buildTemporalContext(requestContext as { get: (key: string) => unknown } | undefined);
    const result = await larkCalendarSpecialistAgent.generate(
      [{
        role: 'user',
        content: `${temporalContext}\n\nUser request: ${inputData.query}`,
      }],
      runOptions as any,
    );

    const normalized = normalizeLarkOperationalResult(result.text);
    if (requestId) {
      emitActivityEvent(requestId, 'activity_done', {
        id: callId,
        name: TOOL_ID,
        label: normalized.success ? 'Updated Lark calendar' : 'Lark calendar flow failed',
        icon: normalized.success ? 'calendar-days' : 'x-circle',
        resultSummary: normalized.summary,
      });
    }

    return normalized;
  },
});
