import { tool } from 'ai';
import { z } from 'zod';

import type { VercelRuntimeRequestContext, VercelRuntimeToolHooks } from '../../types';

export const buildOutreachRuntimeTools = (
  runtime: VercelRuntimeRequestContext,
  hooks: VercelRuntimeToolHooks,
  helpers: Record<string, any>,
): Record<string, any> => {
  const { withLifecycle, buildEnvelope, loadOutreachReadAgent, buildAgentInvokeInput, asRecord, asArray, asString, toEnvelopeFromAgentResult } = helpers;

  const tools = {
    outreach: tool({
      description: 'Comprehensive Outreach publisher inventory tool.',
      inputSchema: z.object({
        operation: z.enum(['searchPublishers', 'getCampaign', 'summarizeInventory']),
        query: z.string().min(1),
        campaignId: z.string().optional(),
        filters: z.record(z.unknown()).optional(),
      }),
      execute: async (input) =>
        withLifecycle(hooks, 'outreach', 'Running Outreach workflow', async () => {
          if (input.operation === 'getCampaign') {
            return buildEnvelope({
              success: false,
              summary:
                'Outreach campaign lookup is not implemented in the current outreach integration. Use searchPublishers or summarizeInventory instead.',
              errorKind: 'unsupported',
              retryable: false,
            });
          }
          const agentResult = await loadOutreachReadAgent().invoke(
            buildAgentInvokeInput(runtime, 'outreach-read', input.query, {
              filters: input.filters,
              rawFilterString:
                typeof input.filters?.rawFilterString === 'string'
                  ? input.filters.rawFilterString
                  : undefined,
            }),
          );
          const result = asRecord(asRecord(agentResult)?.result);
          const records = asArray(result?.records)
            .map((entry) => asRecord(entry))
            .filter((entry): entry is Record<string, unknown> => Boolean(entry));
          const citations = records.flatMap((entry, index) => {
            const website = asString(entry.website);
            const id = asString(entry.id) ?? website;
            if (!id) return [];
            return [
              {
                id: `outreach-${index + 1}`,
                title: website ?? id,
                url: website ? `https://${website.replace(/^https?:\/\//i, '')}` : undefined,
                kind: 'record',
                sourceType: 'outreach',
                sourceId: id,
              },
            ];
          });
          return toEnvelopeFromAgentResult(agentResult, {
            keyData: {
              campaignId: input.campaignId,
              recipientCount: records.length,
            },
            fullPayload: result,
            citations,
          });
        }),
    }),
  };

  return tools;
};
