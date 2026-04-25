/**
 * WebSearchService — orchestrates Serper search + optional page-context fetching.
 *
 * Behaviour:
 *   1. Call Serper for organic results (primary search).
 *   2. If exactDomain is provided, run a second "site:<domain> <query>" search and
 *      merge unique results (site results are not duplicated).
 *   3. Fetch raw HTML for the first `pageContextLimit` items (default 3, max 4) to
 *      extract title, meta-description, and a ~1200-char plain-text excerpt.
 *   4. Return a structured WebSearchResult with source refs for citation.
 *
 * Error handling:
 *   - Serper errors propagate as SearchIntegrationError.
 *   - Individual page-fetch errors are captured per-item (never thrown); the item
 *     gets pageContext.fetched=false + pageContext.error.
 */

import type { Logger } from '../../../shared/logger';
import type { SerperClient, SerperOrganicResult } from './serper.client';
import { SearchIntegrationError } from './serper.client';

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_RESULTS_LIMIT     = 5;
const MAX_RESULTS_LIMIT         = 8;
const DEFAULT_PAGE_CONTEXT_LIMIT = 3;
const MAX_PAGE_CONTEXT_LIMIT    = 4;
const PAGE_FETCH_TIMEOUT_MS     = 8_000;
const PAGE_CONTEXT_CHAR_LIMIT   = 1_200;

const USER_AGENT =
  'Mozilla/5.0 (compatible; DivoBot/1.0; +https://divo.ai)';

// ─── HTML helpers ─────────────────────────────────────────────────────────────

const HTML_ENTITIES: Record<string, string> = {
  '&nbsp;': ' ', '&amp;': '&', '&quot;': '"',
  '&#39;': "'", '&apos;': "'", '&lt;': '<', '&gt;': '>',
};

const decodeEntities = (s: string): string =>
  s.replace(/&nbsp;|&amp;|&quot;|&#39;|&apos;|&lt;|&gt;/g, m => HTML_ENTITIES[m] ?? m);

const stripHtml = (html: string): string =>
  decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi,  ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' '),
  );

const dedupeWS = (s: string): string => s.replace(/\s+/g, ' ').trim();

const extractTagText = (html: string, tag: string): string | undefined => {
  const m = html.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m?.[1] ? dedupeWS(stripHtml(m[1])) : undefined;
};

