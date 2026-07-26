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
import { AIRTABLE_REQUESTED_SCOPES } from '../../application/airtable/airtable-mcp-manifest';
import { AIRTABLE_MCP_DEFAULT_URL } from './airtable-mcp.client';

const AUTH_ATTEMPT_TTL_SECONDS = 10 * 60;
/**
 * Airtable issues clients through dynamic registration rather than a developer
 * console, so the client identity is discovered at runtime. Registering once
 * per deployment and reusing it keeps a single stable client_id across every
 * connection instead of leaving a throwaway registration behind per attempt.
 */
const REGISTERED_CLIENT_TTL_SECONDS = 180 * 24 * 60 * 60;
/**
 * Keyed by redirect origin: Airtable binds redirect_uris to the registered
 * client, so a registration made for one backend origin is unusable from
 * another. Sharing one cache entry across origins would hand out a client_id
 * whose redirect Airtable then rejects.
 */
const REGISTERED_CLIENT_KEY_PREFIX = 'airtable:mcp:oauth:client';
const CLIENT_NAME = 'Divo';

function redirectOrigin(redirectUri: string): string {
  try {
    return new URL(redirectUri).origin;
  } catch {
    return redirectUri;
  }
}

interface StoredAirtableMcpAuth {
  authorizationUrl?: string;
  codeVerifier?: string;
  tokens?: OAuthTokens;
  clientInformation?: OAuthClientInformationMixed;
  discoveryState?: OAuthDiscoveryState;
}

export interface AirtableMcpTokens {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly tokenType: string;
  readonly expiresIn?: number;
  readonly scopes: string[];
  readonly clientInformation?: OAuthClientInformationMixed;
  readonly discoveryState?: OAuthDiscoveryState;
}

/**
 * Runs the OAuth 2.1 + PKCE authorization-code flow against Airtable's hosted
 * MCP. Airtable registers public clients (token_endpoint_auth_method "none"),
 * so there is no client secret: the per-attempt PKCE verifier is what proves
 * the token exchange came from this backend. State, verifier, registration and
 * tokens all stay server-side; nothing reaches Pi or Desktop.
 */
export class AirtableMcpOAuthService {
  private readonly mcpUrl: string;
  private readonly configuredRedirectUri: string | undefined;
  private readonly configuredClientId: string | undefined;
  private readonly log: Logger;
  private readonly cache: CachePort;

  constructor(opts: { env: TypedEnv; cache: CachePort; logger: Logger }) {
    this.cache = opts.cache;
    this.mcpUrl = (opts.env.AIRTABLE_MCP_URL ?? AIRTABLE_MCP_DEFAULT_URL).trim();
    // An explicit override still wins, but the normal path is the caller
    // passing the callback for the backend origin Desktop signed in against.
    this.configuredRedirectUri = opts.env.AIRTABLE_MCP_REDIRECT_URI?.trim() || undefined;
    this.configuredClientId = opts.env.AIRTABLE_CLIENT_ID?.trim() || undefined;
    this.log = opts.logger.child({ service: 'airtable-mcp-oauth' });
  }

  /**
   * Whether the service can talk to Airtable at all. Deliberately independent
   * of any redirect URI: refreshing an existing connection never redirects, so
   * an unresolvable callback origin must not strand live connections.
   */
  isConfigured(): boolean {
    try {
      return new URL(this.mcpUrl).protocol === 'https:';
    } catch {
      return false;
    }
  }

  /**
   * Whether a *new* connection can be started against this callback origin.
   *
   * HTTPS is required everywhere except the loopback interface. OAuth 2.0 for
   * Native Apps (RFC 8252 §7.3) carves out `http://127.0.0.1` and `localhost`
   * precisely because a local redirect never leaves the machine, and Airtable
   * accepts a loopback redirect for the same reason. Without this the desktop
   * app cannot connect Airtable in development at all: the callback origin is
   * derived from the request, which is plain HTTP on localhost.
   */
  isConnectConfigured(redirectUri?: string): boolean {
    if (!this.isConfigured()) return false;
    try {
      const url = new URL(this.resolveRedirectUri(redirectUri));
      if (url.protocol === 'https:') return true;
      return url.protocol === 'http:' && isLoopbackHost(url.hostname);
    } catch {
      return false;
    }
  }

  resolveRedirectUri(requested?: string): string {
    return (this.configuredRedirectUri ?? requested ?? '').trim();
  }

