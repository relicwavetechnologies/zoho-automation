import config from '../../../config';
import { logger } from '../../../utils/logger';

const SERPER_BASE_URL = 'https://google.serper.dev';

export type SerperOrganicResult = {
  title?: string;
  link?: string;
  snippet?: string;
  date?: string;
  position?: number;
};

export type SerperSearchResponse = {
  organic?: SerperOrganicResult[];
  answerBox?: Record<string, unknown>;
  knowledgeGraph?: Record<string, unknown>;
};

export class SearchIntegrationError extends Error {
  readonly code: 'search_unavailable' | 'search_invalid_response';

  constructor(message: string, code: 'search_unavailable' | 'search_invalid_response') {
    super(message);
    this.name = 'SearchIntegrationError';
    this.code = code;
  }
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : null;

const coerceSearchResponse = (value: unknown): SerperSearchResponse => {
  const record = asRecord(value);
  if (!record) {
    throw new SearchIntegrationError('Serper returned a non-object payload', 'search_invalid_response');
  }

  const organic = Array.isArray(record.organic)
    ? record.organic
      .map((entry) => asRecord(entry))
      .filter((entry): entry is Record<string, unknown> => Boolean(entry))
      .map((entry) => ({
        title: typeof entry.title === 'string' ? entry.title : undefined,
        link: typeof entry.link === 'string' ? entry.link : undefined,
        snippet: typeof entry.snippet === 'string' ? entry.snippet : undefined,
        date: typeof entry.date === 'string' ? entry.date : undefined,
        position: typeof entry.position === 'number' ? entry.position : undefined,
      }))
    : [];

  return {
    organic,
    answerBox: asRecord(record.answerBox) ?? undefined,
    knowledgeGraph: asRecord(record.knowledgeGraph) ?? undefined,
  };
};

export type SerperSearchInput = {
  query: string;
  num?: number;
  gl?: string;
  hl?: string;
  page?: number;
  autocorrect?: boolean;
};

export class SerperClient {
  private readonly fetchImpl: typeof fetch;

  constructor(fetchImpl?: typeof fetch) {
    this.fetchImpl = fetchImpl ?? fetch;
  }

  async search(input: SerperSearchInput): Promise<SerperSearchResponse> {
    const apiKey = config.SERPER_API_KEY.trim();
    if (!apiKey) {
      throw new SearchIntegrationError('SERPER_API_KEY is not configured', 'search_unavailable');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.SERPER_TIMEOUT_MS);

    try {
      const response = await this.fetchImpl(`${SERPER_BASE_URL}/search`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-KEY': apiKey,
        },
        body: JSON.stringify({
          q: input.query,
          num: input.num ?? 5,
          gl: input.gl ?? 'us',
          hl: input.hl ?? 'en',
          page: input.page ?? 1,
          autocorrect: input.autocorrect ?? true,
        }),
        signal: controller.signal,
      });

      const rawText = await response.text();
      let payload: unknown = null;
      try {
        payload = rawText.length > 0 ? JSON.parse(rawText) : null;
      } catch {
        throw new SearchIntegrationError('Serper returned invalid JSON', 'search_invalid_response');
      }

      if (!response.ok) {
        logger.warn('serper.search.http_error', {
          status: response.status,
          query: input.query,
          bodyPreview: rawText.slice(0, 240),
        });
        throw new SearchIntegrationError(`Serper request failed with status ${response.status}`, 'search_unavailable');
      }

      return coerceSearchResponse(payload);
    } catch (error) {
      if (error instanceof SearchIntegrationError) {
        throw error;
      }

      const reason = error instanceof Error ? error.message : 'unknown_error';
      logger.warn('serper.search.failed', {
        query: input.query,
        reason,
      });
      throw new SearchIntegrationError(`Serper search failed: ${reason}`, 'search_unavailable');
    } finally {
      clearTimeout(timeout);
    }
  }
}

export const serperClient = new SerperClient();
