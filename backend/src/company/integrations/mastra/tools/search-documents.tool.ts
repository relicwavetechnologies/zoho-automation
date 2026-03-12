import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { randomUUID } from 'crypto';

import type { VectorSearchResult } from '../../../integrations/vector/vector-store.adapter';
import { embeddingService } from '../../../integrations/embedding';
import { qdrantAdapter } from '../../../integrations/vector/qdrant.adapter';
import { TOOL_REGISTRY_MAP } from '../../../tools/tool-registry';
import { emitActivityEvent } from './activity-bus';

export const searchDocumentsTool = createTool({
  id: 'search-documents',
  description:
    'Search uploaded company documents (PDFs, DOCX, images) for relevant information. Respects RBAC — only returns content the requesting user is authorized to see. Use when the user asks about internal documents, policies, HR guidelines, or uploaded files.',
  inputSchema: z.object({
    query: z.string().min(1).describe('Search query to find relevant document content'),
    limit: z.number().int().min(1).max(10).optional().default(5).describe('Max chunks to return'),
  }),
  execute: async (inputData, context) => {
    const requestContext = context?.requestContext;
    const allowedToolIds = requestContext?.get('allowedToolIds') as string[] | undefined;
    if (allowedToolIds !== undefined && !allowedToolIds.includes('search-documents')) {
      const name = TOOL_REGISTRY_MAP.get('search-documents')?.name ?? 'Search Documents';
      return { answer: `Access to "${name}" is not permitted for your role.` };
    }

    const companyId = requestContext?.get('companyId') as string | undefined;
    const userAiRole = requestContext?.get('userAiRole') as string | undefined;
    const requestId = requestContext?.get('requestId') as string | undefined;
    const callId = randomUUID();

    if (!companyId) return { answer: 'No company context available.' };

    if (requestId) {
      emitActivityEvent(requestId, 'activity', {
        id: callId,
        name: 'search-documents',
        label: 'Searching company documents',
        icon: 'file-search',
      });
    }

    try {
      const [queryVector] = await embeddingService.embed([inputData.query]);

      const results = await qdrantAdapter.search({
        companyId,
        vector: queryVector,
        limit: inputData.limit ?? 5,
        sourceTypes: ['file_document'],
        includeShared: true,
        includePersonal: false,
        includePublic: false,
        requesterAiRole: userAiRole,
      });

      if (results.length === 0) {
        if (requestId) {
          emitActivityEvent(requestId, 'activity_done', {
            id: callId,
            name: 'search-documents',
            label: 'No matching documents found',
            icon: 'file-search',
            resultSummary: 'No results',
          });
        }
        return { answer: 'No relevant document content found for your query.' };
      }

      const chunks = results
        .map((r: VectorSearchResult, i: number) => {
          const text =
            typeof r.payload._chunk === 'string'
              ? r.payload._chunk
              : typeof r.payload.text === 'string'
                ? r.payload.text
                : '';
          const fileName = typeof r.payload.fileName === 'string' ? r.payload.fileName : 'document';
          return `[${i + 1}] From "${fileName}" (score: ${r.score.toFixed(3)}):\n${text}`;
        })
        .join('\n\n');

      if (requestId) {
        emitActivityEvent(requestId, 'activity_done', {
          id: callId,
          name: 'search-documents',
          label: 'Document search complete',
          icon: 'file-search',
          resultSummary: `${results.length} sections found`,
        });
      }

      return { answer: `Found ${results.length} relevant document section(s):\n\n${chunks}` };
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'unknown_error';
      if (requestId) {
        emitActivityEvent(requestId, 'activity_done', {
          id: callId,
          name: 'search-documents',
          label: 'Document search failed',
          icon: 'x-circle',
          resultSummary: 'Error',
        });
      }
      return { answer: `Document search failed: ${msg}` };
    }
  },
});
