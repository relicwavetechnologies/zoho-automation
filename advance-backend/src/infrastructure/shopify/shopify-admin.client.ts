import { z } from 'zod';
import { normalizeShopDomain } from '../../domain/shopify/shopify-shop';

const graphQlErrorSchema = z.object({
  message: z.string(),
  extensions: z.record(z.unknown()).optional(),
}).passthrough();

const responseSchema = z.object({
  data: z.unknown().optional(),
  errors: z.array(graphQlErrorSchema).optional(),
  extensions: z.record(z.unknown()).optional(),
}).passthrough();

export type ShopifyGraphqlResponse<T> = {
  readonly data: T;
  readonly extensions: Record<string, unknown>;
  readonly requestId?: string;
};

export class ShopifyApiError extends Error {
  constructor(
    readonly code:
      | 'invalid_shop'
      | 'unauthorized'
      | 'forbidden'
      | 'rate_limited'
      | 'read_only_violation'
      | 'graphql_error'
      | 'invalid_response'
      | 'timeout'
      | 'provider_failure',
    message: string,
    readonly status?: number,
    readonly requestId?: string,
    readonly details?: readonly string[],
  ) {
    super(message);
    this.name = 'ShopifyApiError';
  }
}

type Budget = {
  readonly requested: number;
  readonly available: number;
  readonly resetAt?: number;
};

type ShopBudget = { readonly graphql?: Budget; readonly shopifyql?: Budget };

export class ShopifyAdminClient {
  private readonly fetchImpl: typeof fetch;
  private readonly budgets = new Map<string, ShopBudget>();

  constructor(private readonly options: {
    readonly apiVersion: string;
    readonly timeoutMs: number;
    readonly maxRetries: number;
    readonly maxResponseBytes?: number;
    readonly fetchImpl?: typeof fetch;
  }) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async query<T>(input: {
    readonly shop: string;
    readonly accessToken: string;
    readonly query: string;
    readonly variables?: Record<string, unknown>;
    readonly abortSignal?: AbortSignal;
  }): Promise<ShopifyGraphqlResponse<T>> {
    assertReadOnlyDocument(input.query);
    const shop = normalizeShopDomain(input.shop);
    if (!shop) throw new ShopifyApiError('invalid_shop', 'Stored Shopify shop domain is invalid.');
    await this.waitForKnownBudget(shop, input.abortSignal);

    let lastFailure: unknown;
    for (let attempt = 0; attempt <= this.options.maxRetries; attempt += 1) {
      input.abortSignal?.throwIfAborted();
      try {
        const timeout = AbortSignal.timeout(this.options.timeoutMs);
        const signal = input.abortSignal ? AbortSignal.any([input.abortSignal, timeout]) : timeout;
        const response = await this.fetchImpl(
          `https://${shop}/admin/api/${this.options.apiVersion}/graphql.json`,
          {
            method: 'POST',
            headers: {
              Accept: 'application/json',
              'Content-Type': 'application/json',
              'X-Shopify-Access-Token': input.accessToken,
            },
            body: JSON.stringify({ query: input.query, variables: input.variables ?? {} }),
            signal,
          },
        );
        const requestId = response.headers.get('x-request-id') ?? undefined;
        const payload = await readJson(response, this.options.maxResponseBytes ?? 5_000_000);
        if (!response.ok) {
          const code = response.status === 401 ? 'unauthorized'
            : response.status === 403 ? 'forbidden'
              : response.status === 429 ? 'rate_limited'
                : 'provider_failure';
          const retryable = response.status === 429 || response.status >= 500;
          if (retryable && attempt < this.options.maxRetries) {
            await wait(retryDelayMs(response, attempt), input.abortSignal);
            continue;
          }
          throw new ShopifyApiError(
            code,
            providerMessage(payload, `Shopify Admin API returned HTTP ${response.status}.`),
            response.status,
            requestId,
          );
        }
        const parsed = responseSchema.safeParse(payload);
        if (!parsed.success) {
          throw new ShopifyApiError('invalid_response', 'Shopify returned an invalid GraphQL response.', response.status, requestId);
        }
        const extensions = parsed.data.extensions ?? {};
        this.captureBudgets(shop, extensions);
        if (parsed.data.errors?.length) {
          const details = parsed.data.errors.map(error => error.message);
          const throttled = parsed.data.errors.every(error => errorCode(error.extensions) === 'THROTTLED');
          if (throttled && attempt < this.options.maxRetries) {
            await this.waitForKnownBudget(shop, input.abortSignal);
            await wait(Math.min(250 * 2 ** attempt, 2_000), input.abortSignal);
            continue;
          }
          throw new ShopifyApiError(
            throttled ? 'rate_limited' : 'graphql_error',
            `Shopify GraphQL rejected the request: ${details.join('; ')}`,
            response.status,
            requestId,
            details,
          );
        }
        if (parsed.data.data === undefined) {
          throw new ShopifyApiError('invalid_response', 'Shopify returned an invalid GraphQL response.', response.status, requestId);
        }
        return { data: parsed.data.data as T, extensions, ...(requestId ? { requestId } : {}) };
      } catch (error) {
        if (error instanceof ShopifyApiError) throw error;
        if (input.abortSignal?.aborted) throw input.abortSignal.reason;
        lastFailure = error;
        const timedOut = error instanceof DOMException && error.name === 'TimeoutError';
        if (attempt < this.options.maxRetries) {
          await wait(Math.min(250 * 2 ** attempt, 2_000), input.abortSignal);
          continue;
        }
        throw new ShopifyApiError(
          timedOut ? 'timeout' : 'provider_failure',
          timedOut ? 'Shopify Admin API timed out.' : 'Shopify Admin API request failed.',
        );
      }
    }
    throw new ShopifyApiError(
      'provider_failure',
      lastFailure instanceof Error ? lastFailure.message : 'Shopify Admin API request failed.',
    );
  }

