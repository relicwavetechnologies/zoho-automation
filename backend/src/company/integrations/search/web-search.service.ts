import { logger } from '../../../utils/logger';
import { SearchIntegrationError, serperClient, type SerperOrganicResult } from './serper.client';
import { cloudflareCrawlClient, CloudflareCrawlError } from './cloudflare-crawl.client';

const DEFAULT_SEARCH_RESULTS_LIMIT = 5;
const MAX_SEARCH_RESULTS_LIMIT = 8;
const DEFAULT_PAGE_CONTEXT_LIMIT = 3;
const MAX_PAGE_CONTEXT_LIMIT = 4;
const PAGE_FETCH_TIMEOUT_MS = 8_000;
const PAGE_CONTEXT_CHAR_LIMIT = 1_200;
const USER_AGENT =
  'Mozilla/5.0 (compatible; EMIACBot/1.0; +https://example.invalid/serper-search)';

const COMMON_HTML_ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&lt;': '<',
  '&gt;': '>',
};

export type WebSearchItem = {
  title: string;
  link: string;
  domain: string;
  snippet?: string;
  date?: string;
  position?: number;
  source: 'organic' | 'site';
  pageContext?: {
    excerpt: string;
    metaDescription?: string;
    fetched: boolean;
    contentType?: string;
    error?: string;
  };
};

export type WebSearchInput = {
  query: string;
  exactDomain?: string;
  searchResultsLimit?: number;
  pageContextLimit?: number;
  crawlUrl?: string;
};

export type WebSearchResult = {
  query: string;
  exactDomain?: string;
  focusedSiteSearch: boolean;
  crawlUsed?: boolean;
  crawlUrl?: string;
  crawlError?: string;
  items: WebSearchItem[];
  sourceRefs: Array<{ source: 'web'; id: string }>;
};

const dedupeWhitespace = (value: string): string => value.replace(/\s+/g, ' ').trim();

const decodeHtmlEntities = (value: string): string =>
  value.replace(/&nbsp;|&amp;|&quot;|&#39;|&apos;|&lt;|&gt;/g, (match) => COMMON_HTML_ENTITIES[match] ?? match);

const stripHtml = (html: string): string =>
  decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<!--([\s\S]*?)-->/g, ' ')
      .replace(/<[^>]+>/g, ' '),
  );

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const toDomain = (value: string): string | undefined => {
  try {
    const parsed = new URL(value.startsWith('http') ? value : `https://${value}`);
    return parsed.hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return undefined;
  }
};

const normalizeDomain = (value: string | undefined): string | undefined => {
  if (!value) {
    return undefined;
  }
  return toDomain(value);
};

const extractUrlCandidate = (value: string): string | undefined => {
  const match = value.match(/\bhttps?:\/\/[^\s)]+/i)?.[0];
  return match?.trim();
};

const shouldUseCrawl = (input: WebSearchInput): boolean => {
  const normalized = input.query.toLowerCase();
  if (input.crawlUrl) return true;
  const crawlSignals = [
    'crawl',
    'documentation',
    'docs',
    'developer docs',
    'knowledge base',
    'whole site',
    'entire site',
    'all pages',
    'api reference',
    'sdk reference',
  ];
  return crawlSignals.some((signal) => normalized.includes(signal));
};

const extractTagText = (html: string, tag: string): string | undefined => {
  const match = html.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match?.[1] ? dedupeWhitespace(stripHtml(match[1])) : undefined;
};

const extractMeta = (html: string, name: string): string | undefined => {
  const byName = html.match(
    new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i'),
  );
  if (byName?.[1]) {
    return dedupeWhitespace(decodeHtmlEntities(byName[1]));
  }
  const reversed = html.match(
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${name}["'][^>]*>`, 'i'),
  );
  return reversed?.[1] ? dedupeWhitespace(decodeHtmlEntities(reversed[1])) : undefined;
};

const normalizeSearchItem = (
  result: SerperOrganicResult,
  source: WebSearchItem['source'],
): WebSearchItem | null => {
  const link = typeof result.link === 'string' ? result.link.trim() : '';
  if (!link) {
    return null;
  }
  const domain = toDomain(link);
  if (!domain) {
    return null;
  }
  return {
    title: typeof result.title === 'string' && result.title.trim() ? result.title.trim() : link,
    link,
    domain,
    snippet: typeof result.snippet === 'string' && result.snippet.trim() ? result.snippet.trim() : undefined,
    date: typeof result.date === 'string' && result.date.trim() ? result.date.trim() : undefined,
    position: typeof result.position === 'number' ? result.position : undefined,
    source,
  };
};

const summarizePageText = (html: string): { title?: string; metaDescription?: string; excerpt?: string } => {
  const title = extractTagText(html, 'title');
  const metaDescription = extractMeta(html, 'description') ?? extractMeta(html, 'og:description');
  const text = dedupeWhitespace(stripHtml(html));
  const excerpt = text.length > PAGE_CONTEXT_CHAR_LIMIT ? `${text.slice(0, PAGE_CONTEXT_CHAR_LIMIT - 3)}...` : text;
  return {
    title,
    metaDescription,
    excerpt: excerpt.length > 0 ? excerpt : undefined,
  };
};

type PageFetchResult = NonNullable<WebSearchItem['pageContext']>;

const fetchPageContext = async (url: string, fetchImpl: typeof fetch): Promise<PageFetchResult> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PAGE_FETCH_TIMEOUT_MS);

  try {
    const response = await fetchImpl(url, {
      headers: {
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.5',
        'User-Agent': USER_AGENT,
      },
      redirect: 'follow',
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        excerpt: '',
        fetched: false,
        error: `HTTP ${response.status}`,
      };
    }

    const contentType = response.headers.get('content-type') ?? undefined;
    const raw = await response.text();
    const summary = summarizePageText(raw);

    return {
      excerpt: summary.excerpt ?? '',
      metaDescription: summary.metaDescription,
      fetched: Boolean(summary.excerpt),
      contentType,
      ...(summary.excerpt ? {} : { error: 'No readable page text extracted' }),
    };
  } catch (error) {
    return {
      excerpt: '',
      fetched: false,
      error: error instanceof Error ? error.message : 'unknown_error',
    };
  } finally {
    clearTimeout(timeout);
  }
};

