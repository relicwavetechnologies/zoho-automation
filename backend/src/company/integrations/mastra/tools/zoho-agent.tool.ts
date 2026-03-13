import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { randomUUID } from 'crypto';

import { zohoSpecialistAgent } from '../agents/zoho-specialist.agent';
import { buildMastraAgentRunOptions } from '../mastra-model-control';
import { zohoResultSchema } from '../schemas/specialist-results.schema';
import { TOOL_REGISTRY_MAP } from '../../../tools/tool-registry';
import { emitActivityEvent } from './activity-bus';
import {
  buildStructuredJsonPrompt,
  coerceSchema,
  extractZohoRecordId,
  hasFailureSignal,
  summarizeSpecialistText,
} from './specialist-result-helpers';

const TOOL_ID = 'zoho-agent';

export const zohoAgentTool = createTool({
  id: TOOL_ID,
  description:
    'Delegate to the Zoho CRM specialist agent for any CRM data queries: ' +
    'deals, contacts, tickets, pipeline risk, health reports, next-action recommendations. ' +
    'Always use this for Zoho-specific questions.',
  inputSchema: z.object({
    query: z.string().describe('The CRM question to answer'),
    taskId: z.string().optional().describe('Optional plan task identifier for execution tracking.'),
  }),
  outputSchema: zohoResultSchema,
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
        id: callId, name: TOOL_ID, label: 'Querying Zoho CRM', icon: 'search',
      });
    }

    const runOptions = await buildMastraAgentRunOptions('mastra.zoho-specialist', { requestContext });
    const result = await zohoSpecialistAgent.generate(
      [{
        role: 'user',
        content: buildStructuredJsonPrompt(
          inputData.query,
          '{"success":boolean,"recordId":"string?","recordType":"string?","summary":"string","error":"string?"}',
        ),
      }],
      runOptions as any,
    );

    const summary = summarizeSpecialistText(result.text);
    const coerced = coerceSchema(zohoResultSchema, result.text) ?? {
      success: !hasFailureSignal(summary),
      recordId: extractZohoRecordId(summary) ?? extractZohoRecordId(inputData.query),
      recordType: /\bdeal\b/i.test(summary)
        ? 'deal'
        : /\bcontact\b/i.test(summary)
          ? 'contact'
          : /\blead\b/i.test(summary)
            ? 'lead'
            : /\bticket\b/i.test(summary)
              ? 'ticket'
              : undefined,
      summary,
      error: hasFailureSignal(summary) ? summary : undefined,
    };

    const parsedResult = zohoResultSchema.parse(coerced);

    if (requestId) {
      emitActivityEvent(requestId, 'activity_done', {
        id: callId,
        name: TOOL_ID,
        label: 'Queried Zoho CRM',
        icon: 'search',
        taskId,
        externalRef: parsedResult.recordId,
        resultSummary: result.text,
      });
    }
    return parsedResult;
  },
});
