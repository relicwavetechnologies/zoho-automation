import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { randomUUID } from 'crypto';

import { searchAgent } from '../agents/search.agent';
import { buildMastraAgentRunOptions } from '../mastra-model-control';
import { searchResultSchema } from '../schemas/specialist-results.schema';
import { TOOL_REGISTRY_MAP } from '../../../tools/tool-registry';
import { emitActivityEvent } from './activity-bus';
import {
  buildStructuredJsonPrompt,
  coerceSchema,
  extractUrls,
  hasFailureSignal,
  summarizeSpecialistText,
} from './specialist-result-helpers';

const TOOL_ID = 'search-agent';

export const searchAgentTool = createTool({
  id: TOOL_ID,
  description:
    'Delegate to the research agent for external web search, exact-site page context extraction, and authorized company document retrieval.',
  inputSchema: z.object({
    query: z.string().describe('The search query'),
    taskId: z.string().optional().describe('Optional plan task identifier for execution tracking.'),
  }),
  outputSchema: searchResultSchema,
  execute: async (inputData, context) => {
    const requestContext = context?.requestContext;
    const allowedToolIds = requestContext?.get('allowedToolIds') as string[] | undefined;
    if (allowedToolIds !== undefined && !allowedToolIds.includes(TOOL_ID)) {
      const name = TOOL_REGISTRY_MAP.get(TOOL_ID)?.name ?? TOOL_ID;
      return {
        success: false,
        resultCount: 0,
        summary: `Access to "${name}" is not permitted for your role. Please contact your admin.`,
        sources: [],
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
        id: callId, name: TOOL_ID, label: 'Searching the web', icon: 'globe',
      });
    }

    const runOptions = await buildMastraAgentRunOptions('mastra.search', { requestContext });
    const result = await searchAgent.generate(
      [{
        role: 'user',
        content: buildStructuredJsonPrompt(
          inputData.query,
          '{"success":boolean,"resultCount":"number","summary":"string","sources":["string"]}',
        ),
      }],
      runOptions as any,
    );

    // Try to extract raw tool calls/metadata from the agent run to build structured citations
    let citationsData = result.text;
    let sourceUrls = extractUrls(result.text);
    try {
      const resultAny = result as any;
      const runContext = resultAny.info?.calls?.[0] || {};
      const toolResults = Object.values(runContext)?.filter((c: any) => c?.toolName === 'search-read');
      if (toolResults.length > 0) {
        const payload = toolResults[0] as any;
        const items = payload?.result?.sourceRefs || payload?.result?.items || [];
        const queries = payload?.result?.query ? [payload.result.query] : [];
        if (payload?.result?.focusedSiteSearch) queries.push(payload.result.focusedSiteSearch);
        sourceUrls = items
          .map((item: any) => (typeof item?.url === 'string' ? item.url : null))
          .filter((url: string | null): url is string => Boolean(url));

        // Wrap it in a JSON block so the frontend BlocksRenderer knows it's structured data
        citationsData = JSON.stringify({
          type: 'structured_search',
          queries,
          sources: items.map((i: any) => ({ title: i.title, url: i.url, snippet: i.snippet })),
          answer: result.text
        });
      }
    } catch (e) { /* fallback to text */ }

    const summary = summarizeSpecialistText(result.text);
    const coerced = coerceSchema(searchResultSchema, result.text) ?? {
      success: !hasFailureSignal(summary),
      resultCount: sourceUrls.length,
      summary,
      sources: sourceUrls.length > 0 ? sourceUrls : undefined,
    };

    if (requestId) {
      emitActivityEvent(requestId, 'activity_done', {
        id: callId,
        name: TOOL_ID,
        label: 'Searched the web',
        icon: 'globe',
        taskId,
        resultSummary: citationsData,
      });
    }
    return searchResultSchema.parse(coerced);
  },
});