export class WebSearchService {
  constructor(
    private readonly searchClient: { search: typeof serperClient.search } = serperClient,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async search(input: WebSearchInput): Promise<WebSearchResult> {
    const query = input.query.trim();
    if (!query) {
      return {
        query,
        exactDomain: normalizeDomain(input.exactDomain),
        focusedSiteSearch: false,
        items: [],
        sourceRefs: [],
      };
    }

    const exactDomain = normalizeDomain(input.exactDomain);
    const resultLimit = clamp(input.searchResultsLimit ?? DEFAULT_SEARCH_RESULTS_LIMIT, 1, MAX_SEARCH_RESULTS_LIMIT);
    const pageContextLimit = clamp(input.pageContextLimit ?? DEFAULT_PAGE_CONTEXT_LIMIT, 0, MAX_PAGE_CONTEXT_LIMIT);
    const crawlUrl = input.crawlUrl ?? extractUrlCandidate(query);

    if (crawlUrl && shouldUseCrawl(input) && cloudflareCrawlClient.isEnabled()) {
      try {
        const crawled = await cloudflareCrawlClient.crawl({
          url: crawlUrl,
          limit: resultLimit,
          render: false,
          includePatterns: exactDomain ? [`https://${exactDomain}/*`, `http://${exactDomain}/*`] : undefined,
        });
        const items: WebSearchItem[] = crawled.documents.map((doc, index) => ({
          title: doc.title || doc.url,
          link: doc.url,
          domain: toDomain(doc.url) || (exactDomain ?? 'unknown'),
          source: 'site',
          position: index + 1,
          pageContext: {
            excerpt: doc.excerpt,
            fetched: true,
            contentType: 'text/markdown',
          },
        }));

        logger.debug('web.search.crawl.completed', {
          query,
          crawlUrl,
          resultCount: items.length,
        });

        return {
          query,
          exactDomain,
          focusedSiteSearch: true,
          crawlUsed: true,
          crawlUrl,
          items,
          sourceRefs: items.map((item) => ({ source: 'web' as const, id: item.link })),
        };
      } catch (error) {
        const crawlError = error instanceof CloudflareCrawlError
          ? error.message
          : error instanceof Error
            ? error.message
            : 'unknown_crawl_error';
        logger.warn('web.search.crawl.failed', {
          query,
          crawlUrl,
          reason: crawlError,
        });
        // Fall through to normal search with the crawl error preserved for observability.
        const fallback = await this.searchViaSerper({
          query,
          exactDomain,
          resultLimit,
          pageContextLimit,
        });
        return {
          ...fallback,
          crawlUsed: false,
          crawlUrl,
          crawlError,
        };
      }
    }

    return this.searchViaSerper({
      query,
      exactDomain,
      resultLimit,
      pageContextLimit,
    });
  }

  private async searchViaSerper(input: {
    query: string;
    exactDomain?: string;
    resultLimit: number;
    pageContextLimit: number;
  }): Promise<WebSearchResult> {
    const { query, exactDomain, resultLimit, pageContextLimit } = input;

    const primary = await this.searchClient.search({
      query,
      num: resultLimit,
    });

    const merged = new Map<string, WebSearchItem>();
    for (const entry of primary.organic ?? []) {
      const normalized = normalizeSearchItem(entry, 'organic');
      if (normalized) {
        merged.set(normalized.link, normalized);
      }
    }

    let focusedSiteSearch = false;
    if (exactDomain) {
      const siteSearch = await this.searchClient.search({
        query: `site:${exactDomain} ${query}`,
        num: resultLimit,
      });

      focusedSiteSearch = true;
      for (const entry of siteSearch.organic ?? []) {
        const normalized = normalizeSearchItem(entry, 'site');
        if (normalized && normalized.domain === exactDomain && !merged.has(normalized.link)) {
          merged.set(normalized.link, normalized);
        }
      }
    }

    const items = [...merged.values()].slice(0, resultLimit);
    await Promise.all(
      items.slice(0, pageContextLimit).map(async (item) => {
        item.pageContext = await fetchPageContext(item.link, this.fetchImpl);
      }),
    );

    logger.debug('web.search.completed', {
      query,
      exactDomain,
      focusedSiteSearch,
      resultCount: items.length,
      pageContextCount: items.filter((item) => item.pageContext?.fetched).length,
    });

    return {
      query,
      exactDomain,
      focusedSiteSearch,
      crawlUsed: false,
      items,
      sourceRefs: items.map((item) => ({ source: 'web' as const, id: item.link })),
    };
  }
}

export const webSearchService = new WebSearchService();

export { SearchIntegrationError };