  private captureBudgets(shop: string, extensions: Record<string, unknown>): void {
    const graphql = readGraphqlBudget(extensions['cost']);
    const shopifyql = readShopifyQlBudget(extensions['shopifyqlCost']);
    if (graphql || shopifyql) {
      const current = this.budgets.get(shop);
      this.budgets.set(shop, {
        ...(current?.graphql ? { graphql: current.graphql } : {}),
        ...(current?.shopifyql ? { shopifyql: current.shopifyql } : {}),
        ...(graphql ? { graphql } : {}),
        ...(shopifyql ? { shopifyql } : {}),
      });
    }
  }

  private async waitForKnownBudget(shop: string, signal?: AbortSignal): Promise<void> {
    const current = this.budgets.get(shop);
    const now = Date.now();
    const waits = [current?.graphql, current?.shopifyql]
      .filter((budget): budget is Budget => Boolean(budget))
      .filter(budget => budget.available < budget.requested && budget.resetAt && budget.resetAt > now)
      .map(budget => budget.resetAt! - now);
    if (waits.length > 0) await wait(Math.min(Math.max(...waits), 30_000), signal);
  }
}

function assertReadOnlyDocument(document: string): void {
  if (/\b(?:mutation|subscription)\b/.test(document)) {
    throw new ShopifyApiError(
      'read_only_violation',
      'Divo Shopify access accepts GraphQL query operations only.',
    );
  }
}

function readGraphqlBudget(value: unknown): Budget | undefined {
  if (!isRecord(value)) return undefined;
  const requested = numberAt(value, 'requestedQueryCost');
  const throttle = isRecord(value['throttleStatus']) ? value['throttleStatus'] : undefined;
  const available = throttle ? numberAt(throttle, 'currentlyAvailable') : undefined;
  const restoreRate = throttle ? numberAt(throttle, 'restoreRate') : undefined;
  if (requested === undefined || available === undefined) return undefined;
  const seconds = restoreRate && restoreRate > 0 ? Math.ceil(Math.max(0, requested - available) / restoreRate) : undefined;
  return { requested, available, ...(seconds ? { resetAt: Date.now() + seconds * 1_000 } : {}) };
}

function readShopifyQlBudget(value: unknown): Budget | undefined {
  if (!isRecord(value)) return undefined;
  const requested = numberAt(value, 'requestedQueryCost');
  const available = numberAt(value, 'currentlyAvailable');
  const reset = typeof value['windowResetAt'] === 'string' ? Date.parse(value['windowResetAt']) : NaN;
  if (requested === undefined || available === undefined) return undefined;
  return { requested, available, ...(Number.isFinite(reset) ? { resetAt: reset } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function numberAt(value: Record<string, unknown>, key: string): number | undefined {
  return typeof value[key] === 'number' && Number.isFinite(value[key]) ? value[key] : undefined;
}

function errorCode(extensions: Record<string, unknown> | undefined): string | undefined {
  const code = extensions?.['code'];
  return typeof code === 'string' ? code.toUpperCase() : undefined;
}

async function readJson(response: Response, maxBytes: number): Promise<unknown> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new ShopifyApiError('invalid_response', 'Shopify response exceeded the configured size limit.', response.status);
  }
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new ShopifyApiError('invalid_response', 'Shopify response exceeded the configured size limit.', response.status);
  }
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { message: text.slice(0, 500) }; }
}

function providerMessage(payload: unknown, fallback: string): string {
  if (!isRecord(payload)) return fallback;
  for (const key of ['error_description', 'error', 'message']) {
    if (typeof payload[key] === 'string' && payload[key]) return payload[key];
  }
  return fallback;
}

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfter = Number(response.headers.get('retry-after'));
  return Number.isFinite(retryAfter) && retryAfter >= 0
    ? Math.min(retryAfter * 1_000, 30_000)
    : Math.min(250 * 2 ** attempt, 2_000);
}

async function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}
