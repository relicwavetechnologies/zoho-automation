/**
 * SerperClient — thin wrapper around the google.serper.dev API.
 *
 * Endpoint: POST https://google.serper.dev/search
 * Auth:     X-API-KEY header
 *
 * Returns: organic results, answerBox, knowledgeGraph (raw).
 * Throws:  SearchIntegrationError (search_unavailable | search_invalid_response).
 */

export const SERPER_BASE_URL = 'https://google.serper.dev';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SerperOrganicResult {
  readonly title?: string;
  readonly link?: string;
  readonly snippet?: string;
  readonly date?: string;
  readonly position?: number;
}

export interface SerperSearchResponse {
  readonly organic: SerperOrganicResult[];
  readonly answerBox?: Record<string, unknown>;
  readonly knowledgeGraph?: Record<string, unknown>;
}

export interface SerperSearchInput {
  readonly query: string;
  readonly num?: number;
  readonly gl?: string;        // geo-location e.g. 'us'
  readonly hl?: string;        // language e.g. 'en'
  readonly page?: number;
  readonly autocorrect?: boolean;
}

// ─── Error ────────────────────────────────────────────────────────────────────

export type SearchErrorCode = 'search_unavailable' | 'search_invalid_response' | 'search_not_configured' | 'search_auth_failed' | 'search_rate_limited';

export class SearchIntegrationError extends Error {
  readonly code: SearchErrorCode;
  constructor(message: string, code: SearchErrorCode) {
    super(message);
    this.name = 'SearchIntegrationError';
    this.code = code;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

function coerceResponse(raw: unknown): SerperSearchResponse {
  const record = asRecord(raw);
  if (!record) {
    throw new SearchIntegrationError(
      'Serper returned a non-object payload',
      'search_invalid_response',
    );
  }

  const optStr = (v: unknown): { [k: string]: string } | Record<never, never> => (typeof v === 'string' ? { _v: v } : {});
  const organic: SerperOrganicResult[] = Array.isArray(record['organic'])
    ? (record['organic'] as unknown[])
        .map(asRecord)
        .filter((e): e is Record<string, unknown> => Boolean(e))
        .map(e => ({
          ...(typeof e['title']    === 'string' ? { title:    e['title']    } : {}),
          ...(typeof e['link']     === 'string' ? { link:     e['link']     } : {}),
          ...(typeof e['snippet']  === 'string' ? { snippet:  e['snippet']  } : {}),
          ...(typeof e['date']     === 'string' ? { date:     e['date']     } : {}),
          ...(typeof e['position'] === 'number' ? { position: e['position'] } : {}),
        }))
    : [];
  void optStr; // suppress unused warning — kept for readability of pattern above

  const answerBox      = asRecord(record['answerBox']);
  const knowledgeGraph = asRecord(record['knowledgeGraph']);
  return {
    organic,
    ...(answerBox      ? { answerBox      } : {}),
    ...(knowledgeGraph ? { knowledgeGraph } : {}),
  };
}

// ─── Client ───────────────────────────────────────────────────────────────────

export class SerperClient {
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: {
    apiKey: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
  }) {
    this.apiKey    = opts.apiKey.trim();
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async search(input: SerperSearchInput): Promise<SerperSearchResponse> {
    if (!this.apiKey) {
      throw new SearchIntegrationError(
        'SERPER_API_KEY is not configured',
        'search_not_configured',
      );
    }

    let res: Response;
    try {
      res = await this.fetchImpl(`${SERPER_BASE_URL}/search`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-KEY':    this.apiKey,
        },
        body: JSON.stringify({
          q:           input.query,
          num:         input.num         ?? 5,
          gl:          input.gl          ?? 'us',
          hl:          input.hl          ?? 'en',
          page:        input.page        ?? 1,
          autocorrect: input.autocorrect ?? true,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      throw new SearchIntegrationError(
        `Serper request failed: ${reason}`,
        'search_unavailable',
      );
    }

    const raw = await res.text();

    if (!res.ok) {
      const code: SearchErrorCode = res.status === 429
        ? 'search_rate_limited'
        : res.status === 401 || res.status === 403
          ? 'search_auth_failed'
          : 'search_unavailable';
      throw new SearchIntegrationError(
        `Serper HTTP ${res.status}: ${raw.slice(0, 240)}`,
        code,
      );
    }

    let payload: unknown;
    try {
      payload = raw.length > 0 ? JSON.parse(raw) : null;
    } catch {
      throw new SearchIntegrationError(
        'Serper returned invalid JSON',
        'search_invalid_response',
      );
    }

    return coerceResponse(payload);
  }
}
