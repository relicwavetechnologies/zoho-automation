import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { isShopifyGraphqlId, normalizeShopDomain } from '../../domain/shopify/shopify-shop';
import type { IntegrationConnectionRepository } from '../../infrastructure/persistence/integration-connection.repository';
import type { IntegrationOAuthAttemptRepository } from '../../infrastructure/persistence/integration-oauth-attempt.repository';
import type { ShopifyAdminClient } from '../../infrastructure/shopify/shopify-admin.client';
import type { ShopifyOAuthService } from '../../infrastructure/shopify/shopify-oauth.service';

const identitySchema = z.object({
  shop: z.object({
    id: z.string().refine(value => isShopifyGraphqlId(value, 'Shop')),
    name: z.string().trim().min(1).max(255),
    myshopifyDomain: z.string(),
  }),
});

const ATTEMPT_TTL_MS = 10 * 60 * 1_000;

export class ShopifyAuthorizationError extends Error {
  constructor(readonly code: 'invalid_state' | 'not_found' | 'unavailable' | 'provider_failure', message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'ShopifyAuthorizationError';
  }
}

export class ShopifyAuthorizationService {
  constructor(private readonly deps: {
    readonly oauth: ShopifyOAuthService;
    readonly adminClient: ShopifyAdminClient;
    readonly attempts: IntegrationOAuthAttemptRepository;
    readonly connections: IntegrationConnectionRepository;
    readonly scopes: readonly string[];
    readonly apiVersion: string;
    readonly now?: () => Date;
  }) {}

  isConfigured(): boolean {
    return this.deps.oauth.isConfigured();
  }

  usesSecureRedirectUri(): boolean {
    return this.deps.oauth.usesSecureRedirectUri();
  }

  async begin(input: {
    readonly companyId: string;
    readonly userId: string;
    readonly shopDomain: string;
    readonly returnTo?: string;
    readonly stateTransport?: 'cookie' | 'signed_parameter';
  }): Promise<{ state: string; signedState: string; authorizeUrl: string; expiresInSeconds: number }> {
    const state = randomBytes(32).toString('base64url');
    const stored = await this.deps.attempts.createShopify({
      state,
      companyId: input.companyId,
      userId: input.userId,
      shopDomain: input.shopDomain,
      requestedScopes: this.deps.scopes,
      ...(input.returnTo ? { returnTo: input.returnTo } : {}),
      expiresAt: new Date((this.deps.now?.() ?? new Date()).getTime() + ATTEMPT_TTL_MS),
    });
    if (!stored.ok) throw new ShopifyAuthorizationError('unavailable', 'Shopify OAuth state could not be persisted.', stored.error);
    const signedState = this.deps.oauth.createStateCookie(state);
    return {
      state,
      signedState,
      authorizeUrl: this.deps.oauth.getAuthorizeUrl({
        shop: input.shopDomain,
        state: input.stateTransport === 'signed_parameter' ? signedState : state,
      }),
      expiresInSeconds: ATTEMPT_TTL_MS / 1_000,
    };
  }

  async listCompanyConnections(companyId: string) {
    const listed = await this.deps.connections.listManageableShopifyConnections({ companyId });
    if (!listed.ok) throw new ShopifyAuthorizationError('unavailable', 'Shopify connection status could not be loaded.', listed.error);
    return listed.value;
  }

  async beginReconnect(input: {
    readonly companyId: string;
    readonly userId: string;
    readonly connectionId: string;
    readonly returnTo?: string;
    readonly stateTransport?: 'cookie' | 'signed_parameter';
  }): Promise<{ state: string; signedState: string; authorizeUrl: string; expiresInSeconds: number }> {
    const found = await this.deps.connections.findShopifyConnectionForReconnect({
      companyId: input.companyId,
      connectionId: input.connectionId,
    });
    if (!found.ok) throw new ShopifyAuthorizationError('unavailable', 'Shopify connection status could not be loaded.', found.error);
    if (!found.value) throw new ShopifyAuthorizationError('not_found', 'Shopify connection was not found.');
    return this.begin({
      companyId: input.companyId,
      userId: input.userId,
      shopDomain: found.value.shopDomain,
      ...(input.returnTo ? { returnTo: input.returnTo } : {}),
      ...(input.stateTransport ? { stateTransport: input.stateTransport } : {}),
    });
  }

  async complete(input: {
    readonly searchParams: URLSearchParams;
    readonly signedStateCookie?: string;
  }): Promise<{ status: 'connected' | 'denied'; returnTo?: string }> {
    const verified = this.deps.oauth.verifyCallback(input.searchParams);
    const cookieState = this.deps.oauth.verifyStateCookie(input.signedStateCookie, verified.state)
      ? verified.state
      : null;
    const attemptState = cookieState ?? this.deps.oauth.unwrapSignedState(verified.state);
    if (!attemptState) {
      throw new ShopifyAuthorizationError('invalid_state', 'Shopify OAuth browser state is invalid.');
    }
    const claimed = await this.deps.attempts.claimShopify({
      state: attemptState,
    });
    if (!claimed.ok) throw new ShopifyAuthorizationError('unavailable', 'Shopify OAuth state storage is unavailable.', claimed.error);
    if (!claimed.value) throw new ShopifyAuthorizationError('invalid_state', 'Shopify OAuth state is expired or already consumed.');
    const attempt = claimed.value;
    try {
      if (attempt.shopDomain !== verified.shop) throw new ShopifyAuthorizationError('invalid_state', 'Shopify OAuth shop does not match the requested store.');
      if (verified.error || !verified.code) {
        const failed = await this.deps.attempts.fail(attempt.id, verified.error || 'access_denied');
        if (!failed.ok) throw new ShopifyAuthorizationError('unavailable', 'Shopify denial state could not be persisted.', failed.error);
        return { status: 'denied', ...(attempt.returnTo ? { returnTo: attempt.returnTo } : {}) };
      }
      const tokens = await this.deps.oauth.exchangeAuthorizationCode({
        shop: verified.shop,
        code: verified.code,
        expectedScopes: attempt.requestedScopes,
      });
      const identityResponse = await this.deps.adminClient.query<{ shop: unknown }>({
        shop: verified.shop,
        accessToken: tokens.accessToken,
        query: 'query DivoShopIdentity { shop { id name myshopifyDomain } }',
      });
      const identity = identitySchema.safeParse(identityResponse.data);
      if (!identity.success || normalizeShopDomain(identity.data.shop.myshopifyDomain) !== attempt.shopDomain) {
        throw new ShopifyAuthorizationError('provider_failure', 'Shopify returned an invalid or mismatched shop identity.');
      }
      const saved = await this.deps.connections.upsertShopifyConnection({
        companyId: attempt.companyId,
        ownerType: 'company',
        createdBy: attempt.userId,
        shopDomain: attempt.shopDomain,
        shopName: identity.data.shop.name,
        shopGraphqlId: identity.data.shop.id,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        accessTokenExpiresAt: tokens.accessTokenExpiresAt,
        refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
        scopes: tokens.scopes,
        apiVersion: this.deps.apiVersion,
        authorizationAttemptId: attempt.id,
      });
      if (!saved.ok) throw new ShopifyAuthorizationError('unavailable', 'Shopify connection could not be persisted.', saved.error);
      return { status: 'connected', ...(attempt.returnTo ? { returnTo: attempt.returnTo } : {}) };
    } catch (error) {
      await this.deps.attempts.fail(attempt.id, error instanceof ShopifyAuthorizationError ? error.code : 'provider_failure');
      throw error;
    }
  }
}