const extractMeta = (html: string, name: string): string | undefined => {
  const byName = html.match(
    new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i'),
  );
  if (byName?.[1]) return dedupeWS(decodeEntities(byName[1]));
  const rev = html.match(
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${name}["'][^>]*>`, 'i'),
  );
  return rev?.[1] ? dedupeWS(decodeEntities(rev[1])) : undefined;
};

// ─── Domain helpers ───────────────────────────────────────────────────────────

const toDomain = (url: string): string | undefined => {
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`);
    return u.hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return undefined;
  }
};

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WebSearchItem {
  readonly title: string;
  readonly link: string;
  readonly domain: string;
  readonly snippet?: string;
  readonly date?: string;
  readonly position?: number;
  readonly source: 'organic' | 'site';
  pageContext?: PageContext;
}

export interface PageContext {
  readonly excerpt: string;
  readonly metaDescription?: string;
  readonly fetched: boolean;
  readonly contentType?: string;
  readonly error?: string;
}

export interface WebSearchInput {
  readonly query: string;
  readonly exactDomain?: string;
  readonly searchResultsLimit?: number;
  readonly pageContextLimit?: number;
}

export interface WebSearchResult {
  readonly query: string;
  readonly exactDomain?: string;
  readonly focusedSiteSearch: boolean;
  readonly items: WebSearchItem[];
  readonly sourceRefs: Array<{ source: 'web'; id: string }>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

function normalizeItem(
  r: SerperOrganicResult,
  source: WebSearchItem['source'],
): WebSearchItem | null {
  const link = typeof r.link === 'string' ? r.link.trim() : '';
  if (!link) return null;
  const domain = toDomain(link);
  if (!domain) return null;
  return {
    title:  typeof r.title === 'string' && r.title.trim() ? r.title.trim() : link,
    link,
    domain,
    source,
    ...(typeof r.snippet  === 'string' && r.snippet.trim()  ? { snippet:  r.snippet.trim()  } : {}),
    ...(typeof r.date     === 'string' && r.date.trim()     ? { date:     r.date.trim()     } : {}),
    ...(typeof r.position === 'number'                       ? { position: r.position        } : {}),
  };
}

async function fetchPageContext(
  url: string,
  fetchImpl: typeof fetch,
): Promise<PageContext> {
  try {
    const res = await fetchImpl(url, {
      headers: {
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.5',
        'User-Agent': USER_AGENT,
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(PAGE_FETCH_TIMEOUT_MS),
    });

    if (!res.ok) {
      return { excerpt: '', fetched: false, error: `HTTP ${res.status}` };
    }

    const rawContentType = res.headers.get('content-type');
    const html = await res.text();
    const titleText  = extractTagText(html, 'title');
    const metaDesc   = extractMeta(html, 'description') ?? extractMeta(html, 'og:description');
    const bodyText   = dedupeWS(stripHtml(html));
    const excerpt    = bodyText.length > PAGE_CONTEXT_CHAR_LIMIT
      ? `${bodyText.slice(0, PAGE_CONTEXT_CHAR_LIMIT - 3)}...`
      : bodyText;

    // Prefer page title over the search-result title for the excerpt label, but
    // we don't override item.title — just use excerpt from body text.
    void titleText; // not used in WebSearchItem.title, used only for local context
    return {
      excerpt:  excerpt.length > 0 ? excerpt : '',
      fetched:  excerpt.length > 0,
      ...(metaDesc        ? { metaDescription: metaDesc }                     : {}),
      ...(rawContentType  ? { contentType: rawContentType }                   : {}),
      ...(excerpt.length === 0 ? { error: 'No readable page text extracted' } : {}),
    };
  } catch (e) {
    return {
      excerpt: '',
      fetched: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class WebSearchService {
  constructor(
    private readonly client: SerperClient,
    private readonly logger: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async search(input: WebSearchInput): Promise<WebSearchResult> {
    const query = input.query.trim();
    if (!query) {
      return { query, focusedSiteSearch: false, items: [], sourceRefs: [] };
    }

    const exactDomain   = input.exactDomain ? toDomain(input.exactDomain) : undefined;
    const resultLimit   = clamp(input.searchResultsLimit  ?? DEFAULT_RESULTS_LIMIT,   1, MAX_RESULTS_LIMIT);
    const pageCtxLimit  = clamp(input.pageContextLimit    ?? DEFAULT_PAGE_CONTEXT_LIMIT, 0, MAX_PAGE_CONTEXT_LIMIT);

    // ── Primary search ──────────────────────────────────────────────────────
    const primary = await this.client.search({ query, num: resultLimit });

    const merged = new Map<string, WebSearchItem>();
    for (const entry of primary.organic) {
      const item = normalizeItem(entry, 'organic');
      if (item) merged.set(item.link, item);
    }

    // ── Focused site search (optional) ─────────────────────────────────────
    let focusedSiteSearch = false;
    if (exactDomain) {
      try {
        const siteSearch = await this.client.search({
          query: `site:${exactDomain} ${query}`,
          num: resultLimit,
        });
        focusedSiteSearch = true;
        for (const entry of siteSearch.organic) {
          const item = normalizeItem(entry, 'site');
          if (item && item.domain === exactDomain && !merged.has(item.link)) {
            merged.set(item.link, item);
          }
        }
      } catch (e) {
        this.logger.warn('web.search.site_search.failed', {
          domain: exactDomain,
          reason: e instanceof SearchIntegrationError ? e.message : String(e),
        });
      }
    }

    // ── Collect + page-context fetch ────────────────────────────────────────
    const items = [...merged.values()].slice(0, resultLimit);

    await Promise.all(
      items.slice(0, pageCtxLimit).map(async item => {
        (item as unknown as Record<string, unknown>)['pageContext'] = await fetchPageContext(
          item.link,
          this.fetchImpl,
        );
      }),
    );

    this.logger.debug('web.search.completed', {
      query,
      exactDomain,
      focusedSiteSearch,
      resultCount: items.length,
      pageContextFetched: items.filter(i => i.pageContext?.fetched).length,
    });

    return {
      query,
      focusedSiteSearch,
      items,
      sourceRefs: items.map(i => ({ source: 'web' as const, id: i.link })),
      ...(exactDomain ? { exactDomain } : {}),
    };
  }
}

export { SearchIntegrationError };