  async beginAuthorization(input: {
    readonly attemptId: string;
    readonly state: string;
    readonly redirectUri?: string;
  }): Promise<string> {
    const redirectUri = this.resolveRedirectUri(input.redirectUri);
    this.assertConnectConfigured(redirectUri);
    const provider = this.createProvider(input.attemptId, redirectUri, input.state);
    const client = new Client({ name: CLIENT_NAME, version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(this.mcpUrl), { authProvider: provider });

    try {
      // SDK v1.29's transport declarations are not exactOptionalPropertyTypes
      // compatible even though its runtime transport implements this contract.
      await client.connect(transport as any);
      throw new Error('Airtable MCP unexpectedly accepted an unauthenticated connection');
    } catch (error) {
      if (!(error instanceof UnauthorizedError)) throw error;
      const stored = await this.readAttempt(input.attemptId);
      if (!stored.authorizationUrl) {
        throw new Error('Airtable MCP did not provide an authorization URL');
      }
      return stored.authorizationUrl;
    } finally {
      await transport.close().catch(() => undefined);
    }
  }

  async completeAuthorization(input: {
    readonly attemptId: string;
    readonly code: string;
    readonly redirectUri?: string;
  }): Promise<AirtableMcpTokens> {
    // OAuth requires the token exchange to present the *same* redirect_uri the
    // authorization used, so the caller replays the one it signed into state.
    const redirectUri = this.resolveRedirectUri(input.redirectUri);
    this.assertConnectConfigured(redirectUri);
    const provider = this.createProvider(input.attemptId, redirectUri);
    const transport = new StreamableHTTPClientTransport(new URL(this.mcpUrl), { authProvider: provider });
    try {
      await transport.finishAuth(input.code);
      const stored = await this.readAttempt(input.attemptId);
      if (!stored.tokens?.access_token) throw new Error('Airtable OAuth completed without an access token');
      return this.toTokens(stored.tokens, stored.clientInformation, stored.discoveryState);
    } finally {
      await transport.close().catch(() => undefined);
    }
  }

  async clearAttempt(attemptId: string): Promise<void> {
    await this.cache.del(this.cacheKey(attemptId));
  }

  /**
   * Refresh a persisted connection before an MCP call.
   *
   * Airtable rotates the refresh token on every use and invalidates the
   * previous one immediately, so the caller MUST persist the returned
   * refreshToken atomically — dropping it strands the connection. Airtable also
   * expires a refresh token after 60 days of inactivity, which is why idle
   * connections are refreshed on a schedule rather than only on demand.
   */
  async refreshConnectionTokens(input: {
    readonly accessToken: string;
    readonly refreshToken: string;
    readonly tokenType?: string;
    readonly scopes: readonly string[];
    readonly clientInformation?: OAuthClientInformationMixed;
    readonly discoveryState?: OAuthDiscoveryState;
  }): Promise<AirtableMcpTokens> {
    this.assertConfigured();
    let tokens: OAuthTokens = {
      access_token: input.accessToken,
      token_type: input.tokenType ?? 'Bearer',
      refresh_token: input.refreshToken,
      ...(input.scopes.length ? { scope: input.scopes.join(' ') } : {}),
    };
    let clientInformation = input.clientInformation;
    let discoveryState = input.discoveryState;
    // Refresh replays the registration stored with the connection, so the
    // redirect in this metadata is never exercised — it only satisfies the
    // SDK's required shape.
    const metadata = this.clientMetadata(this.configuredRedirectUri ?? '');
    const provider: OAuthClientProvider = {
      get redirectUrl() { return undefined; },
      clientMetadata: metadata,
      clientInformation: () => clientInformation,
      saveClientInformation: (value) => { clientInformation = value; },
      tokens: () => tokens,
      saveTokens: (value) => { tokens = value; },
      redirectToAuthorization: () => { throw new Error('Airtable connection requires reauthorization'); },
      saveCodeVerifier: () => undefined,
      codeVerifier: () => { throw new Error('Airtable connection requires reauthorization'); },
      discoveryState: () => discoveryState,
      saveDiscoveryState: (value) => { discoveryState = value; },
    };
    const client = new Client({ name: CLIENT_NAME, version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(this.mcpUrl), { authProvider: provider });
    try {
      await client.connect(transport as any);
      return this.toTokens(tokens, clientInformation, discoveryState);
    } finally {
      await transport.close().catch(() => undefined);
      await client.close().catch(() => undefined);
    }
  }

  private toTokens(
    tokens: OAuthTokens,
    clientInformation: OAuthClientInformationMixed | undefined,
    discoveryState: OAuthDiscoveryState | undefined,
  ): AirtableMcpTokens {
    return {
      accessToken: tokens.access_token,
      ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
      tokenType: tokens.token_type,
      ...(tokens.expires_in ? { expiresIn: tokens.expires_in } : {}),
      scopes: tokens.scope?.split(' ').filter(Boolean) ?? [],
      ...(clientInformation ? { clientInformation } : {}),
      ...(discoveryState ? { discoveryState } : {}),
    };
  }

  private createProvider(attemptId: string, redirectUri: string, state?: string): OAuthClientProvider {
    const metadata = this.clientMetadata(redirectUri);

    return {
      redirectUrl: redirectUri,
      clientMetadata: metadata,
      state: async () => state ?? '',
      clientInformation: async () => {
        const attempt = (await this.readAttempt(attemptId)).clientInformation;
        if (attempt) return attempt;
        // Reuse this origin's registration so every connection through the same
        // backend URL shares one stable client_id instead of registering a
        // fresh throwaway client.
        return this.readRegisteredClient(redirectUri);
      },
      saveClientInformation: async (clientInformation) => {
        await this.updateAttempt(attemptId, { clientInformation });
        await this.writeRegisteredClient(redirectUri, clientInformation);
      },
      tokens: async () => (await this.readAttempt(attemptId)).tokens,
      saveTokens: async (tokens) => this.updateAttempt(attemptId, { tokens }),
      redirectToAuthorization: async (authorizationUrl) => this.updateAttempt(attemptId, { authorizationUrl: String(authorizationUrl) }),
      saveCodeVerifier: async (codeVerifier) => this.updateAttempt(attemptId, { codeVerifier }),
      codeVerifier: async () => {
        const codeVerifier = (await this.readAttempt(attemptId)).codeVerifier;
        if (!codeVerifier) throw new Error('Airtable OAuth PKCE verifier is missing or expired');
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
    return `airtable:mcp:oauth:${attemptId}`;
  }

  private registeredClientKey(redirectUri: string): string {
    return `${REGISTERED_CLIENT_KEY_PREFIX}:${redirectOrigin(redirectUri)}`;
  }

  private clientMetadata(redirectUri: string): OAuthClientMetadata {
    return {
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: CLIENT_NAME,
      scope: AIRTABLE_REQUESTED_SCOPES.join(' '),
    };
  }

  /**
   * A pre-registered client from configuration wins over dynamic registration,
   * so a branded Airtable OAuth integration can be adopted later without any
   * code change.
   */
  private async readRegisteredClient(redirectUri: string): Promise<OAuthClientInformationMixed | undefined> {
    if (this.configuredClientId) {
      return { client_id: this.configuredClientId } as OAuthClientInformationMixed;
    }
    const result = await this.cache.get<OAuthClientInformationMixed>(this.registeredClientKey(redirectUri));
    if (!result.ok) {
      this.log.warn('airtable.oauth.client_read_failed', { error: result.error.message });
      return undefined;
    }
    return result.value ?? undefined;
  }

  private async writeRegisteredClient(
    redirectUri: string,
    clientInformation: OAuthClientInformationMixed,
  ): Promise<void> {
    if (this.configuredClientId) return;
    const result = await this.cache.set(this.registeredClientKey(redirectUri), clientInformation, REGISTERED_CLIENT_TTL_SECONDS);
    if (!result.ok) {
      // Non-fatal: the attempt already holds the registration, so this flow
      // still completes. The next connect simply registers a client again.
      this.log.warn('airtable.oauth.client_write_failed', { error: result.error.message });
    }
  }

  private async readAttempt(attemptId: string): Promise<StoredAirtableMcpAuth> {
    const result = await this.cache.get<StoredAirtableMcpAuth>(this.cacheKey(attemptId));
    if (!result.ok) throw new Error(`Could not read Airtable OAuth state: ${result.error.message}`);
    return result.value ?? {};
  }

  private async updateAttempt(attemptId: string, update: Partial<StoredAirtableMcpAuth>): Promise<void> {
    const current = await this.readAttempt(attemptId);
    const result = await this.cache.set(this.cacheKey(attemptId), { ...current, ...update }, AUTH_ATTEMPT_TTL_SECONDS);
    if (!result.ok) {
      this.log.warn('airtable.oauth.state_write_failed', { attemptId, error: result.error.message });
      throw new Error('Could not save Airtable OAuth state');
    }
  }

  private assertConfigured(): void {
    if (!this.isConfigured()) throw new Error('Airtable MCP OAuth is not configured with an HTTPS MCP URL');
  }

  private assertConnectConfigured(redirectUri: string): void {
    this.assertConfigured();
    if (!this.isConnectConfigured(redirectUri)) {
      throw new Error(`Airtable MCP OAuth needs an HTTPS callback URL, or HTTP on loopback; got "${redirectUri || '(none)'}"`);
    }
  }
}

/** RFC 8252 §7.3 loopback hosts, where a plain-HTTP redirect never leaves the machine. */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}
