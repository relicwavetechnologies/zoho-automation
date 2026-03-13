import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { randomUUID } from 'crypto';

import { outreachSpecialistAgent } from '../agents/outreach-specialist.agent';
import { buildMastraAgentRunOptions } from '../mastra-model-control';
import { outreachResultSchema } from '../schemas/specialist-results.schema';
import { TOOL_REGISTRY_MAP } from '../../../tools/tool-registry';
import { emitActivityEvent } from './activity-bus';
import {
  buildStructuredJsonPrompt,
  coerceSchema,
  extractRecordId,
  hasFailureSignal,
  summarizeSpecialistText,
} from './specialist-result-helpers';

const TOOL_ID = 'outreach-agent';

export const outreachAgentTool = createTool({
  id: TOOL_ID,
  description:
    'Delegate to the outreach specialist agent for publisher discovery and SEO inventory filtering queries.',
  inputSchema: z.object({
    query: z.string().describe('The outreach query to answer'),
    taskId: z.string().optional().describe('Optional plan task identifier for execution tracking.'),
  }),
  outputSchema: outreachResultSchema,
  execute: async (inputData, context) => {
    const requestContext = context?.requestContext;
    const allowedToolIds = requestContext?.get('allowedToolIds') as string[] | undefined;
    if (allowedToolIds !== undefined && !allowedToolIds.includes(TOOL_ID)) {
      const name = TOOL_REGISTRY_MAP.get(TOOL_ID)?.name ?? TOOL_ID;
      return {
        success: false,
        summary: `Access to "${name}" is not permitted for your role. Please contact your admin.`,
        error: `Access to "${name}" is not permitted for your role. Please contact your admin.`,
      };
    }

    const requestId = requestContext?.get('requestId') as string | undefined;
    const taskId =
      inputData.taskId
      ?? (requestContext?.get('activePlanTaskId') as string | undefined)
      ?? null;
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
      [{
        role: 'user',
        content: buildStructuredJsonPrompt(
          inputData.query,
          '{"success":boolean,"campaignId":"string?","recipientCount":"number?","summary":"string","error":"string?"}',
        ),
      }],
      runOptions as any,
    );

    const summary = summarizeSpecialistText(result.text);
    const coerced = coerceSchema(outreachResultSchema, result.text) ?? {
      success: !hasFailureSignal(summary),
      campaignId: extractRecordId(summary),
      recipientCount: (() => {
        const count = summary.match(/\b(\d+)\s+(?:publishers|recipients|matches)\b/i)?.[1];
        return count ? Number(count) : undefined;
      })(),
      summary,
      error: hasFailureSignal(summary) ? summary : undefined,
    };

    const parsedResult = outreachResultSchema.parse(coerced);

    if (requestId) {
      emitActivityEvent(requestId, 'activity_done', {
        id: callId,
        name: TOOL_ID,
        label: 'Searched Outreach publishers',
        icon: 'bar-chart-2',
        taskId,
        externalRef: parsedResult.campaignId,
        resultSummary: result.text,
      });
    }
    return parsedResult;
  },
});
