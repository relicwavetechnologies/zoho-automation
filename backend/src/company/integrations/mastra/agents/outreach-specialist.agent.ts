import { Agent } from '@mastra/core/agent';
import { openai } from '@ai-sdk/openai';

import { readOutreachPublishersTool } from '../tools/read-outreach-publishers.tool';

export const outreachSpecialistAgent = new Agent({
  id: 'outreach-specialist',
  name: 'Outreach Specialist',
  instructions: `You are an outreach data specialist for publisher inventory.

Use read-outreach-publishers for:
- publisher discovery by client URL/domain
- DA/DR filtering
- country/language/niche and pricing filters

Rules:
1. Call at most one tool per response turn.
2. Use the tool for data queries; do not invent publisher records.
3. Present concise, user-friendly results with the most relevant rows first.
4. If no data is returned, explain that clearly and suggest how to refine filters.`,
  model: openai('gpt-4o-mini'),
  tools: { readOutreachPublishersTool },
});
