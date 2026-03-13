import { logger } from '../../../utils/logger';

const CLOUDFLARE_API_BASE_URL = 'https://api.cloudflare.com/client/v4';
const DEFAULT_START_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_TIMEOUT_MS = 45_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_RESULT_LIMIT = 12;
const DEFAULT_REQUESTS_PER_MINUTE = 6;
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let nextCloudflareRequestAt = 0;

export class CloudflareCrawlError extends Error {
  readonly code: 'crawl_unavailable' | 'crawl_invalid_response' | 'crawl_timeout' | 'crawl_rate_limited';

  constructor(
    message: string,
    code: 'crawl_unavailable' | 'crawl_invalid_response' | 'crawl_timeout' | 'crawl_rate_limited',
  ) {
    super(message);
    this.name = 'CloudflareCrawlError';
    this.code = code;
  }
}

type CrawlStatus =
  | 'running'
  | 'completed'
  | 'errored'
  | 'cancelled_due_to_timeout'
  | 'cancelled_due_to_limits'
  | 'cancelled_by_user';

type CrawlRecord = {
  url?: string;
  markdown?: string;
  html?: string;
  json?: unknown;
  status?: string;
  title?: string;
  metadata?: {
    title?: string;
    status?: number;
    url?: string;
    lastModified?: string;
  };
};

type CrawlResultEnvelope = {
  success?: boolean;
  result?: string | {
    id?: string;
    status?: CrawlStatus;
    records?: CrawlRecord[];
    cursor?: string;
    browserSecondsUsed?: number;
  };
  errors?: Array<{ message?: string }>;
};

type CrawlOptions = {
  url: string;
  limit?: number;
  depth?: number;
  render?: boolean;
  includePatterns?: string[];
  excludePatterns?: string[];
};

export type CloudflareCrawlDocument = {
  url: string;
  title?: string;
  excerpt: string;
  status?: string;
};

export type CloudflareCrawlCompleted = {
  id: string;
  status: CrawlStatus;
  documents: CloudflareCrawlDocument[];
};

const readEnv = (key: string): string => (process.env[key] || '').trim();

