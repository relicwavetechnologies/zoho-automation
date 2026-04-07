import { tool } from 'ai';
import { z } from 'zod';

import { contextSearchBrokerService } from '../../../../retrieval/context-search-broker.service';
import { redDebug } from '../../../../../utils/red-debug';
import type { VercelCitation, VercelRuntimeRequestContext, VercelRuntimeToolHooks } from '../../types';

type ContextSearchRuntimeHelpers = {
  buildEnvelope: (input: Record<string, unknown>) => any;
  withLifecycle: (
    hooks: VercelRuntimeToolHooks,
    toolName: string,
    title: string,
    run: () => Promise<any>,
  ) => Promise<any>;
  inferErrorKind: (summary: string) => string | undefined;
  asRecord: (value: unknown) => Record<string, unknown> | null;
  asString: (value: unknown) => string | undefined;
  uniqueDefinedStrings: (values: Array<string | undefined | null>) => string[];
  loadFileRetrievalService: () => {
    search: (input: Record<string, unknown>) => Promise<Record<string, any>>;
    readChunkContext: (input: Record<string, unknown>) => Promise<{ text: string; source: string }>;
  };
  parseContextSearchDate: (value: string | undefined, boundary: 'start' | 'end') => Date | undefined;
  normalizeContextSearchSources: (input: Record<string, unknown>) => Record<string, unknown> | undefined;
  scopeContextSearchSourcesForAgent: (input: Record<string, unknown>) => Record<string, unknown> | undefined;
  CONTEXT_SEARCH_SCOPE_VALUES: readonly [string, ...string[]];
};

