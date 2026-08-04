import { randomUUID } from 'node:crypto';
import type {
  DecryptedIntegrationConnection,
  IntegrationConnectionRepository,
} from '../../infrastructure/persistence/integration-connection.repository';
import { ShopifyOAuthError, ShopifyOAuthService } from '../../infrastructure/shopify/shopify-oauth.service';
import { normalizeShopDomain } from '../../domain/shopify/shopify-shop';

export class ShopifyConnectionError extends Error {
  constructor(
    readonly code: 'inaccessible' | 'unavailable' | 'missing_scope' | 'authorization_required',
    message: string,
  ) {
    super(message);
    this.name = 'ShopifyConnectionError';
  }
}

export type ResolvedShopifyConnection = {
  readonly connectionId: string;
  readonly shopDomain: string;
  readonly shopName?: string;
  readonly accessToken: string;
  readonly scopes: readonly string[];
};

export class ShopifyConnectionService {
  private readonly refreshes = new Map<string, Promise<DecryptedIntegrationConnection>>();

  constructor(private readonly deps: {
    readonly repository: IntegrationConnectionRepository;
    readonly oauth: ShopifyOAuthService;
    readonly refreshSkewMs?: number;
    readonly refreshLeaseMs?: number;
    readonly refreshPollMs?: number;
    readonly nowMs?: () => number;
    readonly wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  }) {}

  async resolve(input: {
    readonly companyId: string;
    readonly userId: string;
    readonly connectionId: string;
    readonly requiredScopes: readonly string[];
    readonly forceRefresh?: boolean;
    readonly abortSignal?: AbortSignal;
  }): Promise<ResolvedShopifyConnection> {
    const found = await this.deps.repository.findAccessibleShopifyConnection({
      companyId: input.companyId,
      userId: input.userId,
      connectionId: input.connectionId,
      minimumAccess: 'read_only',
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    });
    if (!found.ok) throw new ShopifyConnectionError('unavailable', 'Shopify connection storage is unavailable.');
    if (!found.value) throw new ShopifyConnectionError('inaccessible', 'This Shopify connection is unavailable or not shared with this member.');

    let connection = found.value;
    const expiresAt = connection.accessTokenExpiresAt?.getTime();
    const expiresSoon = expiresAt !== undefined
      && expiresAt <= this.nowMs() + (this.deps.refreshSkewMs ?? 120_000);
    if (input.forceRefresh || expiresSoon || !connection.accessToken) {
      connection = await this.refresh(connection, input.userId, input.abortSignal);
    }
    const missingScopes = input.requiredScopes.filter(scope => !connection.scopes.includes(scope));
    if (missingScopes.length > 0) {
      throw new ShopifyConnectionError(
        'missing_scope',
        `Shopify connection is missing required scopes: ${missingScopes.join(', ')}.`,
      );
    }
    const shopDomain = normalizeShopDomain(connection.externalAccountId ?? '');
    if (!shopDomain || !connection.accessToken) {
      throw new ShopifyConnectionError('authorization_required', 'Shopify must be reconnected before this store can be used.');
    }
    return {
      connectionId: connection.id,
      shopDomain,
      ...(connection.accountName ? { shopName: connection.accountName } : {}),
      accessToken: connection.accessToken,
      scopes: connection.scopes,
    };
  }

  async touch(connectionId: string): Promise<void> {
    await this.deps.repository.touchLastUsed(connectionId);
  }

  private async refresh(
    connection: DecryptedIntegrationConnection,
    userId: string,
    abortSignal?: AbortSignal,
  ): Promise<DecryptedIntegrationConnection> {
    const active = this.refreshes.get(connection.id);
    if (active) return active;
    const promise = this.refreshOnce(connection, userId, abortSignal)
      .finally(() => this.refreshes.delete(connection.id));
    this.refreshes.set(connection.id, promise);
    return promise;
  }

  private async refreshOnce(
    connection: DecryptedIntegrationConnection,
    userId: string,
    abortSignal?: AbortSignal,
  ): Promise<DecryptedIntegrationConnection> {
    const shopDomain = normalizeShopDomain(connection.externalAccountId ?? '');
    if (!shopDomain || !connection.refreshToken) {
      throw new ShopifyConnectionError('authorization_required', 'Shopify authorization has expired; reconnect this store.');
    }
    if (connection.refreshTokenExpiresAt && connection.refreshTokenExpiresAt.getTime() <= this.nowMs()) {
      throw new ShopifyConnectionError('authorization_required', 'Shopify refresh authorization has expired; reconnect this store.');
    }
    const leaseOwner = randomUUID();
    const acquired = await this.acquireLease(connection, leaseOwner);
    if (!acquired) return this.waitForRefreshOrTakeover(connection, userId, abortSignal);
    return this.refreshWithLease(connection, userId, leaseOwner, abortSignal);
  }

