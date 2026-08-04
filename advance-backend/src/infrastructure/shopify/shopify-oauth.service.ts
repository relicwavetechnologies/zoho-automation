import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { normalizeShopDomain } from '../../domain/shopify/shopify-shop';

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  scope: z.string().default(''),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1),
  refresh_token_expires_in: z.number().int().positive(),
}).passthrough();

export type ShopifyTokenPair = {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly scopes: string[];
  readonly accessTokenExpiresAt: Date;
  readonly refreshTokenExpiresAt: Date;
};

export class ShopifyOAuthError extends Error {
  constructor(
    readonly code:
      | 'not_configured'
      | 'invalid_shop'
      | 'invalid_callback'
      | 'scope_mismatch'
      | 'token_rejected'
      | 'provider_failure',
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ShopifyOAuthError';
  }
}

export class ShopifyOAuthService {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly options: {
    readonly clientId?: string;
    readonly clientSecret?: string;
    readonly redirectUri?: string;
    readonly scopes: readonly string[];
    readonly timeoutMs: number;
    readonly maxRetries: number;
    readonly maxCallbackSkewSeconds: number;
    readonly fetchImpl?: typeof fetch;
    readonly now?: () => Date;
  }) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  isConfigured(): boolean {
    return Boolean(
      this.options.clientId?.trim()
      && this.options.clientSecret?.trim()
      && this.options.redirectUri?.trim(),
    );
  }

  usesSecureRedirectUri(): boolean {
    return Boolean(this.options.redirectUri && new URL(this.options.redirectUri).protocol === 'https:');
  }

  getAuthorizeUrl(input: { readonly shop: string; readonly state: string }): string {
    this.assertConfigured();
    const shop = normalizeShopDomain(input.shop);
    if (!shop) throw new ShopifyOAuthError('invalid_shop', 'Use a valid *.myshopify.com shop domain.');
    const url = new URL(`https://${shop}/admin/oauth/authorize`);
    url.searchParams.set('client_id', this.options.clientId!.trim());
    url.searchParams.set('scope', this.options.scopes.join(','));
    url.searchParams.set('redirect_uri', this.options.redirectUri!.trim());
    url.searchParams.set('state', input.state);
    return url.toString();
  }

  createStateCookie(state: string): string {
    const signature = createHmac('sha256', this.requiredClientSecret()).update(state).digest('base64url');
    return `${state}.${signature}`;
  }

  unwrapSignedState(value: string | undefined): string | null {
    if (!value) return null;
    const separator = value.lastIndexOf('.');
    if (separator <= 0) return null;
    const state = value.slice(0, separator);
    const signature = value.slice(separator + 1);
    const expected = createHmac('sha256', this.requiredClientSecret()).update(state).digest('base64url');
    return safeEqualBytes(expected, signature) ? state : null;
  }

  verifyStateCookie(cookie: string | undefined, state: string): boolean {
    return this.unwrapSignedState(cookie) === state;
  }

  verifyCallback(searchParams: URLSearchParams): { shop: string; code?: string; error?: string; state: string } {
    this.assertConfigured();
    const hmac = searchParams.get('hmac') ?? '';
    const shop = normalizeShopDomain(searchParams.get('shop') ?? '');
    const code = searchParams.get('code') ?? '';
    const providerError = searchParams.get('error') ?? '';
    const state = searchParams.get('state') ?? '';
    const timestamp = Number(searchParams.get('timestamp'));
    if (!hmac || !shop || (!code && !providerError) || !state || !Number.isFinite(timestamp)) {
      throw new ShopifyOAuthError('invalid_callback', 'Shopify OAuth callback is incomplete.');
    }
    const ageSeconds = Math.abs(this.now().getTime() / 1_000 - timestamp);
    if (ageSeconds > this.options.maxCallbackSkewSeconds) {
      throw new ShopifyOAuthError('invalid_callback', 'Shopify OAuth callback has expired.');
    }

    const message = [...searchParams.entries()]
      .filter(([key]) => key !== 'hmac' && key !== 'signature')
      .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
        leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue))
      .map(([key, value]) => `${key}=${value}`)
      .join('&');
    const expected = createHmac('sha256', this.options.clientSecret!.trim())
      .update(message)
      .digest('hex');
    if (!safeEqualHex(expected, hmac)) {
      throw new ShopifyOAuthError('invalid_callback', 'Shopify OAuth callback signature is invalid.');
    }
    return { shop, ...(code ? { code } : {}), ...(providerError ? { error: providerError } : {}), state };
  }

  async exchangeAuthorizationCode(input: {
    readonly shop: string;
    readonly code: string;
    readonly expectedScopes?: readonly string[];
    readonly abortSignal?: AbortSignal;
  }): Promise<ShopifyTokenPair> {
    return this.requestToken(input.shop, new URLSearchParams({
      client_id: this.requiredClientId(),
      client_secret: this.requiredClientSecret(),
      code: input.code,
      expiring: '1',
    }), input.abortSignal, false, input.expectedScopes);
  }

  async refresh(input: {
    readonly shop: string;
    readonly refreshToken: string;
    readonly abortSignal?: AbortSignal;
  }): Promise<ShopifyTokenPair> {
    return this.requestToken(input.shop, new URLSearchParams({
      client_id: this.requiredClientId(),
      client_secret: this.requiredClientSecret(),
      grant_type: 'refresh_token',
      refresh_token: input.refreshToken,
    }), input.abortSignal, true);
  }

  private async requestToken(
    rawShop: string,
    body: URLSearchParams,
    abortSignal: AbortSignal | undefined,
    retryTransient: boolean,
    expectedScopes: readonly string[] = this.options.scopes,
  ): Promise<ShopifyTokenPair> {
    this.assertConfigured();
    const shop = normalizeShopDomain(rawShop);
    if (!shop) throw new ShopifyOAuthError('invalid_shop', 'Stored Shopify shop domain is invalid.');
    let lastFailure: unknown;
    const attempts = retryTransient ? this.options.maxRetries + 1 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      abortSignal?.throwIfAborted();
      try {
        const response = await this.fetchWithTimeout(
          `https://${shop}/admin/oauth/access_token`,
          {
            method: 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
          },
          abortSignal,
        );
        const payload = await readJson(response);
        if (!response.ok) {
          const message = providerMessage(payload, `Shopify token request failed with HTTP ${response.status}.`);
          const transient = response.status === 429 || response.status >= 500;
          if (transient && attempt + 1 < attempts) {
            await wait(retryDelayMs(response, attempt), abortSignal);
            continue;
          }
          throw new ShopifyOAuthError(
            response.status === 401 ? 'token_rejected' : 'provider_failure',
            message,
            response.status,
          );
        }
        const parsed = tokenResponseSchema.safeParse(payload);
        if (!parsed.success) {
          throw new ShopifyOAuthError('provider_failure', 'Shopify returned an incomplete expiring offline token pair.');
        }
        const scopes = splitScopes(parsed.data.scope);
        const missingScopes = expectedScopes.filter(scope => !scopes.includes(scope));
        const unexpectedScopes = scopes.filter(scope => !expectedScopes.includes(scope));
        if (missingScopes.length > 0 || unexpectedScopes.length > 0) {
          const details = [
            ...(missingScopes.length > 0 ? [`missing: ${missingScopes.join(', ')}`] : []),
            ...(unexpectedScopes.length > 0 ? [`unexpected: ${unexpectedScopes.join(', ')}`] : []),
          ].join('; ');
          throw new ShopifyOAuthError(
            'scope_mismatch',
            `Shopify granted a different scope set than the one authorized (${details}).`,
          );
        }
        const nowMs = this.now().getTime();
        return {
          accessToken: parsed.data.access_token,
          refreshToken: parsed.data.refresh_token,
          scopes,
          accessTokenExpiresAt: new Date(nowMs + parsed.data.expires_in * 1_000),
          refreshTokenExpiresAt: new Date(nowMs + parsed.data.refresh_token_expires_in * 1_000),
        };
      } catch (error) {
        if (error instanceof ShopifyOAuthError) throw error;
        if (abortSignal?.aborted) throw abortSignal.reason;
        lastFailure = error;
        if (attempt + 1 < attempts) {
          await wait(Math.min(250 * 2 ** attempt, 2_000), abortSignal);
          continue;
        }
      }
    }
    throw new ShopifyOAuthError(
      'provider_failure',
      lastFailure instanceof Error ? lastFailure.message : 'Shopify token request failed.',
    );
  }

  private async fetchWithTimeout(url: string, init: RequestInit, parent?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs);
    const signal = parent ? AbortSignal.any([parent, timeout]) : timeout;
    return this.fetchImpl(url, { ...init, signal });
  }

  private assertConfigured(): void {
    if (!this.isConfigured()) {
      throw new ShopifyOAuthError('not_configured', 'Shopify OAuth is not configured on this backend.');
    }
  }

  private requiredClientId(): string {
    this.assertConfigured();
    return this.options.clientId!.trim();
  }

  private requiredClientSecret(): string {
    this.assertConfigured();
    return this.options.clientSecret!.trim();
  }
}

function splitScopes(value: string): string[] {
  return [...new Set(value.split(/[ ,]+/).map(scope => scope.trim()).filter(Boolean))].sort();
}

function safeEqualHex(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(right)) return false;
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function safeEqualBytes(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { error_description: text.slice(0, 500) }; }
}

function providerMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== 'object') return fallback;
  const value = payload as Record<string, unknown>;
  for (const key of ['error_description', 'error', 'message']) {
    if (typeof value[key] === 'string' && value[key]) return value[key];
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
