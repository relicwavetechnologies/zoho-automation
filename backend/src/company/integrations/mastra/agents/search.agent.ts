import { Agent } from '@mastra/core/agent';
import { openai } from '@ai-sdk/openai';

import { zohoSearchTool } from '../tools/zoho-search.tool';

export const searchAgent = new Agent({
  id: 'search-agent',
  name: 'Context Search Agent',
  instructions: `You search indexed CRM context to answer general queries.

Use search-zoho-context to find relevant records, then summarize what you found in a clear, concise way.
If no results are found, say so directly.`,
  model: openai('gpt-4o-mini'),
  tools: { zohoSearchTool },
});
