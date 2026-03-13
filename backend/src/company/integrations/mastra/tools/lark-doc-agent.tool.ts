import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { randomUUID } from 'crypto';

import { larkDocSpecialistAgent } from '../agents/lark-doc-specialist.agent';
import { buildMastraAgentRunOptions } from '../mastra-model-control';
import { larkDocResultSchema } from '../schemas/specialist-results.schema';
import { TOOL_REGISTRY_MAP } from '../../../tools/tool-registry';
import { emitActivityEvent } from './activity-bus';
import {
  buildStructuredJsonPrompt,
  coerceSchema,
  extractFirstUrl,
  extractLarkDocToken,
  hasFailureSignal,
  summarizeSpecialistText,
} from './specialist-result-helpers';

const TOOL_ID = 'lark-doc-agent';

export const larkDocAgentTool = createTool({
  id: TOOL_ID,
  description:
    'Delegate to the Lark Docs specialist for final document creation and markdown export into Lark Docs. Use this only after the required CRM, outreach, search, or other grounded work has already been completed in the current task. Do not use this as the first step for a multi-domain research workflow.',
  inputSchema: z.object({
    query: z.string().describe('The user request for the document to create'),
    taskId: z.string().optional().describe('Optional plan task identifier for execution tracking.'),
  }),
  outputSchema: larkDocResultSchema,
  execute: async (inputData, context) => {
    const requestContext = context?.requestContext;
    const allowedToolIds = requestContext?.get('allowedToolIds') as string[] | undefined;
    if (allowedToolIds !== undefined && !allowedToolIds.includes(TOOL_ID)) {
      const name = TOOL_REGISTRY_MAP.get(TOOL_ID)?.name ?? TOOL_ID;
      return {
        success: false,
        operation: 'read',
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
        label: 'Working on Lark document',
        icon: 'file-text',
      });
    }

    const runOptions = await buildMastraAgentRunOptions('mastra.lark-doc', { requestContext });
    const result = await larkDocSpecialistAgent.generate(
      [{
        role: 'user',
        content: buildStructuredJsonPrompt(
          inputData.query,
          '{"success":boolean,"docToken":"string?","docUrl":"string?","operation":"created|updated|read","summary":"string","error":"string?"}',
        ),
      }],
      runOptions as any,
    );

    const summary = summarizeSpecialistText(result.text);
    const docUrl = extractFirstUrl(summary);
    const operation = /\bcreated\b/i.test(summary)
      ? 'created'
      : /\bupdated\b/i.test(summary)
        ? 'updated'
        : 'read';
    const coerced = coerceSchema(larkDocResultSchema, result.text) ?? {
      success: !hasFailureSignal(summary),
      docToken: extractLarkDocToken(summary),
      docUrl,
      operation,
      summary,
      error: hasFailureSignal(summary) ? summary : undefined,
    };

    const parsedResult = larkDocResultSchema.parse(coerced);

    if (requestId) {
      emitActivityEvent(requestId, 'activity_done', {
        id: callId,
        name: TOOL_ID,
        label: 'Updated Lark document',
        icon: 'file-text',
        taskId,
        externalRef: parsedResult.docToken ?? parsedResult.docUrl,
        resultSummary: result.text,
      });
    }

    return parsedResult;
  },
});