const getCrawlConfig = () => {
  const accountId = readEnv('CLOUDFLARE_ACCOUNT_ID');
  const apiToken = readEnv('CLOUDFLARE_API_TOKEN');
  const requestsPerMinute = Math.max(1, Number.parseInt(readEnv('CLOUDFLARE_CRAWL_REQUESTS_PER_MINUTE') || '', 10) || DEFAULT_REQUESTS_PER_MINUTE);
  return {
    accountId,
    apiToken,
    requestsPerMinute,
    minIntervalMs: Math.ceil(60_000 / requestsPerMinute),
    enabled: Boolean(accountId && apiToken),
  };
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : null;

const extractErrorMessage = (payload: unknown): string | undefined => {
  const record = asRecord(payload);
  if (!record) return undefined;
  const errors = Array.isArray(record.errors) ? record.errors : [];
  for (const entry of errors) {
    const message = asRecord(entry)?.message;
    if (typeof message === 'string' && message.trim()) {
      return message.trim();
    }
  }
  return undefined;
};

const parseRetryAfterMs = (value: string | null): number | undefined => {
  if (!value) return undefined;
  const seconds = Number.parseInt(value, 10);
  if (Number.isFinite(seconds) && seconds > 0) {
    return seconds * 1_000;
  }
  const retryAt = Date.parse(value);
  if (Number.isFinite(retryAt)) {
    return Math.max(0, retryAt - Date.now());
  }
  return undefined;
};

const stripMarkdown = (value: string): string =>
  value
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, ' ')
    .replace(/\[[^\]]+\]\(([^)]+)\)/g, '$1')
    .replace(/[#>*_\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const extractExcerpt = (record: CrawlRecord): string => {
  const markdown = typeof record.markdown === 'string' ? stripMarkdown(record.markdown) : '';
  if (markdown) {
    return markdown.length > 1200 ? `${markdown.slice(0, 1197)}...` : markdown;
  }
  const html = typeof record.html === 'string' ? stripMarkdown(record.html) : '';
  if (html) {
    return html.length > 1200 ? `${html.slice(0, 1197)}...` : html;
  }
  return '';
};

export class CloudflareCrawlClient {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  isEnabled(): boolean {
    return getCrawlConfig().enabled;
  }

  private buildHeaders(): HeadersInit {
    const { apiToken, enabled } = getCrawlConfig();
    if (!enabled) {
      throw new CloudflareCrawlError('Cloudflare crawl credentials are not configured', 'crawl_unavailable');
    }
    return {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    };
  }

  private buildBaseUrl(): string {
    const { accountId, enabled } = getCrawlConfig();
    if (!enabled) {
      throw new CloudflareCrawlError('Cloudflare crawl credentials are not configured', 'crawl_unavailable');
    }
    return `${CLOUDFLARE_API_BASE_URL}/accounts/${accountId}/browser-rendering/crawl`;
  }

  private async waitForRateLimitSlot(): Promise<void> {
    const { minIntervalMs } = getCrawlConfig();
    const waitMs = Math.max(0, nextCloudflareRequestAt - Date.now());
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    nextCloudflareRequestAt = Date.now() + minIntervalMs;
  }

  private applyCooldown(retryAfterMs?: number): void {
    const cooldownMs = retryAfterMs && retryAfterMs > 0 ? retryAfterMs : DEFAULT_RATE_LIMIT_COOLDOWN_MS;
    nextCloudflareRequestAt = Math.max(nextCloudflareRequestAt, Date.now() + cooldownMs);
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    await this.waitForRateLimitSlot();
    const response = await this.fetchImpl(url, init);
    if (response.status === 429) {
      const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
      this.applyCooldown(retryAfterMs);
      logger.warn('cloudflare.crawl.rate_limited', {
        retryAfterMs: retryAfterMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS,
      });
      throw new CloudflareCrawlError('Rate limit exceeded', 'crawl_rate_limited');
    }
    return response;
  }

  private async readJson(response: Response): Promise<CrawlResultEnvelope> {
    const text = await response.text();
    let payload: unknown = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      throw new CloudflareCrawlError('Cloudflare crawl returned invalid JSON', 'crawl_invalid_response');
    }

    if (!response.ok) {
      const message = extractErrorMessage(payload) ?? `Cloudflare crawl request failed with status ${response.status}`;
      throw new CloudflareCrawlError(message, 'crawl_unavailable');
    }

    const record = asRecord(payload);
    if (!record) {
      throw new CloudflareCrawlError('Cloudflare crawl returned a non-object payload', 'crawl_invalid_response');
    }
    return record as CrawlResultEnvelope;
  }

  async start(input: CrawlOptions): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_START_TIMEOUT_MS);
    try {
      const response = await this.request(this.buildBaseUrl(), {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify({
          url: input.url,
          limit: input.limit ?? DEFAULT_RESULT_LIMIT,
          depth: input.depth ?? 3,
          formats: ['markdown'],
          render: input.render ?? false,
          options: {
            includePatterns: input.includePatterns,
            excludePatterns: input.excludePatterns,
          },
        }),
        signal: controller.signal,
      });
      const payload = await this.readJson(response);
      if (typeof payload.result !== 'string' || !payload.result.trim()) {
        throw new CloudflareCrawlError('Cloudflare crawl did not return a job id', 'crawl_invalid_response');
      }
      return payload.result.trim();
    } catch (error) {
      if (error instanceof CloudflareCrawlError) {
        throw error;
      }
      throw new CloudflareCrawlError(
        `Cloudflare crawl start failed: ${error instanceof Error ? error.message : 'unknown_error'}`,
        'crawl_unavailable',
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async get(jobId: string, cursor?: string): Promise<CrawlResultEnvelope> {
    const url = new URL(`${this.buildBaseUrl()}/${jobId}`);
    if (cursor) {
      url.searchParams.set('cursor', cursor);
    }
    const response = await this.request(url.toString(), {
      method: 'GET',
      headers: this.buildHeaders(),
    });
    return this.readJson(response);
  }

  async crawl(input: CrawlOptions): Promise<CloudflareCrawlCompleted> {
    const jobId = await this.start(input);
    const startedAt = Date.now();
    let cursor: string | undefined;
    let finalPayload: CrawlResultEnvelope | null = null;
    const limit = input.limit ?? DEFAULT_RESULT_LIMIT;
    const seenCursors = new Set<string>();
    const collectedDocuments = new Map<string, CloudflareCrawlDocument>();

    while (Date.now() - startedAt < DEFAULT_POLL_TIMEOUT_MS) {
      const payload = await this.get(jobId, cursor);
      finalPayload = payload;
      const result = typeof payload.result === 'string' ? null : payload.result;
      const status = result?.status;

      if (status === 'completed') {
        const documentsBefore = collectedDocuments.size;
        for (const record of result?.records ?? []) {
          const url = typeof record.url === 'string' ? record.url : '';
          if (!url) continue;
          const excerpt = extractExcerpt(record);
          if (!excerpt) continue;
          collectedDocuments.set(url, {
            url,
            title:
              typeof record.title === 'string'
                ? record.title
                : typeof record.metadata?.title === 'string'
                  ? record.metadata.title
                  : undefined,
            excerpt,
            status: typeof record.status === 'string' ? record.status : undefined,
          });
        }

        const nextCursor = result?.cursor;
        const documentCount = collectedDocuments.size;
        const madeProgress = documentCount > documentsBefore;
        if (nextCursor && documentCount < limit) {
          if (seenCursors.has(nextCursor) || !madeProgress) {
            return {
              id: result?.id ?? jobId,
              status: 'completed',
              documents: Array.from(collectedDocuments.values()).slice(0, limit),
            };
          }
          seenCursors.add(nextCursor);
          cursor = nextCursor;
          continue;
        }

        return {
          id: result?.id ?? jobId,
          status: 'completed',
          documents: Array.from(collectedDocuments.values()).slice(0, limit),
        };
      }

      if (status && status !== 'running') {
        throw new CloudflareCrawlError(`Cloudflare crawl finished with status ${status}`, 'crawl_unavailable');
      }

      await sleep(Math.max(DEFAULT_POLL_INTERVAL_MS, getCrawlConfig().minIntervalMs));
    }

    logger.warn('cloudflare.crawl.timeout', {
      jobId,
      lastStatus: typeof finalPayload?.result === 'string' ? undefined : finalPayload?.result?.status,
    });
    throw new CloudflareCrawlError('Cloudflare crawl timed out while waiting for completion', 'crawl_timeout');
  }
}

export const cloudflareCrawlClient = new CloudflareCrawlClient();