export const buildContextSearchRuntimeTools = (
  runtime: VercelRuntimeRequestContext,
  hooks: VercelRuntimeToolHooks,
  helpers: ContextSearchRuntimeHelpers,
): Record<string, any> => ({
  webSearch: tool({
    description:
      'Compatibility shim for public web retrieval. Prefer contextSearch with sources.web=true for all new retrieval.',
    inputSchema: z.object({
      operation: z.enum(['search', 'focusedSearch', 'fetchPageContext']),
      query: z.string().min(1),
      site: z.string().optional(),
      limit: z.number().int().min(1).max(10).optional(),
    }),
    execute: async (input) =>
      helpers.withLifecycle(hooks, 'webSearch', 'Searching the web', async () => {
        try {
          const result = await contextSearchBrokerService.search({
            runtime,
            query: input.query,
            limit: input.limit,
            site: input.site,
            webMode: input.operation,
            sources: {
              personalHistory: false,
              files: false,
              larkContacts: false,
              zohoCrmContext: false,
              workspace: false,
              web: true,
              skills: false,
            },
          });
          const topResult = result.results[0] ?? null;
          const citations = contextSearchBrokerService.toVercelCitationsFromSearch(result);
          return helpers.buildEnvelope({
            success: true,
            summary:
              result.results.length > 0
                ? `Found ${result.results.length} public web result(s) for "${input.query}".`
                : `No public web results matched "${input.query}".`,
            keyData: {
              selectedResult: topResult,
              resolvedEntities: result.resolvedEntities,
              urls: helpers.uniqueDefinedStrings(citations.map((citation) => citation.url)),
            },
            fullPayload: {
              query: input.query,
              exactDomain: input.site?.trim() || undefined,
              focusedSiteSearch: Boolean(input.site?.trim()),
              crawlUsed: input.operation === 'fetchPageContext',
              crawlUrl: input.operation === 'fetchPageContext' ? input.query : undefined,
              searchResults: result.results,
              results: result.results,
              matches: result.matches,
              resolvedEntities: result.resolvedEntities,
              sourceCoverage: result.sourceCoverage,
              nextFetchRefs: result.nextFetchRefs,
              searchSummary: result.searchSummary,
            },
            citations,
          });
        } catch (error) {
          const summary = error instanceof Error ? error.message : 'Web search failed.';
          return helpers.buildEnvelope({
            success: false,
            summary,
            errorKind: helpers.inferErrorKind(summary),
            retryable: true,
          });
        }
      }),
  }),

  docSearch: tool({
    description:
      'Internal company document search only. Use this before workspace, Google Drive, or repo inspection when the user is asking about uploaded files, private docs, or indexed company documents.',
    inputSchema: z.discriminatedUnion('operation', [
      z.object({
        operation: z.literal('search'),
        query: z.string().min(1),
        fileAssetId: z.string().optional(),
        limit: z.number().int().min(1).max(10).optional(),
      }),
      z.object({
        operation: z.literal('readChunkContext'),
        fileAssetId: z.string().min(1),
        chunkIndex: z.number().int().min(0).optional(),
        query: z.string().optional(),
        limit: z.number().int().min(1).max(10).optional(),
      }),
    ]),
    execute: async (input) =>
      helpers.withLifecycle(hooks, 'docSearch', 'Searching internal documents', async () => {
        if (input.operation === 'readChunkContext') {
          if (!input.fileAssetId?.trim()) {
            return helpers.buildEnvelope({
              success: false,
              summary: 'readChunkContext requires fileAssetId.',
              errorKind: 'missing_input',
              retryable: false,
            });
          }

          const context = await helpers.loadFileRetrievalService().readChunkContext({
            companyId: runtime.companyId,
            fileAssetId: input.fileAssetId.trim(),
            chunkIndex: input.chunkIndex,
          });

          if (!context.text.trim()) {
            return helpers.buildEnvelope({
              success: false,
              summary: 'No chunk context was found for that file reference.',
              errorKind: 'not_found',
              retryable: false,
            });
          }

          return helpers.buildEnvelope({
            success: true,
            summary: `Loaded ${context.source.replace(/_/g, ' ')} context for file ${input.fileAssetId.trim()}.`,
            keyData: {
              fileAssetId: input.fileAssetId.trim(),
              chunkIndex: input.chunkIndex,
              source: context.source,
            },
            fullPayload: {
              fileAssetId: input.fileAssetId.trim(),
              chunkIndex: input.chunkIndex,
              source: context.source,
              text: context.text,
            },
            citations: [
              {
                id: `file-${input.fileAssetId.trim()}-${input.chunkIndex ?? 0}`,
                title: input.fileAssetId.trim(),
                kind: 'file',
                sourceType: 'file_document',
                sourceId: input.fileAssetId.trim(),
                fileAssetId: input.fileAssetId.trim(),
                chunkIndex: input.chunkIndex,
              },
            ],
          });
        }

        const limit = Math.max(1, Math.min(10, input.limit ?? 5));
        const searchResult = await helpers.loadFileRetrievalService().search({
          companyId: runtime.companyId,
          query: input.query,
          fileAssetId: input.fileAssetId?.trim(),
          limit,
          requesterAiRole: runtime.requesterAiRole,
          requesterUserId: runtime.userId,
          preferParentContext: true,
        });
        const citations = searchResult.citations.filter((entry: unknown): entry is VercelCitation =>
          Boolean(entry),
        );
        const normalizedMatches = searchResult.matches.map((match: unknown) => {
          const payload = helpers.asRecord(match) ?? {};
          return {
            id: helpers.asString(payload.id) ?? 'file_document:unknown',
            fileName: helpers.asString(payload.fileName) ?? 'document',
            text: helpers.asString(payload.text) ?? '',
            displayText: helpers.asString(payload.displayText) ?? helpers.asString(payload.text) ?? '',
            modality: helpers.asString(payload.modality) ?? 'text',
            url: helpers.asString(payload.url),
            score: typeof payload.score === 'number' ? payload.score : undefined,
            sourceId: helpers.asString(payload.sourceId),
            chunkIndex: typeof payload.chunkIndex === 'number' ? payload.chunkIndex : undefined,
            documentClass: helpers.asString(payload.documentClass),
            chunkingStrategy: helpers.asString(payload.chunkingStrategy),
            sectionPath: Array.isArray(payload.sectionPath) ? payload.sectionPath : [],
          };
        });
        return helpers.buildEnvelope({
          success: true,
          summary:
            normalizedMatches.length > 0
              ? `Found ${normalizedMatches.length} relevant internal document section(s).`
              : 'No relevant internal document content matched the request.',
          keyData: {
            documentIds: helpers.uniqueDefinedStrings(
              citations.map((citation) => citation.sourceId),
            ),
            queriesUsed: searchResult.queriesUsed,
            enhancements: searchResult.enhancements,
          },
          fullPayload: {
            matches: normalizedMatches,
            queriesUsed: searchResult.queriesUsed,
            enhancements: searchResult.enhancements,
            correctiveRetryUsed: searchResult.correctiveRetryUsed,
          },
          citations,
        });
      }),
  }),

  contextSearch: tool({
    description:
      'Unified retrieval broker for conversation history, indexed files, Lark contacts, Zoho context, workspace search, public web search, and skills. Use the narrowest possible source selection for the task at hand. Scope guidance: personal_history for conversation recall or prior email/body lookup, files for documents and uploaded files, lark_contacts for people/recipient lookup, zoho_crm for CRM records, and all only when you genuinely need multiple internal sources simultaneously or do not know which source is relevant. Web, workspace, and skills are selected via the sources object. Use search first, then fetch with a returned chunkRef when you need the full content.',
    inputSchema: z.object({
      operation: z.enum(['search', 'fetch']),
      query: z.string().optional(),
      scopes: z
        .array(z.enum(helpers.CONTEXT_SEARCH_SCOPE_VALUES as any))
        .optional()
        .default(['all'])
        .describe(
          'Explicit search scope selector. Use personal_history for conversation recall or prior email/body content, files for documents, lark_contacts for people and recipient lookup, zoho_crm for CRM records, and all only when you genuinely need multiple internal sources simultaneously or are truly unsure which internal source has the answer. Web, workspace, and skills are controlled by the sources object, not this array.',
        ),
      sources: z
        .object({
          personalHistory: z.boolean().optional(),
          files: z.boolean().optional(),
          larkContacts: z.boolean().optional(),
          zohoCrmContext: z.boolean().optional(),
          zohoBooksLive: z.boolean().optional(),
          workspace: z.boolean().optional(),
          web: z.boolean().optional(),
          skills: z.boolean().optional(),
        })
        .optional(),
      limit: z.number().int().min(1).max(25).optional().default(5),
      dateFrom: z.string().optional(),
      dateTo: z.string().optional(),
      chunkRef: z.string().optional(),
    }),
    execute: async (input) =>
      helpers.withLifecycle(hooks, 'contextSearch', 'Searching memory and context', async () => {
        if (input.operation === 'fetch') {
          const chunkRef = input.chunkRef?.trim();
          if (!chunkRef) {
            return helpers.buildEnvelope({
              success: false,
              summary: 'fetch requires chunkRef.',
              errorKind: 'missing_input',
              retryable: false,
              missingFields: ['chunkRef'],
              userAction: 'Use a chunkRef returned from a contextSearch search call.',
            });
          }

          const fetched = await contextSearchBrokerService.fetch({
            runtime,
            chunkRef,
          });
          if (!fetched?.text.trim()) {
            return helpers.buildEnvelope({
              success: false,
              summary: `No content found for chunkRef: ${chunkRef}`,
              errorKind: 'not_found',
              retryable: false,
              keyData: { resultCount: 0 },
            });
          }

          return helpers.buildEnvelope({
            success: true,
            summary: `Full content retrieved for ${chunkRef}.`,
            keyData: {
              chunkRef,
              scope: fetched.scope,
              sourceType: fetched.sourceType,
              sourceId: fetched.sourceId,
              chunkIndex: fetched.chunkIndex,
              resolvedEntities: fetched.resolvedEntities,
            },
            fullPayload: {
              text: fetched.text,
              resolvedEntities: fetched.resolvedEntities,
            },
          });
        }

        const query = input.query?.trim();
        if (!query) {
          return helpers.buildEnvelope({
            success: false,
            summary: 'search requires query.',
            errorKind: 'missing_input',
            retryable: false,
            missingFields: ['query'],
            userAction: 'Provide a natural-language query to search available context sources.',
          });
        }

        const dateFrom = helpers.parseContextSearchDate(input.dateFrom, 'start');
        const dateTo = helpers.parseContextSearchDate(input.dateTo, 'end');
        if ((dateFrom && Number.isNaN(dateFrom.getTime())) || (dateTo && Number.isNaN(dateTo.getTime()))) {
          return helpers.buildEnvelope({
            success: false,
            summary: 'dateFrom and dateTo must be valid ISO date strings.',
            errorKind: 'validation',
            retryable: false,
            missingFields: [
              ...(dateFrom && Number.isNaN(dateFrom.getTime()) ? ['dateFrom'] : []),
              ...(dateTo && Number.isNaN(dateTo.getTime()) ? ['dateTo'] : []),
            ],
            userAction: 'Use ISO date strings like 2026-03-29 or 2026-03-29T17:30:00Z.',
          });
        }
        if (dateFrom && dateTo && dateFrom > dateTo) {
          return helpers.buildEnvelope({
            success: false,
            summary: 'dateFrom must be earlier than or equal to dateTo.',
            errorKind: 'validation',
            retryable: false,
            missingFields: ['dateFrom', 'dateTo'],
            userAction: 'Adjust the date range so the start is not after the end.',
          });
        }

        const normalizedSources = helpers.scopeContextSearchSourcesForAgent({
          runtime,
          query,
          sources: helpers.normalizeContextSearchSources({
            scopes: input.scopes,
            sources: input.sources,
          }),
        });
        redDebug('legacy_tools.context_search.normalized', {
          delegatedAgentId: runtime.delegatedAgentId ?? 'unknown',
          query,
          inputScopes: input.scopes ?? null,
          inputSources: input.sources ?? null,
          normalizedSources: normalizedSources ?? null,
          limit: input.limit ?? null,
        });
        const result = await contextSearchBrokerService.search({
          runtime,
          query,
          limit: Math.max(1, Math.min(25, input.limit ?? 5)),
          dateFrom: input.dateFrom,
          dateTo: input.dateTo,
          sources: normalizedSources,
        });
        redDebug('legacy_tools.context_search.result', {
          delegatedAgentId: runtime.delegatedAgentId ?? 'unknown',
          query,
          sourceCoverage: result.sourceCoverage,
          searchSummary: result.searchSummary,
          resultCount: result.results.length,
        });
        const citations = contextSearchBrokerService.toVercelCitationsFromSearch(result);

        return helpers.buildEnvelope({
          success: true,
          summary: result.searchSummary,
          keyData: {
            resultCount: result.results.length,
            chunkRefs: result.nextFetchRefs,
            resolvedEntities: result.resolvedEntities,
            sourcesQueried: Object.entries(result.sourceCoverage)
              .filter(([, coverage]) => coverage.enabled)
              .map(([source]) => source),
          },
          fullPayload: {
            query,
            results: result.results,
            matches: result.matches,
            resolvedEntities: result.resolvedEntities,
            sourceCoverage: result.sourceCoverage,
            citations: result.citations,
            nextFetchRefs: result.nextFetchRefs,
            searchSummary: result.searchSummary,
          },
          citations,
        });
      }),
  }),
});