  private async refreshWithLease(
    connection: DecryptedIntegrationConnection,
    userId: string,
    leaseOwner: string,
    abortSignal?: AbortSignal,
  ): Promise<DecryptedIntegrationConnection> {
    const shopDomain = normalizeShopDomain(connection.externalAccountId ?? '');
    if (!shopDomain || !connection.refreshToken) {
      throw new ShopifyConnectionError('authorization_required', 'Shopify authorization has expired; reconnect this store.');
    }
    try {
      let refreshed;
      try {
        refreshed = await this.deps.oauth.refresh({
          shop: shopDomain,
          refreshToken: connection.refreshToken,
          ...(abortSignal ? { abortSignal } : {}),
        });
      } catch (error) {
        if (error instanceof ShopifyOAuthError && error.code === 'token_rejected') {
          const marked = await this.deps.repository.markShopifyReauthorizationRequired({
            companyId: connection.companyId,
            connectionId: connection.id,
          });
          if (!marked.ok) {
            throw new ShopifyConnectionError('unavailable', 'Shopify reconnect state could not be persisted safely.');
          }
          throw new ShopifyConnectionError('authorization_required', 'Shopify authorization was revoked; reconnect this store.');
        }
        throw error;
      }
      const saved = await this.deps.repository.compareAndSwapShopifyTokens({
        companyId: connection.companyId,
        connectionId: connection.id,
        expectedTokenVersion: connection.tokenVersion,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        accessTokenExpiresAt: refreshed.accessTokenExpiresAt,
        refreshTokenExpiresAt: refreshed.refreshTokenExpiresAt,
        scopes: refreshed.scopes,
      });
      if (!saved.ok) throw new ShopifyConnectionError('unavailable', 'Refreshed Shopify credentials could not be persisted safely.');
    } finally {
      await this.deps.repository.releaseShopifyRefreshLease({
        companyId: connection.companyId,
        connectionId: connection.id,
        leaseOwner,
      });
    }

    const winner = await this.deps.repository.findAccessibleShopifyConnection({
      companyId: connection.companyId,
      userId,
      connectionId: connection.id,
      minimumAccess: 'read_only',
      ...(abortSignal ? { abortSignal } : {}),
    });
    if (!winner.ok || !winner.value?.accessToken) {
      throw new ShopifyConnectionError('unavailable', 'Refreshed Shopify credentials could not be reloaded.');
    }
    return winner.value;
  }

  private async waitForRefreshOrTakeover(
    previous: DecryptedIntegrationConnection,
    userId: string,
    abortSignal?: AbortSignal,
  ): Promise<DecryptedIntegrationConnection> {
    const deadline = this.nowMs() + this.leaseMs() * 2;
    while (this.nowMs() < deadline) {
      abortSignal?.throwIfAborted();
      const winner = await this.deps.repository.findAccessibleShopifyConnection({
        companyId: previous.companyId,
        userId,
        connectionId: previous.id,
        minimumAccess: 'read_only',
        ...(abortSignal ? { abortSignal } : {}),
      });
      if (!winner.ok) throw new ShopifyConnectionError('unavailable', 'Shopify refresh winner could not be loaded.');
      if (!winner.value) throw new ShopifyConnectionError('authorization_required', 'Shopify must be reconnected before this store can be used.');
      if (winner.value.tokenVersion !== previous.tokenVersion && winner.value.accessToken) return winner.value;
      const leaseOwner = randomUUID();
      if (await this.acquireLease(winner.value, leaseOwner)) {
        return this.refreshWithLease(winner.value, userId, leaseOwner, abortSignal);
      }
      await (this.deps.wait ?? wait)(this.deps.refreshPollMs ?? 100, abortSignal);
    }
    throw new ShopifyConnectionError('unavailable', 'Timed out waiting for another backend to refresh Shopify credentials.');
  }

  private async acquireLease(connection: DecryptedIntegrationConnection, leaseOwner: string): Promise<boolean> {
    const lease = await this.deps.repository.acquireShopifyRefreshLease({
      companyId: connection.companyId,
      connectionId: connection.id,
      leaseOwner,
      expiresAt: new Date(this.nowMs() + this.leaseMs()),
    });
    if (!lease.ok) throw new ShopifyConnectionError('unavailable', 'Shopify refresh coordination is unavailable.');
    return lease.value;
  }

  private nowMs(): number {
    return this.deps.nowMs?.() ?? Date.now();
  }

  private leaseMs(): number {
    return this.deps.refreshLeaseMs ?? 90_000;
  }
}

async function wait(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}
