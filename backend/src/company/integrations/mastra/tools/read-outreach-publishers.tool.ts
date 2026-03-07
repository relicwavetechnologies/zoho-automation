import { randomUUID } from 'crypto';

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { agentRegistry } from '../../../agents';
import { TOOL_REGISTRY_MAP } from '../../../tools/tool-registry';

const TOOL_ID = 'read-outreach-publishers';

export const readOutreachPublishersTool = createTool({
  id: TOOL_ID,
  description:
    'Fetch outreach publisher inventory using URL/DA/DR/country/price filters. ' +
    'Use for outreach SEO dataset queries and publisher shortlist requests.',
  inputSchema: z.object({
    objective: z
      .string()
      .describe('Outreach query objective, e.g. "Find technology publishers for acme.com with DA > 50"'),
    rawFilterString: z
      .string()
      .describe(
        'SQL-like template string for exact filtering (e.g., `"niche" LIKE \'%tech%\' AND "domainAuthority" >= 50`). Supports: = (exact), LIKE (contains), >=, <=, etc. For URL domains, use `LIKE \'%domain.com%\'` instead of exact `=`.'
      )
      .optional(),
    limit: z.number().int().min(1).max(25).optional().default(10),
  }),
  execute: async (inputData, context) => {
    const requestContext = context?.requestContext;
    const allowedToolIds = requestContext?.get('allowedToolIds') as string[] | undefined;
    if (allowedToolIds !== undefined && !allowedToolIds.includes(TOOL_ID)) {
      const name = TOOL_REGISTRY_MAP.get(TOOL_ID)?.name ?? TOOL_ID;
      return {
        answer: null,
        records: [],
        sourceRefs: [],
        error: `Access to "${name}" is not permitted for your role. Please contact your admin.`,
      };
    }

    const result = await agentRegistry.invoke({
      taskId: `mastra_tool_${randomUUID()}`,
      agentKey: 'outreach-read',
      objective: inputData.objective,
      correlationId: randomUUID(),
      constraints: ['mastra-tool'],
      contextPacket: {
        companyId: requestContext?.get('companyId'),
        userId: requestContext?.get('userId'),
        chatId: requestContext?.get('chatId'),
        filters: requestContext?.get('outreachFilters'),
        rawFilterString: inputData.rawFilterString,
        limit: inputData.limit,
      },
    });

    return {
      answer: result.status === 'success' ? result.message : null,
      records: (result.result?.['records'] as Array<Record<string, unknown>> | undefined) ?? [],
      sourceRefs:
        (result.result?.['sourceRefs'] as Array<{ source?: string; id?: string }> | undefined) ?? [],
      filtersApplied: (result.result?.['filtersApplied'] as string | undefined) ?? '',
      error: result.status !== 'success' ? result.message : null,
    };
  },
});
