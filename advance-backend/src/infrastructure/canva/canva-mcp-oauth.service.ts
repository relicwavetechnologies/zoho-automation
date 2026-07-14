import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { UnauthorizedError, type OAuthClientProvider, type OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { CachePort } from '../../shared/cache';
import type { Logger } from '../../shared/logger';
import type { TypedEnv } from '../../config/env';

const AUTH_ATTEMPT_TTL_SECONDS = 10 * 60;
const CANVA_MCP_DEFAULT_URL = 'https://mcp.canva.com/mcp';

interface StoredCanvaMcpAuth {
  authorizationUrl?: string;
  codeVerifier?: string;
  tokens?: OAuthTokens;
  clientInformation?: OAuthClientInformationMixed;
  discoveryState?: OAuthDiscoveryState;
}

export interface CanvaMcpTokens {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly tokenType: string;
  readonly expiresIn?: number;
  readonly scopes: string[];
  readonly clientInformation?: OAuthClientInformationMixed;
  readonly discoveryState?: OAuthDiscoveryState;
}

/**
 * Handles the OAuth authorization-code flow required by Canva's remote MCP.
 * State, PKCE verifier, dynamic-client registration and tokens remain in the
 * backend cache until the callback persists the encrypted connection record.
 */
export class CanvaMcpOAuthService {
  private readonly mcpUrl: string;
  private readonly redirectUri: string;
  private readonly clientMetadataUrl: string | undefined;
  private readonly log: Logger;

  constructor(opts: { env: TypedEnv; cache: CachePort; logger: Logger }) {
    this.cache = opts.cache;
    this.mcpUrl = (opts.env.CANVA_MCP_URL ?? CANVA_MCP_DEFAULT_URL).trim();
    this.redirectUri = (opts.env.CANVA_MCP_REDIRECT_URI
      ?? `${opts.env.BACKEND_PUBLIC_URL.replace(/\/$/, '')}/api/desktop/auth/canva/callback`).trim();
    this.clientMetadataUrl = opts.env.CANVA_MCP_CLIENT_METADATA_URL?.trim() || undefined;
    this.log = opts.logger.child({ service: 'canva-mcp-oauth' });
  }

  private readonly cache: CachePort;

  isConfigured(): boolean {
    try {
      const mcp = new URL(this.mcpUrl);
      const redirect = new URL(this.redirectUri);
      return mcp.protocol === 'https:' && redirect.protocol === 'https:';
    } catch {
      return false;
    }
  }

  async beginAuthorization(input: { readonly attemptId: string; readonly state: string }): Promise<string> {
    this.assertConfigured();
    const provider = this.createProvider(input.attemptId, input.state);
    const client = new Client({ name: 'Divo Dex', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(this.mcpUrl), { authProvider: provider });

    try {
      // SDK v1.29's transport declarations are not exactOptionalPropertyTypes
      // compatible even though its runtime transport implements this contract.
      await client.connect(transport as any);
      throw new Error('Canva MCP unexpectedly accepted an unauthenticated connection');
    } catch (error) {
      if (!(error instanceof UnauthorizedError)) throw error;
      const stored = await this.readAttempt(input.attemptId);
      if (!stored.authorizationUrl) {
        throw new Error('Canva MCP did not provide an authorization URL');
      }
      return stored.authorizationUrl;
    } finally {
      await transport.close().catch(() => undefined);
    }
  }

  async completeAuthorization(input: { readonly attemptId: string; readonly code: string }): Promise<CanvaMcpTokens> {
    this.assertConfigured();
    const provider = this.createProvider(input.attemptId);
    const transport = new StreamableHTTPClientTransport(new URL(this.mcpUrl), { authProvider: provider });
    try {
      await transport.finishAuth(input.code);
      const stored = await this.readAttempt(input.attemptId);
      if (!stored.tokens?.access_token) throw new Error('Canva OAuth completed without an access token');
      return {
        accessToken: stored.tokens.access_token,
        ...(stored.tokens.refresh_token ? { refreshToken: stored.tokens.refresh_token } : {}),
        tokenType: stored.tokens.token_type,
        ...(stored.tokens.expires_in ? { expiresIn: stored.tokens.expires_in } : {}),
        scopes: stored.tokens.scope?.split(' ').filter(Boolean) ?? [],
        ...(stored.clientInformation ? { clientInformation: stored.clientInformation } : {}),
        ...(stored.discoveryState ? { discoveryState: stored.discoveryState } : {}),
      };
    } finally {
      await transport.close().catch(() => undefined);
    }
  }

  async clearAttempt(attemptId: string): Promise<void> {
    await this.cache.del(this.cacheKey(attemptId));
  }

  /**
   * Refresh a persisted connection before an MCP call. The OAuth SDK retains
   * the provider's client-registration/discovery state in token metadata, so
   * token refresh stays server-side and no credential reaches Pi/Desktop.
   */
  async refreshConnectionTokens(input: {
    readonly accessToken: string;
    readonly refreshToken: string;
    readonly tokenType?: string;
    readonly scopes: readonly string[];
    readonly clientInformation?: OAuthClientInformationMixed;
    readonly discoveryState?: OAuthDiscoveryState;
  }): Promise<CanvaMcpTokens> {
    this.assertConfigured();
    let tokens: OAuthTokens = {
      access_token: input.accessToken,
      token_type: input.tokenType ?? 'Bearer',
      refresh_token: input.refreshToken,
      ...(input.scopes.length ? { scope: input.scopes.join(' ') } : {}),
    };
    let clientInformation = input.clientInformation;
    let discoveryState = input.discoveryState;
    const metadata = this.clientMetadata();
    const provider: OAuthClientProvider = {
      get redirectUrl() { return undefined; },
      ...(this.clientMetadataUrl ? { clientMetadataUrl: this.clientMetadataUrl } : {}),
      clientMetadata: metadata,
      clientInformation: () => clientInformation,
      saveClientInformation: (value) => { clientInformation = value; },
      tokens: () => tokens,
      saveTokens: (value) => { tokens = value; },
      redirectToAuthorization: () => { throw new Error('Canva connection requires reauthorization'); },
      saveCodeVerifier: () => undefined,
      codeVerifier: () => { throw new Error('Canva connection requires reauthorization'); },
      discoveryState: () => discoveryState,
      saveDiscoveryState: (value) => { discoveryState = value; },
    };
    const client = new Client({ name: 'Divo Dex', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(this.mcpUrl), { authProvider: provider });
    try {
      await client.connect(transport as any);
      return {
        accessToken: tokens.access_token,
        ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
        tokenType: tokens.token_type,
        ...(tokens.expires_in ? { expiresIn: tokens.expires_in } : {}),
        scopes: tokens.scope?.split(' ').filter(Boolean) ?? [],
        ...(clientInformation ? { clientInformation } : {}),
        ...(discoveryState ? { discoveryState } : {}),
      };
    } finally {
      await transport.close().catch(() => undefined);
      await client.close().catch(() => undefined);
    }
  }

  private createProvider(attemptId: string, state?: string): OAuthClientProvider {
    const metadata = this.clientMetadata();

    return {
      redirectUrl: this.redirectUri,
      ...(this.clientMetadataUrl ? { clientMetadataUrl: this.clientMetadataUrl } : {}),
      clientMetadata: metadata,
      state: async () => state ?? '',
      clientInformation: async () => (await this.readAttempt(attemptId)).clientInformation,
      saveClientInformation: async (clientInformation) => this.updateAttempt(attemptId, { clientInformation }),
      tokens: async () => (await this.readAttempt(attemptId)).tokens,
      saveTokens: async (tokens) => this.updateAttempt(attemptId, { tokens }),
      redirectToAuthorization: async (authorizationUrl) => this.updateAttempt(attemptId, { authorizationUrl: String(authorizationUrl) }),
      saveCodeVerifier: async (codeVerifier) => this.updateAttempt(attemptId, { codeVerifier }),
      codeVerifier: async () => {
        const codeVerifier = (await this.readAttempt(attemptId)).codeVerifier;
        if (!codeVerifier) throw new Error('Canva OAuth PKCE verifier is missing or expired');
        return codeVerifier;
      },
      discoveryState: async () => (await this.readAttempt(attemptId)).discoveryState,
      saveDiscoveryState: async (discoveryState) => this.updateAttempt(attemptId, { discoveryState }),
      invalidateCredentials: async () => {
        await this.cache.del(this.cacheKey(attemptId));
      },
    };
  }

  private cacheKey(attemptId: string): string {
    return `canva:mcp:oauth:${attemptId}`;
  }

  private clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUri],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: 'Divo Dex',
    };
  }

  private async readAttempt(attemptId: string): Promise<StoredCanvaMcpAuth> {
    const result = await this.cache.get<StoredCanvaMcpAuth>(this.cacheKey(attemptId));
    if (!result.ok) throw new Error(`Could not read Canva OAuth state: ${result.error.message}`);
    return result.value ?? {};
  }

  private async updateAttempt(attemptId: string, update: Partial<StoredCanvaMcpAuth>): Promise<void> {
    const current = await this.readAttempt(attemptId);
    const result = await this.cache.set(this.cacheKey(attemptId), { ...current, ...update }, AUTH_ATTEMPT_TTL_SECONDS);
    if (!result.ok) {
      this.log.warn('canva.oauth.state_write_failed', { attemptId, error: result.error.message });
      throw new Error('Could not save Canva OAuth state');
    }
  }

  private assertConfigured(): void {
    if (!this.isConfigured()) throw new Error('Canva MCP OAuth is not configured with HTTPS MCP and redirect URLs');
  }
}
