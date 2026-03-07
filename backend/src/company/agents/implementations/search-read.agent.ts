import type { AgentInvokeInputDTO } from '../../contracts';
import { BaseAgent } from '../base';
import { SearchIntegrationError, webSearchService, type WebSearchService } from '../../integrations/search';

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 8;
const DEFAULT_PAGE_CONTEXT_LIMIT = 3;

const asText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const extractLimit = (objective: string): number => {
  const match = objective.match(/\b(?:top|show|list|find|get|search)\s+(\d{1,2})\b/i);
  if (!match) {
    return DEFAULT_LIMIT;
  }
  const parsed = Number.parseInt(match[1] ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_LIMIT;
  }
  return Math.min(MAX_LIMIT, parsed);
};

const extractExactDomain = (objective: string): string | undefined => {
  const siteMatch = objective.match(/\bsite:([a-z0-9.-]+\.[a-z]{2,})\b/i)?.[1];
  if (siteMatch) {
    return siteMatch;
  }

  const urlMatch = objective.match(/\bhttps?:\/\/([a-z0-9.-]+\.[a-z]{2,})(?:[/?#][^\s]*)?/i)?.[1];
  if (urlMatch) {
    return urlMatch;
  }

  const domainMatch = objective.match(
    /\b(?:website|site|domain|from)\s+([a-z0-9][a-z0-9.-]*\.[a-z]{2,})(?:\b|\/)/i,
  )?.[1];
  if (domainMatch) {
    return domainMatch;
  }

  return objective.match(/\b([a-z0-9][a-z0-9.-]*\.[a-z]{2,})(?:\b|\/)/i)?.[1];
};

const buildAnswer = (result: Awaited<ReturnType<WebSearchService['search']>>): string => {
  if (result.items.length === 0) {
    return `No web results found for "${result.query}".`;
  }

  const header = result.focusedSiteSearch && result.exactDomain
    ? `Found ${result.items.length} web result${result.items.length === 1 ? '' : 's'} for "${result.query}" with an exact-site pass on ${result.exactDomain}.`
    : `Found ${result.items.length} web result${result.items.length === 1 ? '' : 's'} for "${result.query}".`;

  const lines = result.items.map((item, index) => {
    const parts = [`${index + 1}. ${item.title}`, `(${item.domain})`, item.link];
    if (item.snippet) {
      parts.push(`Snippet: ${item.snippet}`);
    }
    const pageExcerpt = item.pageContext?.excerpt?.trim();
    if (pageExcerpt) {
      parts.push(`Page context: ${pageExcerpt}`);
    } else if (item.pageContext?.error) {
      parts.push(`Page context unavailable: ${item.pageContext.error}`);
    }
    return parts.join('\n');
  });

  return [header, ...lines].join('\n\n');
};

export class SearchReadAgent extends BaseAgent {
  readonly key = 'search-read';

  constructor(private readonly searchService: WebSearchService = webSearchService) {
    super();
  }

  async invoke(input: AgentInvokeInputDTO) {
    const startedAt = Date.now();
    const objective = input.objective.trim();
    const exactDomain =
      asText(input.contextPacket.exactDomain) ||
      extractExactDomain(objective);
    const limit = extractLimit(objective);

    try {
      const result = await this.searchService.search({
        query: objective,
        exactDomain,
        searchResultsLimit: limit,
        pageContextLimit: Math.min(DEFAULT_PAGE_CONTEXT_LIMIT, limit),
      });

      const answer = buildAnswer(result);
      return this.success(
        input,
        answer,
        {
          answer,
          query: result.query,
          exactDomain: result.exactDomain,
          focusedSiteSearch: result.focusedSiteSearch,
          items: result.items,
          sourceRefs: result.sourceRefs,
        },
        {
          latencyMs: Date.now() - startedAt,
          apiCalls: result.focusedSiteSearch ? 2 : 1,
        },
      );
    } catch (error) {
      if (error instanceof SearchIntegrationError) {
        return this.failure(
          input,
          `Web search failed: ${error.message}`,
          error.code,
          error.message,
          error.code === 'search_unavailable',
          {
            latencyMs: Date.now() - startedAt,
            apiCalls: 1,
          },
        );
      }

      const rawMessage = error instanceof Error ? error.message : 'unknown_error';
      return this.failure(
        input,
        `Web search failed: ${rawMessage}`,
        'search_unavailable',
        rawMessage,
        true,
        {
          latencyMs: Date.now() - startedAt,
          apiCalls: 1,
        },
      );
    }
  }
}
