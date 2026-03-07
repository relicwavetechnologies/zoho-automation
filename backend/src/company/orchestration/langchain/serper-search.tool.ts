import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

import { webSearchService } from '../../integrations/search';

const serperSearchSchema = z.object({
  query: z.string().min(1).describe('The web search query'),
  exactDomain: z.string().optional().describe('Optional domain to search with a second exact-site pass'),
  searchResultsLimit: z.number().int().min(1).max(8).optional(),
  pageContextLimit: z.number().int().min(0).max(4).optional(),
});

export const serperSearchTool = new DynamicStructuredTool({
  name: 'serper_search_with_page_context',
  description:
    'Search the web via Serper, optionally run an exact-site pass, and fetch result pages for page context.',
  schema: serperSearchSchema as z.ZodTypeAny,
  func: async (input: z.infer<typeof serperSearchSchema>) => {
    const result = await webSearchService.search({
      query: input.query,
      exactDomain: input.exactDomain,
      searchResultsLimit: input.searchResultsLimit,
      pageContextLimit: input.pageContextLimit,
    });

    return JSON.stringify({
      query: result.query,
      exactDomain: result.exactDomain,
      focusedSiteSearch: result.focusedSiteSearch,
      items: result.items,
      sourceRefs: result.sourceRefs,
    });
  },
} as any);
